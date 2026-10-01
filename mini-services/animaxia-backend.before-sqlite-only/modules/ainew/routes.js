/**
 * modules/ainew/routes.js — FAZA 35 (PLAN 100X · WS5): AI LAB — routerul
 * celor 8 capabilități AI noi. Mount: app.use('/api/ai/lab', aiLabRouter)
 * — aditiv, în server.js (import lângă playerx + mount lângă mount-ul
 * playerx, EXACT 2 linii, precedent FAZA 33/34). Rutele /api/ai existente
 * au doar căi literale (fără catch-all — verificat), deci /api/ai/lab cade
 * prin ele fără conflict, identic ca /api/ai/tenant (FAZA 11).
 *
 * Contract public (onest, provider etichetat în FIECARE răspuns):
 *   GET  /status                          → { suite:'AI LAB', faza, capabilities:[8],
 *                                            totals, generatedAt } (mereu disponibil)
 *   POST /settings {key, enabled}         → toggle persistent (aisettings `lab:<key>`)
 *   GET  /companion/context/:contentId    → contextul RAG (public)
 *   POST /companion/chat {contentId, messages} → chat pe titlu (public, 12/min)
 *   GET  /recap/:contentId[?userId=]      → „ce ai ratat" (auth sau ?userId=, altfel 401)
 *   GET  /mood/moods                      → lista deterministă (memo 300s)
 *   GET  /mood/generate?mood=&limit=&seed= → playlistul de dispoziție
 *   POST /shield/filter {texts[,mode]}    → filtru spoilere (public, 30/min)
 *   GET  /dubbing/missing?limit=          → ce are EN dar nu are RO
 *   POST /dubbing/generate {contentId}    → ciornă RO (ADMIN)
 *   GET  /dubbing/draft/:contentId        → ciorna (ADMIN)
 *   PUT  /dubbing/draft/:contentId {cues} → corecturi (ADMIN)
 *   POST /dubbing/publish/:contentId      → publicare prin FAZA 21 (ADMIN, 10/min)
 *   GET  /curation/why/:contentId[?userId=] → „de ce îți recomandăm"
 *   POST /voice/asr {audioBase64}         → transcript (10/min; 503 onest, fără fals)
 *   POST /voice/tts {text, voice?, speed?}→ wav base64 (20/min)
 *   GET  /voice/status                    → capacități vocale (public, fără gardă)
 *   POST /editor/generate {description, limit?} → interpretare + playlist (public, 10/min)
 *   POST /editor/save {playlist, itemIds} → salvare (AUTH)
 *   GET  /editor/lists                    → listele userului (AUTH)
 *
 * Capabilitate oprită → 503 { error, disabled: true } (identic aisuite).
 */

import express from 'express';
import {
  CAPS,
  CAP_BY_KEY,
  loadLabSettings,
  setLabEnabled,
  recordLabRun,
  labRuntimeOf,
  logUsage,
  memo,
  wrap,
  intParam,
} from './common.js';
import { companionData, companionChat } from './companion.js';
import { recapData } from './recap.js';
import { moodData, moodGenerate } from './mood.js';
import { shieldFilter } from './shield.js';
import { dubbingMissing, dubbingGenerate, dubbingDraft, dubbingSave, dubbingPublish } from './dubbing.js';
import { curationWhy } from './curation.js';
import { voiceAsr, voiceTts, voiceStatus } from './voice.js';
import { editorGenerate, editorSave, editorLists } from './editor.js';
import { requireAuth, requireAdmin } from '../users/auth.js';
import { auditLog, clientIpOf, userRateLimit } from '../security/security.js';
import { logger } from '../../utils/logger.js';

export const aiLabRouter = express.Router();

/* NOTE: security.js exportă userRateLimit({scope, max, windowMs, key}) —
 * apelul cu obiect (cheie proprie per rută) izolează bucket-urile AI Lab
 * de restul platformei; aici NU împărțim bucket-ul 'default'. */
const rl = (key, max, windowMs = 60000) => userRateLimit({ scope: 'user', max, windowMs, key: `ai-lab-${key}` });

/* --------------------------- capability run wrapper -------------------------- */

/** Înfășoară un handler: măsoară, recordLabRun + logUsage (fire-and-forget),
 * traduce { status, ...body } în răspuns HTTP onest. */
function cap(key, fn) {
  return wrap(async (req, res) => {
    const t0 = Date.now();
    let result;
    try {
      result = await fn(req);
    } catch (err) {
      const ms = Date.now() - t0;
      recordLabRun(key, { provider: 'error', ms, ok: false });
      void logUsage(key, { provider: 'error', latencyMs: ms, status: 'error', snippet: String(err?.message ?? err).slice(0, 120) });
      logger.error(`[ai-lab] capability ${key} failed: ${err?.message ?? err}`);
      return res.status(err?.status || 500).json({
        error: `Capabilitatea ${key} a eșuat`,
        ...(err?.status ? {} : { detail: String(err?.message ?? err).slice(0, 160) }),
      });
    }
    const ms = Date.now() - t0;
    const status = result?.status ?? 200;
    const provider = result?.provider ?? (status === 200 ? 'heuristic' : 'none');
    recordLabRun(key, { provider, ms, ok: status < 400 });
    void logUsage(key, {
      provider,
      latencyMs: ms,
      status: status < 400 ? 'ok' : 'error',
      degraded: provider === 'heuristic' || provider === 'mixed',
      snippet: result?.snippet ?? '',
    });
    if (result?.status) {
      const { status: _s, ...body } = result;
      return res.status(status).json(body);
    }
    return res.json(result);
  });
}

