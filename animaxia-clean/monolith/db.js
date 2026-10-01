/**
 * db.js — Unified async data layer: Neon PostgreSQL first, with automatic
 * local JSON-file fallback (data/content.json) when Postgres is unreachable.
 * Includes a 60s reconnect probe that migrates local rows back into Postgres.
 * All public methods return plain objects with `createdat` serialized as ISO string.
 */

import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from './utils/logger.js';
import { computeShardIdFromContentId, shardMap, shardBranchName } from './modules/sharding/model.js'; // FAZA 13 (sharding) — model.js is pure (imports nothing), no cycle

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
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
    connectionString: stripSslParams(databaseUrl),
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

export async function getContentById(id, opts = {}) {
  if (driver === 'local') return normalizeRow(localStore.byId(id));
  // FAZA 13 (sharding): optional shard affinity — when opts.shardId is an
  // integer ≥ 0, try the shard-filtered lookup first and fall back to the
  // legacy unfiltered query on miss/error (a bogus hint never breaks reads).
  const shardId = Number.isInteger(opts.shardId) && opts.shardId >= 0 ? opts.shardId : null;
  if (shardId !== null) {
    try {
      const res = await q('SELECT * FROM content WHERE id = $1 AND shardid = $2', [Number(id), shardId]);
      if (res.rows[0]) return normalizeRow(res.rows[0]);
    } catch (err) {
      logger.debug(`[DB] shard-hinted read failed for content ${id} (shard ${shardId}): ${err.message}`);
    }
  }
  const res = await q('SELECT * FROM content WHERE id = $1', [Number(id)]);
  return normalizeRow(res.rows[0]);
}

export async function getContentByExternalId(externalid) {
  if (driver === 'local') return normalizeRow(localStore.byExternalId(externalid));
  const res = await q('SELECT * FROM content WHERE externalid = $1', [externalid]);
  return normalizeRow(res.rows[0]);
}

/**
 * FAZA 16-a central dedup hook: after a successful postgres upsert, extract
 * every source embedded in the content metadata (url, finalUrl, player,
 * sources[] {src,kind}, trailer, youtube) and register each one in the global
 * `contentsources` registry (addedBy='upsert'). This covers every ingest path
 * (miner, POST /api/content, discover add, AI enrichment, external frontend
 * adds). Best-effort: never throws, never blocks the local-fallback driver.
 */
