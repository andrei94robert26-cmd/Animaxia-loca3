/**
 * domain/aicloud/admin.js — Admin AI (Phase 4, requirement 6).
 *
 * CLOUD PORT NOTE: imported verbatim from the monolith
 * modules/aicloud/admin.js — only the import of platform/sql.js was
 * rewritten to @animaxia/common/sql.js (BLUEPRINT §4 import map).
 *
 * Aggregations over the llm-core usage ring (every LLM call: provider, mode,
 * tokens, cost, latency, status) + vector-service index stats. Powers the
 * Admin → AI Cloud dashboard: LLM usage, token cost, error rate, latency,
 * top prompts and recent errors.
 *
 * Endpoints (router, requireAdmin):
 *   GET /api/ai/admin/stats   — usage, cost, error rate, latency p50/p95, vector
 *   GET /api/ai/admin/prompts — top prompts + recent call log
 *   GET /api/ai/admin/errors  — recent failed calls + error rate
 */

import { llmUsageStats, llmTopPrompts, llmUsageRecent, llmUsageErrors, llmProviderStatus } from './llm-core.js';
import { vectorStatus } from './vector-service.js';
import { TOOLS } from './tools.js';
import { rows } from '@animaxia/common/sql.js';

/** Total persisted aiusagelogs rows (Neon) — null on the local driver. */
async function persistedCount() {
  try {
    const result = await rows(`SELECT COUNT(*)::int AS count FROM aiusagelogs`);
    return result[0]?.count ?? null;
  } catch {
    return null;
  }
}

/** GET /api/ai/admin/stats */
export async function adminStats() {
  const usage = llmUsageStats();
  const vector = await vectorStatus().catch(() => ({ backend: 'mock', counts: {} }));
  const persisted = await persistedCount();
  return {
    ok: true,
    provider: llmProviderStatus(),
    usage: {
      totalCalls: usage.totalCalls,
      callsToday: usage.callsToday,
      errors: usage.errors,
      errorRate: usage.errorRate,
      degradedCalls: usage.degradedCalls,
      tokens: usage.tokens,
      costUsd: usage.costUsd,
      byProvider: usage.byProvider,
      byFeature: usage.byFeature,
      byMode: usage.byMode,
      latency: usage.latency,
      persistedLogs: persisted,
      ringSize: usage.ringSize,
    },
    vector,
    assistant: { tools: TOOLS.length, toolNames: TOOLS.map((t) => t.name) },
    generatedat: new Date().toISOString(),
  };
}

/** GET /api/ai/admin/prompts?limit= */
export async function adminPrompts(limit = 20) {
  return {
    ok: true,
    topPrompts: llmTopPrompts(10),
    recent: llmUsageRecent(limit).map((e) => ({
      traceid: e.traceid,
      userid: e.userid,
      feature: e.feature,
      mode: e.mode,
      provider: e.provider,
      tokens: e.prompttokens + e.completiontokens,
      latencyms: e.latencyms,
      status: e.status,
      degraded: e.degraded,
      snippet: e.promptsnippet,
      createdat: e.createdat,
    })),
  };
}

/** GET /api/ai/admin/errors?limit= */
export async function adminErrors(limit = 20) {
  const usage = llmUsageStats();
  return {
    ok: true,
    total: usage.errors,
    errorRate: usage.errorRate,
    recent: llmUsageErrors(limit).map((e) => ({
      traceid: e.traceid,
      userid: e.userid,
      feature: e.feature,
      mode: e.mode,
      provider: e.provider,
      message: e.errormessage,
      snippet: e.promptsnippet,
      createdat: e.createdat,
    })),
  };
}
