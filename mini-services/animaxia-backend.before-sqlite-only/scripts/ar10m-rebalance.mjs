#!/usr/bin/env node
/**
 * scripts/ar10m-rebalance.mjs — AR10M shard rebalance tool (Task AR10M-2-BE).
 * MANUAL, documented, idempotent, checkpointed — never run by the server.
 *
 *   node scripts/ar10m-rebalance.mjs --status          (honest report, no moves)
 *   node scripts/ar10m-rebalance.mjs                   (rebalance all slots)
 *   node scripts/ar10m-rebalance.mjs --slot 3          (only ANIMAXIA_DB_03)
 *
 * What it does: for every logical shard s that has a DEDICATED physical DB
 * configured (env ANIMAXIA_DB_(s+1), slots 2..15 — slot 1 IS the primary),
 * it moves the ar10m.content rows with shard_id = s from the PRIMARY to the
 * dedicated DB:
 *   1. ensure the full ar10m schema on the target (idempotent DDL),
 *   2. copy the referenced ar10m.content_sources rows (explicit ids,
 *      ON CONFLICT (id) DO NOTHING — shared sources stay on primary too),
 *   3. copy content rows (explicit ids, ON CONFLICT (id) DO NOTHING),
 *   4. VERIFY the target count for the batch, then DELETE from primary
 *      (guarded by shard_id — never deletes a wrong row),
 *   5. checkpoint after every batch (data/ar10m-rebalance-state.json),
 *      200ms Neon-friendly pause between batches of 2000,
 *   6. fix the content_sources sequence on the target after the shard lands.
 *
 * If NO dedicated DB is configured, it prints an honest status and exits 0 —
 * today (single primary) there is nothing to rebalance by design.
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { ensureAr10mSchema } from '../modules/ar10m/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(BACKEND_ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'ar10m-rebalance-state.json');

const BATCH_ROWS = 2_000;
const PAUSE_MS = 200;

/* ----------------------------------- env ------------------------------------ */

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

const envName = (slot) => `ANIMAXIA_DB_${String(slot).padStart(2, '0')}`;
const connForSlot = (slot) => (process.env[envName(slot)] || '').trim() || null;
const PRIMARY_CONN = connForSlot(1) || (process.env.DATABASEURL || '').trim() || null;

const args = process.argv.slice(2);
const ONLY_STATUS = args.includes('--status');
const slotArgIdx = args.indexOf('--slot');
const ONLY_SLOT = slotArgIdx !== -1 ? parseInt(args[slotArgIdx + 1], 10) : null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Dedicated slots 2..15 (slot 1 is the primary itself). */
const dedicatedSlots = [];
for (let slot = 2; slot <= 15; slot += 1) {
  if (connForSlot(slot)) dedicatedSlots.push(slot);
}

function maskHost(connStr) {
  try {
    const host = new URL(connStr).hostname.toLowerCase();
    const labels = host.split('.');
    if (labels.length < 2) return '****';
    const first = labels[0];
    const prefix = first.includes('-') ? first.slice(0, first.indexOf('-') + 1) : '';
    return `${prefix}****.${labels.slice(1).join('.')}`;
  } catch {
    return 'necunoscut';
  }
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { perSlot: {} };
  }
}

