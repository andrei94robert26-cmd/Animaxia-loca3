/**
 * services/search-service/health.js — Readiness checks for the search
 * service.
 *
 * Surfaced by createService at GET /health as `checks`:
 *   { db: true|false } — pg pool answers SELECT 1 within 3s (or the local
 *                        fallback store, which pings trivially true).
 *
 * The index itself is deliberately NOT a readiness check: it lives in
 * process memory, starts dirty and rebuilds lazily on the first query (or
 * when the worker flags it dirty) — an unbuilt index still serves requests
 * (the rebuild happens inline, under the domain module's async lock). Live
 * index state is public at GET /api/search/status
 * ({ docs, terms, lastSync, dirty, engine }).
 */

import { ping } from '@animaxia/common/db.js';

export async function readiness() {
  return { db: await ping() };
}

export default readiness;
