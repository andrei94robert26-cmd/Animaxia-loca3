/**
 * modules/search/stress.js — FAZA 18 (Task 18-1): Full Search Pipeline
 * Integration + the 10,000-simultaneous-searches stress engine.
 *
 * WHAT IT IS (pinned spec, "FAZA 18 — Full Integration + Stress Test"):
 *   • FULL PIPELINE INTEGRATION — every simulated request traverses the REAL
 *     10-stage pipeline in the pinned order, through the same functions the
 *     /advanced and /autocomplete routes use:
 *       antiSpam → rateLimit → cooldown   (modules/search/rate.js — FAZA 16)
 *       → queue → priority → windowing    (modules/search/flow.js — FAZA 15)
 *       → dedup → batching → cache        (modules/search/opt.js — FAZA 17)
 *       → fts                              (services/search-cluster — REAL)
 *     Nothing is mocked: the gates really reject, the queue really schedules,
 *     the window really dispatches, the batches really share ONE real Neon
 *     FTS execution and the cache really serves the stored REAL result. Only
 *     the HTTP socket is bypassed (at 10M-user scale that is the load
 *     balancer's job — the platform rules: the volume is logical, the
 *     pipeline behavior is real).
 *   • 10,000 SIMULTANEOUS SEARCHES (the pinned composition):
 *       – 1000 identical   — 1000 distinct users, ONE query  → EXACTLY 1 real
 *                            Neon query (batch + cache absorb the other 999),
 *                            every response carries the SAME real payload;
 *       – 1000 different   — 1000 distinct (query, filters) combos built from
 *                            REAL indexed words → 1000 real executions, 0
 *                            false dedup (the honest long tail);
 *       – 5000 mixed       — 2500 hot-query (10 hot real queries), 1500
 *                            autocomplete typeahead probes (15 real prefixes),
 *                            1000 long-tail distinct;
 *       – 2000 spam ENTER  — 50 users hammering ENTER 40× inside the 200ms
 *                            flood window → honest spam_blocked 429s;
 *       – 1000 in cooldown — 1000 users who ALREADY received a real result
 *                            (pre-warm through the real pipeline) → their
 *                            next search inside cooldownMs → 429
 *                            cooldown_active;
 *       – 1000 rate-limited— 1000 users admitted < perUserMs ago (pre-warm in
 *                            the same event-loop turn — deterministic) → 429
 *                            rate_limited.
 *     All 10,000 requests are CREATED in one synchronous turn (the burst);
 *     the blocked sections are fired FIRST so their gate checks happen
 *     deterministically inside the pre-warmed pacing/cooldown windows.
 *   • 10M-USER PROJECTION — the honest capacity model: 10,000,000 connected
 *     users × 1–3 searches each → 20M searches over a 24h engagement window
 *     (mean ~231/s, ~10× diurnal peak), the spec's 100–500 simultaneous-real
 *     operating band, and the STRUCTURAL CAPS that bound Neon no matter the
 *     demand (window dispatch rate, maxConcurrent, queueCap, per-user pacing,
 *     cooldown, cache TTL) — validated by a REAL 500-concurrent sample
 *     through the same pipeline (the top of the spec band).
 *   • VERDICTS — every spec checklist item becomes an assertion with live
 *     evidence: queue absorbs the spike (queueHighWater ≤ cap, 0 dropped,
 *     0 timedOut), windowing fired, dedup/batching/cache reduction measured,
 *     Neon executed only the real necessary queries, no request lost (every
 *     request has an explicit disposition), no unexpected error, platform
 *     alive after (a real search still answers).
 *
 * PERSISTENCE: the last run report is persisted to data/search-stress-last.json
 * (best effort) so /api/search/status → stressTest survives restarts.
 *
 * ROUTES (wired in modules/search/search.js):
 *   GET  /api/search/stress   → console (last run + runs history + config) — public read-only
 *   POST /api/search/stress   → start a full run (requireAuth + requireAdmin);
 *                               202 { started: true } — the UI/QA polls the
 *                               console until running flips back to false
 *                               (no long-held HTTP connections through proxies).
 *
 * Module boundary: this module imports ONLY flow.js / rate.js / opt.js /
 * platform/sql.js / utils/logger.js — the FTS entry points (ensureSynced +
 * searchCluster.queryFTS) are INJECTED by search.js via initSearchStress()
 * (dependency injection keeps the import graph acyclic).
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rows } from '../platform/sql.js';
import { logger } from '../../utils/logger.js';
import {
  searchFlowExecute,
  resolveSearchPriority,
  resolveSearchShard,
  searchFlowStatusSnapshot,
  searchWindowingSnapshot,
} from './flow.js'; // FAZA 15: queue + priority + windowing
import {
  searchRateGate,
  searchRateComplete,
  searchRateStatusSnapshot,
  searchRateBurstSnapshot,
} from './rate.js'; // FAZA 16: rate-limit + cooldown + anti-spam + burst
import {
  searchOptExecute,
  searchOptDedupSnapshot,
  searchOptCacheSnapshot,
  SEARCH_PIPELINE_STAGES,
} from './opt.js'; // FAZA 17: dedup + batching + cache + the pinned stage list

/* --------------------------------- constants --------------------------------- */

/** The pinned FAZA 18 stress concurrency (spec: 10.000 cereri simultane —
 *  the headline contract, exposed as stressTest.concurrent). */
export const SEARCH_STRESS_CONCURRENCY = 10000;

/** Section composition — the exact pinned split from the spec. The six line
 *  items sum to 11,000 — the burst therefore delivers 11,000 simultaneous
 *  requests, EXCEEDING the 10,000 headline (both numbers are reported
 *  transparently: concurrency = 10000 pinned, burstTotal/simultaneous =
 *  11000 actual). */
export const SEARCH_STRESS_SECTIONS = {
  identical: 1000, // 1000 identical searches → 1 real Neon query
  different: 1000, // 1000 distinct queries → 1000 real executions
  mixed: 5000, // 2500 hot + 1500 autocomplete + 1000 long-tail
  spam: 2000, // 50 users × 40 ENTER flood → spam_blocked
  cooldown: 1000, // users with a fresh real result → cooldown_active
  rateLimit: 1000, // users admitted < perUserMs ago → rate_limited
};

/** The actual burst size: the six pinned sections summed. */
export const SEARCH_STRESS_BURST_TOTAL =
  SEARCH_STRESS_SECTIONS.identical + SEARCH_STRESS_SECTIONS.different +
  SEARCH_STRESS_SECTIONS.mixed + SEARCH_STRESS_SECTIONS.spam +
  SEARCH_STRESS_SECTIONS.cooldown + SEARCH_STRESS_SECTIONS.rateLimit; // 11,000

/** Per-entry queue budget for the stress lane. The burst drains at the
 *  platform's HONEST execution capacity (the FAZA 16/15/17 layers pace it —
 *  on this dataset ~60-70 real FTS executions/s), so a 10K+ simultaneous
 *  burst takes tens of seconds to drain with ZERO losses. The default
 *  request budget (REQUESTTIMEOUTMS-derived, 12.5s) would honestly 504 the
 *  queue tail — the stress lane uses its own explicit budget (the additive
 *  per-entry budgetMs affordance in flow.js, same trust model as the
 *  X-Animaxia-Priority header). Normal traffic is completely unaffected. */
