/**
 * modules/users/auth-extra-migrations.js — TS3 (auth avansat) DDL.
 *
 * Idempotent additions for the advanced-auth surface:
 *   • users.emailverified   — email verification state (SMTP-aware register)
 *   • users.twofasecret     — base32 TOTP shared secret (NULL until setup)
 *   • users.twofaenabled    — TOTP enforcement flag (true only after the user
 *                             confirms a working authenticator code)
 *   • emailtokens           — single-use, 24h-bounded email verification
 *                             tokens (token TEXT PK, purpose, expiresat, usedat)
 *
 * House style: lowercase columns, TIMESTAMPTZ, FK REFERENCES users(id) ON DELETE
 * CASCADE — same conventions as faza21-migrations.js / integrity-migrations.js.
 * This file is ADDITIVE: it never drops or redefines anything.
 *
 * Runs at boot from server.js after ensureFaza21Schema() (users already
 * exists). Safe to re-run on every boot.
 */

import { logger } from '../../utils/logger.js';
import { rows } from '../platform/sql.js';

const DDL_STATEMENTS = [
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS emailverified BOOLEAN DEFAULT false`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS twofasecret TEXT DEFAULT NULL`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS twofaenabled BOOLEAN DEFAULT false`,
  `CREATE TABLE IF NOT EXISTS emailtokens (
    token TEXT PRIMARY KEY,
    userid INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose TEXT NOT NULL,
    expiresat TIMESTAMPTZ NOT NULL,
    usedat TIMESTAMPTZ DEFAULT NULL,
    createdat TIMESTAMPTZ DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_emailtokens_user ON emailtokens (userid)`,
  `CREATE INDEX IF NOT EXISTS idx_emailtokens_purpose ON emailtokens (purpose) WHERE usedat IS NULL`,
];

/**
 * Ensure the auth-extra columns/table exist. Idempotent. Returns the number of
 * statements applied; throws on the first failure so boot logs the degraded
 * state (email-verify/2FA answer 4xx/5xx honestly instead of silently
 * misbehaving).
 */
export async function ensureAuthExtraSchema() {
  for (const stmt of DDL_STATEMENTS) {
    await rows(stmt);
  }
  logger.info(`[auth-extra] Schema verified — ${DDL_STATEMENTS.length}/${DDL_STATEMENTS.length} statements OK`);
  return DDL_STATEMENTS.length;
}

export default ensureAuthExtraSchema;
