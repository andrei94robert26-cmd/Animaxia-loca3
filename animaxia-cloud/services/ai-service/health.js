/**
 * services/ai-service/health.js — Readiness checks for the AI service.
 *
 * Surfaced by createService at GET /health as `checks`:
 *   { db: true|false } — pg pool answers SELECT 1 within 3s (or the local
 *                        fallback store, which pings trivially true).
 *
 * The z-ai provider is deliberately NOT a readiness check: the domain module
 * degrades to deterministic heuristic answers when the SDK is unavailable
 * (missing .z-ai-config, upstream timeout), which is a fully valid serving
 * mode. Provider liveness/usage lives at GET /api/ai/status instead
 * (provider, available, model, requestsToday, quota) — do not gate pods on
 * an external LLM.
 */

import { ping } from '@animaxia/common/db.js';

export async function readiness() {
  return { db: await ping() };
}

export default readiness;
