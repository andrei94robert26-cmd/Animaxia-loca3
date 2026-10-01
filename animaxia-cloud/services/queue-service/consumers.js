/**
 * services/queue-service/consumers.js — The queue worker pool.
 *
 * Owns the HANDLER table for every Animaxia job type (BLUEPRINT §10) and the
 * polling consumer loop that claims jobs from the shared `jobs` table with
 * `FOR UPDATE SKIP LOCKED` (via @animaxia/common/queue.js) and runs them
 * in-process with bounded concurrency:
 *
 *   • QUEUEPOLLMS (default 2000)   — claim interval
 *   • QUEUECONCURRENCY (default 4) — max simultaneously-running jobs
 *   • worker id                    — `queue-<pid>` (visible in jobs.lockedby)
 *
 * Handlers run in the MAIN service process (not isolates): they import the
 * same @animaxia/domain modules the rest of the fleet uses, so side effects
 * like advancedCache warming, provider-cache invalidation and platform event
 * emission work exactly as the monolith's worker pool did. Handler failures
 * call failJob() → the job returns to `pending` with quadratic backoff
 * (attempts²·5s) or lands in `dead` after maxattempts; unknown job types are
 * failed immediately.
 *
 * Honest scope note (indexing): search-service keeps its inverted index in
 * its OWN process memory — a queue-service job cannot warm another service's
 * heap. `indexing.batch` / `maintenance.reindex` therefore only re-validate
 * content freshness (COUNT + MAX(createdat)) and report it; search-service
 * refreshes its index lazily off `content:changed` events and its own worker
 * watermark probe (see services/search-service). Documented in README.md.
 */

import fs from 'node:fs';
import path from 'node:path';
import ZAI from 'z-ai-web-dev-sdk';
import { query, getContentById, upsertContent } from '@animaxia/common/db.js';
import { cache } from '@animaxia/common/cache.js';
import { emitPlatform } from '@animaxia/common/events.js';
import { logger } from '@animaxia/common/logger.js';
import { claimJobs, completeJob, failJob, purgeFinished } from '@animaxia/common/queue.js';
import { fetchProviderJson } from '@animaxia/common/fetcher.js';
import { envInt } from '@animaxia/common/config.js';
import { mineUrl } from '@animaxia/domain/miner/miner.js';
import { resolvePlayer } from '@animaxia/domain/player/player.js';
import { advancedCache } from '@animaxia/domain/cache/advancedCache.js';
import { auditLog } from '@animaxia/domain/security/security.js';
import { tmdbFetch, getGenreMap } from '@animaxia/domain/providers/tmdb.js';

/* ---------------------------------- tuning ---------------------------------- */

const POLL_MS = Math.max(250, envInt('QUEUEPOLLMS', 2000));
const CONCURRENCY = Math.min(10, Math.max(1, envInt('QUEUECONCURRENCY', 4)));
const WORKER_ID = `queue-${process.pid}`;

/** Thumbnails land under the same data dir as the local fallback store
 *  (LOCALDATADIR, default ./data — mounted at /app/data in docker/k8s). */
const THUMBNAILS_DIR = path.resolve(process.env.LOCALDATADIR || './data', 'thumbnails');

const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p';
const JIKAN_BASE = () => process.env.JIKANBASEURL || 'https://api.jikan.moe/v4';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------- z-ai singleton ------------------------------ */
/* Same house pattern as domain/ai/ai.js: lazy client, thinking disabled, 20s
 * timeout, one retry, null on failure so callers fall back to heuristics. */

let zaiInstance = null;

async function getZai() {
  if (!zaiInstance) zaiInstance = await ZAI.create();
  return zaiInstance;
}

async function zaiComplete(messages, { timeoutMs = 20000 } = {}) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const zai = await getZai();
      const completion = await Promise.race([
        zai.chat.completions.create({ messages, thinking: { type: 'disabled' } }),
        new Promise((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`z-ai completion timed out after ${timeoutMs}ms`)),
            timeoutMs,
          );
          if (typeof timer.unref === 'function') timer.unref();
        }),
      ]);
      const text = completion?.choices?.[0]?.message?.content;
      if (typeof text === 'string' && text.trim().length > 0) return text.trim();
      throw new Error('z-ai returned an empty completion');
    } catch (err) {
      if (attempt >= 2) {
        logger.warn(`[queue] z-ai completion failed, using heuristic fallback: ${err?.message || err}`);
        return null;
      }
    }
  }
  return null;
}

