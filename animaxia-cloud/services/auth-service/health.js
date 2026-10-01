/**
 * services/auth-service/health.js — Readiness checks for GET /health
 * (mounted by createService): PostgreSQL ping + a live users count, proving
 * both connectivity AND that the platform schema is queryable.
 *
 * Returns { db: boolean, users: number } — the health router marks the
 * service "degraded" (HTTP still 200, liveness semantics) when any value is
 * false/null/undefined, so a schema-less database or a dead pool shows up as
 * users: null.
 */

import { ping } from '@animaxia/common/db.js';
import { one, num } from '@animaxia/common/sql.js';

export async function readiness() {
  const db = await ping();
  let users = null;
  if (db) {
    try {
      const row = await one(`SELECT COUNT(*)::int AS count FROM users`);
      users = num(row?.count);
    } catch {
      users = null; // schema not applied yet → readiness fails, liveness stays 200
    }
  }
  return { db, users };
}

export default readiness;
