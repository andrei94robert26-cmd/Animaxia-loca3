/**
 * modules/social/social-migrations.js — FAZA 10 (Social & Real-Time) DDL.
 *
 * Idempotent CREATE TABLE/INDEX IF NOT EXISTS for the social layer tables:
 * follows, reviews, reviewlikes, activityevents (social feed v2 source),
 * watchparties, watchpartymembers, partymessages.
 *
 * House style: lowercase columns without underscores, TIMESTAMPTZ defaults,
 * FK REFERENCES users(id)/content(id) ON DELETE CASCADE — same conventions as
 * modules/platform/migrations.js (Phase 2). This file is ADDITIVE: it never
 * alters or drops anything and does not touch Phase-2 tables.
 *
 * Runs at boot from server.js AFTER ensurePlatformSchema() (FK dependencies:
 * users, content already exist by then). Safe to re-run on every boot.
 */

import { logger } from '../../utils/logger.js';
import { rows } from '../platform/sql.js';

const DDL_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS follows (
    id SERIAL PRIMARY KEY,
    followerid INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    followeeid INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    createdat TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (followerid, followeeid)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows (followerid)`,
  `CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows (followeeid)`,
  `CREATE TABLE IF NOT EXISTS reviews (
    id SERIAL PRIMARY KEY,
    userid INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    contentid INTEGER NOT NULL REFERENCES content(id) ON DELETE CASCADE,
    rating INTEGER NOT NULL,
    title TEXT,
    body TEXT NOT NULL,
    createdat TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedat TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (userid, contentid)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_reviews_content ON reviews (contentid, createdat DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_reviews_recent ON reviews (createdat DESC)`,
  `CREATE TABLE IF NOT EXISTS reviewlikes (
    userid INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reviewid INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
    createdat TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (userid, reviewid)
  )`,
  `CREATE TABLE IF NOT EXISTS activityevents (
    id SERIAL PRIMARY KEY,
    actorid INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    contentid INTEGER REFERENCES content(id) ON DELETE SET NULL,
    targetuserid INTEGER REFERENCES users(id) ON DELETE SET NULL,
    metadata JSONB NOT NULL DEFAULT '{}',
    createdat TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_activity_actor ON activityevents (actorid, createdat DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_activity_created ON activityevents (createdat DESC, id DESC)`,
  `CREATE TABLE IF NOT EXISTS watchparties (
    id SERIAL PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    hostid INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    contentid INTEGER NOT NULL REFERENCES content(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    isprivate BOOLEAN NOT NULL DEFAULT FALSE,
    status TEXT NOT NULL DEFAULT 'active',
    state JSONB NOT NULL DEFAULT '{}',
    createdat TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedat TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_watchparties_active ON watchparties (status, updatedat DESC)`,
  `CREATE TABLE IF NOT EXISTS watchpartymembers (
    partyid INTEGER NOT NULL REFERENCES watchparties(id) ON DELETE CASCADE,
    userid INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member',
    joinedat TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (partyid, userid)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_watchpartymembers_user ON watchpartymembers (userid)`,
  `CREATE TABLE IF NOT EXISTS partymessages (
    id SERIAL PRIMARY KEY,
    partyid INTEGER NOT NULL REFERENCES watchparties(id) ON DELETE CASCADE,
    userid INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    createdat TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_partymessages_party ON partymessages (partyid, id DESC)`,
];

/**
 * Ensure all FAZA-10 social tables exist. Idempotent. Returns the number of
 * statements applied. Throws on the first failure so boot knows social routes
 * must answer 503 (the error middleware maps err.status when present).
 */
export async function ensureSocialSchema() {
  let applied = 0;
  for (const statement of DDL_STATEMENTS) {
    try {
      await rows(statement);
      applied += 1;
    } catch (err) {
      logger.error(`[social] Migration statement failed: ${err.message}`);
      throw err;
    }
  }
  logger.info(
    `[social] Schema verified — ${applied}/${DDL_STATEMENTS.length} statements OK (follows, reviews, reviewlikes, activityevents, watchparties, watchpartymembers, partymessages)`,
  );
  return { applied, total: DDL_STATEMENTS.length };
}

export default ensureSocialSchema;