/* ------------------------------ miner handlers ------------------------------- */

/** miner.mine {url, type?, externalId?, userid?} — mine a URL into content. */
async function handleMine(payload = {}) {
  const { record } = await mineUrl(payload.url, { type: payload.type, externalId: payload.externalId });
  cache.clearPrefix('http:'); // provider + HTTP response caches may hold stale rows
  emitPlatform('content:changed', { ids: [record.id] });
  await auditLog({
    userid: payload.userid ?? null,
    action: 'queue.miner.mine.done',
    meta: { id: record.id, title: record.title, externalid: record.externalid },
  });
  return { ok: true, contentId: record.id, title: record.title };
}

/** miner.prefetch {contentId, userid?} — pre-resolve the player and warm the
 *  advancedCache entry (120s TTL, 'content' tag — monolith semantics). */
async function handlePrefetch(payload = {}) {
  const contentId = Number(payload.contentId);
  if (!Number.isInteger(contentId) || contentId <= 0) {
    throw new Error('miner.prefetch requires a positive integer contentId');
  }
  const content = await getContentById(contentId);
  if (!content) {
    const err = new Error(`Content ${contentId} not found`);
    err.status = 404;
    throw err;
  }
  const player = await resolvePlayer(content);
  advancedCache.set(`player:${contentId}`, player, { ttlMs: 120000, tags: ['content'] });
  return { ok: true, contentId, mode: player.mode, sources: player.sources.length };
}

/* ------------------------------- ai.batch ------------------------------------ */

/** First-sentence heuristic fallback when the LLM is unavailable. */
function heuristicSummary(row) {
  const raw = String(
    (row.metadata && (row.metadata.overview || row.metadata.description || row.metadata.synopsis)) || '',
  ).trim();
  if (raw) {
    const sentence = raw.match(/^[^.!?]*[.!?]/);
    const text = (sentence ? sentence[0] : raw).trim();
    return text.length > 240 ? `${text.slice(0, 237)}...` : text;
  }
  return `${row.title} is a ${row.type || 'featured'} title available to stream on Animaxia.`;
}

/** ai.batch {limit?} — generate `metadata.aisummary` for up to N rows (default 5). */
async function handleAiBatch(payload = {}) {
  const limit = Math.min(20, Math.max(1, parseInt(payload.limit, 10) || 5));
  const res = await query(
    `SELECT id, externalid, type, title, thumbnail, metadata FROM content
      WHERE externalid IS NOT NULL AND metadata->>'aisummary' IS NULL
      ORDER BY id
      LIMIT $1`,
    [limit],
  );
  let updated = 0;
  for (const row of res.rows) {
    const metadata =
      row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? row.metadata : {};
    const description =
      metadata.overview || metadata.description || metadata.synopsis || '(no description available)';
    const text = await zaiComplete([
      {
        role: 'user',
        content: `Write a concise 2-3 sentence English summary of the ${row.type || 'title'} "${row.title}" for a streaming catalog, based on this description: ${description}`,
      },
    ]);
    const aisummary =
      text && text.length >= 20 && text.length <= 1200 ? text : heuristicSummary({ ...row, metadata });
    try {
      await upsertContent({
        externalid: row.externalid,
        type: row.type,
        title: row.title,
        thumbnail: row.thumbnail ?? null,
        metadata: { ...metadata, aisummary },
      });
      updated += 1;
    } catch (err) {
      logger.warn(`[queue] ai.batch upsert failed for content ${row.id}: ${err.message}`);
    }
  }
  return { ok: true, processed: res.rows.length, updated };
}

/* ----------------------------- analytics.batch ------------------------------- */
/* Same idempotent rollup the analytics-service worker owns (house columns
 * contentid/day/views/plays/completed/uniqueviewers/updatedat, PK (contentid,
 * day)); recompute the trailing yesterday+today window so today refreshes on
 * every run and late-arriving yesterday events fold in. DDL is IF NOT EXISTS,
 * so both owners converge on the identical table. */

const ROLLUP_DDL = [
  `CREATE TABLE IF NOT EXISTS dailyviewrollups (
     contentid INTEGER NOT NULL REFERENCES content(id) ON DELETE CASCADE,
     day DATE NOT NULL,
     views INTEGER NOT NULL DEFAULT 0,
     plays INTEGER NOT NULL DEFAULT 0,
     completed INTEGER NOT NULL DEFAULT 0,
     uniqueviewers INTEGER NOT NULL DEFAULT 0,
     updatedat TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     PRIMARY KEY (contentid, day)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_dailyviewrollups_day ON dailyviewrollups (day)`,
];

