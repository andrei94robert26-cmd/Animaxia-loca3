import { localDb } from './modules/local/sqlite.js';
import { shardMap, shardBranchName } from './modules/sharding/model.js';
import { logger } from './utils/logger.js';

let dbActivityAt = 0;

function touch() {
  dbActivityAt = Date.now();
}

function detectYear(title, metadata = {}) {
  const direct = Number(metadata?.year);
  if (Number.isInteger(direct) && direct >= 1000 && direct <= 9999) return direct;

  const m = String(title || '').match(/\b(19|20)\d{2}\b/);
  return m ? Number(m[0]) : null;
}

function normalizeRow(row) {
  if (!row) return null;

  const sources = [];

  if (row.url) {
    sources.push({
      url: row.url,
      type: row.embedcode === row.url ? 'iframe' : 'video'
    });
  }

  if (row.embedcode && row.embedcode !== row.url) {
    sources.push({ url: row.embedcode, type: 'iframe' });
  }

  return {
    ...row,
    id: Number(row.id),
    year: row.year == null ? null : Number(row.year),

    // Compatibility fields for old modules
    externalid: null,
    type: 'content',
    thumbnail: null,
    createdat: null,

    metadata: {
      year: row.year ?? null,
      player: { sources }
    }
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

  if (
    /^\s*(SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(sql) ||
    /\bRETURNING\b/i.test(sql)
  ) {
    const rows = stmt.all(...params);
    return { rows, rowCount: rows.length };
  }

  const result = stmt.run(...params);

  return {
    rows: [],
    rowCount: Number(result.changes || 0),
    changes: Number(result.changes || 0),
    lastInsertRowid:
      result.lastInsertRowid == null ? null : Number(result.lastInsertRowid)
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
      title TEXT NOT NULL,
      year INTEGER,
      url TEXT,
      embedcode TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_content_title
      ON Content(title COLLATE NOCASE);

    CREATE INDEX IF NOT EXISTS idx_content_year
      ON Content(year);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_content_unique_media
      ON Content(
        lower(trim(title)),
        ifnull(year, -1),
        ifnull(url, ''),
        ifnull(embedcode, '')
      );
  `);

  touch();
  logger.info('[DB] SQLite minimal database ready');
  return driverInfo();
}

export function driverInfo() {
  return {
    driver: 'sqlite',
    backend: 'local',
    connected: true
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
  sort = 'id'
} = {}) {
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));

  const where = [];
  const params = [];

  // type retained for API compatibility, intentionally ignored.
  void type;

  if (search) {
    where.push('title LIKE ? COLLATE NOCASE');
    params.push(`%${String(search)}%`);
  }

  const clause = where.length
    ? `WHERE ${where.join(' AND ')}`
    : '';

  const count = localDb
    .prepare(`SELECT COUNT(*) AS n FROM Content ${clause}`)
    .get(...params);

  let order = 'id DESC';

  if (sort === 'title') {
    order = 'title COLLATE NOCASE ASC, id ASC';
  } else if (sort === 'year') {
    order = 'year DESC, id DESC';
  }

  const offset = (safePage - 1) * safeLimit;

  const data = localDb.prepare(`
    SELECT id,title,year,url,embedcode
    FROM Content
    ${clause}
    ORDER BY ${order}
    LIMIT ? OFFSET ?
  `).all(...params, safeLimit, offset).map(normalizeRow);

  touch();

  const total = Number(count?.n || 0);

  return {
    data,
    total,
    page: safePage,
    limit: safeLimit,
    totalPages: Math.max(1, Math.ceil(total / safeLimit))
  };
}

export async function getContentById(id, opts = {}) {
  void opts;

  const row = localDb.prepare(`
    SELECT id,title,year,url,embedcode
    FROM Content
    WHERE id=?
    LIMIT 1
  `).get(Number(id));

  touch();
  return normalizeRow(row);
}

export async function getContentByExternalId(externalid) {
  const source = localDb.prepare(`
    SELECT contentId
    FROM ContentSource
    WHERE originalUrl=? OR url=?
    ORDER BY id DESC
    LIMIT 1
  `).get(String(externalid), String(externalid));

  if (!source?.contentId) return null;

  return getContentById(source.contentId);
}

export async function upsertContent({
  externalid,
  type,
  title,
  metadata = {},
  thumbnail
}) {
  void type;
  void thumbnail;

  if (!title) {
    throw new Error('upsertContent requires title');
  }

  const existing = externalid
    ? await getContentByExternalId(externalid)
    : null;

  const sources = Array.isArray(metadata?.player?.sources)
    ? metadata.player.sources
    : [];

  const first = sources[0] ?? null;

  const embed = sources.find((s) =>
    ['iframe', 'youtube'].includes(
      String(s?.type || '').toLowerCase()
    )
  );

  const year = detectYear(title, metadata);
  const url = first?.url ?? existing?.url ?? null;
  const embedcode = embed?.url ?? existing?.embedcode ?? null;

  if (existing) {
    localDb.prepare(`
      UPDATE Content
      SET title=?,year=?,url=?,embedcode=?
      WHERE id=?
    `).run(
      title,
      year,
      url,
      embedcode,
      existing.id
    );

    touch();

    return {
      record: await getContentById(existing.id),
      created: false
    };
  }

  const result = localDb.prepare(`
    INSERT INTO Content(title,year,url,embedcode)
    VALUES(?,?,?,?)
  `).run(
    title,
    year,
    url,
    embedcode
  );

  touch();

  return {
    record: await getContentById(Number(result.lastInsertRowid)),
    created: true
  };
}

export async function deleteContent(id) {
  const existing = await getContentById(id);
  if (!existing) return null;

  localDb.prepare(
    'DELETE FROM Content WHERE id=?'
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
  const total = await countContent();

  // Compatibility response for code still expecting a type map.
  return {
    content: total
  };
}

export function createPoolForBranch(name, url) {
  return {
    name,
    url: url || null,
    sqlite: true,
    query: (text, params = []) => query(text, params),
    end: async () => undefined
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
    mode: 'sqlite-local'
  };
}

export function getPoolForShard(shardId) {
  const shard = ensureShardPool(shardId);

  return {
    shardid: shard.shardid,
    query: (text, params = []) => query(text, params),
    end: async () => undefined
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
      stats: { queries: 0, errors: 0 }
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
  closeShardPools
};

export default db;
