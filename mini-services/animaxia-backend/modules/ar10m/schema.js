/**
 * modules/ar10m/schema.js — AR10M DDL + idempotent ensure (Task AR10M-2-BE).
 *
 * The AR10M real catalog lives in a DEDICATED Postgres schema `ar10m`:
 *   • ar10m.content          — the real, minimal, playable catalog (INTEGER id
 *                              so migration can preserve legacy public.content
 *                              ids — the UI navigates by the same id).
 *   • ar10m.content_sources  — validated playable sources (type/url/embed,
 *                              deduped by source_hash).
 *   • ar10m.bench_catalog    — SYNTHETIC benchmark rows (synthetic = TRUE,
 *                              batch_id prefix 'synthetic-'). Never counted
 *                              in /stats titles and never searched.
 * Legacy tables in schema `public` stay UNTOUCHED (they feed the existing UI).
 *
 * AR10M_DDL is exported as an ARRAY of individual statements (no naive
 * split-on-';' needed — each entry is one idempotent statement).
 * ensureAr10mSchema(queryFn) runs them one by one with logging and NEVER
 * throws fatally: it returns { ok, applied, errors } so the caller (admin
 * endpoint / orchestrator bootstrap) can report honestly.
 */

import { logger } from '../../utils/logger.js';

/**
 * Idempotent DDL for the ar10m schema — every statement is IF NOT EXISTS.
 * Statement order matters (schema → sources → content → indexes → bench).
 */
export const AR10M_DDL = [
  `CREATE SCHEMA IF NOT EXISTS ar10m`,

  `CREATE TABLE IF NOT EXISTS ar10m.content_sources (
  id SERIAL PRIMARY KEY,
  source_type TEXT NOT NULL CHECK (source_type IN ('direct_url','youtube','rumble','iframe','embed','hls')),
  source_url TEXT NOT NULL,
  embed_code TEXT,
  source_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
)`,

  `CREATE TABLE IF NOT EXISTS ar10m.content (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  normalized_title TEXT NOT NULL,
  year INTEGER,
  source_id INTEGER REFERENCES ar10m.content_sources(id) ON DELETE SET NULL,
  shard_id SMALLINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
)`,

  `CREATE INDEX IF NOT EXISTS idx_ar10m_ntitle_prefix ON ar10m.content (normalized_title text_pattern_ops)`,

  `CREATE INDEX IF NOT EXISTS idx_ar10m_year ON ar10m.content (year)`,

  `CREATE INDEX IF NOT EXISTS idx_ar10m_ntitle_year ON ar10m.content (normalized_title, year)`,

  `CREATE INDEX IF NOT EXISTS idx_ar10m_shard ON ar10m.content (shard_id)`,

  `CREATE INDEX IF NOT EXISTS idx_ar10m_source ON ar10m.content (source_id)`,

  `CREATE TABLE IF NOT EXISTS ar10m.bench_catalog (
  id SERIAL PRIMARY KEY,
  batch_id TEXT NOT NULL,
  normalized_title TEXT NOT NULL,
  year INTEGER,
  shard_id SMALLINT NOT NULL,
  synthetic BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
)`,

  `CREATE INDEX IF NOT EXISTS idx_ar10m_bench_ntitle ON ar10m.bench_catalog (normalized_title text_pattern_ops)`,
];

/** The DDL as a single SQL string (for display/admin tooling only). */
export const AR10M_DDL_SQL = AR10M_DDL.map((s) => `${s};`).join('\n\n');

/**
 * Run every DDL statement idempotently through the provided queryFn
 * (text, params) — the orchestrator passes the shard router's primaryQuery.
 * Never throws: returns { ok, applied, errors }.
 */
export async function ensureAr10mSchema(queryFn) {
  const applied = [];
  const errors = [];
  for (const stmt of AR10M_DDL) {
    const label = stmt.split('\n')[0].slice(0, 72);
    try {
      await queryFn(stmt, []);
      applied.push(label);
    } catch (err) {
      // Idempotent DDL: only real failures (permissions, connectivity) land here.
      errors.push({ statement: label, error: err?.message ?? String(err) });
      logger.warn(`[ar10m/schema] DDL statement failed: ${label} — ${err?.message ?? err}`);
    }
  }
  const ok = errors.length === 0;
  if (ok) logger.info(`[ar10m/schema] ensured — ${applied.length} statements applied (idempotent)`);
  else logger.warn(`[ar10m/schema] ensure finished with ${errors.length} error(s)`);
  return { ok, applied, errors };
}
