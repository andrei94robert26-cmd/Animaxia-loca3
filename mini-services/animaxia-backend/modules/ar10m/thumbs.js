/**
 * modules/ar10m/thumbs.js — AR10M tablet thumbnail pipeline (Task AR10M-2-BE).
 * ON-DEMAND ONLY — zero cron, zero background jobs, every import is logged.
 *
 *   • Path scheme: {THUMB_DIR}/{hash[0:2]}/{hash[2:4]}/{id}.webp (content id;
 *     ids <4 chars are deterministically padded — strict [A-Za-z0-9_-]{1,64}
 *     validation blocks path traversal: no '/', no '..', no unicode).
 *   • registerThumbRoute(app) — GET /thumb/:id: real WebP with ETag (sha1 of
 *     content, cached), Last-Modified, Cache-Control public max-age=1y
 *     immutable, If-None-Match → 304; >500KB → 403 (corrupted). Missing →
 *     tiny embedded 320x180 WebP placeholder (200, X-Thumbnail: placeholder,
 *     SHORT cache so lazy-fill can replace it) or 404 with ?strict=1.
 *   • importThumbnail({ url, contentId }) — validates the source URL through
 *     the allowlist (youtube / direct_url only; rumble honestly skipped — no
 *     public API), fetches official YouTube thumbs (i.ytimg.com) or extracts
 *     a frame at 3s with ffmpeg, converts/resizes to WebP (320x180, q75,
 *     aspect-preserving + letterbox pad), saves atomically (.tmp → rename).
 *     If ffmpeg is missing the result says so HONESTLY
 *     ('ffmpeg-indisponibil' / 'ffmpeg-indisponibil-pentru-conversie').
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../../utils/logger.js';
import { detectSourceType } from './allowlist.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, '..', '..');

export const THUMB_DIR = process.env.THUMB_DIR || path.join(BACKEND_ROOT, 'data', 'thumbnails');
export const THUMB_WIDTH = parseInt(process.env.THUMB_WIDTH || '320', 10) || 320;
export const THUMB_HEIGHT = parseInt(process.env.THUMB_HEIGHT || '180', 10) || 180;
export const THUMB_QUALITY = parseInt(process.env.THUMB_QUALITY || '75', 10) || 75;

const MAX_THUMB_BYTES = 500 * 1024;
const FFMPEG_TIMEOUT_MS = 30_000;
const FETCH_TIMEOUT_MS = 15_000;
const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Embedded placeholder: a REAL 320x180 WebP (176 bytes, generated once with
 * ffmpeg libwebp, solid dark color) — shipped as a constant so the tablet
 * always gets a valid image even with zero tooling on the host.
 */
const PLACEHOLDER_WEBP_BASE64 =
  'UklGRqgAAABXRUJQVlA4IJwAAAAQEACdASpAAbQAPpFIoU0lpCMiICgAsBIJaW7hdrEbQArN2vFych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ9YAD+/53YP6rIfWAAAAAAAAAAAAA=';
const PLACEHOLDER_BUFFER = Buffer.from(PLACEHOLDER_WEBP_BASE64, 'base64');
const PLACEHOLDER_ETAG = '"ar10m-placeholder-v1"';

/* -------------------------------- id + paths --------------------------------- */

/**
 * Absolute path for a thumbnail id — STRICT validation first (path traversal
 * protection): only [A-Za-z0-9_-]{1,64}. Returns null when invalid.
 */
export function thumbPath(id) {
  const s = String(id ?? '');
  if (!ID_RE.test(s)) return null;
  const padded = s.padEnd(4, '0'); // ids shorter than 4 chars stay deterministic
  return path.join(THUMB_DIR, padded.slice(0, 2), padded.slice(2, 4), `${s}.webp`);
}

/* ---------------------------------- etags ------------------------------------- */

const etagCache = new Map(); // id → { etag, mtimeMs, size }

function etagFor(id, buf, mtimeMs, size) {
  const c = etagCache.get(id);
  if (c && c.mtimeMs === mtimeMs && c.size === size) return c.etag;
  const etag = `"${createHash('sha1').update(buf).digest('hex')}"`;
  if (etagCache.size > 2000) etagCache.clear();
  etagCache.set(id, { etag, mtimeMs, size });
  return etag;
}

