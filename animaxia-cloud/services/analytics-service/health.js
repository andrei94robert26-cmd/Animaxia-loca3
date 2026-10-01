/**
 * services/analytics-service/health.js — Readiness checks for the analytics
 * service.
 *
 * Surfaced by createService at GET /health as `checks`:
 *   { db: true|false } — pg pool answers SELECT 1 within 3s (or the local
 *                        fallback store, which pings trivially true).
 *
 * The `dailyviewrollups` table is deliberately NOT a readiness check: it is
 * owned and ensured by the worker thread (idempotent DDL on every run), so a
 * not-yet-created rollup table only means the first 15-minute tick has not
 * landed — the live /api/analytics endpoints query `viewevents` directly and
 * are unaffected.
 */

import { ping } from '@animaxia/common/db.js';

export async function readiness() {
  return { db: await ping() };
}

export default readiness;
