import { localDb } from './modules/local/sqlite.js';
import { computeShardIdFromContentId, shardMap, shardBranchName } from './modules/sharding/model.js';
import { logger } from './utils/logger.js';

let dbActivityAt = 0;

function touch() {
  dbActivityAt = Date.now();
}

function parseJson(value, fallback = {}) {
  if (value == null) return fallback;
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
    ...row,
    id: Number(row.id),
    metadata: parseJson(row.metadata, {}),
    thumbnail: row.thumbnail ?? null,
    createdat: row.createdat ? String(row.createdat) : null,
  };
}

function sqliteSql(sql) {
  return String(sql)
    .replace(/\$(\d+)::jsonb/gi, '?$1')
    .replace(/\$(\d+)::text/gi, '?$1')
    .replace(/\$(\d+)::int/gi, '?$1')
    .replace(/\$(\d+)/g, '?$1')
    .replace(/::jsonb\b/gi, '')
    .replace(/::text\b/gi, '')
    .replace(/::int\b/gi, '')
    .replace(/::numeric\b/gi, '')
    .replace(/\bILIKE\b/gi, 'LIKE')
    .replace(/\bNOW\(\)/gi, 'CURRENT_TIMESTAMP');
}

function runSql(text, params = []) {
  const sql = sqliteSql(text);
  const stmt = localDb.prepare(sql);
  touch();

  if (/^\s*(SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(sql) ||
      /\bRETURNING\b/i.test(sql)) {
    const rows = stmt.all(...params);
    return { rows, rowCount: rows.length };
  }

  const result = stmt.run(...params);

  return {
    rows: [],
    rowCount: Number(result.changes || 0),
    changes: Number(result.changes || 0),
    lastInsertRowid: result.lastInsertRowid == null
      ? null
      : Number(result.lastInsertRowid),
  };
}

export function lastDbActivityAt() {
  return dbActivityAt;
}

export async function query(text, params = []) {
  return runSql(text, params);
}

export async function initDb() {
  localDb.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=5000;

    CREATE TABLE IF NOT EXISTS Content (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      externalid TEXT UNIQUE,
      type TEXT,
      title TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      thumbnail TEXT,
      shardid INTEGER NOT NULL DEFAULT 0,
      createdat TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedat TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_content_type
      ON Content(type);

    CREATE INDEX IF NOT EXISTS idx_content_createdat
      ON Content(createdat DESC);

    CREATE INDEX IF NOT EXISTS idx_content_shardid
      ON Content(shardid);
  `);

  touch();
  logger.info('[DB] SQLite-only database ready');
  return driverInfo();
}

export function driverInfo() {
  return {
    driver: 'sqlite',
    backend: 'local',
    connected: true,
  };
}

export function poolStats() {
  return { total: 1, idle: 1, waiting: 0 };
}

export async function ping() {
  try {
    localDb.prepare('SELECT 1 AS ok').get();
    touch();
    return true;
  } catch {
    return false;
  }
}

export async function closeDb() {
  logger.info('[DB] SQLite shutdown complete');
}

export async function listContent({
  page = 1,
  limit = 20,
  type,
  search,
  sort = 'createdat',
} = {}) {
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));

  const where = [];
  const params = [];

  if (type) {
    where.push('type = ?');
    params.push(type);
  }

  if (search) {
    where.push('LOWER(title) LIKE LOWER(?)');
    params.push(`%${String(search)}%`);
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const count = localDb
    .prepare(`SELECT COUNT(*) AS n FROM Content ${clause}`)
    .get(...params);

  const order =
    sort === 'title'
      ? 'title COLLATE NOCASE ASC, id ASC'
      : 'createdat DESC, id DESC';

  const offset = (safePage - 1) * safeLimit;

  const data = localDb
    .prepare(`
      SELECT *
      FROM Content
      ${clause}
      ORDER BY ${order}
      LIMIT ? OFFSET ?
    `)
    .all(...params, safeLimit, offset)
    .map(normalizeRow);

  touch();

  const total = Number(count?.n || 0);

  return {
    data,
    total,
    page: safePage,
    limit: safeLimit,
    totalPages: Math.max(1, Math.ceil(total / safeLimit)),
  };
}

export async function getContentById(id, opts = {}) {
  let row = null;
  const numericId = Number(id);

  if (Number.isInteger(opts.shardId) && opts.shardId >= 0) {
    row = localDb
      .prepare('SELECT * FROM Content WHERE id = ? AND shardid = ?')
      .get(numericId, opts.shardId);
  }

  if (!row) {
    row = localDb
      .prepare('SELECT * FROM Content WHERE id = ?')
      .get(numericId);
  }

  touch();
  return normalizeRow(row);
}

export async function getContentByExternalId(externalid) {
  const row = localDb
    .prepare('SELECT * FROM Content WHERE externalid = ?')
    .get(String(externalid));

  touch();
  return normalizeRow(row);
}

export async function upsertContent({
  externalid,
  type,
  title,
  metadata,
  thumbnail,
}) {
  if (!externalid || !title) {
    throw new Error('upsertContent requires externalid and title');
  }

  const existing = await getContentByExternalId(externalid);
  const metadataText = JSON.stringify(parseJson(metadata, {}));

  if (existing) {
    localDb.prepare(`
      UPDATE Content
      SET type = ?,
          title = ?,
          metadata = ?,
          thumbnail = ?,
          updatedat = CURRENT_TIMESTAMP
      WHERE externalid = ?
    `).run(
      type ?? existing.type,
      title,
      metadataText,
      thumbnail ?? existing.thumbnail,
      externalid
    );

    touch();

    return {
      record: await getContentByExternalId(externalid),
      created: false,
    };
  }

  const result = localDb.prepare(`
    INSERT INTO Content
      (externalid, type, title, metadata, thumbnail)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    externalid,
    type ?? null,
    title,
    metadataText,
    thumbnail ?? null
  );

  const id = Number(result.lastInsertRowid);
  const shardid = computeShardIdFromContentId(id);

  localDb.prepare(
    'UPDATE Content SET shardid = ? WHERE id = ?'
  ).run(shardid, id);

  touch();

  return {
    record: await getContentById(id),
    created: true,
  };
}

export async function deleteContent(id) {
  const existing = await getContentById(id);
  if (!existing) return null;

  localDb.prepare(
    'DELETE FROM Content WHERE id = ?'
  ).run(Number(id));

  touch();
  return existing;
}

export async function countContent() {
  const row = localDb.prepare(
    'SELECT COUNT(*) AS n FROM Content'
  ).get();

  touch();
  return Number(row?.n || 0);
}

export async function countsByType() {
  const result = localDb.prepare(`
    SELECT type, COUNT(*) AS n
    FROM Content
    GROUP BY type
  `).all();

  touch();

  return result.reduce((acc, row) => {
    acc[row.type || 'unknown'] = Number(row.n || 0);
    return acc;
  }, {});
}

export function createPoolForBranch(name, url) {
  return {
    name,
    url: url || null,
    sqlite: true,
    query: (text, params = []) => query(text, params),
    end: async () => undefined,
  };
}

export function ensureShardPool(shardId) {
  const n = Number(shardId);
  const id = Number.isInteger(n) && n >= 0 ? n : 0;

  return {
    shardid: id,
    branch: shardBranchName(id),
    url: null,
    ownPool: false,
    pool: null,
    healthy: true,
    lastError: null,
    stats: { queries: 0, errors: 0 },
    mode: 'sqlite-local',
  };
}

export function getPoolForShard(shardId) {
  const shard = ensureShardPool(shardId);

  return {
    shardid: shard.shardid,
    query: (text, params = []) => query(text, params),
    end: async () => undefined,
  };
}

export async function queryOnShard(shardId, text, params = []) {
  ensureShardPool(shardId);
  return query(text, params);
}

export function listShardPools() {
  return Object.keys(shardMap())
    .map(Number)
    .sort((a, b) => a - b)
    .map((shardid) => ({
      shardid,
      branch: shardBranchName(shardid),
      mode: 'sqlite-local',
      urlConfigured: false,
      connected: true,
      healthy: true,
      lastError: null,
      pool: { total: 1, idle: 1, waiting: 0 },
      stats: { queries: 0, errors: 0 },
    }));
}

export async function closeShardPools() {
  return [];
}

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
  poolStats,
  ping,
  closeDb,
  query,
  createPoolForBranch,
  ensureShardPool,
  getPoolForShard,
  queryOnShard,
  listShardPools,
  closeShardPools,
};

export default db;