function writeState(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

/* ---------------------------------- clients ---------------------------------- */

function makeClient(connStr, label) {
  const c = new pg.Client({
    connectionString: connStr,
    ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
  });
  c.__label = label;
  return c;
}

/* ------------------------------- the mover core -------------------------------- */

const CONTENT_COLS = 'id, title, normalized_title, year, source_id, shard_id, created_at, updated_at';
const SOURCE_COLS = 'id, source_type, source_url, embed_code, source_hash, created_at';

/**
 * Move all rows of one logical shard from primary to the dedicated target.
 * Batch-by-batch with verification + checkpoint (persisted per batch via
 * onBatch); returns { moved, batches, complete, error? }.
 */
async function moveShard(primary, target, logicalShard, checkpoint, onBatch) {
  let moved = checkpoint.moved ?? 0;
  let lastId = checkpoint.lastId ?? 0;
  let batches = checkpoint.batches ?? 0;

  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- batches are intentionally sequential
    const rows = (await primary.query(
      `SELECT ${CONTENT_COLS} FROM ar10m.content WHERE shard_id = $1 AND id > $2 ORDER BY id ASC LIMIT ${BATCH_ROWS}`,
      [logicalShard, lastId],
    )).rows;
    if (rows.length === 0) return { moved, batches, complete: true };

    const ids = rows.map((r) => Number(r.id));

    // 1. Copy referenced sources (explicit ids — target ids must match).
    const sourceIds = [...new Set(rows.map((r) => r.source_id).filter((v) => v !== null && v !== undefined))];
    if (sourceIds.length > 0) {
      const sources = (await primary.query(`SELECT ${SOURCE_COLS} FROM ar10m.content_sources WHERE id = ANY($1::int[])`, [sourceIds])).rows;
      if (sources.length > 0) {
        const sParams = [];
        const sValues = sources.map((s) => {
          sParams.push(s.id, s.source_type, s.source_url, s.embed_code, s.source_hash, s.created_at);
          const base = sParams.length - 6;
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
        });
        await target.query(
          `INSERT INTO ar10m.content_sources (${SOURCE_COLS}) VALUES ${sValues.join(',')} ON CONFLICT (id) DO NOTHING`,
          sParams,
        );
      }
    }

    // 2. Copy content rows.
    const cParams = [];
    const cValues = rows.map((r) => {
      cParams.push(r.id, r.title, r.normalized_title, r.year, r.source_id, r.shard_id, r.created_at, r.updated_at);
      const base = cParams.length - 8;
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`;
    });
    await target.query(
      `INSERT INTO ar10m.content (${CONTENT_COLS}) VALUES ${cValues.join(',')} ON CONFLICT (id) DO NOTHING`,
      cParams,
    );

    // 3. VERIFY before deleting anything from the primary.
    const verify = Number(
      (await target.query('SELECT COUNT(*)::int AS n FROM ar10m.content WHERE id = ANY($1::int[])', [ids])).rows[0]?.n ?? 0,
    );
    if (verify !== ids.length) {
      return { moved, batches, complete: false, error: `verificare eșuată: ${verify}/${ids.length} rânduri pe țintă — batch oprit, nimic șters` };
    }

    // 4. Delete from primary — guarded by shard_id.
    await primary.query('DELETE FROM ar10m.content WHERE shard_id = $1 AND id = ANY($2::int[])', [logicalShard, ids]);

    lastId = ids[ids.length - 1];
    moved += rows.length;
    batches += 1;
    checkpoint.lastId = lastId;
    checkpoint.moved = moved;
    checkpoint.batches = batches;
    checkpoint.updatedAt = new Date().toISOString();
    if (onBatch) onBatch();
    // eslint-disable-next-line no-await-in-loop
    await sleep(PAUSE_MS);
  }
}

/* ------------------------------------ main ------------------------------------- */

async function main() {
  console.log('AR10M rebalance — mută rândurile shard-urilor logice cu DB dedicat (ANIMAXIA_DB_02..15)');

  if (!PRIMARY_CONN) {
    console.error('EROARE: niciun primary (ANIMAXIA_DB_01 sau DATABASEURL lipsește).');
    process.exit(1);
  }
  console.log(`primary: ${maskHost(PRIMARY_CONN)} (${connForSlot(1) ? envName(1) : 'DATABASEURL'})`);

  if (dedicatedSlots.length === 0) {
    console.log('\nSTATUS: zero DB-uri dedicate configurate (ANIMAXIA_DB_02..15 goale).');
    console.log('Toate cele 15 shard-uri logice stau fizic pe primary — BY DESIGN (extensie graduală).');
    console.log('Când adaugi ANIMAXIA_DB_02..15 în .env, rulează din nou acest script.');
    return;
  }

  const targets = dedicatedSlots
    .filter((slot) => ONLY_SLOT === null || slot === ONLY_SLOT)
    .map((slot) => ({ slot, logicalShard: slot - 1, conn: connForSlot(slot) }));
  if (targets.length === 0) {
    console.error(`EROARE: --slot ${ONLY_SLOT} nu are DB dedicat configurat.`);
    process.exit(1);
  }

  if (ONLY_STATUS) {
    const primary = makeClient(PRIMARY_CONN, 'primary');
    await primary.connect();
    console.log('\n[STATUS] distribuție pe primary (ar10m.content):');
    const dist = (await primary.query('SELECT shard_id, COUNT(*)::int AS rows FROM ar10m.content GROUP BY shard_id ORDER BY shard_id')).rows;
    const byShard = new Map(dist.map((r) => [Number(r.shard_id), Number(r.rows)]));
    for (const t of targets) {
      console.log(`  shard logic ${t.logicalShard} → ${envName(t.slot)} (${maskHost(t.conn)}): ${byShard.get(t.logicalShard) ?? 0} rânduri de mutat`);
    }
    await primary.end();
    return;
  }

  const state = readState();
  state.perSlot = state.perSlot ?? {};
  const primary = makeClient(PRIMARY_CONN, 'primary');
  await primary.connect();

  let totalMoved = 0;
  for (const t of targets) {
    const checkpoint = state.perSlot[t.slot] ?? { moved: 0, lastId: 0, batches: 0 };
    state.perSlot[t.slot] = checkpoint;
    console.log(`\n[REBALANCE] shard logic ${t.logicalShard} → ${envName(t.slot)} (${maskHost(t.conn)})`);

    const target = makeClient(t.conn, envName(t.slot));
    try {
      await target.connect();
      const ensure = await ensureAr10mSchema(async (text, params) => target.query(text, params));
      if (!ensure.ok) throw new Error(`schema ensure: ${JSON.stringify(ensure.errors)}`);

      const t0 = Date.now();
      const result = await moveShard(primary, target, t.logicalShard, checkpoint, () => writeState(state));
      totalMoved += result.moved;

      if (result.error) {
        console.log(`  OPRIT: ${result.error} (mutate ${result.moved} — relansez pentru continuare de la checkpoint)`);
      } else {
        // Fix the sources sequence on the target so future local inserts work.
        await target.query(
          `SELECT setval(pg_get_serial_sequence('ar10m.content_sources', 'id'),
                         GREATEST((SELECT COALESCE(MAX(id), 1) FROM ar10m.content_sources), 1))`,
        );
        console.log(`  GATA: ${result.moved} rânduri mutate în ${result.batches} batch-uri, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        checkpoint.complete = true;
      }
    } catch (err) {
      console.error(`  EROARE: ${err?.message ?? err} (checkpoint păstrat — rulează din nou)`);
    } finally {
      await target.end().catch(() => {});
      checkpoint.updatedAt = new Date().toISOString();
      writeState(state);
    }
  }

  await primary.end();
  console.log(`\nREZUMAT: ${totalMoved} rânduri mutate. Stare: ${path.relative(process.cwd(), STATE_FILE)}`);
  console.log('Notă: sursele partajate rămân și pe primary (copiate, nu mutate) — dedupe prin source_hash.');
}

main().catch((err) => {
  console.error(`EROARE rebalance: ${err?.stack ?? err}`);
  process.exit(1);
});
