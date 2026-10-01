/**
 * services/queue-service/health.js — Readiness checks for /health.
 *
 * Two checks:
 *   • db    — pg pool ping (createHealthRouter marks the service degraded
 *             when any check is false/null/undefined)
 *   • queue — live queueStats snapshot (pending/running/deadLetters). When the
 *             SQL layer is unavailable (Postgres down → local fallback store,
 *             where the `jobs` table cannot exist) the check is explicitly
 *             false: a queue-service without its queue IS degraded, even
 *             though the process itself stays alive (liveness still 200).
 */

import { ping } from '@animaxia/common/db.js';
import { queueStats } from '@animaxia/common/queue.js';

export async function readiness() {
  const db = await ping();
  let queue = null;
  try {
    const stats = await queueStats();
    queue = {
      pending: stats.byStatus.pending?.count ?? 0,
      running: stats.byStatus.running?.count ?? 0,
      deadLetters: stats.deadLetters ?? 0,
    };
  } catch {
    queue = false; // jobs table unreachable — degraded (see header)
  }
  return { db, queue };
}

export default readiness;
