/**
 * common/migrations.js — Idempotent DDL for all Phase-2 platform
 * tables (users, tokens, watchlist, history, comments, votes, likes, views,
 * subscriptions, audit logs, AI chats). Column names follow the house style
 * (lowercase, no underscores). Runs at boot after initDb(); safe to re-run.
 */

import { logger } from './logger.js';
import { rows } from './sql.js';

const DDL_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    username TEXT NOT NULL,
    passwordhash TEXT NOT NULL,
    avatar TEXT,
    role TEXT NOT NULL DEFAULT 'user',
    plan TEXT NOT NULL DEFAULT 'free',
    planexpiresat TIMESTAMPTZ,
    preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
    createdat TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    lastloginat TIMESTAMPTZ
  )`,
  `CREATE TABLE IF NOT EXISTS refreshtokens (
    id SERIAL PRIMARY KEY,
    userid INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tokenhash TEXT UNIQUE NOT NULL,
    expiresat TIMESTAMPTZ NOT NULL,
    revoked BOOLEAN NOT NULL DEFAULT FALSE,
    createdat TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_refreshtokens_user ON refreshtokens (userid)`,
  `CREATE TABLE IF NOT EXISTS watchlist (
    id SERIAL PRIMARY KEY,
    userid INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    contentid INTEGER NOT NULL REFERENCES content(id) ON DELETE CASCADE,
    createdat TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (userid, contentid)
  )`,
  `CREATE TABLE IF NOT EXISTS watchhistory (
    id SERIAL PRIMARY KEY,
    userid INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    contentid INTEGER NOT NULL REFERENCES content(id) ON DELETE CASCADE,
    progress INTEGER NOT NULL DEFAULT 0,
    watchedat TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (userid, contentid)
  )`,
  `CREATE TABLE IF NOT EXISTS comments (
    id SERIAL PRIMARY KEY,
    contentid INTEGER NOT NULL REFERENCES content(id) ON DELETE CASCADE,
    userid INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    parentid INTEGER REFERENCES comments(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    createdat TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_comments_content ON comments (contentid, createdat DESC)`,
  `CREATE TABLE IF NOT EXISTS commentvotes (
    userid INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    commentid INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
    value SMALLINT NOT NULL,
    createdat TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (userid, commentid)
  )`,
  `CREATE TABLE IF NOT EXISTS contentlikes (
    contentid INTEGER NOT NULL REFERENCES content(id) ON DELETE CASCADE,
    userid INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    value SMALLINT NOT NULL,
    createdat TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (contentid, userid)
  )`,
  `CREATE TABLE IF NOT EXISTS viewevents (
    id SERIAL PRIMARY KEY,
    contentid INTEGER NOT NULL REFERENCES content(id) ON DELETE CASCADE,
    userid INTEGER REFERENCES users(id) ON DELETE SET NULL,
    event TEXT NOT NULL DEFAULT 'view',
    createdat TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_viewevents_content ON viewevents (contentid)`,
  `CREATE INDEX IF NOT EXISTS idx_viewevents_created ON viewevents (createdat DESC)`,
  `CREATE TABLE IF NOT EXISTS subscriptions (
    id SERIAL PRIMARY KEY,
    userid INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    provider TEXT NOT NULL DEFAULT 'stripe-sandbox',
    sessionid TEXT,
    stripecustomerid TEXT,
    stripesubscriptionid TEXT,
    currentperiodend TIMESTAMPTZ,
    createdat TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions (userid, createdat DESC)`,
  `CREATE TABLE IF NOT EXISTS auditlogs (
    id SERIAL PRIMARY KEY,
    userid INTEGER REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    ip TEXT,
    meta JSONB,
    createdat TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_auditlogs_created ON auditlogs (createdat DESC)`,
  `CREATE TABLE IF NOT EXISTS aichats (
    id SERIAL PRIMARY KEY,
    contentid INTEGER REFERENCES content(id) ON DELETE CASCADE,
    userid INTEGER REFERENCES users(id) ON DELETE SET NULL,
    role TEXT NOT NULL,
    message TEXT NOT NULL,
    createdat TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_aichats_content ON aichats (contentid, createdat ASC)`,
  // Phase 6 (additive): one-shot password reset codes.
  `CREATE TABLE IF NOT EXISTS passwordresets (
    id SERIAL PRIMARY KEY,
    userid INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    codehash TEXT NOT NULL,
    expiresat TIMESTAMPTZ NOT NULL,
    used BOOLEAN NOT NULL DEFAULT FALSE,
    createdat TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_passwordresets_user ON passwordresets (userid, createdat DESC)`,
];

/**
 * Ensure all platform tables exist. Idempotent — every statement uses
 * IF NOT EXISTS. Returns the number of statements executed.
 */
export async function ensurePlatformSchema() {
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
  logger.info(`[platform] Schema verified — ${applied}/${DDL_STATEMENTS.length} statements OK (users, tokens, watchlist, history, comments, votes, likes, views, subscriptions, audit, aichats, passwordresets)`);
  return { applied, total: DDL_STATEMENTS.length };
}

export default ensurePlatformSchema;
