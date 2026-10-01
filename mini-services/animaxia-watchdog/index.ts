/**
 * index.ts — animaxia-watchdog (FAZA 17-d · NEON FREE PLAN).
 *
 * Process supervisor for the Animaxia platform: the user's requirement is
 * that the platform, the server, the search engine and the player must never
 * *stay* down at 30B external contents.
 *
 * NEON FREE PLAN (scale-to-zero) — watchdog-ul a fost reconfigurat exact cum
 * cere utilizatorul: verificare la 6 ORE, ZERO acces la DB, verifică DOAR
 * procesul (TCP connect pe port — fără HTTP /api/health, care ar fi executat
 * interogări Neon la fiecare 10s și ar fi ținut compute-ul treaz non-stop,
 * rădăcina arderii cotei pe vechea bază). După FAILS_TO_RESTART verificări
 * eșuate consecutive respawn-ează serviciul (`bun run dev` în cwd-ul corect,
 * detașat) și intră în cooldown.
 *
 * Monitored (process liveness via TCP connect — no HTTP, no DB):
 *   web      → 127.0.0.1:3000   (portul acceptă conexiuni = proces viu)
 *   backend  → 127.0.0.1:4000
 *   realtime → 127.0.0.1:4010
 *   gateway  → 127.0.0.1:4040
 *
 * Status API (port 4020):
 *   GET /        → { ok, uptimeSec, intervalMs, services: [...states] }
 *   GET /health  → { ok: true }
 *
 * The watchdog never exits on errors — a failed check is data, not a crash.
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';

const PORT = 4020;
/* NEON FREE PLAN: 10s → 6 ORE (cerință explicită utilizator). */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CONNECT_TIMEOUT_MS = 3_000;
const FAILS_TO_RESTART = 3;
const COOLDOWN_MS = 90_000;

/* TS3 (env-restore auto-heal): when the backend reports the recurring
 * failure mode "DATABASEURL missing → local-fallback" in /api/health, run
 * restore-env.sh (persistent secrets/ backup → .env → relaunch) at most once
 * per 10 minutes. restore-env.sh manages the backend process itself, so the
 * watchdog suppresses its OWN respawn for the same window — no double-spawn. */
const ENV_RESTORE_INTERVAL_MS = 10 * 60_000;
let lastEnvRestoreAt = 0;
const BACKEND_CWD = '/home/z/my-project/mini-services/animaxia-backend';

interface ServiceConfig {
  key: string;
  label: string;
  url: string;
  cwd: string;
  /** Respawn command run inside `cwd` (bash -c, detached, output appended). */
  respawnCmd: string;
  /** Human note shown in the status API. */
  note: string;
}

interface ServiceState {
  key: string;
  label: string;
  url: string;
  up: boolean;
  roundTripMs: number | null;
  lastOkAt: string | null;
  lastFailAt: string | null;
  consecutiveFails: number;
  restarts: number;
  lastRestartAt: string | null;
  cooldownUntil: number;
  lastError: string | null;
  note: string;
  /** TS3: env-restore auto-heal counters (backend only). */
  envRestores: number;
  lastEnvRestoreAt: string | null;
}

