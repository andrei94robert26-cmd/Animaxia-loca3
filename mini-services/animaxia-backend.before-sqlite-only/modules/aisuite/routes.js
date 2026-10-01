/**
 * modules/aisuite/routes.js — FAZA 32 (AI SUITE 100X): routerul celor 18
 * motoare AI. Mount: app.use('/api/ai/suite', aiSuiteRouter) — aditiv, în
 * server.js, ÎNAINTE de mount-urile generice /api/ai (namespace nou, fără
 * conflicte de căi).
 *
 * Contract public (analog FAZA 16-b, onest):
 *   GET  /status                     → { engines: [18 × {key,name,emoji,
 *                                       description,enabled,stats}],
 *                                       totals: {enabled,disabled} }
 *   POST /settings {key, enabled}    → { ok, key, enabled }  (persistă
 *                                       aisettings `suite:<key>`, auditat)
 *   GET  /:engine/data               → payloadul motorului (503 dacă oprit)
 *   GET  /miner/dry-run?provider=    → { ok, wouldMine, sample } (fără scrieri)
 *   GET  /news/data?refresh=1        → refetch RSS + reclasificare AI
 *   GET  /recommendations/data?limit=&userId= (userId din token dacă e logat)
 *   GET  /infinite/feed?cursor=&seed=&genre=&pageSize=
 *   GET  /feeds/fetch/:feedId        → fetch real + categorizare
 *   GET  /admin/data                 → panou administrare
 *
 * Când un motor este oprit, /:engine/data returnează
 * 503 {error: 'AI Suite engine <key> is disabled', disabled: true}.
 * /status și /settings rămân mereu disponibile.
 */

import express from 'express';
import {
  ENGINES,
  ENGINE_BY_KEY,
  loadSuiteSettings,
  setEngineEnabled,
  recordRun,
  runtimeOf,
  memo,
  wrap,
} from './common.js';
import {
  minerData,
  minerDryRun,
  metadataData,
  analyzerData,
  newsData,
  socialData,
  watchpartyData,
  recommendationsData,
  franchiseData,
  taxonomyData,
  statsData,
  infiniteFeed,
  scannerData,
  discoveryData,
  duplicatesData,
  posterData,
  trendsData,
  feedsData,
  feedsFetchOne,
  adminData,
} from './engines.js';
import { requireAuth } from '../users/auth.js';
import { auditLog, clientIpOf, userRateLimit } from '../security/security.js';
import { logger } from '../../utils/logger.js';

export const aiSuiteRouter = express.Router();

/* ------------------------------- data routeri ------------------------------- */

const DATA_HANDLERS = {
  miner: minerData,
  metadata: metadataData,
  analyzer: analyzerData,
  news: () => newsData({ refresh: false }),
  social: socialData,
  watchparty: watchpartyData,
  franchise: franchiseData,
  taxonomy: taxonomyData,
  stats: statsData,
  scanner: scannerData,
  discovery: discoveryData,
  duplicates: duplicatesData,
  poster: posterData,
  trends: trendsData,
  feeds: feedsData,
  admin: adminData,
};

/* ------------------------------- status & settings --------------------------- */

aiSuiteRouter.get('/status', wrap(async (req, res) => {
  const settings = await loadSuiteSettings();
  const engines = ENGINES.map((e) => {
    const enabled = settings.get(e.key) !== false;
    return {
      ...e,
      enabled,
      stats: runtimeOf(e.key),
    };
  });
  res.json({
    suite: 'AI SUITE 100X',
    faza: 'FAZA 32 (PLAN 100X)',
    generatedAt: new Date().toISOString(),
    engines,
    totals: {
      total: engines.length,
      enabled: engines.filter((e) => e.enabled).length,
      disabled: engines.filter((e) => !e.enabled).length,
    },
  });
}));

aiSuiteRouter.post('/settings', userRateLimit(30, 60000), wrap(async (req, res) => {
  const { key, enabled } = req.body || {};
  if (!ENGINE_BY_KEY.has(String(key))) {
    return res.status(400).json({ error: `Unknown engine key: ${key} (valid: ${ENGINES.map((e) => e.key).join(', ')})` });
  }
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'Field "enabled" must be a boolean' });
  }
  await setEngineEnabled(String(key), enabled);
  await auditLog({
    userid: req.user?.id ?? null,
    action: 'ai-suite.settings',
    ip: clientIpOf(req),
    meta: { key, enabled },
  }).catch(() => {});
  logger.info(`[ai-suite] engine "${key}" ${enabled ? 'enabled' : 'disabled'} by user ${req.user?.id ?? 'anon'}`);
  return res.json({ ok: true, key: String(key), enabled });
}));