const ROLLUP_LOOKBACK = '1 day';

const ROLLUP_SQL = `
  INSERT INTO dailyviewrollups (contentid, day, views, plays, completed, uniqueviewers, updatedat)
  SELECT v.contentid,
         date_trunc('day', v.createdat)::date AS day,
         COUNT(*) FILTER (WHERE v.event = 'view')::int      AS views,
         COUNT(*) FILTER (WHERE v.event = 'play')::int     AS plays,
         COUNT(*) FILTER (WHERE v.event = 'complete')::int AS completed,
         COUNT(DISTINCT v.userid)::int                     AS uniqueviewers,
         NOW()
  FROM viewevents v
  WHERE v.createdat >= date_trunc('day', NOW()) - ($1::text)::interval
  GROUP BY v.contentid, date_trunc('day', v.createdat)::date
  ON CONFLICT (contentid, day) DO UPDATE SET
    views         = EXCLUDED.views,
    plays         = EXCLUDED.plays,
    completed     = EXCLUDED.completed,
    uniqueviewers = EXCLUDED.uniqueviewers,
    updatedat     = NOW()`;

/** analytics.batch {} — roll up viewevents into dailyviewrollups (yesterday+today). */
async function handleAnalyticsBatch() {
  for (const statement of ROLLUP_DDL) await query(statement);
  const res = await query(ROLLUP_SQL, [ROLLUP_LOOKBACK]);
  return { ok: true, upserted: Number(res?.rowCount ?? 0) };
}

/* -------------------------- indexing.batch / reindex ------------------------- */

/** Content corpus freshness probe — the honest part of "reindex" (see header). */
async function contentFreshness() {
  const res = await query('SELECT COUNT(*)::int AS docs, MAX(createdat) AS latest FROM content');
  const row = res.rows[0] || {};
  return {
    docs: Number(row.docs ?? 0),
    latestContentAt: row.latest instanceof Date ? row.latest.toISOString() : row.latest ? String(row.latest) : null,
  };
}

const INDEXING_NOTE =
  'search index refreshes lazily in search-service (in-process memory); this job reports content freshness only — the index rebuilds on content:changed events, the search-service worker watermark probe, or a manual admin POST /api/search/index';

/** indexing.batch {limit?} — validate content freshness + report (see header note). */
async function handleIndexingBatch(payload = {}) {
  const stats = await contentFreshness();
  return { ok: true, ...stats, note: INDEXING_NOTE, ...(payload && payload.limit != null ? { requestedLimit: payload.limit } : {}) };
}

/** maintenance.reindex {} — same probe, fleet-wide intent (limit 100000 accepted). */
async function handleReindex() {
  const stats = await contentFreshness();
  return { ok: true, ...stats, note: INDEXING_NOTE };
}

/* ------------------------------ providers.refresh ---------------------------- */

/** TMDB trending movies + TV (top 20 each) — seed.js normalize/upsert pattern. */
async function refreshTmdb() {
  let upserted = 0;
  const perType = {};
  for (const mediaType of ['movie', 'tv']) {
    const payload = await tmdbFetch(`/trending/${mediaType}/week`);
    const results = (payload?.results || []).slice(0, 20);
    let genreMap = {};
    try {
      genreMap = await getGenreMap(mediaType);
    } catch {
      genreMap = {};
    }
    let count = 0;
    for (const item of results) {
      try {
        await upsertContent({
          externalid: `tmdb:${mediaType}:${item.id}`,
          type: mediaType,
          title: item.title || item.name || 'Untitled',
          thumbnail: item.poster_path ? `${TMDB_IMAGE_BASE}/w500${item.poster_path}` : null,
          metadata: {
            source: 'tmdb',
            mediaType,
            overview: item.overview || '',
            rating: item.vote_average ?? null,
            year: (item.release_date || item.first_air_date || '').slice(0, 4) || null,
            genres: (item.genre_ids || []).map((id) => genreMap[id]).filter(Boolean),
            backdrop: item.backdrop_path ? `${TMDB_IMAGE_BASE}/w780${item.backdrop_path}` : null,
          },
        });
        count += 1;
      } catch (err) {
        logger.warn(`[queue] providers.refresh(tmdb) upsert failed for ${mediaType}:${item.id}: ${err.message}`);
      }
    }
    perType[mediaType] = count;
    upserted += count;
  }
  return { upserted, perType };
}

