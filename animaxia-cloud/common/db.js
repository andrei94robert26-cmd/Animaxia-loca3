/**
 * common/db.js — Unified async data layer (ported from the Animaxia monolith):
 * Neon PostgreSQL first, with automatic local JSON-file fallback
 * (LOCALDATADIR/content.json, default ./data) when Postgres is unreachable.
 * Includes a 60s reconnect probe that migrates local rows back into Postgres.
 * All public methods return plain objects with `createdat` serialized as ISO.
 *
 * Every microservice instantiates its own pool via initDb() on boot; Neon's
 * pooler endpoint safely supports multiple small pools per deployment.
 */

import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';

const DATA_DIR = process.env.LOCALDATADIR
  ? path.resolve(process.env.LOCALDATADIR)
  : path.resolve('./data');
const LOCAL_FILE = path.join(DATA_DIR, 'content.json');

const DDL = `
CREATE TABLE IF NOT EXISTS content (
  id SERIAL PRIMARY KEY,
  externalid TEXT UNIQUE,
  type TEXT,
  title TEXT,
  metadata JSONB,
  thumbnail TEXT,
  createdat TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_content_type ON content (type);
CREATE INDEX IF NOT EXISTS idx_content_createdat ON content (createdat DESC);
`;

const UPSERT_SQL = `
INSERT INTO content (externalid, type, title, metadata, thumbnail)
VALUES ($1, $2, $3, $4::jsonb, $5)
ON CONFLICT (externalid) DO UPDATE
SET type = EXCLUDED.type,
    title = EXCLUDED.title,
    metadata = EXCLUDED.metadata,
    thumbnail = EXCLUDED.thumbnail
RETURNING *
`;

let pool = null;
let driver = null; // 'postgres' | 'local'
let lastError = null;
let reconnectTimer = null;
let localStore = null;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const t = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
      if (typeof t.unref === 'function') t.unref();
    }),
  ]);
}

function safeParseJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    externalid: row.externalid,
    type: row.type,
    title: row.title,
    metadata: safeParseJson(row.metadata, {}) ?? {},
    thumbnail: row.thumbnail === undefined ? null : row.thumbnail,
    createdat:
      row.createdat instanceof Date
        ? row.createdat.toISOString()
        : String(row.createdat ?? new Date().toISOString()),
  };
}

