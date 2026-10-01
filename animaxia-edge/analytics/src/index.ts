/**
 * analytics/src/index.ts — animaxia-edge-analytics: view/play/complete
 * telemetry ingestion, edge trending and guaranteed cloud delivery.
 *
 * Routes (the gateway routes /analytics/* and /beacon here):
 *   POST /analytics/view   — ingest one event. Aliases: POST /analytics/event
 *   POST /analytics/event    and POST /beacon (navigator.sendBeacon sends
 *   POST /beacon             text/plain JSON — readJsonBody is content-type
 *                            agnostic). Body: { contentId, title?,
 *                            thumbnail?, event? } with event ∈
 *                            'view'|'play'|'complete' (default 'view').
 *   GET  /analytics/trending?window=15m|1h|6h|24h|7d&limit=1..50
 *                          — edge-computed trending from the hourly KV
 *                            counters (default 24h window, limit 20).
 *   POST /analytics/flush  — internal (requireInternalAuth): drain the KV
 *                            ring buffer into the cloud in batches.
 *   GET  /analytics/health — liveness + binding snapshot.
 *
 * Ingest pipeline per event:
 *   1. Trending counters (always, best-effort): ANALYTICS_TREND key
 *      trend:<hourBucket>:<contentId> (hourBucket = epoch hours) holding
 *      { views, plays, completes, title, thumbnail }, read-modify-write with
 *      expirationTtl = cfg.analytics.trendTtlSec. NOTE: KV is last-write-wins,
 *      so two concurrent events for the same (hour, contentId) can drop one
 *      increment — acceptable for trending (relative popularity, not billing).
 *   2. Delivery, strongest tier first:
 *        ANALYTICS_QUEUE  → ctx.waitUntil(queue.send(event)) → 'queue'
 *                           (on send failure: fallback into the KV buffer)
 *        else ANALYTICS_TREND → KV ring buffer (buf:<ts>:<rand>, TTL 24h)
 *                           → 'buffer', drained by POST /analytics/flush.
 *
 * Cloud contract (modules/analytics/analytics.js — verified, never guessed):
 *   POST /api/analytics/views accepts EXACTLY ONE event per call —
 *   { contentId, event: 'view'|'play'|'complete' } → { ok: true }; 400 on a
 *   bad body, 404 when the content row no longer exists, 429 above 120
 *   events/min per IP. There is NO batch shape, so flush/queue fire batches
 *   as parallel single POSTs. The user attribution comes from the caller's
 *   Bearer token at the cloud; the edge event keeps userId/ip/ua for edge
 *   records but forwards only the fields the contract defines.
 *
 * Flush semantics — at-least-once: a buffered event is deleted from the ring
 * after a 2xx or a PERMANENT rejection (400/401/403/404/409/422 — retrying
 * cannot succeed); transient failures (429 rate limit, 5xx, network) keep
 * the event for the next flush. Per-batch failures are reported in the
 * response; flush never throws.
 *
 * queue(batch, env, ctx) — Cloudflare Queues consumer: one cloud POST per
 * message; 2xx/permanent → ack, 429/5xx/network → retry after 60s.
 *
 * Zero runtime dependencies; Cloudflare Workers (ES2022).
 */

import {
  jsonOk, jsonError, withSecurityHeaders, withCors, readJsonBody,
  clientIpOf, requireInternalAuth,
} from '../../shared/http';
import { loadEdgeConfig } from '../../shared/config';
import { verifyRequest } from '../../shared/jwt';
import { upstreamFetch } from '../../shared/upstream';
import { withMetrics } from '../../shared/metrics'; // FAZA 9 ops
import type { EdgeEnv, EdgeCtx, EdgeWorker, KvLike, AnalyticsEvent, TrendingRow, QueueBatch } from '../../shared/types';

/* ------------------------------------------------------------- constants ---- */