/** Jikan top anime (top 20) — seed.js retry loop + refresh.mjs metadata shape
 *  (rating AND score carried for UI normalization). */
async function refreshJikan() {
  let payload = null;
  let lastError = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      payload = await fetchProviderJson('jikan', `${JIKAN_BASE()}/top/anime`, {
        params: { limit: 20 },
        retries: 0,
        timeoutMs: 10000,
      });
      break;
    } catch (err) {
      lastError = err;
      logger.warn(`[queue] providers.refresh(jikan) attempt ${attempt}/4 failed: ${err.message}`);
      if (attempt < 4) await sleep(4000);
    }
  }
  if (!payload?.data) throw lastError || new Error('Jikan returned no data');
  let upserted = 0;
  for (const item of payload.data.slice(0, 20)) {
    try {
      await upsertContent({
        externalid: `jikan:anime:${item.mal_id}`,
        type: 'anime',
        title: item.title || item.title_english || 'Untitled',
        thumbnail: item.images?.jpg?.large_image_url || item.images?.webp?.large_image_url || null,
        metadata: {
          source: 'jikan',
          mediaType: 'anime',
          synopsis: String(item.synopsis || '').slice(0, 1000),
          rating: item.score ?? item.scored ?? null,
          score: item.score ?? item.scored ?? null,
          year: item.year || (item.aired?.from ? String(item.aired.from).slice(0, 4) : null),
          genres: (item.genres || []).slice(0, 5).map((g) => g.name),
          url: item.url || '',
        },
      });
      upserted += 1;
    } catch (err) {
      logger.warn(`[queue] providers.refresh(jikan) upsert failed for anime:${item.mal_id}: ${err.message}`);
    }
  }
  return { upserted, perType: { anime: upserted } };
}

/** providers.refresh {source:'tmdb'|'jikan', userid?} — pull fresh provider data. */
async function handleProvidersRefresh(payload = {}) {
  const source = payload.source;
  if (source !== 'tmdb' && source !== 'jikan') {
    throw new Error('providers.refresh requires source "tmdb" or "jikan"');
  }
  const { upserted } = source === 'tmdb' ? await refreshTmdb() : await refreshJikan();
  cache.clearPrefix('http:');
  emitPlatform('content:changed');
  await auditLog({
    userid: payload.userid ?? null,
    action: 'queue.providers.refresh.done',
    meta: { source, upserted },
  });
  return { ok: true, source, upserted };
}

/* ------------------------------ thumbnails.generate -------------------------- */
/* Deterministic SVG poster generator, ported from the monolith
 * modules/workers/tasks/thumbnail.mjs: two HSL gradient stops derived from an
 * FNV-1a hash of the title, so the same title always renders the same art. */

/** Deterministic 32-bit FNV-1a hash of a string. */
function hashString(str) {
  let h = 2166136261;
  const text = String(str || '');
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Escape XML-special characters for safe embedding in SVG text nodes. */
function escapeXml(value) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&apos;', '"': '&quot;' };
  return String(value).replace(/[&<>'"]/g, (c) => map[c]);
}

/** Greedy word-wrap: build lines of at most maxChars chars (max maxLines). */
function wrapWords(words, maxChars, maxLines) {
  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxChars && current) {
      lines.push(current);
      current = word;
      if (lines.length === maxLines) break;
    } else if (candidate.length > maxChars) {
      // A single over-long word — hard-split it.
      for (let i = 0; i < candidate.length; i += maxChars) {
        lines.push(candidate.slice(i, i + maxChars));
        if (lines.length === maxLines) break;
      }
      current = '';
    } else {
      current = candidate;
    }
  }
  if (lines.length < maxLines && current) lines.push(current);
  // Truncate the last line with an ellipsis when the title was cut short.
  if (lines.length === maxLines) {
    const last = lines[maxLines - 1];
    if (last.length > maxChars - 1) lines[maxLines - 1] = `${last.slice(0, maxChars - 1)}…`;
  }
  return lines;
}

