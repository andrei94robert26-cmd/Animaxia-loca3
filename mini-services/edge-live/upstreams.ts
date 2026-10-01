/**
 * upstreams.ts — normalizarea upstream-urilor edge-ului public FAZA 28-E.
 *
 * Regula FAZA 28-E: TOATE upstream-urile folosesc hostname-uri de container
 * (http://backend:4000, http://gateway:4040, …) — NICIODATĂ localhost direct
 * în config. În sandbox nu există Docker DNS, deci edge-ul implementează
 * STRATUL DE NORMALIZARE DNS INTERN (alias map container-name → adresă
 * sandbox), echivalentul functional al rețelei de containere din producție.
 *
 * Tabela de mapare (container/namespace → sandbox) este publică la
 * GET /api/edge/mapping și în README — un singur loc unde se definesc
 * toate numele, porturile și adresele platformei.
 */

/* ------------------------------------------------------------------ */
/* Internal DNS alias map — container hostname → sandbox address        */
/* ------------------------------------------------------------------ */
export const DNS_ALIASES: Record<string, string> = {
  frontend: '127.0.0.1',
  backend: '127.0.0.1',
  realtime: '127.0.0.1',
  watchdog: '127.0.0.1',
  'redis-global': '127.0.0.1',
  gateway: '127.0.0.1',
  observability: '127.0.0.1',
  stability: '127.0.0.1',
  edge: '127.0.0.1',
};

/* ------------------------------------------------------------------ */
/* Upstream-uri normalizate (env-driven, valori canonice container)     */
/* ------------------------------------------------------------------ */
export const UPSTREAMS = {
  BACKEND: process.env.UPSTREAM_BACKEND ?? 'http://backend:4000',
  GATEWAY: process.env.UPSTREAM_GATEWAY ?? 'http://gateway:4040',
  OBSERVABILITY: process.env.UPSTREAM_OBSERVABILITY ?? 'http://observability:4050',
  STABILITY: process.env.UPSTREAM_STABILITY ?? 'http://stability:4060',
  REALTIME: process.env.UPSTREAM_REALTIME ?? 'http://realtime:4010',
  FRONTEND: process.env.UPSTREAM_FRONTEND ?? 'http://frontend:3000',
  REDIS: process.env.UPSTREAM_REDIS ?? 'redis://redis-global:4030',
} as const;

/* Proba de health per upstream (endpoint + timeout). */
export const HEALTH_PROBES: Record<string, { path: string; method: string }> = {
  BACKEND: { path: '/api/health', method: 'GET' },
  GATEWAY: { path: '/api/infra/health', method: 'GET' },
  OBSERVABILITY: { path: '/api/observability/health', method: 'GET' },
  STABILITY: { path: '/api/health', method: 'GET' },
  REALTIME: { path: '/socket.io/?EIO=4&transport=polling', method: 'GET' },
  FRONTEND: { path: '/', method: 'GET' },
};

export interface UpstreamState {
  canonical: string;      // ex. http://backend:4000 (numele de container)
  address: string;        // ex. http://127.0.0.1:4000 (adresa sandbox)
  host: string;
  port: number;
  healthy: boolean;
  lastError: string | null;
  lastCheck: number;
  latencyMs: number | null;
}

/** Resolvă un URL canonic (http://backend:4000) prin alias map. */
export function resolveUpstream(canonicalUrl: string): { address: string; host: string; port: number } {
  const u = new URL(canonicalUrl);
  const host = DNS_ALIASES[u.hostname] ?? u.hostname;
  return { address: `${u.protocol}//${host}:${u.port}`, host, port: Number(u.port) };
}

export class UpstreamRegistry {
  states = new Map<string, UpstreamState>();

  constructor() {
    for (const [key, canonical] of Object.entries(UPSTREAMS)) {
      if (key === 'REDIS') continue; // RESP/TCP — probat separat prin PING
      const { address, host, port } = resolveUpstream(canonical);
      this.states.set(key, {
        canonical, address, host, port,
        healthy: true, lastError: null, lastCheck: 0, latencyMs: null,
      });
    }
  }

  get(key: string): UpstreamState | undefined {
    return this.states.get(key);
  }

  /**
   * AR10M (NEON FREE PLAN, strict): re-probe ON-DEMAND — apelat din deciziile
   * reale de rutare (pickChain), doar când starea e mai veche de maxAgeMs.
   * Refresh piggyback pe traficul real, zero activitate de fundal.
   */
  ensureFresh(maxAgeMs = 60_000): void {
    const now = Date.now();
    for (const key of this.states.keys()) {
      const st = this.states.get(key);
      if (st && now - st.lastCheck > maxAgeMs) {
        // fire-and-forget: decizia curentă folosește starea existentă
        void this.probeWithHardTimeout(key).catch(() => {});
      }
    }
  }

