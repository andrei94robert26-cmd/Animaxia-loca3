/**
 * modules/search/console-routes.js — FAZA 29-R (PLAN 100X): restaurare ADITIVĂ
 * a consolelelor de administrare căutare (FAZA 15/16/17/18), pierdute la
 * restaurarea snapshot-ului FAZA 24. Handlerele sunt cele CANONICE din
 * search.js-ul complet (mirror animaxia-searchopt), extrase 1:1 — modulele de
 * bibliotecă (flow.js, rate.js, opt.js, stress.js) au rămas intacte în
 * backend; lipsea doar expunerea HTTP.
 *
 * ZERO bytes modificați în componentele protejate: search.js (motorul FTS
 * real + pipeline FAZA 18) rămâne neatins — acest router se montează DUPĂ
 * el pe același prefix și servește DOAR rutele noi (Express cade prin next()
 * către acest router pentru rute pe care searchRouter nu le tratează).
 *
 * Router (mount: app.use('/api/search', searchConsoleRouter) — după searchRouter):
 *   GET  /flow            → consola FAZA 15 Search Flow Control (public read-only)
 *   POST /flow/settings   → reconfigurare runtime flow (admin, clamp în flow.js)
 *   GET  /rate            → consola FAZA 16 Search Rate Management (public)
 *   POST /rate/settings   → reconfigurare runtime rate (admin, clamp în rate.js)
 *   GET  /opt             → consola FAZA 17 Search Optimization Layer (public)
 *   POST /opt/settings    → reconfigurare runtime opt (admin, clamp în opt.js)
 *   GET  /stress          → consola FAZA 18 Full Integration + Stress (public;
 *                           POST /stress rămâne în searchRouter protejat)
 */

import express from 'express';
import { requireAuth, requireAdmin } from '../users/auth.js';
import { auditLog, clientIpOf } from '../security/security.js';
import { logger } from '../../utils/logger.js';
import {
  searchFlowConsoleSnapshot,
  updateSearchFlowConfig,
} from './flow.js';
import {
  searchRateConsoleSnapshot,
  updateSearchRateConfig,
} from './rate.js';
import {
  searchOptConsoleSnapshot,
  updateSearchOptConfig,
} from './opt.js';
import {
  searchStressConsoleSnapshot,
} from './stress.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const router = express.Router();

/** GET /api/search/flow — FAZA 15 Search Flow Control console snapshot:
 *  full config, the rolling history (180 × 1s samples of queueLength /
 *  inflight / rate) and the per-shard attribution table. Public read-only. */
router.get('/flow', wrap(async (_req, res) => {
  return res.json(searchFlowConsoleSnapshot());
}));

/** POST /api/search/flow/settings — runtime reconfiguration of the flow
 *  control knobs. requireAuth + requireAdmin — operational surface. Unknown
 *  fields are ignored; every value is clamped in modules/search/flow.js. */
router.post('/flow/settings', requireAuth, requireAdmin, wrap(async (req, res) => {
  const patch = req.body || {};
  const allowed = [
    'enabled', 'maxConcurrent', 'intervalMs', 'batchSize',
    'queueCap', 'maxWaitMs', 'lowPromoteMs', 'normalPromoteMs',
  ];
  const filtered = {};
  for (const key of allowed) {
    if (patch[key] !== undefined) filtered[key] = patch[key];
  }
  const config = updateSearchFlowConfig(filtered);
  await auditLogConsole(req, 'searchflow.settings', filtered);
  return res.json({ ok: true, config });
}));

/** GET /api/search/rate — FAZA 16 Search Rate Management console snapshot.
 *  Public read-only (same policy as /flow). */
router.get('/rate', wrap(async (_req, res) => {
  return res.json(searchRateConsoleSnapshot());
}));

/** POST /api/search/rate/settings — runtime reconfiguration of the pacing
 *  knobs. requireAuth + requireAdmin; clamped in modules/search/rate.js. */
router.post('/rate/settings', requireAuth, requireAdmin, wrap(async (req, res) => {
  const patch = req.body || {};
  const allowed = [
    'enabled', 'perUserMs', 'cooldownMs',
    'spamWindowMs', 'spamThreshold', 'spamBlockMs',
    'burstWindowMs', 'burstThreshold',
  ];
  const filtered = {};
  for (const key of allowed) {
    if (patch[key] !== undefined) filtered[key] = patch[key];
  }
  const config = updateSearchRateConfig(filtered);
  await auditLogConsole(req, 'searchrate.settings', filtered);
  return res.json({ ok: true, config });
}));

/** GET /api/search/opt — FAZA 17 Search Optimization Layer console snapshot.
 *  Public read-only (same policy as /flow and /rate). */
router.get('/opt', wrap(async (_req, res) => {
  return res.json(searchOptConsoleSnapshot());
}));

/** POST /api/search/opt/settings — runtime reconfiguration of the
 *  optimization knobs (enabled, cacheTtlMs, cacheMax, batchMax).
 *  requireAuth + requireAdmin; clamped in modules/search/opt.js. */
router.post('/opt/settings', requireAuth, requireAdmin, wrap(async (req, res) => {
  const patch = req.body || {};
  const allowed = ['enabled', 'cacheTtlMs', 'cacheMax', 'batchMax'];
  const filtered = {};
  for (const key of allowed) {
    if (patch[key] !== undefined) filtered[key] = patch[key];
  }
  const config = updateSearchOptConfig(filtered);
  await auditLogConsole(req, 'searchopt.settings', filtered);
  return res.json({ ok: true, config });
}));

/** GET /api/search/stress — FAZA 18 Full Integration + Stress Test console
 *  snapshot: the integrated-pipeline contract, the section composition, the
 *  last full run report and the runs history. Public read-only. (POST
 *  /stress — pornirea efectivă — rămâne în searchRouter protejat.) */
router.get('/stress', wrap(async (_req, res) => {
  return res.json(searchStressConsoleSnapshot());
}));

/** Audit trail pentru reconfigurările consolelor (best effort, canonic). */
async function auditLogConsole(req, action, patch) {
  try {
    await auditLog({
      userid: req.user?.id ?? null,
      action,
      ip: clientIpOf(req),
      meta: { patch },
    });
  } catch (err) {
    logger.warn(`[search-console] audit best-effort failed: ${err?.message ?? err}`);
  }
}

export default router;