/** JSON-file backed store with identical query semantics to the SQL layer. */
class LocalStore {
  constructor(file) {
    this.file = file;
    this.rows = [];
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.rows = Array.isArray(parsed) ? parsed : [];
      }
    } catch (err) {
      logger.error(`[DB] Failed to read local store: ${err.message} — starting empty`);
      this.rows = [];
    }
  }

  persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.rows, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  nextId() {
    return this.rows.reduce((max, r) => Math.max(max, Number(r.id) || 0), 0) + 1;
  }

  all() {
    return this.rows;
  }

  list({ page = 1, limit = 20, type, search, sort = 'createdat' }) {
    let filtered = this.rows;
    if (type) filtered = filtered.filter((r) => r.type === type);
    if (search) {
      const needle = String(search).toLowerCase();
      filtered = filtered.filter((r) => String(r.title || '').toLowerCase().includes(needle));
    }
    const sorted = [...filtered].sort((a, b) => {
      if (sort === 'title') {
        return String(a.title || '').localeCompare(String(b.title || '')) || a.id - b.id;
      }
      const at = Date.parse(a.createdat) || 0;
      const bt = Date.parse(b.createdat) || 0;
      if (bt !== at) return bt - at;
      return b.id - a.id;
    });
    const total = sorted.length;
    const safeLimit = Math.min(100, Math.max(1, limit));
    const safePage = Math.max(1, page);
    const start = (safePage - 1) * safeLimit;
    return {
      data: sorted.slice(start, start + safeLimit).map(normalizeRow),
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.max(1, Math.ceil(total / safeLimit)),
    };
  }

  byId(id) {
    const numeric = Number(id);
    return this.rows.find((r) => Number(r.id) === numeric) || null;
  }

  byExternalId(externalid) {
    return this.rows.find((r) => r.externalid === externalid) || null;
  }

  upsert({ externalid, type, title, metadata, thumbnail }) {
    const existing = this.byExternalId(externalid);
    if (existing) {
      existing.type = type === undefined || type === null ? existing.type : type;
      existing.title = title ?? existing.title;
      existing.metadata = safeParseJson(metadata, {}) ?? {};
      existing.thumbnail = thumbnail === undefined ? existing.thumbnail : thumbnail;
      this.persist();
      return { record: normalizeRow(existing), created: false };
    }
    const row = {
      id: this.nextId(),
      externalid,
      type: type ?? null,
      title,
      metadata: safeParseJson(metadata, {}) ?? {},
      thumbnail: thumbnail ?? null,
      createdat: new Date().toISOString(),
    };
    this.rows.push(row);
    this.persist();
    return { record: normalizeRow(row), created: true };
  }

  remove(id) {
    const existing = this.byId(id);
    if (!existing) return null;
    this.rows = this.rows.filter((r) => r !== existing);
    this.persist();
    return normalizeRow(existing);
  }

  count() {
    return this.rows.length;
  }

  countsByType() {
    return this.rows.reduce((acc, r) => {
      const key = r.type || 'unknown';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
  }
}

async function q(text, params = []) {
  try {
    return await pool.query(text, params);
  } catch (err) {
    logger.error(`[DB] PostgreSQL query error: ${err.message}`);
    throw err;
  }
}

function stopReconnectProbe() {
  if (reconnectTimer) {
    clearInterval(reconnectTimer);
    reconnectTimer = null;
  }
}

/**
 * One-time migration of local-fallback rows into PostgreSQL (idempotent upserts).
 * After a successful migration the local file is archived as content.json.migrated
 * so subsequent boots do not repeat the work.
 */
async function migrateLocalToPostgres() {
  if (!fs.existsSync(LOCAL_FILE)) return 0;
  let rows = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(LOCAL_FILE, 'utf8'));
    rows = Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    logger.warn(`[DB] Local store unreadable, skipping migration: ${err.message}`);
    return 0;
  }
  if (!rows.length) return 0;
  let migrated = 0;
  for (const row of rows) {
    try {
      await q(UPSERT_SQL, [
        row.externalid,
        row.type ?? null,
        row.title ?? 'untitled',
        JSON.stringify(safeParseJson(row.metadata, {})),
        row.thumbnail ?? null,
      ]);
      migrated += 1;
    } catch (err) {
      logger.warn(`[DB] Migration skipped row ${row.externalid}: ${err.message}`);
    }
  }
  try {
    fs.renameSync(LOCAL_FILE, `${LOCAL_FILE}.migrated`);
  } catch (err) {
    logger.warn(`[DB] Could not archive local store: ${err.message}`);
  }
  logger.info(`[DB] Migrated ${migrated}/${rows.length} local rows into PostgreSQL`);
  return migrated;
}

function startReconnectProbe() {
  if (reconnectTimer || !pool) return;
  reconnectTimer = setInterval(async () => {
    if (driver !== 'local') {
      stopReconnectProbe();
      return;
    }
    try {
      await withTimeout(pool.query('SELECT 1'), 8000);
      await q(DDL);
      await migrateLocalToPostgres();
      driver = 'postgres';
      lastError = null;
      stopReconnectProbe();
      logger.info('[DB] Reconnected to PostgreSQL');
    } catch (err) {
      logger.debug(`[DB] Reconnect probe failed: ${err.message}`);
    }
  }, 60000);
  if (typeof reconnectTimer.unref === 'function') reconnectTimer.unref();
}

function switchToLocal(reason) {
  driver = 'local';
  if (!localStore) localStore = new LocalStore(LOCAL_FILE);
  startReconnectProbe();
  logger.warn(`[DB] Active driver: local fallback store (${LOCAL_FILE})${reason ? ` — ${reason}` : ''}`);
}

/**
 * Probe PostgreSQL and initialise the schema; on failure fall back to the
 * local JSON store and keep probing for reconnection every 60s.
 */
