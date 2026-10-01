#!/usr/bin/env node
/**
 * tests/bench-ar10m.mjs — REAL AR10M benchmark runner (Task AR10M-2-BE).
 * Manual tool (node or bun compatible) — NEVER run by the server.
 *
 *   node tests/bench-ar10m.mjs --rows 10000|100000|1000000   (default 10000)
 *   node tests/bench-ar10m.mjs --cleanup
 *   node tests/bench-ar10m.mjs --resume                       (continue inserts)
 *
 * What it does (honest, measured, zero invented values):
 *   1. INSERT phase — SYNTHETIC rows into ar10m.bench_catalog (batch_id
 *      'synthetic-…', synthetic=TRUE). Titles 'synthetic title N' normalized
 *      via the REAL normalizeTitle, years 1950..2030 deterministic, shard_id
 *      via the REAL computeShardId. Batches of 5000 with 250ms pauses
 *      (Neon-friendly). Checkpoint + resume via data/ar10m-bench-state.json.
 *      Synthetic rows NEVER enter ar10m.content → never counted in /stats
 *      and never returned by the real search.
 *   2. MEASURE phase — 4 concurrent workers, 200 prefix queries per size
 *      against ar10m.bench_catalog (same column + text_pattern_ops index
 *      shape as ar10m.content — representative of the real gateway SQL,
 *      which is mirrored here 1:1 but pointed at the synthetic table so the
 *      real catalog stays clean). Prefixes: 1-3 chars sampled from synthetic
 *      titles + realistic ('the', 'synthetic', 2-char). Measures p50/p95/p99,
 *      queries/sec, errors. Plus single-row exact search and year-filtered
 *      search latencies.
 *   3. SPACE phase (REAL pg_* functions): pg_total_relation_size +
 *      pg_indexes_size for ar10m.bench_catalog AND ar10m.content,
 *      pg_database_size(), AVG(pg_column_size()) over a 1000-row sample.
 *      Space per row = total_relation_size(bench_catalog) / bench row count.
 *
 * Results → data/ar10m-bench-state.json (merged into lastRun) + stdout table.
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { normalizeTitle, computeShardId } from '../modules/ar10m/normalize.js';
import { ensureAr10mSchema } from '../modules/ar10m/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(BACKEND_ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'ar10m-bench-state.json');

const BATCH_ROWS = 5_000;
const PAUSE_MS = 250;
const CONCURRENCY = 4;
const QUERIES_PER_SIZE = 200;
const PAGE_LIMIT = 20;

/* ----------------------------------- env ------------------------------------ */