/** Build the 400x600 poster SVG for one content row (monolith design). */
function buildPosterSvg(row) {
  const title = String(row.title || 'Untitled');
  const type = String(row.type || 'title');
  const hash = hashString(title);
  const hue1 = hash % 360;
  const hue2 = (hue1 + 40 + ((hash >> 8) % 80)) % 360;
  const c1 = `hsl(${hue1}, 62%, 16%)`;
  const c2 = `hsl(${hue2}, 68%, 38%)`;

  const words = title.split(/\s+/).filter(Boolean).slice(0, 3); // first 3 words
  const lines = wrapWords(words, 16, 4);
  const fontSize = lines.length >= 4 ? 30 : lines.length === 3 ? 34 : 40;
  const lineHeight = Math.round(fontSize * 1.25);
  const firstLineY = 310 - Math.round(((lines.length - 1) * lineHeight) / 2);

  const titleSpans = lines
    .map(
      (line, i) =>
        `    <text x="200" y="${firstLineY + i * lineHeight}" font-size="${fontSize}" fill="#ffffff" opacity="0.96">${escapeXml(line)}</text>`,
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600" viewBox="0 0 400 600" role="img" aria-label="${escapeXml(title)} poster">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${c1}"/>
      <stop offset="100%" stop-color="${c2}"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="42%" r="65%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.16"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="400" height="600" fill="url(#bg)"/>
  <rect width="400" height="600" fill="url(#glow)"/>
  <circle cx="${60 + (hash % 60)}" cy="${140 + ((hash >> 5) % 80)}" r="${90 + ((hash >> 3) % 60)}" fill="#000000" opacity="0.14"/>
  <circle cx="${300 - ((hash >> 7) % 70)}" cy="${430 + ((hash >> 11) % 60)}" r="${70 + ((hash >> 9) % 50)}" fill="#ffffff" opacity="0.07"/>
  <g font-family="'Segoe UI', 'Helvetica Neue', Arial, sans-serif" text-anchor="middle">
    <g transform="translate(200 60)">
      <rect x="-58" y="-16" width="116" height="32" rx="16" fill="#000000" opacity="0.45"/>
      <text y="6" font-size="15" font-weight="700" fill="#ffffff" letter-spacing="2">${escapeXml(type.toUpperCase())}</text>
    </g>
    <g font-weight="800">
${titleSpans}
    </g>
    <text x="200" y="566" font-size="15" fill="#ffffff" opacity="0.55" letter-spacing="7">ANIMAXIA</text>
    <rect x="168" y="578" width="64" height="3" rx="1.5" fill="#ffffff" opacity="0.35"/>
  </g>
</svg>
`;
}

/** URL/file-safe slug: lowercase alphanumerics + hyphens only (served by the
 *  workers router's ^[a-z0-9-]+\.svg$ guard). */
function slugify(title, id) {
  const slug = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `${slug || 'untitled'}-${id}`;
}

function parseMetadata(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      /* fall through */
    }
  }
  return {};
}

/** thumbnails.generate {contentId?, missing?, userid?} — write SVG posters to
 *  data/thumbnails/<slug>.svg and link them on the content rows. */
async function handleThumbnails(payload = {}) {
  const { contentId, missing } = payload;
  let targets = [];
  if (missing === true) {
    const res = await query(
      `SELECT id, externalid, type, title, thumbnail, metadata FROM content
        WHERE thumbnail IS NULL OR thumbnail = ''
        ORDER BY id
        LIMIT 20`,
    );
    targets = res.rows || [];
  } else if (contentId != null) {
    const res = await query(
      'SELECT id, externalid, type, title, thumbnail, metadata FROM content WHERE id = $1',
      [Number(contentId)],
    );
    targets = res.rows || [];
    if (!targets.length) {
      const err = new Error(`Content ${contentId} not found`);
      err.status = 404;
      throw err;
    }
  } else {
    throw new Error('thumbnails.generate requires contentId or missing=true');
  }

  fs.mkdirSync(THUMBNAILS_DIR, { recursive: true });

  const generated = [];
  let updated = 0;
  for (const row of targets) {
    const svg = buildPosterSvg(row);
    const name = `${slugify(row.title, row.id)}.svg`;
    fs.writeFileSync(path.join(THUMBNAILS_DIR, name), svg, 'utf8');
    generated.push(name);
    if (!row.externalid) continue; // upsertContent requires an externalid — file only
    try {
      await upsertContent({
        externalid: row.externalid,
        type: row.type,
        title: row.title,
        thumbnail: `/api/workers/thumbnails/${name}`,
        metadata: parseMetadata(row.metadata),
      });
      updated += 1;
    } catch (err) {
      logger.warn(`[queue] thumbnails.generate link failed for content ${row.id}: ${err.message}`);
    }
  }
  return { ok: true, generated, updated };
}

/* ----------------------------- maintenance jobs ------------------------------ */

/** maintenance.cleanup-logs — finished queue jobs ARE the logs: purge finished
 *  (done/failed/dead) jobs older than 1 day. */
async function handleCleanupLogs() {
  const purged = await purgeFinished({ olderThanDays: 1 });
  return { ok: true, purged };
}

/** maintenance.cleanup-audit — auditlogs older than 90 days (house column createdat). */
async function handleCleanupAudit() {
  const res = await query(`DELETE FROM auditlogs WHERE createdat < NOW() - INTERVAL '90 days'`);
  return { ok: true, deleted: Number(res?.rowCount ?? 0) };
}

/** maintenance.cleanup-sessions — expired + revoked refresh tokens. */
async function handleCleanupSessions() {
  const res = await query('DELETE FROM refreshtokens WHERE expiresat < NOW() OR revoked = TRUE');
  return { ok: true, deleted: Number(res?.rowCount ?? 0) };
}

/* --------------------------------- registry ---------------------------------- */

/** Job type → handler (each `async (payload) => resultObject`). */
export const HANDLERS = {
  'miner.mine': handleMine,
  'miner.prefetch': handlePrefetch,
  'ai.batch': handleAiBatch,
  'analytics.batch': handleAnalyticsBatch,
  'indexing.batch': handleIndexingBatch,
  'providers.refresh': handleProvidersRefresh,
  'thumbnails.generate': handleThumbnails,
  'maintenance.cleanup-logs': handleCleanupLogs,
  'maintenance.cleanup-audit': handleCleanupAudit,
  'maintenance.cleanup-sessions': handleCleanupSessions,
  'maintenance.reindex': handleReindex,
};

/* ------------------------------- consumer loop ------------------------------- */

const consumerState = {
  started: false,
  workerId: WORKER_ID,
  concurrency: CONCURRENCY,
  pollMs: POLL_MS,
  lastTickAt: null,
  lastError: null,
  inflight: 0,
  claimed: 0,
  processed: 0,
  failed: 0,
};

/** Run one claimed job to completion (never throws — failures go to failJob). */
async function runJob(job) {
  const startedAtMs = Date.now();
  const handler = HANDLERS[job.type];
  try {
    if (typeof handler !== 'function') throw new Error(`Unknown job type: ${job.type}`);
    const result = await handler(job.payload || {});
    await completeJob(job.id, result, { startedAtMs });
    consumerState.processed += 1;
    logger.info(`[queue] job #${job.id} ${job.type} done in ${Date.now() - startedAtMs}ms`);
  } catch (err) {
    const message = String(err?.message || err);
    try {
      await failJob(job.id, message, { startedAtMs });
    } catch (failErr) {
      logger.error(`[queue] job #${job.id} ${job.type} could not be failed: ${failErr.message}`);
    }
    consumerState.failed += 1;
    logger.warn(`[queue] job #${job.id} ${job.type} failed (attempt ${job.attempts}): ${message}`);
  } finally {
    consumerState.inflight -= 1;
  }
}