  /** Lanț failover: primul upstream HEALTHY din listă. */
  pickChain(keys: string[]): { key: string; state: UpstreamState } | null {
    this.ensureFresh(); // AR10M: re-probe on-demand (piggyback pe trafic real)
    for (const key of keys) {
      const st = this.states.get(key);
      if (st && st.healthy) return { key, state: st };
    }
    return null;
  }

  async probe(key: string): Promise<void> {
    const st = this.states.get(key);
    if (!st) return;
    const probe = HEALTH_PROBES[key] ?? { path: '/api/health', method: 'GET' };
    const t0 = Date.now();
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 2000);
    try {
      const res = await fetch(`${st.address}${probe.path}`, {
        method: probe.method, signal: ctl.signal, redirect: 'manual',
      });
      clearTimeout(to);
      const alive = res.status < 500; // orice răspuns HTTP = proces viu
      st.healthy = alive;
      st.latencyMs = Date.now() - t0;
      st.lastCheck = Date.now();
      st.lastError = alive ? null : `probe status ${res.status}`;
    } catch (e) {
      clearTimeout(to); // igienă: oprește abort-timer-ul și pe calea de eroare
      st.healthy = false;
      st.latencyMs = null;
      st.lastCheck = Date.now();
      st.lastError = (e as Error).message;
    }
  }

  /**
   * FAZA 28-E-2 (2026-09-27): probe cu hard-timeout race. Incident real: după
   * boot-ul simultan edge+backend (edge a pornit înainte ca :4000 să asculte),
   * fetch-ul probe-ului BACKEND a rămas blocat definitiv — AbortController nu
   * a anulat promisiunea — iar bucla SECVENȚIALĂ din startHealthChecks a
   * înghețat TOT registrul (toate lastCheck-oarele congelate la boot, edge
   * marcând BACKEND unhealthy 42+ min deși procesul era sănătos; doar
   * failover-ul proxy pe GATEWAY a ținut lanțul public viu). Race-ul garantează
   * că fiecare probe se închide onest: dacă fetch-ul atârnă, lastCheck/lastError
   * sunt actualizate cu „probe timeout" în loc să înghețe tot tabelul.
   */
  async probeWithHardTimeout(key: string, hardTimeoutMs = 5000): Promise<void> {
    const st = this.states.get(key);
    if (!st) return;
    let settled = false;
    await Promise.race([
      this.probe(key).finally(() => { settled = true; }),
      new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          if (!settled) {
            st.healthy = false;
            st.latencyMs = null;
            st.lastCheck = Date.now();
            st.lastError = `probe timeout (hung fetch >${hardTimeoutMs}ms)`;
          }
          resolve();
        }, hardTimeoutMs);
        if (typeof t.unref === 'function') t.unref();
      }),
    ]);
  }

  /**
   * AR10M (NEON FREE PLAN, strict): ZERO blind interval polling (fost 5s,
   * relaxat la 60s în NEON-OPT — acum eliminat complet). Probe-urile rulează
   * (1) o singură dată la boot și (2) on-demand la deciziile de rutare
   * (ensureFresh/pickChain). /api/health pe backend e zero-DB, deci probe-urile
   * nu pot trezi Neon — dar regula utilizatorului e strictă: zero polling.
   */
  startOnDemandHealthChecks(): void {
    // boot: un singur set de probe-uri (procesul tocmai a pornit — cost unic)
    void Promise.allSettled([...this.states.keys()].map((k) => this.probeWithHardTimeout(k)));
  }

  snapshot(): Record<string, UpstreamState> {
    const out: Record<string, UpstreamState> = {};
    for (const [k, v] of this.states) out[k] = { ...v };
    return out;
  }
}

/** Proba RESP (PING) pentru redis-global — protocol TCP, nu HTTP. */
export async function redisPing(address: string): Promise<{ ok: boolean; latencyMs: number | null; error?: string }> {
  const { host, port } = resolveUpstream(address);
  const t0 = Date.now();
  try {
    const { connect } = await import('node:net');
    return await new Promise((resolve) => {
      const sock = connect({ host, port }, () => {
        sock.write('*1\r\n$4\r\nPING\r\n');
      });
      const to = setTimeout(() => { sock.destroy(); resolve({ ok: false, latencyMs: null, error: 'timeout' }); }, 2000);
      sock.once('data', (buf: Buffer) => {
        clearTimeout(to);
        const ok = buf.toString().startsWith('+PONG');
        sock.destroy();
        resolve({ ok, latencyMs: Date.now() - t0 });
      });
      sock.once('error', (err: Error) => {
        clearTimeout(to);
        resolve({ ok: false, latencyMs: null, error: err.message });
      });
    });
  } catch (e) {
    return { ok: false, latencyMs: null, error: (e as Error).message };
  }
}
