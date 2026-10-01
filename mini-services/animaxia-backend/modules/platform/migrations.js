/**
 * modules/platform/migrations.js — Idempotent DDL for all Phase-2 platform
 * tables (users, tokens, watchlist, history, comments, votes, likes, views,
 * subscriptions, audit logs, AI chats). Column names follow the house style
 * (lowercase, no underscores). Runs at boot after initDb(); safe to re-run.
 */

import { logger } from '../../utils/logger.js';
import { rows } from './sql.js';

const DDL_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    username TEXT NOT NULL,
    passwordhash TEXT NOT NULL,
    avatar TEXT,
    role TEXT NOT NULL DEFAULT 'user',
    plan TEXT NOT NULL DEFAULT 'free',
    planexpiresat TIMESTAMPTZ,
    preferences TEXT NOT NULL DEFAULT '{}',
    createdat TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    lastloginat TIMESTAMPTZ
  )`,
  `CREATE TABLE IF NOT EXISTS refreshtokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userid INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tokenhash TEXT UNIQUE NOT NULL,
    expiresat TIMESTAMPTZ NOT NULL,
    revoked BOOLEAN NOT NULL DEFAULT FALSE,
    createdat TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_refreshtokens_user ON refreshtokens (userid)`,
  `CREATE TABLE IF NOT EXISTS watchlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userid INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    contentid INTEGER NOT NULL REFERENCES content(id) ON DELETE CASCADE,
    createdat TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (userid, contentid)
  )`,
  `CREATE TABLE IF NOT EXISTS watchhistory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userid INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    contentid INTEGER NOT NULL REFERENCES content(id) ON DELETE CASCADE,
    progress INTEGER NOT NULL DEFAULT 0,
    watchedat TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (userid, contentid)
  )`,
  `CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contentid INTEGER NOT NULL REFERENCES content(id) ON DELETE CASCADE,
    userid INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    parentid INTEGER REFERENCES comments(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    createdat TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_comments_content ON comments (contentid, createdat DESC)`,
  `CREATE TABLE IF NOT EXISTS commentvotes (
    userid INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    commentid INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
    value SMALLINT NOT NULL,
    createdat TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (userid, commentid)
  )`,
  `CREATE TABLE IF NOT EXISTS contentlikes (
    contentid INTEGER NOT NULL REFERENCES content(id) ON DELETE CASCADE,
    userid INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    value SMALLINT NOT NULL,
    createdat TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (contentid, userid)
  )`,
  `CREATE TABLE IF NOT EXISTS viewevents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contentid INTEGER NOT NULL REFERENCES content(id) ON DELETE CASCADE,
    userid INTEGER REFERENCES users(id) ON DELETE SET NULL,
    event TEXT NOT NULL DEFAULT 'view',
    createdat TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_viewevents_content ON viewevents (contentid)`,
  `CREATE INDEX IF NOT EXISTS idx_viewevents_created ON viewevents (createdat DESC)`,
  `CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userid INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    provider TEXT NOT NULL DEFAULT 'stripe-sandbox',
    sessionid TEXT,
    stripecustomerid TEXT,
    stripesubscriptionid TEXT,
    currentperiodend TIMESTAMPTZ,
    createdat TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions (userid, createdat DESC)`,
  `CREATE TABLE IF NOT EXISTS auditlogs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userid INTEGER REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    ip TEXT,
    meta TEXT,
    createdat TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_auditlogs_created ON auditlogs (createdat DESC)`,
  `CREATE TABLE IF NOT EXISTS aichats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contentid INTEGER REFERENCES content(id) ON DELETE CASCADE,
    userid INTEGER REFERENCES users(id) ON DELETE SET NULL,
    role TEXT NOT NULL,
    message TEXT NOT NULL,
    createdat TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_aichats_content ON aichats (contentid, createdat ASC)`,
  // Phase 6 (additive): one-shot password reset codes.
  `CREATE TABLE IF NOT EXISTS passwordresets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userid INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    codehash TEXT NOT NULL,
    expiresat TIMESTAMPTZ NOT NULL,
    used BOOLEAN NOT NULL DEFAULT FALSE,
    createdat TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_passwordresets_user ON passwordresets (userid, createdat DESC)`,
  // FAZA 16 (Task 16-a): Neon FTS search docs — denormalized, queryable index table.
  `CREATE TABLE IF NOT EXISTS searchdocs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contentid INTEGER NOT NULL UNIQUE,
    externalid TEXT,
    type TEXT,
    title TEXT NOT NULL,
    tsv TEXT,
    year INTEGER,
    rating REAL,
    genres TEXT DEFAULT '{}',
    actors TEXT DEFAULT '{}',
    studios TEXT DEFAULT '{}',
    category TEXT,
    syncedat TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_searchdocs_year ON searchdocs (year)`,
  // FAZA 16: global dedup registry for every ingested external source.
  `CREATE TABLE IF NOT EXISTS contentsources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    urlhash TEXT NOT NULL UNIQUE,
    url TEXT NOT NULL,
    originalurl TEXT,
    kind TEXT NOT NULL DEFAULT 'link',
    contentid INTEGER,
    externalid TEXT,
    addedby TEXT DEFAULT 'manual',
    hits INTEGER DEFAULT 1,
    metadata TEXT DEFAULT '{}',
    createdat TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    lastseenat TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_contentsources_contentid ON contentsources (contentid)`,
  `CREATE INDEX IF NOT EXISTS idx_contentsources_kind ON contentsources (kind)`,
  // FAZA 16: ai/home stores moved from data/*.json into Neon.
  `CREATE TABLE IF NOT EXISTS aisettings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updatedat TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS aienrichment (
    externalid TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    updatedat TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS aitrailercache (
    cachekey TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    updatedat TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`,
  // FAZA 16: SVG thumbnail storage moved from disk into Neon.
  `CREATE TABLE IF NOT EXISTS thumbnailcache (
    file TEXT PRIMARY KEY,
    svg TEXT NOT NULL,
    contentid INTEGER,
    createdat TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`,
  // FAZA 16: marathon playlists (future frontend surface).
  `CREATE TABLE IF NOT EXISTS marathons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT UNIQUE,
    userid INTEGER,
    title TEXT NOT NULL,
    description TEXT,
    items TEXT NOT NULL DEFAULT '[]',
    createdat TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_marathons_key ON marathons (key)`,
  // FAZA 16-b (AI Hub): semantic-search embeddings (TEXT vectors, provider-tagged).
  `CREATE TABLE IF NOT EXISTS aisemantic (
    externalid TEXT PRIMARY KEY,
    contentid INTEGER,
    title TEXT,
    embedding TEXT,
    dims INTEGER,
    provider TEXT,
    updatedat TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_aisemantic_contentid ON aisemantic (contentid)`,
];

/**
 * Best-effort statements executed BEFORE the main DDL: failures are logged
 * and skipped, never fatal. pg_trgm is already installed on the production
 * database — the CREATE EXTENSION is purely defensive (fresh branches).
 */
const BEST_EFFORT_STATEMENTS = [
];

/**
 * Ensure all platform tables exist. Idempotent — every statement uses
 * IF NOT EXISTS. Returns the number of statements executed.
 */
export async function ensurePlatformSchema() {
  for (const statement of BEST_EFFORT_STATEMENTS) {
    try {
      await rows(statement);
    } catch (err) {
      // Defensive only (pg_trgm is already installed) — log and continue.
      logger.warn(`[platform] Best-effort statement skipped: ${err.message}`);
    }
  }
  let applied = 0;
  for (const statement of DDL_STATEMENTS) {
    try {
      await rows(statement);
      applied += 1;
    } catch (err) {
      // Re-throw the first failure: boot must know the schema is not ready.
      logger.error(`[platform] Migration statement failed: ${err.message}`);
      throw err;
    }
  }
  logger.info(`[platform] Schema verified — ${applied}/${DDL_STATEMENTS.length} statements OK (users, tokens, watchlist, history, comments, votes, likes, views, subscriptions, audit, aichats, searchdocs, contentsources, aisettings, aienrichment, aitrailercache, thumbnailcache, marathons, aisemantic)`);
  return { applied, total: DDL_STATEMENTS.length };
}

export default ensurePlatformSchema;