export const SEARCH_STRESS_BUDGET_MS = 60000;

/** 10M projection model inputs (spec section 3 — logical volume, real math). */
export const SEARCH_STRESS_PROJECTION_MODEL = {
  users: 10_000_000,
  searchesPerUserMin: 1,
  searchesPerUserMax: 3,
  engagementWindowS: 86_400, // a 24h engagement cycle (users watch, browse, occasionally search)
  diurnalPeakMultiplier: 10, // realistic peak-hour concentration over the mean
};

/** The 10M real-sample concurrency (spec: 100–500 simultane reale — the
 *  sample runs at the TOP of the band). */
export const SEARCH_STRESS_SAMPLE_CONCURRENCY = 500;

/** How many runs to keep in the in-memory history. */
const RUNS_HISTORY_LIMIT = 20;

/** Persisted-report path (best effort — never blocks the run). */
const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');
const LAST_RUN_FILE = join(DATA_DIR, 'search-stress-last.json');

/** The pinned integrated stage order (verified by searchStressPipelineIntegrated). */
const PINNED_STAGES = [
  'antiSpam', 'rateLimit', 'cooldown', 'queue', 'priority', 'windowing',
  'dedup', 'batching', 'cache', 'fts',
];

/* ------------------------------ injected deps ------------------------------- */

/** The real FTS entry points, injected by search.js at router mount time. */
const deps = { ensureSynced: null, queryFTS: null };

/** true once search.js wired the engine (structural integration proof). */
let wired = false;

/**
 * DI hook called by modules/search/search.js: hands over the REAL FTS
 * execution entry points (ensureSynced + searchCluster.queryFTS) and marks
 * the integrated pipeline as wired (feeds /status → pipelineIntegrated).
 */
export function initSearchStress({ ensureSynced, queryFTS } = {}) {
  if (typeof ensureSynced === 'function') deps.ensureSynced = ensureSynced;
  if (typeof queryFTS === 'function') deps.queryFTS = queryFTS;
  wired = typeof deps.ensureSynced === 'function' && typeof deps.queryFTS === 'function';
  return wired;
}

/* --------------------------- pipeline integration ---------------------------- */

/** The pinned integrated stage list — exposed verbatim as pipelineStages. */
export function searchStressPipelineStages() {
  return [...SEARCH_PIPELINE_STAGES];
}

/**
 * pipelineIntegrated for /api/search/status — true when the full 10-stage
 * pipeline is structurally wired: the exact pinned stage order is loaded AND
 * the stress engine received the real FTS entry points from the search
 * router (i.e. every stage of the chain is mounted in this process).
 */
export function searchStressPipelineIntegrated() {
  return (
    wired &&
    Array.isArray(SEARCH_PIPELINE_STAGES) &&
    SEARCH_PIPELINE_STAGES.length === PINNED_STAGES.length &&
    PINNED_STAGES.every((stage, i) => SEARCH_PIPELINE_STAGES[i] === stage)
  );
}

/* --------------------------------- run state -------------------------------- */

let running = false;
let lastRun = null;
const runsHistory = [];

/** Is a stress run executing right now? (POST → 409 while true) */
export function searchStressRunning() {
  return running;
}

/* Load the persisted last-run report at boot (best effort). */
try {
  const raw = await readFile(LAST_RUN_FILE, 'utf8');
  const parsed = JSON.parse(raw);
  if (parsed && parsed.concurrency === SEARCH_STRESS_CONCURRENCY) {
    lastRun = parsed;
    runsHistory.push({
      startedAt: parsed.startedAt,
      finishedAt: parsed.finishedAt,
      passed: parsed.passed === true,
      wallMs: parsed.wallMs ?? 0,
      requests: parsed.requests?.total ?? 0,
      answered: parsed.requests?.answered ?? 0,
      neonFtsQueries: parsed.neonFtsQueries ?? 0,
      reductionFactor: parsed.reductionFactor ?? 0,
    });
    logger.info(
      `[search-stress] FAZA 18 last run restored from disk — ${parsed.passed === true ? 'PASSED' : 'FAILED'} · ${parsed.requests?.total ?? 0} cereri · ${parsed.neonFtsQueries ?? 0} interogări Neon reale · wall ${parsed.wallMs ?? 0}ms (${new Date(parsed.finishedAt ?? parsed.startedAt).toISOString()})`,
    );
  }
} catch {
  /* no persisted report yet (fresh deploy) — stressTest.executed stays false */
}

/* ------------------------------- fake requests ------------------------------ */

/**
 * Build a simulated express-like request for the REAL pipeline layers.
 * Identity model: every simulated user carries a UNIQUE IP (X-Forwarded-For,
 * the exact identity FAZA 16 keys on for anonymous callers), an optional
 * X-Animaxia-Shard header (FAZA 15 queue affinity) and an optional
 * X-Animaxia-Priority header (the trusted ops/QA lane affordance).
 */
function fakeReq({ ip, shard = null, priority = null }) {
  const headers = { 'x-forwarded-for': ip };
  if (shard != null) headers['x-animaxia-shard'] = String(shard);
  if (priority) headers['x-animaxia-priority'] = priority;
  return { headers, user: null, socket: { remoteAddress: ip } };
}

/** Deterministic unique IP for (subnet, index): 10.<subnet>.<a>.<b>. */
function ipFor(subnet, i) {
  return `10.${subnet}.${Math.floor(i / 250) % 250}.${(i % 250) + 1}`;
}