export async function initDb() {
  const databaseUrl = process.env.DATABASEURL;
  if (!databaseUrl) {
    lastError = 'DATABASEURL is not set';
    logger.error('[DB] PostgreSQL unavailable (DATABASEURL missing) — switching to local fallback store');
    switchToLocal();
    return driverInfo();
  }

  pool = new pg.Pool({
    connectionString: databaseUrl,
    ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
    max: parseInt(process.env.PGPOOLMAX || '10', 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 8000,
  });
  pool.on('error', (err) => logger.error(`[DB] idle client error: ${err.message}`));

  try {
    await withTimeout(pool.query('SELECT 1'), 8000);
    await q(DDL);
    // Adopt any rows written while running on the local fallback store.
    await migrateLocalToPostgres();
    driver = 'postgres';
    lastError = null;
    stopReconnectProbe();
    logger.info('[DB] Connected to PostgreSQL (Neon) — schema ready');
  } catch (err) {
    lastError = err.message;
    logger.error(`[DB] PostgreSQL unavailable (${err.message}) — switching to local fallback store`);
    switchToLocal();
  }
  return driverInfo();
}

export async function listContent({
  page = 1,
  limit = 20,
  type,
  search,
  sort = 'createdat',
} = {}) {
  const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const safePage = Math.max(1, parseInt(page, 10) || 1);

  if (driver === 'local') {
    return localStore.list({ page: safePage, limit: safeLimit, type, search, sort });
  }

  const clauses = [];
  const values = [];
  if (type) {
    values.push(type);
    clauses.push(`type = $${values.length}`);
  }
  if (search) {
    values.push(String(search));
    clauses.push(`title ILIKE '%' || $${values.length} || '%'`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const orderBy = sort === 'title' ? 'ORDER BY title ASC' : 'ORDER BY createdat DESC, id DESC';
  const offset = (safePage - 1) * safeLimit;

  const totalRes = await q(`SELECT COUNT(*)::int AS count FROM content ${where}`, values);
  const rowsRes = await q(
    `SELECT * FROM content ${where} ${orderBy} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, safeLimit, offset],
  );
  const total = totalRes.rows[0]?.count ?? 0;
  return {
    data: rowsRes.rows.map(normalizeRow),
    total,
    page: safePage,
    limit: safeLimit,
    totalPages: Math.max(1, Math.ceil(total / safeLimit)),
  };
}

export async function getContentById(id) {
  if (driver === 'local') return normalizeRow(localStore.byId(id));
  const res = await q('SELECT * FROM content WHERE id = $1', [Number(id)]);
  return normalizeRow(res.rows[0]);
}

export async function getContentByExternalId(externalid) {
  if (driver === 'local') return normalizeRow(localStore.byExternalId(externalid));
  const res = await q('SELECT * FROM content WHERE externalid = $1', [externalid]);
  return normalizeRow(res.rows[0]);
}

export async function upsertContent({ externalid, type, title, metadata, thumbnail }) {
  if (!externalid || !title) {
    throw new Error('upsertContent requires externalid and title');
  }
  if (driver === 'local') {
    return localStore.upsert({ externalid, type, title, metadata, thumbnail });
  }
  const existing = await getContentByExternalId(externalid);
  const res = await q(UPSERT_SQL, [
    externalid,
    type ?? null,
    title,
    JSON.stringify(safeParseJson(metadata, {})),
    thumbnail ?? null,
  ]);
  return { record: normalizeRow(res.rows[0]), created: !existing };
}

export async function deleteContent(id) {
  if (driver === 'local') return localStore.remove(id);
  const res = await q('DELETE FROM content WHERE id = $1 RETURNING *', [Number(id)]);
  return normalizeRow(res.rows[0]);
}

export async function countContent() {
  if (driver === 'local') return localStore.count();
  const res = await q('SELECT COUNT(*)::int AS count FROM content');
  return res.rows[0]?.count ?? 0;
}

export async function countsByType() {
  if (driver === 'local') return localStore.countsByType();
  const res = await q('SELECT type, COUNT(*)::int AS count FROM content GROUP BY type');
  return res.rows.reduce((acc, r) => {
    acc[r.type || 'unknown'] = r.count;
    return acc;
  }, {});
}

export function driverInfo() {
  return {
    driver: driver === 'postgres' ? 'postgres' : 'local-fallback',
    connected: driver === 'postgres',
    ...(driver !== 'postgres' && lastError ? { lastError } : {}),
  };
}

/**
 * Generic SQL query on the active PostgreSQL pool — used by the platform
 * modules (users, premium, social, ai, analytics, search, queue).
 * Throws a 503-tagged error when running on the local fallback store.
 */
export async function query(text, params = []) {
  if (driver !== 'postgres' || !pool) {
    const err = new Error('SQL layer unavailable — PostgreSQL driver inactive (local fallback store in use)');
    err.status = 503;
    throw err;
  }
  return q(text, params);
}

export async function ping() {
  if (driver === 'postgres') {
    try {
      await withTimeout(pool.query('SELECT 1'), 3000);
      return true;
    } catch {
      return false;
    }
  }
  return true;
}

export async function closeDb() {
  stopReconnectProbe();
  if (pool) {
    try {
      await pool.end();
      logger.info('[DB] PostgreSQL pool closed');
    } catch (err) {
      logger.warn(`[DB] pool close error: ${err.message}`);
    }
  }
}

/** Unified data-layer facade mirroring the named exports. */
export const db = {
  initDb,
  listContent,
  getContentById,
  getContentByExternalId,
  upsertContent,
  deleteContent,
  countContent,
  countsByType,
  driverInfo,
  ping,
  closeDb,
  query,
};

export default db;