const HOUR_MS = 3_600_000;
const TREND_PREFIX = 'trend:';
const BUFFER_PREFIX = 'buf:';
const BUFFER_TTL_SEC = 86_400;            // ring-buffer retention: 24h
const BUFFER_DRAIN_LIMIT = 500;           // max events drained per flush
const TREND_LIST_LIMIT = 1000;            // max trend keys scanned per query
const CLOUD_VIEWS_PATH = '/api/analytics/views';
const CLOUD_CALL_TIMEOUT_MS = 15_000;

const VALID_EVENTS = new Set(['view', 'play', 'complete']);

/** Trending windows supported by the edge (cloud supports 24h|7d|30d). */
const TREND_WINDOWS: Record<string, number> = {
  '15m': 15 * 60_000,
  '1h': HOUR_MS,
  '6h': 6 * HOUR_MS,
  '24h': 24 * HOUR_MS,
  '7d': 7 * 24 * HOUR_MS,
};
const DEFAULT_WINDOW = '24h';
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/** Statuses whose retry can never succeed — the event is dropped. */
const PERMANENT_STATUS = new Set([400, 401, 403, 404, 409, 422]);

/* --------------------------------------------------------------- records ---- */

/** Value stored under trend:<hourBucket>:<contentId>. */
interface TrendCounter {
  views: number;
  plays: number;
  completes: number;
  title: string | null;
  thumbnail: string | null;
}

interface BufferedEvent {
  key: string;
  event: AnalyticsEvent;
}

/* --------------------------------------------------------------- helpers ---- */

function emptyCounter(): TrendCounter {
  return { views: 0, plays: 0, completes: 0, title: null, thumbnail: null };
}

function parseCounter(raw: string): TrendCounter {
  try {
    const parsed = JSON.parse(raw) as Partial<TrendCounter>;
    return {
      views: Number(parsed.views) || 0,
      plays: Number(parsed.plays) || 0,
      completes: Number(parsed.completes) || 0,
      title: typeof parsed.title === 'string' ? parsed.title : null,
      thumbnail: typeof parsed.thumbnail === 'string' ? parsed.thumbnail : null,
    };
  } catch {
    return emptyCounter();
  }
}

/**
 * Hourly trending counter, read-modify-write. KV is last-write-wins, so
 * concurrent events for the same (hour, contentId) can drop an increment —
 * acceptable for trending (relative popularity, not billing).
 */
async function bumpTrend(
  kv: KvLike,
  contentId: number,
  event: AnalyticsEvent['event'],
  title: string | null,
  thumbnail: string | null,
  ttlSec: number,
): Promise<void> {
  const bucket = Math.floor(Date.now() / HOUR_MS);
  const key = `${TREND_PREFIX}${bucket}:${contentId}`;
  const counter = parseCounter((await kv.get(key).catch(() => null)) || '');
  if (event === 'view') counter.views += 1;
  else if (event === 'play') counter.plays += 1;
  else counter.completes += 1;
  if (title) counter.title = title;
  if (thumbnail) counter.thumbnail = thumbnail;
  await kv.put(key, JSON.stringify(counter), { expirationTtl: Math.max(60, ttlSec) }).catch(() => undefined);
}

/** Append one event to the KV ring buffer (flush fallback path). */
async function putBuffered(kv: KvLike, event: AnalyticsEvent): Promise<void> {
  const key = `${BUFFER_PREFIX}${Date.now()}:${crypto.randomUUID().slice(0, 8)}`;
  await kv.put(key, JSON.stringify(event), { expirationTtl: BUFFER_TTL_SEC }).catch(() => undefined);
}

/**
 * One cloud delivery call — the cloud accepts a single view per POST:
 * { contentId, event } (see analytics.js). upstreamFetch never throws for
 * network failures (returns 502).
 */
async function postViewToCloud(env: EdgeEnv, event: AnalyticsEvent): Promise<Response> {
  return upstreamFetch({
    env, kind: 'cloud', path: CLOUD_VIEWS_PATH, method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ contentId: event.contentId, event: event.event }),
    timeoutMs: CLOUD_CALL_TIMEOUT_MS,
  });
}

/* ------------------------------------------------------------ ingestion ----- */

