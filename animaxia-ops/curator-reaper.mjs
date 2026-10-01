/**
 * curator-reaper.mjs — FAZA 33 (ops aditiv, PLAN 100X): mitigație operațională
 * pentru degradarea cunoscută FAZA-32-B (curatorScan O(n²) din hub.js protejat
 * FAZA 16 pe catalogul de 18.925 itemi, apelat de synthetics FAZA 23 protejate
 * la fiecare 60s + stability FAZA 24).
 *
 * Ce face: termină SESIUNILE DB (nu codul!) care rulează cross-join-ul trigram
 * `similarity(a.title, b.title)` de mai mult de REAP_AFTER_MS (default 90s).
 * Acele query-uri sunt oricum abandonate client-side (resilience timeout 30s ⇒
 * 504 onest) — dar continuă să ruleze pe Neon și saturează CPU-ul, blocând
 * motorul de căutare protejat (FAZA 18) și boot-urile de servicii.
 *
 * ZERO atingeri de cod protejat: hub.js (FAZA 16), synthetics (FAZA 23),
 * stability (FAZA 24) rămân neatinse — acest script este strat ops NOU.
 * Fix-ul definitiv (operator % indexabil în curatorScan, 1 linie) rămâne la
 * poarta de aprobare ⚠️ din PLAN-100X.
 *
 * Rulează la fiecare 30s; log onest în stdout (redirectionat în jurnal).
 */
import pg from 'pg';

const REAP_AFTER_MS = parseInt(process.env.REAP_AFTER_MS || '90000', 10);
const INTERVAL_MS = parseInt(process.env.REAPER_INTERVAL_MS || '30000', 10);

const envText = await Bun.file('/home/z/my-project/mini-services/animaxia-backend/.env').text();
const cs = envText.split('\n').find((l) => l.startsWith('DATABASEURL=')).slice('DATABASEURL='.length).trim();

let reaped = 0;
let runs = 0;

async function reap() {
  runs += 1;
  const client = new pg.Client({ connectionString: cs, ssl: { rejectUnauthorized: false } });
  try {
    await client.connect();
    const r = await client.query(
      `SELECT pid, pg_terminate_backend(pid) AS terminated, now()-query_start AS age
       FROM pg_stat_activity
       WHERE datname IS NOT NULL AND pid <> pg_backend_pid()
         AND state = 'active'
         AND query ILIKE '%similarity(a.title, b.title)%'
         AND now() - query_start > $1::interval`,
      [`${Math.round(REAP_AFTER_MS / 1000)} seconds`],
    );
    for (const row of r.rows) {
      if (row.terminated) {
        reaped += 1;
        const ageTotalS = Math.round(row.age.seconds + row.age.minutes * 60 + row.age.hours * 3600);
        console.log(`[curator-reaper] terminated orphan PID ${row.pid} (age ${ageTotalS}s) — query abandonată client-side, continua să satureze Neon`);
      }
    }
  } catch (err) {
    console.warn(`[curator-reaper] probe failed (non-fatal): ${err.message}`);
  } finally {
    try {
      await client.end();
    } catch {
      /* ignore */
    }
  }
}

console.log(`[curator-reaper] start — interval ${INTERVAL_MS}ms, prag ${REAP_AFTER_MS}ms (mitigare aditivă FAZA 33; fix-ul definitiv rămâne la poarta ⚠️)`);
await reap();
setInterval(reap, INTERVAL_MS);
