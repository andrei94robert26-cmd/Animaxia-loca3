/**
 * services/content-service/health.js — Readiness checks for GET /health.
 *
 * Replaces the monolith's GET /api/health content summary (in the cloud the
 * gateway owns /api/health and fan-outs to each service's own /health):
 *
 *   checks: {
 *     db:      true|false                — pg ping (true on local fallback)
 *     content: { total: n, byType: {...} } — countContent + countsByType
 *   }
 *
 * createService reports status 'degraded' when any check value is
 * false/null/undefined and always adds worker + rateLimit extras.
 */

import { ping, countContent, countsByType } from '@animaxia/common/db.js';

/** Readiness: DB ping + a content summary (db-light: two COUNT queries). */
export async function contentReadiness() {
  const db = await ping();
  const [total, byType] = await Promise.all([countContent(), countsByType()]);
  return {
    db,
    content: { total, byType },
  };
}

export default contentReadiness;
