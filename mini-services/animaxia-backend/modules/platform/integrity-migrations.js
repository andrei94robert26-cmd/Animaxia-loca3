/**
 * modules/platform/integrity-migrations.js — TS1 (security/integrity) DDL.
 *
 * Data-integrity hardening of pre-existing tables (idempotent — safe to re-run
 * on every boot, pattern of faza21-migrations.js):
 *   • users          — dedup legacy case-insensitive duplicate usernames, then
 *                      enforce UNIQUE (lower(username)) via a unique index;
 *   • searchdocs     — delete orphaned rows (contentid without a content row),
 *                      then add FK searchdocs_contentid_fkey → content(id)
 *                      ON DELETE CASCADE (PG has no IF NOT EXISTS for
 *                      constraints → DO $$ … pg_constraint guard);
 *   • contentsources — same orphan cleanup + FK (column verified: contentid,
 *                      INTEGER NULLABLE — dedup.js registers sources with
 *                      contentId on every upsert);
 *   • playlistitems / subtitles — already FK-protected since FAZA 21
 *                      (REFERENCES content(id) ON DELETE CASCADE), untouched.
 *
 * Deliberately NO FK on miner_* tables: the miner queues/sources/manifests
 * keep WEAK references to content by design (contentid is a soft link — jobs
 * must survive content deletion and re-run against re-created ids), verified
 * in modules/miner/miner-migrations.js (contentid INTEGER NOT NULL, no
 * REFERENCES clause).
 *
 * This file never alters or drops pre-existing columns/tables; the only data
 * mutation is the username dedup (append `-<id>` to later duplicates —
 * deterministic and idempotent) and the orphan DELETEs.
 */

import { logger } from '../../utils/logger.js';
import { rows } from './sql.js';

const DDL_STATEMENTS = [
  // 1) Dedup legacy usernames case-insensitively: keep the earliest row per
  //    lower(username), suffix every later duplicate with its own id.
  //    Idempotent — once applied there is at most one row per lower(username).
  `UPDATE users
     SET username = username || '-' || id
   WHERE id NOT IN (SELECT MIN(id) FROM users GROUP BY lower(username))`,
  // 2) Enforce it from now on (case-insensitive uniqueness).
  `CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_unique ON users (lower(username))`,
  // 3) Orphan cleanup — index rows whose content is gone (FKs below then keep
  //    them from reappearing).
  `DELETE FROM searchdocs WHERE contentid IS NOT NULL AND contentid NOT IN (SELECT id FROM content)`,
  `DELETE FROM contentsources WHERE contentid IS NOT NULL AND contentid NOT IN (SELECT id FROM content)`,
  // 4) FK searchdocs.contentid → content.id (ON DELETE CASCADE). No
  //    IF NOT EXISTS for constraints in PG → pg_constraint guard in DO block.
  // 5) Same for the dedup registry (contentsources.contentid → content.id).
];

/**
 * Ensure the integrity constraints exist. Idempotent. Throws on the first
 * failure so boot can log the degradation (previous behavior — no FK
 * enforcement — keeps the platform fully usable).
 */
export async function ensureIntegritySchema() {
  let applied = 0;
  for (const statement of DDL_STATEMENTS) {
    try {
      await rows(statement);
      applied += 1;
    } catch (err) {
      logger.error(`[integrity] Migration statement failed: ${err.message}`);
      throw err;
    }
  }
  logger.info(
    `[integrity] Schema verified — ${applied}/${DDL_STATEMENTS.length} statements OK (unique usernames, orphans cleaned, FKs searchdocs/contentsources → content)`,
  );
  return { applied, total: DDL_STATEMENTS.length };
}

export default ensureIntegritySchema;
