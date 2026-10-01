/**
 * services/mobile-service/health.js — Readiness checks for GET /health.
 *
 *   checks: {
 *     db:      true|false           — pg ping (true on local fallback)
 *     content: { total: n }         — COUNT(*) FROM content (the feed every
 *                                     /api/mobile/home row is built from)
 *   }
 *
 * createService reports status 'degraded' when any check value is
 * false/null/undefined and always adds worker + rateLimit extras (the worker
 * detail carries the last content count + db driver too).
 */

import { ping, countContent } from '@animaxia/common/db.js';

/** Readiness: DB ping + the content count powering the home rows. */
export async function mobileReadiness() {
  const db = await ping();
  const total = await countContent();
  return {
    db,
    content: { total },
  };
}

export default mobileReadiness;
