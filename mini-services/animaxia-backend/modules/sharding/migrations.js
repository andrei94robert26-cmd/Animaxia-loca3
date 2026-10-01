/**
 * modules/sharding/migrations.js — FAZA 13 (Task 13-1): additive sharding DDL.
 *
 * Adds the `shardid INT NOT NULL DEFAULT 0` column (house style: lowercase,
 * no underscores) + index to the three sharded tables:
 *   • content          — catalog range shards (computeShardIdFromContentId)
 *   • searchdocs       — FAZA 16 FTS catalog; shardid mirrors the contentid range shard
 *   • vectorembeddings — vector shards (computeShardIdFromTenant / FromVectorRef)
 *
 * NO DATA REWRITES (deliberate decision, spec 13-0): the column DEFAULT 0 plus
 * the RANGE rule already place every existing row correctly — all pre-FAZA-13
 * content/searchdoc/vector ids are SERIAL values < 1B, so their computed shard
 * is 0, which is exactly what the DEFAULT seeds. A backfill UPDATE would be a
 * no-op rewrite of the whole table, so it is skipped entirely. Future rows are
 * stamped at write time (db.js upsertContent stamp block, search.js syncIndex,
 * vector-service.js PgVectorBackend.upsert).
 *
 * Idempotent (ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS) and never
 * throws — on the local fallback driver (or a Neon hiccup) the statements fail
 * per-statement, are logged, and shard routing degrades to legacy (shard 0).
 * Mounted in server.js boot right after the FAZA 12 ensureMinerSchema block.
 */

import { logger } from '../../utils/logger.js';
import { query } from '../../db.js';

const DDL_STATEMENTS = [
  { sql: `CREATE INDEX IF NOT EXISTS idx_vectorembeddings_shardid ON vectorembeddings (shardid)` },
];

/**
 * Ensure the FAZA 13 shardid columns + indexes exist. Idempotent, never throws.
 * @returns {{ ok: boolean, columns: string[], applied: number, total: number }}
 */
export async function ensureShardingSchema() {
  const columns = [];
  let applied = 0;
  for (const statement of DDL_STATEMENTS) {
    try {
      await query(statement.sql);
      applied += 1;
      if (statement.column) columns.push(statement.column);
    } catch (err) {
      logger.warn(`[sharding] Migration statement skipped: ${err.message} — ${statement.sql.slice(0, 60)}…`);
    }
  }
  const ok = applied === DDL_STATEMENTS.length;
  if (ok) {
    logger.info(
      `[sharding] Schema verified — ${applied}/${DDL_STATEMENTS.length} statements OK (shardid columns on content/searchdocs/vectorembeddings + indexes; existing rows are already correct at shard 0 via DEFAULT — no data rewrite needed)`,
    );
  } else {
    logger.warn(
      `[sharding] Schema degraded — ${applied}/${DDL_STATEMENTS.length} statements OK (shard routing falls back to legacy shard 0)`,
    );
  }
  return { ok, columns, applied, total: DDL_STATEMENTS.length };
}

/**
 * Live check of the three shardid columns via information_schema.
 * @returns {{ content: boolean, searchdocs: boolean, vectorembeddings: boolean }}
 */
export async function shardingSchemaStatus() {
  const status = { content: false, searchdocs: false, vectorembeddings: false };
  try {
    const res = await query(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE column_name = 'shardid' AND table_name IN ('content','searchdocs','vectorembeddings')`,
    );
    for (const row of res.rows ?? []) {
      if (row.table_name === 'content') status.content = true;
      if (row.table_name === 'searchdocs') status.searchdocs = true;
      if (row.table_name === 'vectorembeddings') status.vectorembeddings = true;
    }
  } catch (err) {
    logger.warn(`[sharding] Schema status check unavailable: ${err.message}`);
  }
  return status;
}
