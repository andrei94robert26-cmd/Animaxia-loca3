/**
 * scripts/ar10m-setup.mjs — AR10M one-time (idempotent) setup:
 *   1. ensure schema `ar10m` + minimal tables (content, content_sources, bench_catalog) + indexes
 *   2. add normalized_title column to LEGACY public.content (additive only) + text_pattern_ops index
 *   3. backfill legacy normalized_title in JS batches (normalizeTitle from modules/ar10m/normalize.js)
 *   4. seed REAL playable items (Blender open movies + platform demo sources) into ar10m.content
 *      with deduped ar10m.content_sources rows (UNIQUE source_hash)
 * Run manually: `bun scripts/ar10m-setup.mjs` (reads .env DATABASEURL).
 * ZERO polling, ZERO cron — this is a one-shot migration script.
 */
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AR10M_DDL } from '../modules/ar10m/schema.js';
import { normalizeTitle, computeShardId, normalizeYear } from '../modules/ar10m/normalize.js';
import { detectSourceType, sourceHash } from '../modules/ar10m/allowlist.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

/* tiny .env parser (no dep) */
function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}
loadEnv();

const DATABASEURL = process.env.DATABASEURL;
if (!DATABASEURL) { console.error('DATABASEURL missing'); process.exit(1); }

const pool = new pg.Pool({
  connectionString: DATABASEURL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : { rejectUnauthorized: false },
  max: 3, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 10_000,
});
const q = (text, params = []) => pool.query(text, params);

/* ── 1. ar10m schema (idempotent) ───────────────────────────────── */
let applied = 0, errors = 0;
for (const stmt of AR10M_DDL) {
  try { await q(stmt); applied++; }
  catch (err) { errors++; console.error('DDL FAIL:', err.message, '| stmt:', stmt.slice(0, 80)); }
}
console.log(`[1] ar10m schema: ${applied} applied, ${errors} errors`);

/* ── 2. legacy normalized_title (additive) ──────────────────────── */
await q('ALTER TABLE public.content ADD COLUMN IF NOT EXISTS normalized_title TEXT');
const missing = await q("SELECT id, title FROM public.content WHERE normalized_title IS NULL ORDER BY id");
console.log(`[2] legacy rows needing normalized_title: ${missing.rows.length}`);
const BATCH = 500;
for (let i = 0; i < missing.rows.length; i += BATCH) {
  const slice = missing.rows.slice(i, i + BATCH);
  const cs = [];
  const ps = [];
  slice.forEach((r, j) => {
    cs.push(`($${j * 2 + 1}::int, $${j * 2 + 2})`);
    ps.push(r.id, normalizeTitle(r.title || ''));
  });
  await q(`UPDATE public.content SET normalized_title = v.nt FROM (VALUES ${cs.join(',')}) AS v(id, nt) WHERE public.content.id = v.id`, ps);
  process.stdout.write(`  backfill ${Math.min(i + BATCH, missing.rows.length)}/${missing.rows.length}\r`);
}
console.log('');
await q('CREATE INDEX IF NOT EXISTS idx_content_ntitle_prefix ON public.content (normalized_title text_pattern_ops)');
await q('CREATE INDEX IF NOT EXISTS idx_content_ntitle_year ON public.content (normalized_title, id)');
console.log('[2] legacy normalized_title backfilled + prefix indexes created');

/* ── 3. seed REAL playable items ────────────────────────────────── */
/* Real sources the platform legitimately uses (Blender open movies —
 * Creative Commons; Google sample CDN; W3C/Apple HLS test streams). */