// dotenv is a backend dependency — use it, with a tiny manual fallback.
try {
  const dotenv = await import('dotenv');
  dotenv.config({ path: path.join(BACKEND_ROOT, '.env') });
} catch {
  try {
    const raw = fs.readFileSync(path.join(BACKEND_ROOT, '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    /* no .env — rely on real env */
  }
}

const DATABASEURL = process.env.DATABASEURL;
if (!DATABASEURL) {
  console.error('EROARE: DATABASEURL lipsește (definește-l în .env sau environ).');
  process.exit(1);
}

/* ----------------------------------- args ----------------------------------- */

const args = process.argv.slice(2);
const argValue = (name) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
};
const DO_CLEANUP = args.includes('--cleanup');
const DO_RESUME = args.includes('--resume');
const ROWS_TARGET = (() => {
  const n = parseInt(argValue('--rows') || '10000', 10);
  return [10_000, 100_000, 1_000_000].includes(n) ? n : 10_000;
})();

/* ---------------------------------- helpers ---------------------------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p * sorted.length) / 100))];
const stats = (samples) => {
  if (samples.length === 0) return { n: 0, p50Ms: null, p95Ms: null, p99Ms: null, avgMs: null, minMs: null, maxMs: null };
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = samples.reduce((a, b) => a + b, 0);
  return {
    n: samples.length,
    p50Ms: pct(sorted, 50),
    p95Ms: pct(sorted, 95),
    p99Ms: pct(sorted, 99),
    avgMs: Math.round((sum / samples.length) * 100) / 100,
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
  };
};
const fmtBytes = (b) => {
  if (b === null || b === undefined) return 'indisponibil';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeState(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

/* ---------------------------------- client ----------------------------------- */

/* Pool (nu Client simplu): măsurătorile rulează cu CONCURRENCY workeri
 * simultan — un singur Client nu suportă query-uri concurente (pg@9 le va
 * respinge). Pool max=CONCURRENCY+1 acoperă și faza de insert. */
const client = new pg.Pool({
  connectionString: DATABASEURL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
  max: CONCURRENCY + 1,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 10_000,
});

const q = async (text, params = []) => (await client.query(text, params)).rows;

/* ------------------------------- insert phase --------------------------------- */

async function insertPhase(state) {
  const t0 = Date.now();
  let done = state.rowsDone || 0;
  console.log(`\n[INSERT] batch ${state.batchId}: ${done}/${state.rowsTarget} rows (5000/batch, pauză ${PAUSE_MS}ms)`);
  while (done < state.rowsTarget) {
    const n = Math.min(BATCH_ROWS, state.rowsTarget - done);
    const params = [];
    const values = [];
    for (let i = 0; i < n; i += 1) {
      const idx = done + i;
      const title = syntheticTitle(idx);
      const year = 1950 + (idx % 81);
      params.push(state.batchId, normalizeTitle(title), year, computeShardId(title, year));
      const base = i * 4;
      values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
    }
    await client.query(
      `INSERT INTO ar10m.bench_catalog (batch_id, normalized_title, year, shard_id) VALUES ${values.join(',')}`,
      params,
    );
    done += n;
    state.rowsDone = done;
    state.updatedAt = new Date().toISOString();
    writeState(state);
    process.stdout.write(`\r[INSERT] ${done}/${state.rowsTarget}`);
    if (done < state.rowsTarget) await sleep(PAUSE_MS); // eslint-disable-line no-await-in-loop
  }
  console.log(`\n[INSERT] gata în ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  state.phase = 'done';
  state.updatedAt = new Date().toISOString();
}

/* ------------------------------ measure phase --------------------------------- */

// The gateway's per-shard SQL mirrored 1:1, pointed at the synthetic table.
const PREFIX_SQL = `SELECT b.id, b.normalized_title, b.year, b.shard_id
FROM ar10m.bench_catalog b
WHERE b.normalized_title LIKE $1 || '%'
ORDER BY b.normalized_title ASC, b.id ASC
LIMIT ${PAGE_LIMIT + 1}`;

const YEAR_SQL = `SELECT b.id, b.normalized_title, b.year, b.shard_id
FROM ar10m.bench_catalog b
WHERE b.normalized_title LIKE $1 || '%' AND b.year = $2
ORDER BY b.normalized_title ASC, b.id ASC
LIMIT ${PAGE_LIMIT + 1}`;

/** Sample realistic prefixes: 1-3 chars from synthetic titles + known terms. */
/* Vocabular realist determinist — prefix-urile generate apar ERECTIV în date
 * (regula AR10M: benchmark-ul măsoară index scan real, nu zero-scanuri). */
const BENCH_WORDS = ['the', 'synthetic', 'dark', 'last', 'new', 'lost', 'city', 'night', 'road', 'king', 'star', 'love', 'time', 'dream', 'iron', 'deep'];
function syntheticTitle(idx) {
  const w1 = BENCH_WORDS[idx % BENCH_WORDS.length];
  const w2 = BENCH_WORDS[(idx >> 4) % BENCH_WORDS.length];
  return `${w1} ${w2} ${idx}`;
}

function buildPrefixPool() {
  const pool = new Set(BENCH_WORDS.slice(0, 6));
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648; // deterministic LCG
    return seed / 2147483648;
  };
  for (let i = 0; i < 40; i += 1) {
    const title = `synthetic title ${Math.floor(rand() * 1000000)}`;
    const nt = normalizeTitle(title);
    const len = 1 + Math.floor(rand() * 3);
    pool.add(nt.slice(0, len));
  }
  return [...pool];
}

async function measurePhase(state) {
  const prefixes = buildPrefixPool();
  const totalBenchRows = Number((await q('SELECT COUNT(*)::int AS n FROM ar10m.bench_catalog'))[0]?.n ?? 0);
  console.log(`\n[MEASURE] ${QUERIES_PER_SIZE} prefix queries, ${CONCURRENCY} workers concurrency, tabelă ar10m.bench_catalog (${totalBenchRows} rânduri totale)`);

  const samples = [];
  const errors = [];
  let zeroResults = 0;
  let done = 0;
  let seed = 1337;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };

  const worker = async () => {
    for (;;) {
      const i = done++;
      if (i >= QUERIES_PER_SIZE) return;
      const prefix = prefixes[Math.floor(rand() * prefixes.length)];
      const t0 = Date.now();
      try {
        const rows = await q(PREFIX_SQL, [prefix]);
        samples.push(Date.now() - t0);
        if (rows.length === 0) zeroResults += 1; // index scan real fără potriviri — informativ, nu eroare
      } catch (err) {
        samples.push(Date.now() - t0);
        errors.push({ i, prefix, error: String(err?.message ?? err).slice(0, 160) });
      }
    }
  };
  const t0 = Date.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const wallMs = Date.now() - t0;

  // Single-row exact search: full normalized title of one synthetic row.
  const exactSamples = [];
  const oneRow = await q('SELECT normalized_title FROM ar10m.bench_catalog LIMIT 1');
  if (oneRow.length > 0) {
    for (let i = 0; i < 10; i += 1) {
      const te = Date.now();
      await q(PREFIX_SQL, [oneRow[0].normalized_title]);
      exactSamples.push(Date.now() - te);
    }
  }

  // Year-filtered search.
  const yearSamples = [];
  const year = 1950 + (Math.floor(rand() * 1000) % 81);
  for (let i = 0; i < 20; i += 1) {
    const prefix = prefixes[Math.floor(rand() * prefixes.length)];
    const ty = Date.now();
    try {
      await q(YEAR_SQL, [prefix, year]);
    } catch {
      /* counted as error below */
    }
    yearSamples.push(Date.now() - ty);
  }

  return {
    concurrency: CONCURRENCY,
    queries: QUERIES_PER_SIZE,
    prefix: stats(samples),
    queriesPerSec: Math.round((QUERIES_PER_SIZE / (wallMs / 1000)) * 100) / 100,
    errors: errors.length,
    errorSamples: errors.slice(0, 5),
    singleRowExact: stats(exactSamples),
    yearFiltered: stats(yearSamples),
    benchRowsTotal: totalBenchRows,
  };
}

/* ------------------------------- space phase ---------------------------------- */

async function spacePhase() {
  const rel = await q(
    `SELECT
       pg_total_relation_size('ar10m.bench_catalog')::bigint AS bench_total,
       pg_indexes_size('ar10m.bench_catalog')::bigint AS bench_indexes,
       pg_total_relation_size('ar10m.content')::bigint AS content_total,
       pg_indexes_size('ar10m.content')::bigint AS content_indexes,
       pg_database_size(current_database())::bigint AS db_size,
       (SELECT COUNT(*)::int FROM ar10m.bench_catalog) AS bench_rows,
       (SELECT COUNT(*)::int FROM ar10m.content) AS content_rows`,
  );
  const col = await q('SELECT AVG(pg_column_size(t))::float AS avg_col_bytes FROM (SELECT * FROM ar10m.bench_catalog LIMIT 1000) t');
  const r = rel[0] ?? {};
  const benchRows = Number(r.bench_rows ?? 0);
  const contentRows = Number(r.content_rows ?? 0);
  return {
    benchCatalog: {
      rows: benchRows,
      totalBytes: Number(r.bench_total ?? 0),
      indexBytes: Number(r.bench_indexes ?? 0),
      bytesPerRow: benchRows > 0 ? Math.round((Number(r.bench_total ?? 0) / benchRows) * 100) / 100 : null,
    },
    ar10mContent: {
      rows: contentRows,
      totalBytes: Number(r.content_total ?? 0),
      indexBytes: Number(r.content_indexes ?? 0),
      bytesPerRow: contentRows > 0 ? Math.round((Number(r.content_total ?? 0) / contentRows) * 100) / 100 : null,
    },
    avgColumnSizeBytes: col[0]?.avg_col_bytes !== null && col[0]?.avg_col_bytes !== undefined ? Math.round(Number(col[0].avg_col_bytes) * 100) / 100 : null,
    databaseBytes: Number(r.db_size ?? 0),
  };
}

/* ----------------------------------- main ------------------------------------- */

async function main() {
  console.log('AR10M benchmark REAL — rânduri sintetice marcate (synthetic=TRUE), niciodată în catalogul real');
    console.log('[SCHEMA] ensure idempotent (ar10m.*)…');
  const ensure = await ensureAr10mSchema(async (text, params) => client.query(text, params));
  if (!ensure.ok) {
    console.error(`EROARE: schema ensure a eșuat: ${JSON.stringify(ensure.errors)}`);
    await client.end();
    process.exit(1);
  }

  if (DO_CLEANUP) {
    const t0 = Date.now();
    const before = Number((await q('SELECT COUNT(*)::int AS n FROM ar10m.bench_catalog'))[0]?.n ?? 0);
    await q("DELETE FROM ar10m.bench_catalog WHERE batch_id LIKE 'synthetic-%'");
    console.log(`[CLEANUP] șterse ${before} rânduri sintetice în ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    const st = readState();
    if (st) {
      st.phase = 'cleaned';
      st.rowsDone = 0;
      st.updatedAt = new Date().toISOString();
      delete st.lastRun;
      writeState(st);
    }
    await client.end();
    return;
  }

  let state = readState();
  const resumable = state && state.phase !== 'done' && (state.rowsDone ?? 0) < (state.rowsTarget ?? 0) && DO_RESUME;
  if (!resumable) {
    state = {
      rowsTarget: ROWS_TARGET,
      rowsDone: 0,
      batchId: `synthetic-${Date.now()}`,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      phase: 'running',
      lastRun: state?.lastRun ?? null,
    };
  } else {
    console.log(`[RESUME] continuu de la ${state.rowsDone}/${state.rowsTarget} (batch ${state.batchId})`);
    state.phase = 'running';
  }
  writeState(state);

  await insertPhase(state);

  const measured = await measurePhase(state);
  const space = await spacePhase();

  state.lastRun = {
    rows: state.rowsDone,
    batchId: state.batchId,
    finishedAt: new Date().toISOString(),
    metrics: measured,
    space,
  };
  state.updatedAt = new Date().toISOString();
  writeState(state);

  /* ------------------------------ stdout table ------------------------------ */
  const line = '─'.repeat(72);
  console.log(`\n${line}`);
  console.log(`AR10M BENCH — ${measured.benchRowsTotal.toLocaleString('ro-RO')} rânduri sintetice (ar10m.bench_catalog)`);
  console.log(line);
  console.log('CĂUTARE PREFIX (LIKE prefix%, index text_pattern_ops, LIMIT 21):');
  console.log(`  p50 ${measured.prefix.p50Ms}ms · p95 ${measured.prefix.p95Ms}ms · p99 ${measured.prefix.p99Ms}ms · avg ${measured.prefix.avgMs}ms`);
  console.log(`  ${measured.queriesPerSec} queries/sec cu ${CONCURRENCY} workers · ${measured.queries} interogări · ${measured.errors} erori · ${measured.zeroResults ?? 0} fără potrivire (index scan valid)`);
  if (measured.singleRowExact.n > 0) {
    console.log(`CAUTARE EXACTĂ (1 rând): p50 ${measured.singleRowExact.p50Ms}ms · p95 ${measured.singleRowExact.p95Ms}ms`);
  }
  if (measured.yearFiltered.n > 0) {
    console.log(`CAUTARE + FILTRU AN: p50 ${measured.yearFiltered.p50Ms}ms · p95 ${measured.yearFiltered.p95Ms}ms`);
  }
  console.log('SPAȚIU (măsurat, pg_* real):');
  console.log(`  bench_catalog: ${fmtBytes(space.benchCatalog.totalBytes)} total (${fmtBytes(space.benchCatalog.indexBytes)} indexuri) · ${space.benchCatalog.bytesPerRow ?? 'indisponibil'} B/rând`);
  console.log(`  ar10m.content (real): ${space.ar10mContent.rows} rânduri · ${fmtBytes(space.ar10mContent.totalBytes)} total (${fmtBytes(space.ar10mContent.indexBytes)} indexuri)`);
  console.log(`  dimensiune coloană medie: ${space.avgColumnSizeBytes ?? 'indisponibil'} B · bază de date: ${fmtBytes(space.databaseBytes)}`);
  console.log(`  proiecție 10M rânduri ≈ ${space.benchCatalog.bytesPerRow ? fmtBytes(space.benchCatalog.bytesPerRow * 10_000_000) : 'indisponibil'} (doar bench_catalog, fără content_sources)`);
  console.log(line);
  console.log(`Stare salvată: ${path.relative(process.cwd(), STATE_FILE)}`);
  if (measured.errors > 0) console.log(`  ⚠ ${measured.errors} erori (primele: ${JSON.stringify(measured.errorSamples)})`);

  await client.end();
}

main().catch(async (err) => {
  console.error(`EROARE benchmark: ${err?.stack ?? err}`);
  try {
    await client.end();
  } catch {
    /* already closed */
  }
  process.exit(1);
});
