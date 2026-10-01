/**
 * services/premium-service/health.js — Readiness checks for GET /health
 * (mounted by createService): PostgreSQL ping + live premium counters,
 * proving both connectivity AND that the platform schema (users /
 * subscriptions) is queryable.
 *
 * Returns { db: boolean, paidUsers: number, subscriptions: number } — the
 * health router marks the service "degraded" (HTTP still 200, liveness
 * semantics) when any value is false/null/undefined.
 */

import { ping } from '@animaxia/common/db.js';
import { one, num } from '@animaxia/common/sql.js';

export async function readiness() {
  const db = await ping();
  let paidUsers = null;
  let subscriptions = null;
  if (db) {
    try {
      const [paid, subs] = await Promise.all([
        one(
          `SELECT COUNT(*)::int AS count FROM users
            WHERE plan <> 'free' AND (planexpiresat IS NULL OR planexpiresat > NOW())`,
        ),
        one(`SELECT COUNT(*)::int AS count FROM subscriptions`),
      ]);
      paidUsers = num(paid?.count);
      subscriptions = num(subs?.count);
    } catch {
      paidUsers = null; // schema not applied yet → readiness fails, liveness stays 200
      subscriptions = null;
    }
  }
  return { db, paidUsers, subscriptions };
}

export default readiness;