/** One poll: claim whatever fits in the free slots and start it (unawaited). */
async function tick() {
  consumerState.lastTickAt = new Date().toISOString();
  if (consumerState.inflight >= CONCURRENCY) return;
  const available = Math.min(10, CONCURRENCY - consumerState.inflight);
  let jobs = [];
  try {
    jobs = await claimJobs({ worker: WORKER_ID, limit: available });
  } catch (err) {
    consumerState.lastError = err?.message || String(err);
    logger.warn(`[queue] claim failed: ${consumerState.lastError}`);
    return;
  }
  consumerState.lastError = null;
  if (!jobs.length) return;
  consumerState.inflight += jobs.length;
  consumerState.claimed += jobs.length;
  for (const job of jobs) {
    runJob(job).catch((err) => logger.error(`[queue] job #${job.id} runner crashed: ${err.message}`));
  }
}

/** Start the polling consumer loop (idempotent; unref'd timer). */
export function startConsumers() {
  if (consumerState.started) return consumerState;
  consumerState.started = true;
  const timer = setInterval(() => {
    tick().catch((err) => logger.warn(`[queue] consumer tick error: ${err.message}`));
  }, POLL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  logger.info(
    `[queue] consumers started (worker=${WORKER_ID} concurrency=${CONCURRENCY} pollMs=${POLL_MS} handlers=${Object.keys(HANDLERS).length})`,
  );
  tick().catch(() => {});
  return consumerState;
}

/** Live consumer counters (surfaced via GET /api/queue/stats and /api/workers/status). */
export function consumerStats() {
  return { ...consumerState, handlers: Object.keys(HANDLERS) };
}

export default HANDLERS;