async function handleIngest(request: Request, env: EdgeEnv, ctx: EdgeCtx): Promise<Response> {
  const cfg = await loadEdgeConfig(env);
  const body = await readJsonBody(request);
  if (!body) {
    return jsonError(400, 'invalid_body', 'body must be JSON { contentId, title?, thumbnail?, event? }');
  }

  const contentId = Number(body.contentId);
  if (!Number.isInteger(contentId) || contentId <= 0) {
    return jsonError(400, 'invalid_content_id', 'contentId must be a positive integer');
  }

  let event: AnalyticsEvent['event'] = 'view';
  const rawEvent = typeof body.event === 'string' ? body.event : '';
  if (rawEvent) {
    if (!VALID_EVENTS.has(rawEvent)) {
      return jsonError(400, 'invalid_event', "event must be one of 'view', 'play', 'complete'");
    }
    event = rawEvent as AnalyticsEvent['event'];
  }

  // Optional attribution: verify the caller's access token (cloud HS256
  // semantics, shared/jwt.ts). Anonymous telemetry stays anonymous.
  const payload = await verifyRequest(request, env);
  const sub = payload?.sub;
  let userId: number | null = null;
  if (sub !== undefined && sub !== null) {
    const n = Number(sub);
    if (Number.isFinite(n)) userId = n;
  }

  const analyticsEvent: AnalyticsEvent = {
    contentId,
    event,
    userId,
    ts: Date.now(),
    ip: clientIpOf(request),
    ua: request.headers.get('user-agent'),
  };
  const title = typeof body.title === 'string' ? body.title : null;
  const thumbnail = typeof body.thumbnail === 'string' ? body.thumbnail : null;

  // 1. Trending counters — always (best-effort, never blocks delivery).
  const trendKv = env.ANALYTICS_TREND;
  if (trendKv) {
    await bumpTrend(trendKv, contentId, event, title, thumbnail, cfg.analytics.trendTtlSec).catch(() => undefined);
  }

  // 2. Delivery — queue first, KV ring buffer as the fallback tier.
  const queue = env.ANALYTICS_QUEUE;
  if (queue) {
    ctx.waitUntil(
      queue.send(analyticsEvent).catch(async () => {
        // Queue unavailable → keep the event in the KV ring buffer so the
        // cron flush still delivers it ('delivery' above already said queue).
        if (env.ANALYTICS_TREND) await putBuffered(env.ANALYTICS_TREND, analyticsEvent);
      }),
    );
    return jsonOk({ ok: true, delivery: 'queue', contentId });
  }
  if (trendKv) {
    await putBuffered(trendKv, analyticsEvent);
    return jsonOk({ ok: true, delivery: 'buffer', contentId });
  }
  return jsonOk({ ok: true, delivery: 'dropped', contentId });
}

/* -------------------------------------------------------------- trending ---- */

/**
 * Aggregate the hourly trend counters inside the window into TrendingRow[].
 * Buckets are hourly, so short windows are inclusive by bucket: a 15m window
 * keeps every bucket whose start is within now-15m in bucket units —
 * over-inclusive by up to an hour, never empty mid-hour.
 */
async function computeTrending(env: EdgeEnv, windowMs: number, limit: number): Promise<TrendingRow[]> {
  const kv = env.ANALYTICS_TREND;
  if (!kv) return [];

  const now = Date.now();
  const minBucket = Math.floor((now - windowMs) / HOUR_MS);

  const entries: Array<{ key: string; contentId: number }> = [];
  try {
    const list = await kv.list({ prefix: TREND_PREFIX, limit: TREND_LIST_LIMIT });
    for (const k of list.keys) {
      const parts = k.name.split(':'); // trend:<bucket>:<contentId>
      if (parts.length !== 3) continue;
      const bucket = Number(parts[1]);
      const contentId = Number(parts[2]);
      if (!Number.isFinite(bucket) || bucket < minBucket) continue;
      if (!Number.isInteger(contentId) || contentId <= 0) continue;
      entries.push({ key: k.name, contentId });
    }
  } catch {
    return [];
  }

  const values = await Promise.all(entries.map((entry) => kv.get(entry.key).catch(() => null)));
  const byContent = new Map<number, TrendCounter>();
  for (let i = 0; i < entries.length; i++) {
    const raw = values[i];
    if (raw === null) continue;
    const parsed = parseCounter(raw);
    const current = byContent.get(entries[i].contentId) ?? emptyCounter();
    current.views += parsed.views;
    current.plays += parsed.plays;
    current.completes += parsed.completes;
    if (!current.title && parsed.title) current.title = parsed.title;
    if (!current.thumbnail && parsed.thumbnail) current.thumbnail = parsed.thumbnail;
    byContent.set(entries[i].contentId, current);
  }

  const rows: TrendingRow[] = [...byContent.entries()].map(([contentId, counter]) => ({
    contentId,
    title: counter.title,
    thumbnail: counter.thumbnail,
    // plays weigh double, completes triple (edge scoring — the cloud's own
    // trending uses plays*2 + views over its Postgres viewevents table).
    score: counter.views + counter.plays * 2 + counter.completes * 3,
    plays: counter.plays,
    views: counter.views,
  }));
  rows.sort((a, b) => b.score - a.score || a.contentId - b.contentId);
  return rows.slice(0, limit);
}