/* -------------------------------- the route ----------------------------------- */

/**
 * Mount GET /thumb/:id on the Express app (called by the orchestrator with
 * the main app — absolute path, same origin via gateway).
 */
export function registerThumbRoute(app) {
  app.get('/thumb/:id', async (req, res) => {
    const id = String(req.params.id ?? '');
    if (!ID_RE.test(id)) {
      return res.status(400).json({ ok: false, error: 'invalid-thumbnail-id' });
    }
    const filePath = thumbPath(id);
    try {
      const stat = await fsp.stat(filePath);
      if (stat.size > MAX_THUMB_BYTES) {
        return res.status(403).json({ ok: false, error: 'thumbnail-corrupted', sizeBytes: stat.size });
      }
      const buf = await fsp.readFile(filePath);
      const etag = etagFor(id, buf, stat.mtimeMs, stat.size);
      res.set('ETag', etag);
      res.set('Last-Modified', stat.mtime.toUTCString());
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
      res.set('Content-Type', 'image/webp');
      res.set('X-Thumbnail', 'real');
      if (req.get('if-none-match') === etag) return res.status(304).end();
      return res.send(buf);
    } catch {
      // No real thumbnail yet.
      if (req.query.strict === '1') {
        return res.status(404).json({ ok: false, error: 'thumbnail-missing' });
      }
      // Placeholder: 200 + marker so the tablet can lazy-fill later. Short
      // cache (NOT immutable) so a later import replaces it client-side.
      res.set('ETag', PLACEHOLDER_ETAG);
      res.set('Cache-Control', 'public, max-age=300');
      res.set('Content-Type', 'image/webp');
      res.set('X-Thumbnail', 'placeholder');
      if (req.get('if-none-match') === PLACEHOLDER_ETAG) return res.status(304).end();
      return res.send(PLACEHOLDER_BUFFER);
    }
  });
  logger.info(`[ar10m/thumbs] route GET /thumb/:id registered (dir ${THUMB_DIR}, ${THUMB_WIDTH}x${THUMB_HEIGHT} q${THUMB_QUALITY})`);
}

/* --------------------------------- ffmpeg ------------------------------------- */

let ffmpegProbe = null;

/** Cached probe: is an ffmpeg binary available on this host? */
export function ffmpegAvailable() {
  if (ffmpegProbe === null) {
    ffmpegProbe = new Promise((resolve) => {
      const child = spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
      child.on('error', () => resolve(false)); // ENOENT — binary missing
      child.on('close', (code) => resolve(code === 0));
    });
  }
  return ffmpegProbe;
}

