import { localDb } from './modules/local/sqlite.js';
import { ensureContentFts } from './modules/search/content-fts.js';
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

function inferMediaType(url, embed = false) {
  if (embed) return 'iframe';
  const value = String(url || '').toLowerCase();
  if (/youtube\.com|youtu\.be|youtube-nocookie\.com/.test(value)) return 'youtube';
  if (/\.m3u8(?:[?#]|$)/.test(value)) return 'm3u8';
  if (/\.mpd(?:[?#]|$)/.test(value)) return 'mpd';
  if (/\.mp4(?:[?#]|$)/.test(value)) return 'mp4';
  return 'iframe';
}

function normalizeRow(row) {
  if (!row) return null;
  let stored = {};
  try { stored = row.metadata ? JSON.parse(row.metadata) : {}; } catch { stored = {}; }
  const sources = Array.isArray(stored?.player?.sources) ? [...stored.player.sources] : [];
  const seen = new Set(sources.map((source) => source.url));
  if (row.url && !seen.has(row.url)) {
    sources.push({ url: row.url, type: inferMediaType(row.url, row.embedcode === row.url) });
    seen.add(row.url);
  }
  if (row.embedcode && !seen.has(row.embedcode)) {
    sources.push({ url: row.embedcode, type: inferMediaType(row.embedcode, true) });
  }
  const metadata = { ...stored, year: row.year ?? stored.year ?? null, player: { ...(stored.player || {}), sources } };
  return {
    ...row,
    id: Number(row.id),
    year: row.year == null ? null : Number(row.year),
    externalid: row.externalid || null,
    type: row.type || stored.mediaType || 'content',
    thumbnail: row.thumbnail || null,
    createdat: row.createdat || null,
    metadata
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
      embedcode TEXT,
      externalid TEXT,
      type TEXT NOT NULL DEFAULT 'content',
      thumbnail TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      createdat TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const columns = new Set(
    localDb.prepare("PRAGMA table_info(Content)").all().map((r) => String(r.name).toLowerCase())
  );

  if (!columns.has("year"))
    localDb.exec("ALTER TABLE Content ADD COLUMN year INTEGER");

  if (!columns.has("url"))
    localDb.exec("ALTER TABLE Content ADD COLUMN url TEXT");

  if (!columns.has("embedcode"))
    localDb.exec("ALTER TABLE Content ADD COLUMN embedcode TEXT");
  if (!columns.has('externalid')) localDb.exec('ALTER TABLE Content ADD COLUMN externalid TEXT');
  if (!columns.has('type')) localDb.exec("ALTER TABLE Content ADD COLUMN type TEXT NOT NULL DEFAULT 'content'");
  if (!columns.has('thumbnail')) localDb.exec('ALTER TABLE Content ADD COLUMN thumbnail TEXT');
  if (!columns.has('metadata')) localDb.exec("ALTER TABLE Content ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'");
  if (!columns.has('createdat')) localDb.exec('ALTER TABLE Content ADD COLUMN createdat TEXT');

  localDb.exec(`
    CREATE INDEX IF NOT EXISTS idx_content_title
      ON Content(title COLLATE NOCASE);

    CREATE INDEX IF NOT EXISTS idx_content_year
      ON Content(year);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_content_externalid
      ON Content(externalid) WHERE externalid IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_content_type
      ON Content(type);

    -- ID-bearing API/addon records may legitimately share title/year/media
    -- with different episodes/editions/providers. Keep legacy-url dedupe only
    -- for manual rows that lack a stable externalid.
    DROP INDEX IF EXISTS idx_content_unique_media;
    CREATE UNIQUE INDEX idx_content_unique_media
      ON Content(
        lower(trim(title)),
        ifnull(year, -1),
        ifnull(url, ''),
        ifnull(embedcode, '')
      ) WHERE externalid IS NULL;
  `);

  // Build the native full-text index only on first installation; all later
  // INSERT/UPDATE/DELETE mutations stay synchronized through SQLite triggers.
  ensureContentFts();

  // Auth must not depend on optional AI/tenant migrations completing.
  // Fresh SQLite installs can lack vectorembeddings, which used to abort the
  // tenant migration before the refresh-token tenantid column was added.
  for (const [table, column, ddl] of [
    ['refreshtokens', 'tenantid', 'TEXT'],
    ['users', 'emailverified', 'INTEGER NOT NULL DEFAULT 0'],
    ['users', 'twofaenabled', 'INTEGER NOT NULL DEFAULT 0'],
  ]) {
    const found = localDb.prepare(`PRAGMA table_info(${table})`).all()
      .some((entry) => entry.name.toLowerCase() === column);
    if (!found) localDb.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }

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

  if (type) { where.push('type = ? COLLATE NOCASE'); params.push(String(type)); }

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
    SELECT *
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
    SELECT *
    FROM Content
    WHERE id=?
    LIMIT 1
  `).get(Number(id));

  touch();
  return normalizeRow(row);
}

export async function getContentByExternalId(externalid) {
  const key = String(externalid || '');
  let row = localDb.prepare('SELECT * FROM Content WHERE externalid=? LIMIT 1').get(key);
  if (!row) {
    const source = localDb.prepare(`
      SELECT contentId FROM contentsources
      WHERE originalUrl=? OR url=? ORDER BY id DESC LIMIT 1
    `).get(key, key);
    if (source?.contentId) row = localDb.prepare('SELECT * FROM Content WHERE id=?').get(source.contentId);
  }
  return normalizeRow(row);
}

export async function upsertContent({ externalid, type, title, metadata = {}, thumbnail }) {
  if (!title) throw new Error('upsertContent requires title');
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('Content metadata must be a JSON object');
  }
  const existing = externalid ? await getContentByExternalId(externalid) : null;
  const savedMeta = existing?.metadata || {};
  const mergedMeta = { ...savedMeta, ...metadata, player: {
    ...(savedMeta.player || {}), ...(metadata.player || {}),
    sources: Array.isArray(metadata.player?.sources) ? metadata.player.sources : (savedMeta.player?.sources || [])
  }};
  const sources = mergedMeta.player.sources;
  const first = sources[0] || null;
  const embed = sources.find((source) => ['iframe', 'youtube'].includes(String(source?.type || '').toLowerCase()));
  const year = detectYear(title, mergedMeta);
  const url = first?.url || existing?.url || null;
  const embedcode = embed?.url || existing?.embedcode || null;
  const mediaType = type || existing?.type || mergedMeta.mediaType || 'content';
  const artwork = thumbnail || existing?.thumbnail || null;
  const key = externalid == null ? existing?.externalid || null : String(externalid);
  if (existing) {
    localDb.prepare(`
      UPDATE Content SET title=?, year=?, url=?, embedcode=?, externalid=?, type=?, thumbnail=?, metadata=?
      WHERE id=?
    `).run(title, year, url, embedcode, key, mediaType, artwork, JSON.stringify(mergedMeta), existing.id);
    touch();
    return { record: await getContentById(existing.id), created: false };
  }
  const result = localDb.prepare(`
    INSERT INTO Content (title, year, url, embedcode, externalid, type, thumbnail, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(title, year, url, embedcode, key, mediaType, artwork, JSON.stringify(mergedMeta));
  touch();
  return { record: await getContentById(Number(result.lastInsertRowid)), created: true };
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

  const rows = localDb.prepare('SELECT type, COUNT(*) AS n FROM Content GROUP BY type').all();
  return Object.fromEntries(rows.map((row) => [row.type || 'content', Number(row.n)]));
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
