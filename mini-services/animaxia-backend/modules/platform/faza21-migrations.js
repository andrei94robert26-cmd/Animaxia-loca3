/**
 * modules/platform/faza21-migrations.js — FAZA 21 (user account + playerhub) DDL.
 *
 * Idempotent CREATE TABLE/INDEX IF NOT EXISTS for the FAZA-21 tables:
 *   • playlists       — user-owned playlists (title + description, updatedat)
 *   • playlistitems   — ordered content references (position, unique per pair)
 *   • subtitles       — WebVTT subtitle tracks per content (unique per
 *                       content+lang+label), served publicly as {id}.vtt
 *
 * House style: lowercase columns without underscores, TIMESTAMPTZ defaults,
 * FK REFERENCES users(id)/playlists(id)/content(id) ON DELETE CASCADE — same
 * conventions as modules/platform/migrations.js and social-migrations.js.
 * This file is ADDITIVE: it never alters or drops anything and does not touch
 * any pre-existing table.
 *
 * Runs at boot from server.js AFTER ensureShardingSchema() (FK dependencies:
 * users, content already exist by then). Safe to re-run on every boot.
 */

import { logger } from '../../utils/logger.js';
import { rows } from './sql.js';

const DDL_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS playlists (
    id BIGSERIAL PRIMARY KEY,
    userid INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    createdat TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updatedat TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_playlists_user ON playlists (userid)`,
  `CREATE TABLE IF NOT EXISTS playlistitems (
    id BIGSERIAL PRIMARY KEY,
    playlistid INT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    contentid INT NOT NULL REFERENCES content(id) ON DELETE CASCADE,
    position INT NOT NULL DEFAULT 0,
    addedat TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (playlistid, contentid)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_playlistitems_playlist ON playlistitems (playlistid, position)`,
  `CREATE TABLE IF NOT EXISTS subtitles (
    id BIGSERIAL PRIMARY KEY,
    contentid INT NOT NULL REFERENCES content(id) ON DELETE CASCADE,
    lang TEXT NOT NULL DEFAULT 'ro',
    label TEXT NOT NULL DEFAULT 'Română',
    vtt TEXT NOT NULL,
    createdby INT,
    createdat TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (contentid, lang, label)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_subtitles_content ON subtitles (contentid)`,
];

/**
 * Ensure all FAZA-21 tables exist. Idempotent. Returns the number of
 * statements applied. Throws on the first failure so boot knows the FAZA-21
 * routes must answer 503 (the error middleware maps err.status when present).
 */
export async function ensureFaza21Schema() {
  let applied = 0;
  for (const statement of DDL_STATEMENTS) {
    try {
      await rows(statement);
      applied += 1;
    } catch (err) {
      logger.error(`[faza21] Migration statement failed: ${err.message}`);
      throw err;
    }
  }
  logger.info(
    `[faza21] Schema verified — ${applied}/${DDL_STATEMENTS.length} statements OK (playlists, playlistitems, subtitles)`,
  );
  return { applied, total: DDL_STATEMENTS.length };
}

export default ensureFaza21Schema;