/** Run ffmpeg with a hard timeout; SIGKILL + FFMPEG_TIMEOUT error on expiry. */
function runFfmpeg(args, timeoutMs = FFMPEG_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (d) => {
      stderr = (stderr + d.toString()).slice(-2000);
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(Object.assign(new Error(`ffmpeg timeout after ${timeoutMs}ms`), { code: 'FFMPEG_TIMEOUT' }));
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-300)}`));
    });
  });
}

/** Aspect-preserving resize + letterbox pad to the target box. */
const SCALE_VF = `scale=${THUMB_WIDTH}:${THUMB_HEIGHT}:force_original_aspect_ratio=decrease,pad=${THUMB_WIDTH}:${THUMB_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=black`;

/* ------------------------------ youtube helpers -------------------------------- */

/** Extract the video id from a youtube/youtu.be/embed URL (or null). */
function extractYoutubeId(u) {
  try {
    const url = new URL(u);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'youtu.be') {
      const id = url.pathname.slice(1).split('/')[0];
      return /^[A-Za-z0-9_-]{6,}$/.test(id) ? id : null;
    }
    if (host === 'youtube.com' || host === 'youtube-nocookie.com' || host.endsWith('.youtube.com')) {
      const v = url.searchParams.get('v');
      if (v && /^[A-Za-z0-9_-]{6,}$/.test(v)) return v;
      const m = url.pathname.match(/\/(embed|shorts|live)\/([A-Za-z0-9_-]{6,})/);
      if (m) return m[2];
    }
  } catch {
    /* invalid URL */
  }
  return null;
}

/* ------------------------------- the importer ---------------------------------- */

/**
 * On-demand thumbnail import. HONEST results — no tooling on the host is
 * reported as such, never as a fake success. Zero background jobs.
 */
export async function importThumbnail({ url, contentId } = {}) {
  const id = String(contentId ?? '');
  if (!ID_RE.test(id)) {
    return { ok: false, reason: 'content-id-invalid', thumbnailId: null };
  }
  const detected = detectSourceType(url);
  if (!detected) {
    return { ok: false, reason: 'url-nepermisa-domeniu-nealowlistat', thumbnailId: null };
  }
  if (detected.sourceType === 'rumble') {
    // Honest: Rumble has no public thumbnail API.
    return { ok: false, reason: 'rumble-fara-api-public', thumbnailId: null };
  }
  if (detected.sourceType !== 'youtube' && detected.sourceType !== 'direct_url') {
    return { ok: false, reason: `tip-sursa-nesuportat-${detected.sourceType}`, thumbnailId: null };
  }

  const target = thumbPath(id);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  const t0 = Date.now();
  try {
    await fsp.mkdir(path.dirname(target), { recursive: true });

    if (detected.sourceType === 'youtube') {
      const vid = extractYoutubeId(detected.normalizedUrl);
      if (!vid) return { ok: false, reason: 'youtube-id-nedetectat', thumbnailId: null };
      const resp = await fetch(`https://i.ytimg.com/vi/${vid}/hqdefault.jpg`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!resp.ok) return { ok: false, reason: `ytimg-http-${resp.status}`, thumbnailId: null };
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length === 0) return { ok: false, reason: 'thumbnail-gol-de-la-sursa', thumbnailId: null };
      const contentType = resp.headers.get('content-type') || '';
      if (contentType.includes('webp')) {
        await fsp.writeFile(tmp, buf);
        await fsp.rename(tmp, target);
        logger.info(`[ar10m/thumbs] imported ${id} ← youtube hqdefault (webp direct) în ${Date.now() - t0}ms`);
        return { ok: true, thumbnailId: id, origin: 'youtube-hqdefault' };
      }
      // JPG/PNG from ytimg → conversion to WebP requires ffmpeg.
      if (!(await ffmpegAvailable())) {
        return { ok: false, reason: 'ffmpeg-indisponibil-pentru-conversie', thumbnailId: null };
      }
      const srcTmp = `${tmp}.src`;
      await fsp.writeFile(srcTmp, buf);
      try {
        await runFfmpeg(['-y', '-loglevel', 'error', '-i', srcTmp, '-vf', SCALE_VF, '-c:v', 'libwebp', '-quality', String(THUMB_QUALITY), tmp]);
      } finally {
        await fsp.rm(srcTmp, { force: true }).catch(() => {});
      }
    } else {
      // direct_url → extract a frame at 3s straight from the URL.
      if (!(await ffmpegAvailable())) {
        return { ok: false, reason: 'ffmpeg-indisponibil', thumbnailId: null };
      }
      await runFfmpeg(['-y', '-loglevel', 'error', '-ss', '3', '-i', detected.normalizedUrl, '-frames:v', '1', '-vf', SCALE_VF, '-c:v', 'libwebp', '-quality', String(THUMB_QUALITY), tmp]);
    }

    const stat = await fsp.stat(tmp);
    if (stat.size === 0 || stat.size > MAX_THUMB_BYTES) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      return { ok: false, reason: stat.size === 0 ? 'frame-gol' : 'thumbnail-prea-mare', thumbnailId: null };
    }
    await fsp.rename(tmp, target); // atomic save
    logger.info(`[ar10m/thumbs] imported ${id} ← ${detected.sourceType} (ffmpeg) în ${Date.now() - t0}ms`);
    return { ok: true, thumbnailId: id, origin: detected.sourceType === 'youtube' ? 'youtube-hqdefault-convertit' : 'ffmpeg-frame-3s' };
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    const reason = err?.code === 'FFMPEG_TIMEOUT' ? 'ffmpeg-timeout' : String(err?.message ?? err).slice(0, 200);
    logger.warn(`[ar10m/thumbs] import eșuat pentru ${id}: ${reason}`);
    return { ok: false, reason, thumbnailId: null };
  }
}