const SERVICES: ServiceConfig[] = [
  {
    key: 'web',
    label: 'Web Next.js (:3000)',
    url: 'http://127.0.0.1:3000/',
    cwd: '/home/z/my-project',
    // `bun run dev` = `next dev -p 3000 2>&1 | tee dev.log` — tee keeps dev.log alive.
    respawnCmd: 'nohup bun run dev > /dev/null 2>&1 &',
    note: 'Frontendul platformei — repornit automat la cădere.',
  },
  {
    key: 'backend',
    label: 'Backend API (:4000)',
    url: 'http://127.0.0.1:4000/api/health',
    cwd: '/home/z/my-project/mini-services/animaxia-backend',
    respawnCmd: 'nohup bun run dev >> log 2>&1 &',
    note: 'Motorul de căutare Neon FTS + toate API-urile platformei.',
  },
  {
    key: 'realtime',
    label: 'Realtime socket.io (:4010)',
    url: 'http://127.0.0.1:4010/socket.io/?EIO=4&transport=polling',
    cwd: '/home/z/my-project/mini-services/animaxia-realtime',
    respawnCmd: 'nohup bun run dev >> log 2>&1 &',
    note: 'Canale în timp real (watch party, feed live, presence).',
  },
  {
    // FAZA 22 — global perimeter. redis-global (:4030) is TCP/RESP only (not
    // HTTP), so it is monitored indirectly via the gateway's /api/infra/status
    // (redisMode field) and degrades in-memory inside the gateway if it dies.
    key: 'global-gateway',
    label: 'Gateway global multi-regiune (:4040)',
    url: 'http://127.0.0.1:4040/api/infra/health',
    cwd: '/home/z/my-project/mini-services/global-gateway',
    respawnCmd: 'nohup bun run dev >> log 2>&1 &',
    note: 'FAZA 22 — routing multi-regiune + straturi perimetrale distribuite (Redis).',
  },
];

const states = new Map<string, ServiceState>();
const startedAt = Date.now();

for (const svc of SERVICES) {
  states.set(svc.key, {
    key: svc.key,
    label: svc.label,
    url: svc.url,
    up: false,
    roundTripMs: null,
    lastOkAt: null,
    lastFailAt: null,
    consecutiveFails: 0,
    restarts: 0,
    lastRestartAt: null,
    cooldownUntil: 0,
    lastError: null,
    note: svc.note,
    envRestores: 0,
    lastEnvRestoreAt: null,
  });
}

function log(msg: string): void {
  console.log(`[watchdog ${new Date().toISOString()}] ${msg}`);
}

async function checkService(svc: ServiceConfig): Promise<{ ok: boolean; ms: number; error: string | null }> {
  /* NEON FREE PLAN: TCP connect pur — verifică DOAR că procesul e viu și
   * portul e legat. Fostul fetch HTTP pe /api/health executa, la fiecare 10s,
   * countContent()+countsByType() pe Neon (prin endpoint-ul de health) și
   * ținea compute-ul permanent treaz. TCP nu atinge nici HTTP, nici DB-ul. */
  const started = Date.now();
  const target = new URL(svc.url);
  const host = target.hostname || '127.0.0.1';
  const port = parseInt(target.port || (target.protocol === 'https:' ? '443' : '80'), 10);
  return new Promise((resolve) => {
    const socket = connect({ host, port }, () => {
      socket.destroy();
      resolve({ ok: true, ms: Date.now() - started, error: null });
    });
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => {
      socket.destroy();
      resolve({ ok: false, ms: Date.now() - started, error: `connect timeout after ${CONNECT_TIMEOUT_MS}ms` });
    });
    socket.once('error', (err: Error) => {
      socket.destroy();
      resolve({ ok: false, ms: Date.now() - started, error: err.message });
    });
  });
}

