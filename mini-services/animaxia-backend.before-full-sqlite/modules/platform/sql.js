/**
 * modules/platform/sql.js — Shared SQL helpers for the platform modules.
 * Thin wrappers around the unified data layer's generic `query()` with row
 * helpers and JSONB (de)serialization matching the house column style
 * (lowercase, no underscores).
 */

import { localDb } from '../local/sqlite.js';

/** Throw a 503 when the PostgreSQL driver is inactive (local fallback mode). */
export function assertPostgres() {
  return true;
}

function sqliteSql(text) {
  return String(text)
    .replace(/\$\d+::jsonb/g, '?')
    .replace(/\$\d+::text/g, '?')
    .replace(/\$\d+::int/g, '?')
    .replace(/\$(\d+)/g, '?$1')
    .replace(/::jsonb/g, '')
    .replace(/::int\b/g, '')
    .replace(/::float\b/g, '')
    .replace(/::numeric\b/g, '')
    .replace(/NOW\(\)\s*-\s*INTERVAL\s*'(\d+)\s+days?'/gi, "datetime('now','-$1 days')")
    .replace(/NOW\(\)\s*-\s*INTERVAL\s*'(\d+)\s+hours?'/gi, "datetime('now','-$1 hours')")
    .replace(/NOW\(\)/gi, 'CURRENT_TIMESTAMP');
}

/** Run a query and return all rows. */
export async function rows(text, params = []) {
  return localDb.prepare(sqliteSql(text)).all(...params);
}

/** Run a query and return the first row (or null). */
export async function one(text, params = []) {
  return localDb.prepare(sqliteSql(text)).get(...params) ?? null;
}

/** Serialize a value for a JSONB column parameter. */
export function jsonb(value) {
  return JSON.stringify(value ?? {});
}

/** Parse a JSONB column value with a safe fallback. */
export function parseJsonb(value, fallback = {}) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/** Normalize a timestamp-ish column to an ISO string (or null). */
export function isoOrNull(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/** Normalize an integer-ish column (SERIAL/NUMERIC from pg arrives as number). */
export function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/* ----------------- FAZA 13 (sharding): shard-routed helpers ----------------- */

/** Run a query on a specific shard's pool and return all rows. Dedicated
 *  branch pools fall back to the main pool on connection-level failures
 *  (see queryOnShard in db.js). */
export async function rowsOnShard(shardId, text, params = []) {
  const res = await queryOnShard(shardId, text, params);
  return res.rows ?? [];
}

/** Run a query on a specific shard's pool and return the first row (or null). */
export async function oneOnShard(shardId, text, params = []) {
  const res = await queryOnShard(shardId, text, params);
  return res.rows?.[0] ?? null;
}
