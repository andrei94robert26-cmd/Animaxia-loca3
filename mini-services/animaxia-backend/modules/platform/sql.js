import { query, queryOnShard } from '../../db.js';

export async function rows(text, params = []) {
  const result = await query(text, params);
  return result.rows ?? [];
}

export async function one(text, params = []) {
  const result = await query(text, params);
  return result.rows?.[0] ?? null;
}

export function jsonb(value) {
  return JSON.stringify(value ?? {});
}

export function parseJsonb(value, fallback = {}) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function isoOrNull(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export async function rowsOnShard(shardId, text, params = []) {
  const result = await queryOnShard(shardId, text, params);
  return result.rows ?? [];
}

export async function oneOnShard(shardId, text, params = []) {
  const result = await queryOnShard(shardId, text, params);
  return result.rows?.[0] ?? null;
}