/* ------------------------------- status & settings --------------------------- */

aiLabRouter.get('/status', wrap(async (req, res) => {
  const cached = memo.get('ai-lab:status');
  if (cached) return res.json(cached);
  const settings = await loadLabSettings();
  const capabilities = CAPS.map((c) => {
    const enabled = settings.get(c.key) !== false;
    return { ...c, enabled, stats: labRuntimeOf(c.key) };
  });
  const payload = {
    suite: 'AI LAB',
    faza: 'FAZA 35 (PLAN 100X · WS5)',
    generatedAt: new Date().toISOString(),
    capabilities,
    totals: {
      total: capabilities.length,
      enabled: capabilities.filter((c) => c.enabled).length,
      disabled: capabilities.filter((c) => !c.enabled).length,
    },
  };
  return res.json(memo.set('ai-lab:status', payload, 5000));
}));

aiLabRouter.post('/settings', rl('settings', 30), wrap(async (req, res) => {
  const { key, enabled } = req.body || {};
  if (!CAP_BY_KEY.has(String(key))) {
    return res.status(400).json({ error: `Unknown capability key: ${key} (valid: ${CAPS.map((c) => c.key).join(', ')})` });
  }
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'Field "enabled" must be a boolean' });
  }
  await setLabEnabled(String(key), enabled);
  await auditLog({
    userid: req.user?.id ?? null,
    action: 'ai-lab.settings',
    ip: clientIpOf(req),
    meta: { key, enabled },
  }).catch(() => {});
  logger.info(`[ai-lab] capability "${key}" ${enabled ? 'enabled' : 'disabled'} by user ${req.user?.id ?? 'anon'}`);
  return res.json({ ok: true, key: String(key), enabled });
}));

/* ------------------------------ capability guard ----------------------------- */

function capGuard(key) {
  return wrap(async (req, res, next) => {
    const settings = await loadLabSettings();
    if (settings.get(key) === false) {
      return res.status(503).json({ error: `AI Lab capability ${key} is disabled`, disabled: true });
    }
    return next();
  });
}

/* --------------------------------- 1. companion ------------------------------- */

aiLabRouter.get('/companion/context/:contentId', capGuard('companion'), cap('companion', async (req) => {
  const contentId = intParam(req.params.contentId);
  if (!contentId) return { status: 400, error: 'ID conținut invalid' };
  const context = await companionData(contentId);
  if (!context) return { status: 404, error: 'Conținut inexistent' };
  return { ok: true, context, provider: 'sql' };
}));

aiLabRouter.post('/companion/chat', capGuard('companion'), rl('companion-chat', 12), cap('companion', async (req) => {
  const body = req.body || {};
  const contentId = intParam(body.contentId);
  if (!contentId) return { status: 400, error: 'contentId (întreg pozitiv) este obligatoriu' };
  return companionChat({ contentId, messages: body.messages, user: req.user ?? null });
}));

/* ----------------------------------- 2. recap --------------------------------- */

aiLabRouter.get('/recap/:contentId', capGuard('recap'), cap('recap', async (req) => {
  const contentId = intParam(req.params.contentId);
  if (!contentId) return { status: 400, error: 'ID conținut invalid' };
  /* Auth OPȚIONAL: token > query userId > 401 onest (contract FAZA-35-b). */
  let userId = req.user?.id ?? null;
  if (userId == null && req.query.userId != null) {
    const q = Number(req.query.userId);
    if (Number.isInteger(q) && q > 0) userId = q;
  }
  if (userId == null) return { status: 401, error: 'Autentificare necesară pentru recap' };
  return recapData({ contentId, userId });
}));

/* ----------------------------------- 3. mood ---------------------------------- */

aiLabRouter.get('/mood/moods', capGuard('mood'), cap('mood', async () => {
  const cached = memo.get('ai-lab:mood:moods');
  if (cached) return cached;
  return memo.set('ai-lab:mood:moods', moodData(), 300000);
}));

aiLabRouter.get('/mood/generate', capGuard('mood'), cap('mood', async (req) => {
  const mood = req.query.mood ? String(req.query.mood) : null;
  if (!mood) return { status: 400, error: 'mood este obligatoriu (vezi /mood/moods)' };
  const limit = req.query.limit != null ? Number(req.query.limit) : 12;
  if (!Number.isInteger(limit) || limit < 1 || limit > 48) {
    return { status: 400, error: 'limit trebuie un întreg între 1 și 48' };
  }
  const seed = req.query.seed != null ? String(req.query.seed) : 'animaxia';
  return moodGenerate({ mood, limit, seed });
}));