function respawn(svc: ServiceConfig): void {
  const st = states.get(svc.key);
  if (!st) return;
  st.restarts += 1;
  st.lastRestartAt = new Date().toISOString();
  st.cooldownUntil = Date.now() + COOLDOWN_MS;
  st.consecutiveFails = 0; // require FAILS_TO_RESTART fresh failures post-spawn
  log(`RESTART ${svc.key} — picat după ${FAILS_TO_RESTART} verificări consecutive; respawn în ${svc.cwd}`);
  try {
    const child = spawn('bash', ['-c', `cd ${svc.cwd} && ${svc.respawnCmd}`], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch (err) {
    log(`RESTART ${svc.key} EȘUAT: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * TS3 auto-heal (NEON FREE PLAN: fs-based, zero HTTP/DB) for the RECURRING
 * failure mode: a session reset wiped `backend/.env` (DATABASEURL missing →
 * local-fallback). Fosta detecție inspecta body-ul /api/health (HTTP la 10s);
 * acum watchdog-ul citește DIRECT fișierul .env de pe disc (zero rețea, zero
 * DB) la fiecare ciclu de 6h și rulează restore-env.sh detașat, cel mult o
 * dată la ENV_RESTORE_INTERVAL_MS. Scriptul oprește/relansează backendul
 * singur, deci respawn-ul propriu al watchdog-ului e suprimat pe fereastra
 * respectivă (fără spawn-uri duble).
 */
function maybeRestoreEnv(): void {
  const now = Date.now();
  const st = states.get('backend');
  if (!st) return;
  if (now - lastEnvRestoreAt < ENV_RESTORE_INTERVAL_MS) return;
  let envBroken = false;
  try {
    const envPath = `${BACKEND_CWD}/.env`;
    if (!existsSync(envPath)) {
      envBroken = true;
    } else {
      const envContent = readFileSync(envPath, 'utf8');
      envBroken = !/^DATABASEURL=.+/m.test(envContent);
    }
  } catch {
    envBroken = false; // .env ilizibil — nu facem restore orbește
  }
  if (!envBroken) return;
  lastEnvRestoreAt = now;
  st.envRestores += 1;
  st.lastEnvRestoreAt = new Date().toISOString();
  st.cooldownUntil = now + ENV_RESTORE_INTERVAL_MS; // restore-env.sh owns the relaunch
  st.consecutiveFails = 0;
  log(`AUTO-RESTORE .env — backend .env lipsește/DATABASEURL șters pe disc; rulez restore-env.sh (următorul încerc în ${ENV_RESTORE_INTERVAL_MS / 60_000} min)`);
  try {
    const child = spawn('bash', ['-c', `bash ${BACKEND_CWD}/restore-env.sh`], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch (err) {
    log(`AUTO-RESTORE eșuat: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function checkAll(): Promise<void> {
  await Promise.all(
    SERVICES.map(async (svc) => {
      const st = states.get(svc.key)!;
      const result = await checkService(svc);
      st.roundTripMs = result.ms;
      if (result.ok) {
        st.up = true;
        st.lastOkAt = new Date().toISOString();
        st.consecutiveFails = 0;
        st.lastError = null;
        // TS3 (NEON FREE PLAN): procesul e viu — verificarea .env se face pe
        // disc (fs), nu prin body-ul HTTP /api/health (zero rețea, zero DB).
        if (svc.key === 'backend') {
          maybeRestoreEnv();
        }
      } else {
        st.up = false;
        st.lastFailAt = new Date().toISOString();
        st.lastError = result.error;
        st.consecutiveFails += 1;
        log(`FAIL ${svc.key} (${st.consecutiveFails}/${FAILS_TO_RESTART}): ${result.error}`);
        if (
          st.consecutiveFails >= FAILS_TO_RESTART &&
          Date.now() >= st.cooldownUntil
        ) {
          respawn(svc);
        } else if (st.consecutiveFails >= FAILS_TO_RESTART) {
          log(`(${svc.key} în cooldown de respawn — aștept până ${new Date(st.cooldownUntil).toISOString()})`);
        }
      }
    }),
  );
}

/* ------------------------------ status API ------------------------------ */

const server = createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0];
  if (url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'animaxia-watchdog' }));
    return;
  }
  if (url === '/') {
    const allUp = [...states.values()].every((s) => s.up);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        service: 'animaxia-watchdog',
        allUp,
        uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
        intervalMs: CHECK_INTERVAL_MS,
        failsToRestart: FAILS_TO_RESTART,
        cooldownMs: COOLDOWN_MS,
        services: [...states.values()],
      }),
    );
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'Route not found' }));
});

server.listen(PORT, () => {
  log(`animaxia-watchdog activ pe :${PORT} — supraveghez ${SERVICES.length} servicii la fiecare ${CHECK_INTERVAL_MS / 1000}s`);
  // First check immediately, then on the interval.
  void checkAll();
  const timer = setInterval(() => {
    void checkAll();
  }, CHECK_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
});

process.on('uncaughtException', (err) => {
  log(`uncaughtException (watchdog continuă): ${err instanceof Error ? err.message : String(err)}`);
});
process.on('unhandledRejection', (reason) => {
  log(`unhandledRejection (watchdog continuă): ${reason instanceof Error ? reason.message : String(reason)}`);
});