/* ------------------------------- engine guards ------------------------------- */

function engineGuard(key) {
  return wrap(async (req, res, next) => {
    const settings = await loadSuiteSettings();
    if (settings.get(key) === false) {
      return res.status(503).json({ error: `AI Suite engine ${key} is disabled`, disabled: true });
    }
    return next();
  });
}

/* ------------------------- rute specifice înainte de /:engine ---------------- */

/* AI Miner — dry-run real (fără scrieri). */
aiSuiteRouter.get('/miner/dry-run', engineGuard('miner'), wrap(async (req, res) => {
  const provider = String(req.query.provider || 'tmdb').toLowerCase();
  const result = await minerDryRun(provider);
  res.status(result.ok === false && result.error ? 400 : 200).json(result);
}));

/* AI News — refresh forțat al surselor RSS. */
aiSuiteRouter.get('/news/refresh', engineGuard('news'), userRateLimit(10, 60000), wrap(async (req, res) => {
  res.json(await newsData({ refresh: true }));
}));

/* AI Recommendations — personalizare din token dacă există. */
aiSuiteRouter.get('/recommendations/data', engineGuard('recommendations'), wrap(async (req, res) => {
  const limit = Number(req.query.limit || 12);
  const userId = req.user?.id ?? (req.query.userId ? Number(req.query.userId) : null);
  res.json(await recommendationsData({ userId: userId && Number.isFinite(userId) ? userId : null, limit }));
}));

/* AI Infinite Scroll — feed cursor stabil. */
aiSuiteRouter.get('/infinite/feed', engineGuard('infinite'), wrap(async (req, res) => {
  const cursor = Number(req.query.cursor || 0);
  const seed = String(req.query.seed || 'animaxia');
  const genre = req.query.genre ? String(req.query.genre) : null;
  const pageSize = Number(req.query.pageSize || 24);
  res.json(await infiniteFeed({ cursor, seed, genre, pageSize }));
}));

/* AI External Feeds — fetch real al unui feed din catalog. */
aiSuiteRouter.get('/feeds/fetch/:feedId', engineGuard('feeds'), userRateLimit(20, 60000), wrap(async (req, res) => {
  const result = await feedsFetchOne(String(req.params.feedId || ''));
  res.status(result.ok === false ? 400 : 200).json(result);
}));

/* AI Poster Scanner — sample size configurabil (bounded 4-24). */
aiSuiteRouter.get('/poster/data', engineGuard('poster'), wrap(async (req, res) => {
  res.json(await posterData({ sampleSize: Number(req.query.sample || 12) }));
}));

/* AI Analyzer — bounded sample. */
aiSuiteRouter.get('/analyzer/data', engineGuard('analyzer'), wrap(async (req, res) => {
  res.json(await analyzerData());
}));

/* AI Content Scanner — bounded scan + limit configurabil. */
aiSuiteRouter.get('/scanner/data', engineGuard('scanner'), wrap(async (req, res) => {
  res.json(await scannerData({ limit: Number(req.query.limit || 300) }));
}));

/* ------------------------------ /:engine/data -------------------------------- */

aiSuiteRouter.get('/:engine/data', wrap(async (req, res) => {
  const key = String(req.params.engine || '').toLowerCase();
  const engine = ENGINE_BY_KEY.get(key);
  if (!engine) {
    return res.status(404).json({ error: `Unknown engine '${key}'`, valid: ENGINES.map((e) => e.key) });
  }
  const settings = await loadSuiteSettings();
  if (settings.get(key) === false) {
    return res.status(503).json({ error: `AI Suite engine ${key} is disabled`, disabled: true });
  }

  const handler = DATA_HANDLERS[key];
  if (!handler) {
    /* Engines with dedicated routes above still answer here via their base data. */
    if (key === 'recommendations') return res.json(await recommendationsData({ userId: req.user?.id ?? null }));
    if (key === 'infinite') return res.json(await infiniteFeed({}));
    if (key === 'poster') return res.json(await posterData({}));
    return res.status(501).json({ error: `Engine '${key}' has dedicated routes only` });
  }

  const cached = memo.get(`ai-suite:${key}`);
  if (cached && key !== 'infinite' && key !== 'stats') return res.json(cached);

  const t0 = Date.now();
  try {
    const payload = await handler();
    res.json(payload);
  } catch (err) {
    recordRun(key, { provider: 'sql', ms: Date.now() - t0, ok: false });
    logger.error(`[ai-suite] engine ${key} failed: ${err.message}`);
    res.status(500).json({ error: `Engine ${key} failed`, detail: String(err.message || err).slice(0, 200) });
  }
}));

export default aiSuiteRouter;