async function handleTrending(env: EdgeEnv, url: URL): Promise<Response> {
  const requested = url.searchParams.get('window') || DEFAULT_WINDOW;
  const window = typeof TREND_WINDOWS[requested] === 'number' ? requested : DEFAULT_WINDOW;
  const windowMs = TREND_WINDOWS[window];

  const rawLimit = url.searchParams.get('limit');
  const parsedLimit = Math.floor(Number(rawLimit));
  const limit = rawLimit !== null && Number.isFinite(parsedLimit) && parsedLimit >= 1
    ? Math.min(MAX_LIMIT, parsedLimit)
    : DEFAULT_LIMIT;

  const rows = await computeTrending(env, windowMs, limit);
  return jsonOk({ ok: true, window, rows, generatedAt: new Date().toISOString() });
}

/* ----------------------------------------------------------------- flush ---- */

/** Collect up to BUFFER_DRAIN_LIMIT buffered events (corrupt entries purged). */
async function drainBuffer(kv: KvLike): Promise<BufferedEvent[]> {
  const out: BufferedEvent[] = [];
  let list: { keys: Array<{ name: string }> };
  try {
    list = await kv.list({ prefix: BUFFER_PREFIX, limit: BUFFER_DRAIN_LIMIT });
  } catch {
    return out;
  }
  for (const k of list.keys) {
    let raw: string | null;
    try {
      raw = await kv.get(k.name);
    } catch {
      continue; // transient read error — leave the event for the next flush
    }
    if (raw === null) continue; // expired between list and get
    try {
      const event = JSON.parse(raw) as Partial<AnalyticsEvent>;
      if (Number.isInteger(event.contentId) && (event.contentId as number) > 0
        && typeof event.event === 'string' && VALID_EVENTS.has(event.event)) {
        out.push({ key: k.name, event: event as AnalyticsEvent });
      } else {
        await kv.delete(k.name).catch(() => undefined); // corrupt record — purge
      }
    } catch {
      await kv.delete(k.name).catch(() => undefined); // unparseable — purge
    }
  }
  return out;
}

/**
 * POST /analytics/flush (internal): drain the KV ring buffer and deliver to
 * the cloud in batches of cfg.analytics.batchSize. The cloud takes one view
 * per POST, so each batch is a set of parallel single POSTs. At-least-once:
 * only 2xx / permanently-rejected events are removed from the ring. Reports
 * per-batch failures; never throws.
 */