async function registerContentSourcesBestEffort(record) {
  try {
    if (driver !== 'postgres' || !record?.id) return;
    const { registerSource } = await import('./modules/ingest/dedup.js');
    const meta = safeParseJson(record.metadata, {}) ?? {};
    const candidates = [];
    const pushStr = (v) => {
      if (typeof v === 'string' && v.trim()) candidates.push(v);
    };
    pushStr(meta.url);
    pushStr(meta.finalUrl);
    pushStr(meta.trailer);
    pushStr(meta.youtube);
    if (typeof meta.player === 'string') {
      pushStr(meta.player);
    } else if (meta.player && typeof meta.player === 'object') {
      pushStr(meta.player.url);
      pushStr(meta.player.embed);
      pushStr(meta.player.src);
    }
    if (Array.isArray(meta.sources)) {
      for (const s of meta.sources) {
        if (typeof s === 'string') pushStr(s);
        else if (s && typeof s === 'object') pushStr(s.src);
      }
    }
    for (const raw of candidates) {
      try {
        await registerSource({ url: raw, contentId: record.id, externalId: record.externalid, addedBy: 'upsert' });
      } catch {
        /* best-effort per source */
      }
    }
  } catch {
    /* never throw from the hook */
  }
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
  const record = normalizeRow(res.rows[0]);
  // FAZA 13 (sharding): stamp the row's shard id (RANGE rule) — best-effort,
  // never throws. Ids < 1B → shard 0, matching the column DEFAULT (no-op
  // UPDATE via the `shardid <> $1` guard); future 1B+ ranges self-stamp.
  try {
    const shardid = computeShardIdFromContentId(record.id);
    await q('UPDATE content SET shardid = $1 WHERE id = $2 AND shardid <> $1', [shardid, record.id]);
  } catch (err) {
    logger.debug(`[DB] shardid stamp skipped for content ${record?.id}: ${err.message}`);
  }
  await registerContentSourcesBestEffort(record);
  return { record, created: !existing };
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

/** FAZA 9 (ops): live pg pool gauges for the metrics collector — zeros when
 *  the pool is not initialized (local fallback driver / pre-boot). */
export function poolStats() {
  if (!pool) return { total: 0, idle: 0, waiting: 0 };
  return {
    total: typeof pool.totalCount === 'number' ? pool.totalCount : 0,
    idle: typeof pool.idleCount === 'number' ? pool.idleCount : 0,
    waiting: typeof pool.waitingCount === 'number' ? pool.waitingCount : 0,
  };
}

/**
 * Generic SQL query on the active PostgreSQL pool — used by the Phase-2
 * platform modules (users, premium, social, ai, analytics, search, workers).
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

/* ====================================================================
 * FAZA 13 (sharding — Task 13-2): Neon multi-branch shard pool registry.
 *
 * Every shard id in the generated shard map (see modules/sharding/model.js)
 * gets a registry entry. Shard 0 and any shard N ≥ 1 WITHOUT a configured
 * SHARD{N}URL resolve to the MAIN pool (logical sharding mode: shardid
 * columns, routing, metrics and health are real, one physical database). A
 * shard N ≥ 1 WITH a non-empty SHARD{N}URL gets a dedicated pg.Pool on that
 * Neon branch (physical mode, activated purely by configuration). queryOnShard
 * falls back to the main pool when a dedicated branch pool fails at the
 * connection level — a down branch never breaks reads.
 * ==================================================================== */

const shardPools = new Map(); // shardId -> { shardid, branch, url, pool, ownPool, healthy, lastError, stats }

/** Strip `sslmode`/`ssl` query params from a connection URL. The TLS policy is
 *  set explicitly via the `ssl` pool option (PGSSL) — keeping sslmode in the
 *  URL only triggers pg-connection-string's deprecation warning at boot. */
function stripSslParams(url) {
  const raw = String(url);
  try {
    const u = new URL(raw);
    u.searchParams.delete('sslmode');
    u.searchParams.delete('ssl');
    return u.toString();
  } catch {
    return raw;
  }
}

/** Create a standalone pg.Pool for a Neon branch (same tuning as the main
 *  pool). Does NOT register it — registration is by shardId via ensureShardPool. */
export function createPoolForBranch(name, url) {
  const branchPool = new pg.Pool({
    connectionString: stripSslParams(url),
    ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
    max: parseInt(process.env.PGPOOLMAX || '10', 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 8000,
  });
  branchPool.on('error', (err) => logger.error(`[DB] shard pool ${name} idle client error: ${err.message}`));
  return branchPool;
}

/**
 * Idempotent per-shard registry entry. Shard 0 / shards without SHARD{N}URL →
 * { ownPool: false, pool: null } where the MAIN pool is resolved lazily at
 * query time (initDb() may not have run yet when this is first called).
 * Shard N ≥ 1 with a non-empty SHARD{N}URL → dedicated branch pool
 * (ownPool: true) created once and cached.
 */
export function ensureShardPool(shardId) {
  const n = Number(shardId);
  const id = Number.isInteger(n) && n >= 0 ? n : 0;
  const existing = shardPools.get(id);
  if (existing) return existing;

  const branch = shardBranchName(id);
  const url = id >= 1 ? String(process.env[`SHARD${id}URL`] || '').trim() : '';
  const stats = { queries: 0, errors: 0 };

  if (id >= 1 && url) {
    const entry = {
      shardid: id,
      branch,
      url,
      ownPool: true,
      pool: createPoolForBranch(branch, url),
      healthy: true,
      lastError: null,
      stats,
    };
    shardPools.set(id, entry);
    logger.info(`[DB] shard ${id} → dedicated Neon branch pool (${branch})`);
    return entry;
  }

  // Logical mode: main-pool-backed. `pool: null` on purpose — the main pool
  // is resolved at query time (it may not exist yet pre-boot).
  const entry = {
    shardid: id,
    branch,
    url: null,
    ownPool: false,
    pool: null,
    healthy: null, // mirrors driver === 'postgres' at read time
    lastError: null,
    stats,
  };
  shardPools.set(id, entry);
  return entry;
}

/** Ensure + return the underlying pg pool for a shard (null pre-boot for
 *  main-backed entries — the main pool is initialised by initDb()). */
export function getPoolForShard(shardId) {
  const entry = ensureShardPool(shardId);
  if (entry.ownPool) return entry.pool;
  return pool; // module-scope main pool (null until initDb runs)
}

/** Connection-level failure detection for the branch → main fallback. */
function isConnectionError(err) {
  const code = String(err?.code || '');
  if (
    code.startsWith('08') || // PostgreSQL class 08 — connection_exception
    ['57P01', '57P02', '57P03'].includes(code) || // admin/crash shutdown, cannot connect now
    ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET', 'EPIPE', 'EAI_AGAIN'].includes(code)
  ) {
    return true;
  }
  const message = String(err?.message || '');
  return (
    message.includes('timeout exceeded when trying to connect') ||
    message.includes('Connection terminated') ||
    message.includes('connection terminated')
  );
}

/**
 * Run a query on a specific shard's pool. Dedicated branch pools fall back to
 * the MAIN pool on connection-level failures (resilience — a down branch never
 * breaks reads; logged as a warning). Throws the same 503-tagged error as
 * query() when the PostgreSQL driver is inactive (local fallback store).
 */
export async function queryOnShard(shardId, text, params = []) {
  if (driver !== 'postgres' || !pool) {
    const err = new Error('SQL layer unavailable — PostgreSQL driver inactive (local fallback store in use)');
    err.status = 503;
    throw err;
  }
  const entry = ensureShardPool(shardId);
  entry.stats.queries += 1;
  const target = entry.ownPool ? entry.pool : pool;
  try {
    if (!target) throw new Error('shard pool not initialised');
    const res = await target.query(text, params);
    if (entry.ownPool) {
      entry.healthy = true;
      entry.lastError = null;
    }
    return res;
  } catch (err) {
    entry.stats.errors += 1;
    if (entry.ownPool && (err.message === 'shard pool not initialised' || isConnectionError(err))) {
      entry.healthy = false;
      entry.lastError = err.message;
      logger.warn(
        `[DB] shard ${entry.shardid} (${entry.branch}) query failed (${err.message}) — falling back to main pool`,
      );
      return pool.query(text, params); // main pool is guaranteed non-null here
    }
    throw err;
  }
}

/** Registry snapshot for metrics/admin — one entry per shard in the shard map. */
export function listShardPools() {
  return Object.keys(shardMap())
    .map(Number)
    .sort((a, b) => a - b)
    .map((id) => {
      const entry = ensureShardPool(id);
      const poolStatsOf = (p) => ({
        total: typeof p?.totalCount === 'number' ? p.totalCount : 0,
        idle: typeof p?.idleCount === 'number' ? p.idleCount : 0,
        waiting: typeof p?.waitingCount === 'number' ? p.waitingCount : 0,
      });
      if (entry.ownPool) {
        return {
          shardid: entry.shardid,
          branch: entry.branch,
          mode: 'branch',
          urlConfigured: true,
          connected: entry.healthy === true,
          healthy: entry.healthy,
          lastError: entry.lastError,
          pool: poolStatsOf(entry.pool),
          stats: { ...entry.stats },
        };
      }
      return {
        shardid: entry.shardid,
        branch: entry.branch,
        mode: 'main',
        urlConfigured: id === 0 ? Boolean(String(process.env.DATABASEURL || '').trim()) : false,
        connected: driver === 'postgres',
        lastError: entry.lastError,
        pool: poolStats(),
        stats: { ...entry.stats },
      };
    });
}

/** End every dedicated branch pool (ownPool). The main pool is closed by
 *  closeDb() — never double-closed here. */
export async function closeShardPools() {
  const closed = [];
  for (const [id, entry] of shardPools) {
    if (!entry.ownPool || !entry.pool) continue;
    try {
      await entry.pool.end();
      closed.push(id);
      entry.healthy = false;
      entry.lastError = 'pool closed';
    } catch (err) {
      logger.warn(`[DB] shard ${id} pool close error: ${err.message}`);
    }
  }
  if (closed.length) logger.info(`[DB] shard branch pools closed (${closed.join(', ')})`);
  return closed;
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
  // FAZA 13 (sharding) — multi-branch shard pool registry
  createPoolForBranch,
  ensureShardPool,
  getPoolForShard,
  queryOnShard,
  listShardPools,
  closeShardPools,
};

export default db;