const REAL_ITEMS = [
  { title: 'Big Buck Bunny', year: 2008, sources: [
    { type: 'direct_url', url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4' },
    { type: 'direct_url', url: 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_720_10s_1MB.mp4' },
  ]},
  { title: 'Sintel', year: 2010, sources: [
    { type: 'direct_url', url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4' },
    { type: 'hls', url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8' },
  ]},
  { title: 'Elephants Dream', year: 2006, sources: [
    { type: 'direct_url', url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4' },
  ]},
  { title: 'Tears of Steel', year: 2012, sources: [
    { type: 'direct_url', url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4' },
  ]},
  { title: 'For Bigger Blazes', year: 2013, sources: [
    { type: 'direct_url', url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4' },
  ]},
  { title: 'For Bigger Escapes', year: 2013, sources: [
    { type: 'direct_url', url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4' },
  ]},
  { title: 'For Bigger Fun', year: 2013, sources: [
    { type: 'direct_url', url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerFun.mp4' },
  ]},
  { title: 'For Bigger Joyrides', year: 2013, sources: [
    { type: 'direct_url', url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyrides.mp4' },
  ]},
  { title: 'For Bigger Meltdowns', year: 2013, sources: [
    { type: 'direct_url', url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerMeltdowns.mp4' },
  ]},
  { title: 'Subaru Outback On Street And Dirt', year: 2013, sources: [
    { type: 'direct_url', url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/SubaruOutbackOnStreetAndDirt.mp4' },
  ]},
  { title: 'Volkswagen GTI Review', year: 2013, sources: [
    { type: 'direct_url', url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/VolkswagenGTIReview.mp4' },
  ]},
  { title: 'We Are Going On Bullrun', year: 2013, sources: [
    { type: 'direct_url', url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/WeAreGoingOnBullrun.mp4' },
  ]},
  { title: 'What Car Can You Get For A Grand', year: 2013, sources: [
    { type: 'direct_url', url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/WhatCarCanYouGetForAGrand.mp4' },
  ]},
  { title: 'Apple Basic Stream Demo HLS', year: 2019, sources: [
    { type: 'hls', url: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_ts/master.m3u8' },
  ]},
  { title: 'Mux Test Stream HLS', year: 2020, sources: [
    { type: 'hls', url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8' },
  ]},
  { title: 'Big Buck Bunny HLS', year: 2008, sources: [
    { type: 'hls', url: 'https://test-streams.mux.dev/pts_shift/master.m3u8' },
  ]},
];

async function ensureSource(src) {
  const detected = detectSourceType(src.url);
  if (!detected) { console.warn('  SKIP not-allowlisted:', src.url); return null; }
  const hash = sourceHash(detected.sourceType, detected.normalizedUrl);
  const existing = await q('SELECT id FROM ar10m.content_sources WHERE source_hash = $1', [hash]);
  if (existing.rows.length) return existing.rows[0].id;
  const ins = await q(
    'INSERT INTO ar10m.content_sources (source_type, source_url, source_hash) VALUES ($1,$2,$3) ON CONFLICT (source_hash) DO UPDATE SET source_url = EXCLUDED.source_url RETURNING id',
    [detected.sourceType, detected.normalizedUrl, hash],
  );
  return ins.rows[0].id;
}

let seededTitles = 0, seededSources = 0;
for (const item of REAL_ITEMS) {
  const nt = normalizeTitle(item.title);
  const yr = normalizeYear(item.year);
  if (!nt) continue;
  // reuse legacy id when the same title+year exists in legacy catalog (1:1 navigation)
  const legacy = await q(
    'SELECT id FROM public.content WHERE normalized_title = $1 AND substring(metadata->>\'year\' from \'^[0-9]{4}\') = $2::text LIMIT 1',
    [nt, String(yr)],
  );
  const legacyByTitle = legacy.rows.length ? legacy.rows : (
    await q('SELECT id FROM public.content WHERE normalized_title = $1 LIMIT 1', [nt])
  ).rows;
  // deterministic: reuse existing ar10m id for the same title+year (idempotent re-runs)
  const existingAr10m = (await q(
    'SELECT id FROM ar10m.content WHERE normalized_title = $1 AND year IS NOT DISTINCT FROM $2 LIMIT 1',
    [nt, yr],
  )).rows;
  let id;
  if (existingAr10m.length) {
    id = existingAr10m[0].id;
  } else if (legacyByTitle.length) {
    id = legacyByTitle[0].id; // 1:1 with legacy → UI navigation works
  } else {
    // non-legacy real items get explicit ids from a dedicated high range (1_000_000+)
    const maxId = await q('SELECT COALESCE(MAX(id), 999999)::int AS m FROM ar10m.content WHERE id >= 1000000');
    id = Math.max(maxId.rows[0].m, 999999) + 1;
  }
  const shard = computeShardId(item.title, yr);
  let sourceId = null;
  for (const src of item.sources) {
    const sid = await ensureSource(src);
    if (sid) { seededSources++; if (sourceId === null) sourceId = sid; }
  }
  await q(
    `INSERT INTO ar10m.content (id, title, normalized_title, year, source_id, shard_id)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, source_id = EXCLUDED.source_id, updated_at = NOW()`,
    [id, item.title, nt, yr, sourceId, shard],
  );
  seededTitles++;
}
console.log(`[3] seeded REAL items: ${seededTitles} titles, ${seededSources} source rows`);

/* ── 4. verify ──────────────────────────────────────────────────── */
const stats = await q(`SELECT
  (SELECT COUNT(*)::int FROM ar10m.content) AS content,
  (SELECT COUNT(*)::int FROM ar10m.content_sources) AS sources,
  (SELECT COUNT(*)::int FROM public.content WHERE normalized_title IS NOT NULL) AS legacy_normalized`);
const dist = await q('SELECT shard_id, COUNT(*)::int n FROM ar10m.content GROUP BY shard_id ORDER BY shard_id');
console.log('[4] VERIFY:', JSON.stringify(stats.rows[0]));
console.log('    distribution:', dist.rows.map(r => `S${r.shard_id}=${r.n}`).join(' '));
console.log('    unique hashes:', (await q('SELECT COUNT(DISTINCT source_hash)::int n FROM ar10m.content_sources')).rows[0].n, '/', stats.rows[0].sources);

await pool.end();
console.log('DONE — ar10m setup complete (idempotent, safe to re-run).');