async function handleFlush(request: Request, env: EdgeEnv, _ctx: EdgeCtx): Promise<Response> {
  if (!requireInternalAuth(request, env)) {
    return jsonError(401, 'unauthorized', 'internal auth required (Bearer EDGE_ADMIN_JWT or x-internal-token)', {}, { 'www-authenticate': 'Bearer' });
  }
  const cfg = await loadEdgeConfig(env);
  const kv = env.ANALYTICS_TREND;
  if (!kv) {
    return jsonOk({ ok: true, drained: 0, batches: 0, failed: [], retained: 0 });
  }

  const buffered = await drainBuffer(kv);
  const batchSize = Math.max(1, Math.floor(cfg.analytics.batchSize) || 1);
  const failed: Array<{ batch: number; contentId: number; status: number }> = [];
  let batches = 0;
  let removed = 0;

  for (let i = 0; i < buffered.length; i += batchSize) {
    const chunk = buffered.slice(i, i + batchSize);
    const batchIndex = batches + 1;
    batches += 1;

    const outcomes = await Promise.all(chunk.map(async (item) => {
      try {
        const res = await postViewToCloud(env, item.event);
        return { item, status: res.status };
      } catch {
        return { item, status: 0 }; // network error — keep for retry
      }
    }));

    const deletions: Array<Promise<void>> = [];
    for (const outcome of outcomes) {
      const delivered = outcome.status >= 200 && outcome.status < 300;
      const permanent = PERMANENT_STATUS.has(outcome.status);
      if (delivered || permanent) {
        removed += 1;
        deletions.push(kv.delete(outcome.item.key).catch(() => undefined));
      } else {
        // 429 / 5xx / network — transient, retained for the next flush.
        failed.push({ batch: batchIndex, contentId: outcome.item.event.contentId, status: outcome.status });
      }
    }
    await Promise.all(deletions);
  }

  return jsonOk({
    ok: true,
    drained: buffered.length,
    batches,
    failed,
    retained: buffered.length - removed,
  });
}

/* ------------------------------------------------------- queue consumer ----- */

/**
 * Cloudflare Queues consumer: one cloud POST per message (the cloud accepts
 * a single view per call). 2xx + permanent rejections (bad event / deleted
 * content) are acked; 429 / 5xx / network failures retry after 60s.
 */
async function handleQueue(batch: QueueBatch, env: EdgeEnv, _ctx: EdgeCtx): Promise<void> {
  for (const message of batch.messages) {
    const body = message.body as Partial<AnalyticsEvent> | null;
    const valid = body !== null && typeof body === 'object'
      && Number.isInteger(body.contentId) && (body.contentId as number) > 0
      && typeof body.event === 'string' && VALID_EVENTS.has(body.event);
    if (!valid) {
      batch.ack(message); // malformed payload — retrying cannot fix it
      continue;
    }
    try {
      const res = await postViewToCloud(env, body as AnalyticsEvent);
      if ((res.status >= 200 && res.status < 300) || PERMANENT_STATUS.has(res.status)) {
        batch.ack(message);
      } else {
        batch.retry(message, { delaySeconds: 60 });
      }
    } catch {
      batch.retry(message, { delaySeconds: 60 });
    }
  }
}

/* --------------------------------------------------------------- health ----- */

function handleHealth(env: EdgeEnv): Response {
  return jsonOk({
    ok: true,
    worker: 'animaxia-edge-analytics',
    queue: Boolean(env.ANALYTICS_QUEUE),
    trend: Boolean(env.ANALYTICS_TREND),
  });
}

/* --------------------------------------------------------------- router ----- */

async function handleFetch(request: Request, env: EdgeEnv, ctx: EdgeCtx): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  let response: Response;
  try {
    if (method === 'POST' && (path === '/analytics/view' || path === '/analytics/event' || path === '/beacon')) {
      response = await handleIngest(request, env, ctx);
    } else if (method === 'GET' && path === '/analytics/trending') {
      response = await handleTrending(env, url);
    } else if (method === 'POST' && path === '/analytics/flush') {
      response = await handleFlush(request, env, ctx);
    } else if (method === 'GET' && path === '/analytics/health') {
      response = handleHealth(env);
    } else {
      response = jsonError(404, 'not_found', `no analytics route for ${method} ${path}`);
    }
  } catch (err) {
    response = jsonError(500, 'edge_error', String((err as Error)?.message ?? err));
  }
  return withCors(withSecurityHeaders(response), request);
}

const worker: EdgeWorker = {
  fetch: withMetrics('analytics', handleFetch), // FAZA 9 ops: /metrics + request counters
  queue: handleQueue,
};

export default worker;