/* ---------------------------------- 4. shield --------------------------------- */

aiLabRouter.post('/shield/filter', capGuard('shield'), rl('shield-filter', 30), cap('shield', async (req) => {
  const body = req.body || {};
  const contentId = body.contentId != null ? intParam(body.contentId) : null;
  if (body.contentId != null && !contentId) return { status: 400, error: 'contentId trebuie un întreg pozitiv' };
  return shieldFilter({
    contentId,
    texts: body.texts,
    mode: body.mode === undefined || body.mode === null ? 'tag' : String(body.mode),
  });
}));

/* --------------------------------- 5. dubbing --------------------------------- */

aiLabRouter.get('/dubbing/missing', capGuard('dubbing'), cap('dubbing', async (req) => {
  const limit = req.query.limit != null ? Number(req.query.limit) : 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return { status: 400, error: 'limit trebuie un întreg între 1 și 100' };
  }
  try {
    return await dubbingMissing({ limit });
  } catch {
    return { status: 503, error: 'Sursa de subtitrări este momentan indisponibilă (PostgreSQL necesar)' };
  }
}));

aiLabRouter.post('/dubbing/generate', capGuard('dubbing'), requireAuth, requireAdmin, cap('dubbing', async (req) => {
  const contentId = intParam(req.body?.contentId);
  if (!contentId) return { status: 400, error: 'contentId (întreg pozitiv) este obligatoriu' };
  return dubbingGenerate({ contentId, user: req.user });
}));

aiLabRouter.get('/dubbing/draft/:contentId', capGuard('dubbing'), requireAuth, requireAdmin, cap('dubbing', async (req) => {
  const contentId = intParam(req.params.contentId);
  if (!contentId) return { status: 400, error: 'ID conținut invalid' };
  return dubbingDraft(contentId);
}));

aiLabRouter.put('/dubbing/draft/:contentId', capGuard('dubbing'), requireAuth, requireAdmin, cap('dubbing', async (req) => {
  const contentId = intParam(req.params.contentId);
  if (!contentId) return { status: 400, error: 'ID conținut invalid' };
  return dubbingSave({ contentId, cues: req.body?.cues, user: req.user });
}));

aiLabRouter.post('/dubbing/publish/:contentId', capGuard('dubbing'), requireAuth, requireAdmin, rl('dubbing-publish', 10), cap('dubbing', async (req) => {
  const contentId = intParam(req.params.contentId);
  if (!contentId) return { status: 400, error: 'ID conținut invalid' };
  return dubbingPublish({ contentId, authHeader: req.headers.authorization, user: req.user });
}));

/* --------------------------------- 6. curation -------------------------------- */

aiLabRouter.get('/curation/why/:contentId', capGuard('curation'), cap('curation', async (req) => {
  const contentId = intParam(req.params.contentId);
  if (!contentId) return { status: 400, error: 'ID conținut invalid' };
  let userId = req.user?.id ?? null;
  if (userId == null && req.query.userId != null) {
    const q = Number(req.query.userId);
    if (Number.isInteger(q) && q > 0) userId = q;
  }
  return curationWhy({ contentId, userId });
}));

/* ---------------------------------- 7. voice ---------------------------------- */

aiLabRouter.get('/voice/status', cap('voice', async () => voiceStatus())); // public, fără gardă

aiLabRouter.post('/voice/asr', capGuard('voice'), rl('voice-asr', 10), cap('voice', async (req) => {
  return voiceAsr({ audioBase64: req.body?.audioBase64, user: req.user ?? null });
}));

aiLabRouter.post('/voice/tts', capGuard('voice'), rl('voice-tts', 20), cap('voice', async (req) => {
  const body = req.body || {};
  return voiceTts({
    text: body.text,
    voice: body.voice === undefined || body.voice === null ? 'tongtong' : String(body.voice),
    speed: body.speed === undefined || body.speed === null ? 1.0 : Number(body.speed),
    user: req.user ?? null,
  });
}));

/* ---------------------------------- 8. editor --------------------------------- */

aiLabRouter.post('/editor/generate', capGuard('editor'), rl('editor-generate', 10), cap('editor', async (req) => {
  const body = req.body || {};
  const limit = body.limit != null ? Number(body.limit) : 12;
  if (!Number.isInteger(limit) || limit < 1 || limit > 48) {
    return { status: 400, error: 'limit trebuie un întreg între 1 și 48' };
  }
  return editorGenerate({ description: body.description, limit, userId: req.user?.id ?? null });
}));

aiLabRouter.post('/editor/save', capGuard('editor'), requireAuth, cap('editor', async (req) => {
  const body = req.body || {};
  return editorSave({ playlist: body.playlist, itemIds: body.itemIds, user: req.user });
}));

aiLabRouter.get('/editor/lists', capGuard('editor'), requireAuth, cap('editor', async (req) => {
  return editorLists(req.user);
}));

export default aiLabRouter;
