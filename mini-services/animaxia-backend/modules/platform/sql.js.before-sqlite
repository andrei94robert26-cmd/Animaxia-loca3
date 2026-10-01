/**
 * modules/platform/sql.js — Shared SQL helpers for the platform modules.
 * Thin wrappers around the unified data layer's generic `query()` with row
 * helpers and JSONB (de)serialization matching the house column style
 * (lowercase, no underscores).
 */

import { query, queryOnShard, driverInfo } from '../../db.js'; // queryOnShard added in FAZA 13 (sharding)

/** Throw a 503 when the PostgreSQL driver is inactive (local fallback mode). */
export function assertPostgres() {
  const info = driverInfo();
  if (!info.connected) {
    const err = new Error('This module requires the PostgreSQL driver — the backend is currently on the local fallback store');
    err.status = 503;
    throw err;
  }
}

/** Run a query and return all rows. */
export async function rows(text, params = []) {
  const res = await query(text, params);
  return res.rows ?? [];
}

/** Run a query and return the first row (or null). */
export async function one(text, params = []) {
  const res = await query(text, params);
  return res.rows?.[0] ?? null;
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