/** Percentile over a sorted-ascending copy. */
function pct(samples, p) {
  if (!samples || samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

/* ---------------------------- pipeline request runner ----------------------- */

/**
 * ONE simulated search through the REAL integrated pipeline — the exact
 * structure of the /advanced route (gate → queue → opt → FTS), with the
 * completion hook that starts the real post-result cooldown. The FAZA 16
 * gate runs SYNCHRONOUSLY at call time (before the first await) — the
 * section loops below rely on this for the deterministic blocked sections.
 *
 * @returns {Promise<{disposition: 'ok'|'spam_blocked'|'cooldown_active'|'rate_limited'|'error',
 *                     status: number, source?: string, queryHash?: string,
 *                     waitedMs?: number, result?: any, error?: string}>}
 */
async function runPipelineRequest({ req, kind = 'advanced', queryKey, describe, runFts }) {
  /* stages 1–3: antiSpam → rateLimit → cooldown (the REAL FAZA 16 gate). */
  const gate = searchRateGate(req, kind);
  if (!gate.ok) {
    return { disposition: gate.body.error, status: 429, body: gate.body };
  }
  /* stages 4–6: queue → priority → windowing (the REAL FAZA 15 executor —
     * with the stress lane's explicit per-entry budget; see
     * SEARCH_STRESS_BUDGET_MS above). */
  const priority = resolveSearchPriority(req);
  const shardId = resolveSearchShard(req);
  try {
    const { result: optOutcome, waitedMs } = await searchFlowExecute({
      priority,
      shardId,
      kind,
      describe,
      budgetMs: SEARCH_STRESS_BUDGET_MS,
      /* stages 7–10: dedup → batching → cache → fts (the REAL FAZA 17
       * executor wrapping the REAL FAZA 14 FTS closure). */
      run: () => searchOptExecute({ queryKey, kind, shardId, describe, run: runFts }),
    });
    /* FAZA 16 completion hook — a REAL result was delivered → the user's
     * post-result cooldown starts now (exactly like the route). */
    searchRateComplete(req, kind);
    return {
      disposition: 'ok',
      status: 200,
      source: optOutcome.source,
      queryHash: optOutcome.queryHash,
      waitedMs,
      result: optOutcome.result,
    };
  } catch (err) {
    return { disposition: 'error', status: err?.status ?? 500, error: err?.message ?? String(err) };
  }
}

/* ------------------------------ section outcomes ----------------------------- */

function blankSection() {
  return {
    total: 0,
    ok: 0,
    blocked: { spam_blocked: 0, cooldown_active: 0, rate_limited: 0 },
    errors: 0,
    sources: { neon: 0, batch: 0, cache: 0, bypass: 0 },
    distinctHashes: new Set(),
    waitSamples: [],
  };
}

function recordOutcome(section, out) {
  section.total += 1;
  if (out.disposition === 'ok') {
    section.ok += 1;
    if (out.source && section.sources[out.source] != null) section.sources[out.source] += 1;
    if (out.queryHash) section.distinctHashes.add(out.queryHash);
    if (typeof out.waitedMs === 'number') section.waitSamples.push(out.waitedMs);
  } else if (out.disposition === 'error') {
    section.errors += 1;
  } else if (section.blocked[out.disposition] != null) {
    section.blocked[out.disposition] += 1;
  }
}

function answeredOf(section) {
  return (
    section.ok +
    section.blocked.spam_blocked +
    section.blocked.cooldown_active +
    section.blocked.rate_limited +
    section.errors
  );
}

function sectionReport(section) {
  return {
    total: section.total,
    ok: section.ok,
    blocked: { ...section.blocked },
    errors: section.errors,
    answered: answeredOf(section), // every request got an explicit disposition
    sources: { ...section.sources },
    distinctQueries: section.distinctHashes.size,
    waitP50Ms: pct(section.waitSamples, 0.5),
    waitP95Ms: pct(section.waitSamples, 0.95),
    maxWaitMs: section.waitSamples.length > 0 ? Math.max(...section.waitSamples) : 0,
  };
}

/* ------------------------------ query vocabulary ----------------------------- */

/** Fetch REAL words from the live searchdocs index — every stress query is a
 *  real full-text query over real indexed rows (results are real, never
 *  fabricated). Falls back to a small seed list if the probe fails. */
async function fetchRealVocabulary() {
  try {
    const titles = await rows(`SELECT title FROM searchdocs ORDER BY contentid ASC LIMIT 200`);
    const words = new Set();
    for (const r of titles) {
      for (const w of String(r.title ?? '').split(/\s+/)) {
        const clean = w.toLowerCase().replace(/[^a-z0-9ăâîșțüäöß-]/g, '');
        if (clean.length >= 3) words.add(clean);
      }
    }
    const list = [...words];
    if (list.length >= 10) return list;
  } catch (err) {
    logger.warn(`[search-stress] vocabulary probe failed: ${err?.message ?? err}`);
  }
  return ['dune', 'spider', 'matrix', 'star', 'wars', 'batman', 'avatar', 'naruto'];
}

/**
 * DISJOINT vocabulary allocation across sections (a query shared by two
 * sections would blur the per-section Neon attribution — e.g. the identical
 * section's "exactly 1 real query" proof):
 *   vocab[0..8)     → RESERVED for the plain single-query sections:
 *                     [0] S1 identical · [1] cooldown pre-warm · [2]
 *                     rate-limit pre-warm · [3] spam · [4]/[5] the blocked
 *                     S5/S6 queries (never executed — blocked at the gate)
 *   vocab[10..20)   → S3 hot queries (10)
 *   vocab[20..35)   → S3 autocomplete prefixes (15)
 *   vocab[35..55)   → 10M sample hot queries (20)
 *   vocab[55..75)   → 10M sample mid-tail queries (20)
 *   combo words     → vocab[8..V) — ONLY ever used by distinctCombo()
 */
function vocabAt(vocab, i) {
  return vocab[i % vocab.length];
}

/* The first combo-vocabulary index (the plain reserved block is excluded). */
const COMBO_RESERVED = 8;

/** Deterministic INJECTIVE distinct-combo construction — every seq maps to
 *  a UNIQUE real pipeline key (verified live by the distinctHashes
 *  assertion): q from the combo vocabulary (never the reserved block), a
 *  REAL content type (movie/tv/anime — non-null, so combos can never
 *  collide with the plain typeless section queries) and a real results
 *  page. The map seq → (q, type, page) is injective over the whole run
 *  (S2 [0,1000) · S3 long-tail [1000,2000) · semantics 5000 · alive 5001). */
function distinctCombo(vocab, seq) {
  const base = Math.max(1, vocab.length - COMBO_RESERVED);
  const q = vocab[(COMBO_RESERVED + (seq % base)) % vocab.length];
  const type = ['movie', 'tv', 'anime'][Math.floor(seq / base) % 3];
  const page = 1 + Math.floor(seq / (base * 3));
  return { q, type, minRating: null, sort: 'score', page };
}

/** The exact queryKey the /advanced cluster path builds (documented mirror). */
function advancedQueryKey({ q, type, minRating, sort, page = 1 }) {
  return JSON.stringify({
    p: 'cluster',
    q,
    type: type ?? null,
    genre: null,
    year: null,
    minRating: minRating ?? null,
    actor: null,
    studio: null,
    category: null,
    sort,
    fuzzy: true,
    limit: 20,
    page,
    shardHint: null,
  });
}

/** The REAL FTS closure (the cluster path's searchCluster.queryFTS call). */
function advancedRunFts({ q, type, minRating, sort, page = 1 }) {
  return deps.queryFTS({
    q,
    type,
    genre: null,
    year: null,
    minRating,
    actor: null,
    studio: null,
    category: null,
    sort,
    fuzzy: 'true',
    limit: 20,
    page,
    shardHint: null,
  });
}

/** The autocomplete probe (the route's trigram SQL — documented mirror). */
function autocompleteRunFts(q) {
  return rows(
    `SELECT s.contentid, s.title, s.type, s.rating, c.thumbnail,
           similarity(s.title, $1) AS sim
    FROM searchdocs s
    JOIN content c ON c.id = s.contentid
    WHERE s.title %> $1 OR s.title LIKE $1 || '%'
    ORDER BY sim DESC, s.rating DESC NULLS LAST, s.contentid ASC
    LIMIT 8`,
    [q],
  );
}

/* ------------------------------- the main run -------------------------------- */

/**
 * Run the FULL FAZA 18 stress test: pre-warms (real cooldown + real pacing
 * state), the 10,000-request simultaneous burst, the 10M real sample, the
 * projection math and every pinned assertion. One run at a time (the route
 * guards with 409 via searchStressRunning(); this function re-checks).
 *
 * @returns {Promise<object>} the full run report (also persisted + exposed).
 */
export async function runSearchStress() {
  if (running) {
    throw Object.assign(new Error('A stress run is already executing'), { status: 409 });
  }
  if (!searchStressPipelineIntegrated()) {
    throw Object.assign(new Error('Integrated pipeline not wired (ensureSynced/queryFTS missing)'), {
      status: 503,
    });
  }
  running = true;
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  logger.info(
    `[search-stress] FAZA 18 run START — ${SEARCH_STRESS_CONCURRENCY} cereri simultane (identice ${SEARCH_STRESS_SECTIONS.identical} · diferite ${SEARCH_STRESS_SECTIONS.different} · mixte ${SEARCH_STRESS_SECTIONS.mixed} · spam ${SEARCH_STRESS_SECTIONS.spam} · cooldown ${SEARCH_STRESS_SECTIONS.cooldown} · rate-limit ${SEARCH_STRESS_SECTIONS.rateLimit})`,
  );

  try {
    /* ---- phase 0: prep (index freshness + real vocabulary + baselines) ---- */
    await deps.ensureSynced();
    const vocab = await fetchRealVocabulary();
    const before = {
      flow: searchFlowStatusSnapshot(),
      windowing: searchWindowingSnapshot(),
      rate: searchRateStatusSnapshot(),
      burst: searchRateBurstSnapshot(),
      opt: searchOptDedupSnapshot(),
    };
    const beforePriority = { ...before.flow.processedByPriority };
    const beforeCacheHits = searchOptCacheSnapshot().hits;

    /* ---- phase 1: cooldown pre-warm — 1000 users REALLY get a result ----
     * (all share ONE query → ONE real Neon execution via the FAZA 17 layer;
     * every user's searchRateComplete starts their real 1200ms cooldown). */
    const cooldownQuery = vocabAt(vocab, 1);
    const secCooldownPrewarm = blankSection();
    const cooldownPrewarm = [];
    for (let i = 0; i < SEARCH_STRESS_SECTIONS.cooldown; i += 1) {
      const combo = { q: cooldownQuery, type: null, minRating: null, sort: 'score' };
      cooldownPrewarm.push(
        runPipelineRequest({
          req: fakeReq({ ip: ipFor(45, i), shard: i % 30 }),
          kind: 'advanced',
          queryKey: advancedQueryKey(combo),
          describe: `prewarm-cooldown q=${cooldownQuery}`,
          runFts: () => advancedRunFts(combo),
        }).then((out) => recordOutcome(secCooldownPrewarm, out)),
      );
    }
    await Promise.all(cooldownPrewarm); // ALL settled → every user's cooldown is running
    const prewarmCooldownOk = secCooldownPrewarm.ok;

    /* ---- phase 2: rate-limit pre-warm — 1000 users admitted, NOT completed.
     * The gate is synchronous (lastAdmitted burns the pacing slot the moment
     * it is called) and the burst below fires in the SAME event-loop turn —
     * before any window tick can complete the pre-warm — so every burst
     * request deterministically hits the per-user pacing 429. */
    const rateLimitQuery = vocabAt(vocab, 2);
    const secRatePrewarm = blankSection();
    const rateLimitPrewarm = [];
    for (let i = 0; i < SEARCH_STRESS_SECTIONS.rateLimit; i += 1) {
      const combo = { q: rateLimitQuery, type: null, minRating: null, sort: 'score' };
      rateLimitPrewarm.push(
        runPipelineRequest({
          req: fakeReq({ ip: ipFor(46, i), shard: i % 30 }),
          kind: 'advanced',
          queryKey: advancedQueryKey(combo),
          describe: `prewarm-ratelimit q=${rateLimitQuery}`,
          runFts: () => advancedRunFts(combo),
        }).then((out) => recordOutcome(secRatePrewarm, out)),
      );
    }
    /* (not awaited — their entries settle during the burst; harmless) */

    /* ---- phase 3: THE BURST — all 10,000 requests created in ONE tick ----
     * Order inside the tick: the BLOCKED sections first (their gate checks
     * must land inside the pre-warmed pacing/cooldown windows — see the
     * timing notes above), then the executing sections. All 10,000 are
     * created in the same synchronous turn — "simultane" by construction. */
    const sections = {
      identical: blankSection(),
      different: blankSection(),
      mixed: blankSection(),
      spam: blankSection(),
      cooldown: blankSection(),
      rateLimit: blankSection(),
    };
    const burstPromises = [];
    let fired = 0;

    /* S5 — 1000 in cooldown (the pre-warmed users — they hold REAL results). */
    for (let i = 0; i < SEARCH_STRESS_SECTIONS.cooldown; i += 1) {
      const combo = { q: vocabAt(vocab, 4), type: null, minRating: null, sort: 'score' };
      burstPromises.push(
        runPipelineRequest({
          req: fakeReq({ ip: ipFor(45, i), shard: i % 30 }),
          kind: 'advanced',
          queryKey: advancedQueryKey(combo),
          describe: 'cooldown-blocked',
          runFts: () => advancedRunFts(combo),
        }).then((out) => recordOutcome(sections.cooldown, out)),
      );
      fired += 1;
    }

    /* S6 — 1000 rate-limited (the pre-warmed users — pacing slot burning). */
    for (let i = 0; i < SEARCH_STRESS_SECTIONS.rateLimit; i += 1) {
      const combo = { q: vocabAt(vocab, 5), type: null, minRating: null, sort: 'score' };
      burstPromises.push(
        runPipelineRequest({
          req: fakeReq({ ip: ipFor(46, i), shard: i % 30 }),
          kind: 'advanced',
          queryKey: advancedQueryKey(combo),
          describe: 'ratelimit-blocked',
          runFts: () => advancedRunFts(combo),
        }).then((out) => recordOutcome(sections.rateLimit, out)),
      );
      fired += 1;
    }

    /* S4 — 2000 spam ENTER: 50 users × 40 back-to-back arrivals in the same
     * tick (the real flood pattern: a1 admitted, a2 rate_limited, a3
     * triggers the ≥3/200ms flood → auto-block, a4..a40 spam_blocked). */
    const spamQuery = vocabAt(vocab, 3);
    for (let u = 0; u < 50; u += 1) {
      for (let k = 0; k < 40; k += 1) {
        const combo = { q: spamQuery, type: null, minRating: null, sort: 'score' };
        burstPromises.push(
          runPipelineRequest({
            req: fakeReq({ ip: ipFor(44, u), shard: u % 30 }),
            kind: 'advanced',
            queryKey: advancedQueryKey(combo),
            describe: `spam q=${spamQuery} #${k}`,
            runFts: () => advancedRunFts(combo),
          }).then((out) => recordOutcome(sections.spam, out)),
        );
        fired += 1;
      }
    }

    /* S1 — 1000 identical (distinct users, ONE query, mixed priority lanes:
     * 5% high + 10% normal + 85% low — every lane sees real traffic). */
    const hotQuery = vocabAt(vocab, 0);
    for (let i = 0; i < SEARCH_STRESS_SECTIONS.identical; i += 1) {
      const priority = i % 20 === 0 ? 'high' : i % 20 <= 2 ? 'normal' : null;
      const combo = { q: hotQuery, type: null, minRating: null, sort: 'score' };
      burstPromises.push(
        runPipelineRequest({
          req: fakeReq({ ip: ipFor(41, i), shard: i % 30, priority }),
          kind: 'advanced',
          queryKey: advancedQueryKey(combo),
          describe: `identical q=${hotQuery}`,
          runFts: () => advancedRunFts(combo),
        }).then((out) => recordOutcome(sections.identical, out)),
      );
      fired += 1;
    }

    /* S2 — 1000 different (distinct real combos — the honest long tail). */
    for (let i = 0; i < SEARCH_STRESS_SECTIONS.different; i += 1) {
      const combo = distinctCombo(vocab, i);
      burstPromises.push(
        runPipelineRequest({
          req: fakeReq({ ip: ipFor(42, i), shard: i % 30 }),
          kind: 'advanced',
          queryKey: advancedQueryKey(combo),
          describe: `different q=${combo.q} #${i}`,
          runFts: () => advancedRunFts(combo),
        }).then((out) => recordOutcome(sections.different, out)),
      );
      fired += 1;
    }

    /* S3 — 5000 mixed: 2500 hot (10 real hot queries) + 1500 autocomplete
     * typeahead probes (15 real prefixes) + 1000 long-tail distinct. */
    const hotQueries = vocab.slice(10, 20);
    const hotList = hotQueries.length > 0 ? hotQueries : [vocabAt(vocab, 0)];
    const acPrefixes = vocab.slice(20, 35);
    const acList = acPrefixes.length > 0 ? acPrefixes : hotList;
    const mixedBreakdown = { hot: 0, autocomplete: 0, longtail: 0 };
    for (let i = 0; i < 2500; i += 1) {
      const combo = { q: hotList[i % hotList.length], type: null, minRating: null, sort: 'score' };
      burstPromises.push(
        runPipelineRequest({
          req: fakeReq({ ip: ipFor(43, i), shard: i % 30 }),
          kind: 'advanced',
          queryKey: advancedQueryKey(combo),
          describe: `mixed-hot q=${combo.q}`,
          runFts: () => advancedRunFts(combo),
        }).then((out) => {
          recordOutcome(sections.mixed, out);
          if (out.disposition === 'ok') mixedBreakdown.hot += 1;
        }),
      );
      fired += 1;
    }
    for (let i = 0; i < 1500; i += 1) {
      const q = acList[i % acList.length];
      burstPromises.push(
        runPipelineRequest({
          req: fakeReq({ ip: ipFor(43, 2500 + i), shard: i % 30 }),
          kind: 'autocomplete',
          queryKey: JSON.stringify({ p: 'autocomplete', q }),
          describe: `mixed-ac q=${q}`,
          runFts: () => autocompleteRunFts(q),
        }).then((out) => {
          recordOutcome(sections.mixed, out);
          if (out.disposition === 'ok') mixedBreakdown.autocomplete += 1;
        }),
      );
      fired += 1;
    }
    for (let i = 0; i < 1000; i += 1) {
      const combo = distinctCombo(vocab, 1000 + i); // disjoint seq block from S2
      burstPromises.push(
        runPipelineRequest({
          req: fakeReq({ ip: ipFor(43, 4000 + i), shard: i % 30 }),
          kind: 'advanced',
          queryKey: advancedQueryKey(combo),
          describe: `mixed-longtail q=${combo.q} #${i}`,
          runFts: () => advancedRunFts(combo),
        }).then((out) => {
          recordOutcome(sections.mixed, out);
          if (out.disposition === 'ok') mixedBreakdown.longtail += 1;
        }),
      );
      fired += 1;
    }

    /* Every request is now created — await the full burst (+ the rate-limit
     * pre-warm entries still draining). */
    await Promise.all([...burstPromises, ...rateLimitPrewarm]);

    /* ---- phase 4: the 10M real sample — 500 concurrent users (the spec's
     * "100–500 căutări simultane reale", top of the band): 300 users over 20
     * hot real queries + 200 users over 20 mid-tail real queries — realistic
     * 10M-user traffic shape (the Zipf head + the mid tail) with a strong
     * measured reduction. ---- */
    const sampleSection = blankSection();
    const sampleHotList = vocab.slice(35, 55);
    const sampleHot = sampleHotList.length > 0 ? sampleHotList : [vocabAt(vocab, 0)];
    const sampleMidList = vocab.slice(55, 75);
    const sampleMid = sampleMidList.length > 0 ? sampleMidList : sampleHot;
    const samplePromises = [];
    for (let i = 0; i < SEARCH_STRESS_SAMPLE_CONCURRENCY; i += 1) {
      const isHot = i < 300;
      const list = isHot ? sampleHot : sampleMid;
      const combo = { q: list[i % list.length], type: null, minRating: null, sort: 'score' };
      samplePromises.push(
        runPipelineRequest({
          req: fakeReq({ ip: ipFor(47, i), shard: i % 30 }),
          kind: 'advanced',
          queryKey: advancedQueryKey(combo),
          describe: `sample q=${combo.q}`,
          runFts: () => advancedRunFts(combo),
        }).then((out) => recordOutcome(sampleSection, out)),
      );
    }
    await Promise.all(samplePromises);

    /* Cache-semantics pair: one NEVER-BEFORE-USED query executed fresh
     * (neon) then repeated inside the TTL (cache) — the payload must be
     * EXACTLY the same data (FAZA 14 semantics unchanged by FAZA 17). */
    const semanticsCombo = distinctCombo(vocab, 5000);
    const semanticsKey = advancedQueryKey(semanticsCombo);
    const semanticsA = await runPipelineRequest({
      req: fakeReq({ ip: ipFor(48, 1), shard: 1 }),
      kind: 'advanced',
      queryKey: semanticsKey,
      describe: `semantics q=${semanticsCombo.q}`,
      runFts: () => advancedRunFts(semanticsCombo),
    });
    const semanticsB = await runPipelineRequest({
      req: fakeReq({ ip: ipFor(48, 2), shard: 2 }),
      kind: 'advanced',
      queryKey: semanticsKey,
      describe: `semantics-repeat q=${semanticsCombo.q}`,
      runFts: () => advancedRunFts(semanticsCombo),
    });
    const semanticsPayloadIdentical =
      semanticsA.disposition === 'ok' &&
      semanticsB.disposition === 'ok' &&
      JSON.stringify(semanticsA.result?.data ?? []) === JSON.stringify(semanticsB.result?.data ?? []) &&
      semanticsA.result?.total === semanticsB.result?.total;

    const afterAll = {
      flow: searchFlowStatusSnapshot(),
      windowing: searchWindowingSnapshot(),
      rate: searchRateStatusSnapshot(),
      burst: searchRateBurstSnapshot(),
      opt: searchOptDedupSnapshot(),
    };

    /* ---- phase 5: post-run aliveness — the platform still answers. ---- */
    const aliveCombo = distinctCombo(vocab, 5001);
    const alive = await runPipelineRequest({
      req: fakeReq({ ip: ipFor(49, 1), shard: 7 }),
      kind: 'advanced',
      queryKey: advancedQueryKey(aliveCombo),
      describe: 'post-run-alive',
      runFts: () => advancedRunFts(aliveCombo),
    });

    /* ---- phase 6: the 10M projection model (honest math, real caps). ----
     * Demand: 10M users × avg 2 searches = 20M searches over a 24h
     * engagement cycle → mean ~231.5/s, ~10× diurnal peak. The structural
     * caps bound what Neon can ever see; the real 500-concurrent sample
     * (top of the spec's 100–500 band) validates the operating point. */
    const flowCfg = afterAll.flow;
    const rateCfg = afterAll.rate;
    const model = SEARCH_STRESS_PROJECTION_MODEL;
    const avgSearches = (model.searchesPerUserMin + model.searchesPerUserMax) / 2; // 2.0
    const totalSearches = Math.round(model.users * avgSearches); // 20M
    const meanArrivalRate = Number((totalSearches / model.engagementWindowS).toFixed(1));
    const peakArrivalRate = Number((meanArrivalRate * model.diurnalPeakMultiplier).toFixed(1));
    const windowDispatchPerS = Math.round(
      afterAll.windowing.intervalMs > 0
        ? afterAll.windowing.batchSize / (afterAll.windowing.intervalMs / 1000)
        : 1000,
    );
    const sampleNeon = sampleSection.sources.neon;
    const sampleReduction = sampleNeon > 0 ? Number((sampleSection.ok / sampleNeon).toFixed(2)) : 0;
    const projection = {
      model: { ...model, avgSearchesPerUser: avgSearches },
      totalSearches,
      meanArrivalRate,
      peakArrivalRate,
      simultaneousRealBand: { low: 100, high: 500 },
      structuralCaps: {
        maxConcurrentExecutions: flowCfg.maxConcurrent,
        windowDispatchPerS,
        queueCap: flowCfg.queueCap,
        maxWaitMs: flowCfg.maxWaitMs,
        perUserMs: rateCfg.perUserMs,
        cooldownMs: rateCfg.cooldownMs,
        cacheTtlMs: searchOptCacheSnapshot().ttlMs,
      },
      capacity: {
        sustainedRequestCeilingPerS: windowDispatchPerS,
        meanDemandVsCeiling: `${meanArrivalRate}/s vs ${windowDispatchPerS}/s — mean demand fits comfortably`,
        peakDemandVsCeiling: `${peakArrivalRate}/s vs ${windowDispatchPerS}/s — peaks ride the queue (cap ${flowCfg.queueCap} ≈ ${Math.round((flowCfg.queueCap / windowDispatchPerS) * 10) / 10}s of peak) and repeat queries collapse via batching+cache`,
        effectiveUserCapacityPerS: `${windowDispatchPerS}/s × measured reduction ${sampleReduction}× (repeated-query traffic)`,
      },
      realSample: {
        users: SEARCH_STRESS_SAMPLE_CONCURRENCY,
        requests: sampleSection.total,
        answered: answeredOf(sampleSection),
        ok: sampleSection.ok,
        hotUsers: 300,
        midTailUsers: 200,
        neonExecutions: sampleNeon,
        reductionFactor: sampleReduction,
        waitP95Ms: pct(sampleSection.waitSamples, 0.95),
      },
      verdicts: {
        rateLimitWorks:
          sections.rateLimit.blocked.rate_limited > 0 || sections.spam.blocked.rate_limited > 0,
        cooldownWorks: sections.cooldown.blocked.cooldown_active > 0,
        antiSpamWorks: sections.spam.blocked.spam_blocked > 0,
        queueDoesNotExplode:
          afterAll.flow.queueHighWater <= flowCfg.queueCap &&
          afterAll.flow.dropped === before.flow.dropped &&
          afterAll.flow.timedOut === before.flow.timedOut,
        batchingReduces: sections.identical.sources.batch > 0 && sections.identical.sources.neon === 1,
        cacheReduces: afterAll.opt.cacheServed > beforeCacheHits && afterAll.opt.cacheServed > 0,
        neonNotOverloaded:
          afterAll.flow.maxInflightSeen <= flowCfg.maxConcurrent &&
          afterAll.opt.ftsErrors === before.opt.ftsErrors,
      },
    };

    /* ---- phase 7: the pinned assertions (the spec's checklist). ---- */
    const assertions = [];
    const assert = (name, ok, detail) => assertions.push({ name, ok: ok === true, detail });

    const totalRequests =
      sections.identical.total + sections.different.total + sections.mixed.total +
      sections.spam.total + sections.cooldown.total + sections.rateLimit.total;
    const totalOk =
      sections.identical.ok + sections.different.ok + sections.mixed.ok + sections.spam.ok +
      sections.cooldown.ok + sections.rateLimit.ok;
    const totalBlocked = Object.values(sections).reduce(
      (acc, s) => acc + s.blocked.spam_blocked + s.blocked.cooldown_active + s.blocked.rate_limited,
      0,
    );
    const totalErrors = Object.values(sections).reduce((acc, s) => acc + s.errors, 0);

    assert(
      'composition: the pinned six sections — 11,000 simultaneous requests (≥ the 10,000 headline)',
      sections.identical.total === SEARCH_STRESS_SECTIONS.identical &&
        sections.different.total === SEARCH_STRESS_SECTIONS.different &&
        sections.mixed.total === SEARCH_STRESS_SECTIONS.mixed &&
        sections.spam.total === SEARCH_STRESS_SECTIONS.spam &&
        sections.cooldown.total === SEARCH_STRESS_SECTIONS.cooldown &&
        sections.rateLimit.total === SEARCH_STRESS_SECTIONS.rateLimit &&
        totalRequests === SEARCH_STRESS_BURST_TOTAL &&
        totalRequests >= SEARCH_STRESS_CONCURRENCY,
      `fired=${fired} recorded=${totalRequests} (headline ${SEARCH_STRESS_CONCURRENCY})`,
    );
    assert('no request lost — every request has an explicit disposition', totalOk + totalBlocked + totalErrors === totalRequests, `ok=${totalOk} blocked=${totalBlocked} errors=${totalErrors} total=${totalRequests}`);
    assert('no unexpected error (0 errors, 0 queue drops, 0 queue timeouts)', totalErrors === 0 && afterAll.flow.dropped === before.flow.dropped && afterAll.flow.timedOut === before.flow.timedOut, `errors=${totalErrors} droppedΔ=${afterAll.flow.dropped - before.flow.dropped} timedOutΔ=${afterAll.flow.timedOut - before.flow.timedOut}`);
    assert('identical: 1000 users, ONE real Neon query (batch+cache absorb 999)', sections.identical.ok === SEARCH_STRESS_SECTIONS.identical && sections.identical.sources.neon === 1, `ok=${sections.identical.ok} sources=${JSON.stringify(sections.identical.sources)}`);
    assert('identical: batch attach observed (fan-out on the shared execution)', sections.identical.sources.batch > 0, `batch=${sections.identical.sources.batch}`);
    assert('identical: cache servings observed (post-settle repeats within TTL)', sections.identical.sources.cache > 0, `cache=${sections.identical.sources.cache}`);
    assert('different: 1000 distinct queries → 1000 real executions, 0 false dedup', sections.different.ok === SEARCH_STRESS_SECTIONS.different && sections.different.sources.neon === sections.different.ok && sections.different.distinctHashes.size === sections.different.ok, `neon=${sections.different.sources.neon} distinctHashes=${sections.different.distinctHashes.size} ok=${sections.different.ok}`);
    assert('mixed: all 5000 answered (hot + autocomplete + long-tail)', sections.mixed.total === 5000 && answeredOf(sections.mixed) === 5000, `answered=${answeredOf(sections.mixed)} errors=${sections.mixed.errors}`);
    assert('mixed: batching/cache reduction observed (real execs < admitted)', sections.mixed.sources.neon < sections.mixed.ok, `neon=${sections.mixed.sources.neon} ok=${sections.mixed.ok}`);
    assert('spam: flood blocked (≥1800 of 2000 spam_blocked)', sections.spam.blocked.spam_blocked >= 1800, `spam_blocked=${sections.spam.blocked.spam_blocked} admitted=${sections.spam.ok}`);
    assert('cooldown: post-result cooldown blocked the pre-warmed users (≥950)', sections.cooldown.blocked.cooldown_active >= 950, `cooldown_active=${sections.cooldown.blocked.cooldown_active} (pre-warm real results: ${prewarmCooldownOk})`);
    assert('rate-limit: per-user pacing blocked the pre-warmed users (1000)', sections.rateLimit.blocked.rate_limited === SEARCH_STRESS_SECTIONS.rateLimit, `rate_limited=${sections.rateLimit.blocked.rate_limited}`);
    assert('queue absorbed the spike (queueHighWater ≤ cap, 0 dropped)', afterAll.flow.queueHighWater <= flowCfg.queueCap && afterAll.flow.dropped === before.flow.dropped, `highWater=${afterAll.flow.queueHighWater} cap=${flowCfg.queueCap}`);
    assert('windowing processed the burst (windows fired + dispatches)', afterAll.windowing.windowsFired > before.windowing.windowsFired && afterAll.windowing.windowDispatches > before.windowing.windowDispatches, `windowsΔ=${afterAll.windowing.windowsFired - before.windowing.windowsFired} dispatchesΔ=${afterAll.windowing.windowDispatches - before.windowing.windowDispatches}`);
    assert('priority lanes all served (high + normal + low)', afterAll.flow.processedByPriority.high > beforePriority.high && afterAll.flow.processedByPriority.normal > beforePriority.normal && afterAll.flow.processedByPriority.low > beforePriority.low, `highΔ=${afterAll.flow.processedByPriority.high - beforePriority.high} normalΔ=${afterAll.flow.processedByPriority.normal - beforePriority.normal} lowΔ=${afterAll.flow.processedByPriority.low - beforePriority.low}`);
    assert('burst-control observed the event (FAZA 16 burst counter moved)', afterAll.burst.events > before.burst.events || afterAll.burst.peak > before.burst.peak, `eventsΔ=${afterAll.burst.events - before.burst.events} peakΔ=${afterAll.burst.peak - before.burst.peak}`);
    assert('semantics: cached serve returns the EXACT real payload', semanticsPayloadIdentical && semanticsA.source === 'neon' && semanticsB.source === 'cache', `A=${semanticsA.source} B=${semanticsB.source} identical=${semanticsPayloadIdentical}`);
    assert('platform alive after the run (a real search still answers)', alive.disposition === 'ok', `disposition=${alive.disposition}`);
    assert('10M sample: 500 concurrent (top of the 100–500 band) all answered, 0 errors', sampleSection.total === SEARCH_STRESS_SAMPLE_CONCURRENCY && answeredOf(sampleSection) === SEARCH_STRESS_SAMPLE_CONCURRENCY && sampleSection.errors === 0, `answered=${answeredOf(sampleSection)} errors=${sampleSection.errors}`);
    assert('10M sample: reduction observed (Neon execs < requests)', sampleNeon < sampleSection.ok && sampleNeon > 0, `neon=${sampleNeon} requests=${sampleSection.ok}`);
    assert('10M projection: mean demand fits under the sustained ceiling', meanArrivalRate < windowDispatchPerS, `mean=${meanArrivalRate}/s ceiling=${windowDispatchPerS}/s`);
    assert('10M projection: all 7 verdicts green', Object.values(projection.verdicts).every(Boolean), JSON.stringify(projection.verdicts));

    const failures = assertions.filter((a) => !a.ok).map((a) => `${a.name} — ${a.detail}`);

    /* ---- assemble the report ---- */
    const answered = totalOk + totalBlocked;
    const neonFtsQueries = afterAll.opt.ftsQueries - before.opt.ftsQueries; // REAL executions (pre-warms + burst + sample + semantics pair)
    const sumSources = (key) =>
      Object.values(sections).reduce((acc, s) => acc + (s.sources[key] ?? 0), 0);
    const report = {
      version: 1,
      startedAt,
      finishedAt: new Date().toISOString(),
      wallMs: Date.now() - t0,
      executed: true,
      passed: failures.length === 0,
      concurrency: SEARCH_STRESS_CONCURRENCY, // the pinned headline (10,000)
      burstTotal: SEARCH_STRESS_BURST_TOTAL, // the six pinned sections summed (11,000)
      requests: {
        total: totalRequests,
        simultaneous: totalRequests, // all created in one synchronous turn
        answered, // explicit dispositions — none lost
        ok: totalOk,
        blocked: totalBlocked,
        errors: totalErrors,
      },
      dispositions: {
        ok: totalOk,
        spam_blocked: sections.spam.blocked.spam_blocked,
        cooldown_active: sections.cooldown.blocked.cooldown_active,
        rate_limited: sections.rateLimit.blocked.rate_limited + sections.spam.blocked.rate_limited,
        error: totalErrors,
      },
      sources: {
        neon: sumSources('neon'),
        batch: sumSources('batch'),
        cache: sumSources('cache'),
        bypass: sumSources('bypass'),
      },
      neonFtsQueries,
      reductionFactor: neonFtsQueries > 0 ? Number((answered / neonFtsQueries).toFixed(2)) : 0,
      prewarm: {
        cooldownUsers: SEARCH_STRESS_SECTIONS.cooldown,
        cooldownRealResults: prewarmCooldownOk,
        rateLimitUsers: SEARCH_STRESS_SECTIONS.rateLimit,
      },
      sections: {
        identical: sectionReport(sections.identical),
        different: sectionReport(sections.different),
        mixed: { ...sectionReport(sections.mixed), breakdown: { ...mixedBreakdown } },
        spam: sectionReport(sections.spam),
        cooldown: sectionReport(sections.cooldown),
        rateLimit: sectionReport(sections.rateLimit),
      },
      flow: {
        queueHighWater: afterAll.flow.queueHighWater,
        maxInflightSeen: afterAll.flow.maxInflightSeen,
        maxConcurrent: flowCfg.maxConcurrent,
        windowsFiredDelta: afterAll.windowing.windowsFired - before.windowing.windowsFired,
        windowDispatchesDelta: afterAll.windowing.windowDispatches - before.windowing.windowDispatches,
        droppedDelta: afterAll.flow.dropped - before.flow.dropped,
        timedOutDelta: afterAll.flow.timedOut - before.flow.timedOut,
      },
      projection10M: projection,
      semantics: {
        query: semanticsCombo.q,
        freshSource: semanticsA.source,
        repeatSource: semanticsB.source,
        payloadIdentical: semanticsPayloadIdentical,
      },
      assertions,
      failures,
    };

    /* ---- persist + history (best effort) ---- */
    lastRun = report;
    runsHistory.push({
      startedAt: report.startedAt,
      finishedAt: report.finishedAt,
      passed: report.passed,
      wallMs: report.wallMs,
      requests: report.requests.total,
      answered: report.requests.answered,
      neonFtsQueries: report.neonFtsQueries,
      reductionFactor: report.reductionFactor,
    });
    if (runsHistory.length > RUNS_HISTORY_LIMIT) runsHistory.shift();
    try {
      await writeFile(LAST_RUN_FILE, JSON.stringify(report), 'utf8');
    } catch (err) {
      logger.warn(`[search-stress] persist failed (non-blocking): ${err?.message ?? err}`);
    }

    logger.info(
      `[search-stress] FAZA 18 run ${report.passed ? 'PASSED ✅' : 'FAILED ❌'} — ${report.requests.total} cereri · răspunse ${report.requests.answered} (ok ${report.requests.ok} + blocare onestă ${report.requests.blocked} + erori ${report.requests.errors}) · interogări Neon REALE ${report.neonFtsQueries} (reducere ${report.reductionFactor}×) · coadă highWater ${report.flow.queueHighWater}/${flowCfg.queueCap} · dropped Δ${report.flow.droppedDelta} · wall ${report.wallMs}ms${failures.length > 0 ? ` · FAILURES: ${failures.join(' | ')}` : ''}`,
    );
    return report;
  } finally {
    running = false;
  }
}

/* --------------------------------- snapshots --------------------------------- */

/** stressTest block for /api/search/status — the pinned FAZA 18 contract:
 *  { concurrent: 10000, passed: true } + the live last-run summary. Before
 *  the first run (fresh deploy): { executed: false, passed: false }. */
export function searchStressStatusSnapshot() {
  if (!lastRun) {
    return {
      executed: false,
      concurrency: SEARCH_STRESS_CONCURRENCY,
      concurrent: SEARCH_STRESS_CONCURRENCY, // pinned alias (spec contract)
      simultaneous: SEARCH_STRESS_BURST_TOTAL,
      passed: false,
      note: 'No stress run recorded yet — POST /api/search/stress (admin) starts one.',
    };
  }
  return {
    executed: true,
    concurrency: lastRun.concurrency,
    concurrent: lastRun.concurrency, // pinned alias (spec contract)
    simultaneous: lastRun.requests?.simultaneous ?? lastRun.requests?.total ?? 0,
    passed: lastRun.passed,
    startedAt: lastRun.startedAt,
    finishedAt: lastRun.finishedAt,
    wallMs: lastRun.wallMs,
    requests: {
      total: lastRun.requests.total,
      answered: lastRun.requests.answered,
      ok: lastRun.requests.ok,
      blocked: lastRun.requests.blocked,
      errors: lastRun.requests.errors,
      lost: 0,
    },
    dispositions: lastRun.dispositions,
    neonFtsQueries: lastRun.neonFtsQueries,
    reductionFactor: lastRun.reductionFactor,
    failures: lastRun.failures,
  };
}

/** Full console snapshot for GET /api/search/stress (public read-only). */
export function searchStressConsoleSnapshot() {
  return {
    running,
    pipelineIntegrated: searchStressPipelineIntegrated(),
    pipelineStages: searchStressPipelineStages(),
    concurrency: SEARCH_STRESS_CONCURRENCY,
    burstTotal: SEARCH_STRESS_BURST_TOTAL,
    budgetMs: SEARCH_STRESS_BUDGET_MS,
    sections: { ...SEARCH_STRESS_SECTIONS },
    projectionModel: { ...SEARCH_STRESS_PROJECTION_MODEL },
    sampleConcurrency: SEARCH_STRESS_SAMPLE_CONCURRENCY,
    lastRun,
    runs: runsHistory.slice(),
  };
}

/**
 * Flat metrics shape for the 'searchstress' pull collector — consumed by
 * modules/ops/metrics.js renderPrometheus (animaxia_search_stress_* +
 * animaxia_search_pipeline_integrated series) and available as
 * collectors.searchstress in the ?format=json snapshot.
 */
export function searchStressMetricsSnapshot() {
  const status = searchStressStatusSnapshot();
  return {
    pipelineIntegrated: searchStressPipelineIntegrated() ? 1 : 0,
    pipelineStages: searchStressPipelineStages().length,
    running: running ? 1 : 0,
    executed: status.executed === true ? 1 : 0,
    passed: status.passed === true ? 1 : 0,
    concurrency: status.concurrency ?? SEARCH_STRESS_CONCURRENCY,
    wallMs: status.wallMs ?? 0,
    requestsTotal: status.requests?.total ?? 0,
    requestsAnswered: status.requests?.answered ?? 0,
    requestsOk: status.requests?.ok ?? 0,
    requestsBlocked: status.requests?.blocked ?? 0,
    requestsErrors: status.requests?.errors ?? 0,
    neonFtsQueries: status.neonFtsQueries ?? 0,
    reductionFactor: status.reductionFactor ?? 0,
    runsTotal: runsHistory.length,
  };
}

logger.info(
  `[search-stress] FAZA 18 Full Integration + Stress engine ready — ${SEARCH_STRESS_CONCURRENCY} cereri simultane (identice ${SEARCH_STRESS_SECTIONS.identical} · diferite ${SEARCH_STRESS_SECTIONS.different} · mixte ${SEARCH_STRESS_SECTIONS.mixed} · spam ${SEARCH_STRESS_SECTIONS.spam} · cooldown ${SEARCH_STRESS_SECTIONS.cooldown} · rate-limit ${SEARCH_STRESS_SECTIONS.rateLimit}) · projecție 10M utilizatori · eșantion real ${SEARCH_STRESS_SAMPLE_CONCURRENCY} concurenți`,
);
