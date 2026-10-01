/**
 * modules/player/player.js — Player resolution: policy-filtered direct sources,
 * automatic YouTube trailer search fallback when no direct sources exist.
 *
 * FAZA 14 (Task 14-2): UNIVERSAL EXTERNAL PLAYBACK — resolveExternalSource()
 * turns ANY external URL into a playable descriptor (YouTube, Vimeo, Rumble,
 * MP4, HLS master.m3u8, generic iframe/embed/JS) with ZERO database access:
 * the player does NOT depend on how many real content rows exist in Neon
 * (definitive spec rule 4). New policy flags PLAYERALLOWVIMEO / PLAYERALLOWRUMBLE
 * (default allowed, same 'false'-to-disable convention as the rest).
 */

import { fetchProviderJson } from '../../utils/fetcher.js';
import { logger } from '../../utils/logger.js';

function policyAllows() {
  return {
    mp4: process.env.PLAYERALLOWMP4 !== 'false',
    m3u8: process.env.PLAYERALLOWM3U8 !== 'false',
    iframe: process.env.PLAYERALLOWIFRAME !== 'false',
    youtube: process.env.PLAYERALLOWYOUTUBE !== 'false',
    vimeo: process.env.PLAYERALLOWVIMEO !== 'false', // FAZA 14
    rumble: process.env.PLAYERALLOWRUMBLE !== 'false', // FAZA 14
  };
}

export function playerAllowedTypes() {
  const policy = policyAllows();
  return Object.entries(policy)
    .filter(([, enabled]) => enabled)
    .map(([type]) => type);
}

function inferType(url) {
  const u = String(url || '').toLowerCase();
  if (u.includes('.mp4')) return 'mp4';
  if (u.includes('.m3u8')) return 'm3u8';
  if (/youtube\.com|youtu\.be|youtube-nocookie\.com/.test(u)) return 'youtube';
  if (/vimeo\.com|player\.vimeo\.com/.test(u)) return 'vimeo'; // FAZA 14
  if (/rumble\.com/.test(u)) return 'rumble'; // FAZA 14
  return 'iframe';
}

/* --------------------- FAZA 14: universal external playback --------------------- */

/** Extract an 11-char YouTube video id from any YouTube URL shape. */
function youtubeIdOf(url) {
  const u = String(url || '');
  let m = u.match(/[?&]v=([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  m = u.match(/youtu\.be\/([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  m = u.match(/youtube\.com\/(?:embed|shorts|live|v)\/([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  m = u.match(/youtube-nocookie\.com\/embed\/([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  return null;
}

/** Extract a Vimeo video id (numeric path segment). */
function vimeoIdOf(url) {
  const m = String(url || '').match(/vimeo\.com\/(?:video\/)?(\d{6,12})/);
  return m ? m[1] : null;
}

/** True when the URL points at a private/loopback network target (SSRF guard).
 *  Mirrors the miner's MINERALLOWPRIVATE_NETWORK escape hatch. */
function isPrivateNetworkUrl(rawUrl) {
  if (process.env.MINERALLOWPRIVATE_NETWORK === 'true') return false;
  let host;
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return true;
  }
  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '[::1]' ||
    host === '0.0.0.0' ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    host.endsWith('.local')
  ) {
    return true;
  }
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  return false;
}

/**
 * FAZA 14: resolve ANY external URL to a playable descriptor — PURE
 * computation, ZERO database access (the player never depends on how many
 * real content rows exist). Detection: YouTube (watch/shorts/youtu.be/embed),
 * Vimeo (canonical player embed), Rumble (embed URLs pass through; watch URLs
 * fall back to a sandboxed iframe), direct MP4, HLS (.m3u8 — master or
 * variant), and any other http(s) URL → generic iframe (covers every embed
 * JS / CDN page). Policy-filtered like every other source type.
 *
 * @param {string} rawUrl
 * @returns {{ ok: boolean, type?: string, url: string, embedUrl?: string,
 *   label?: string, allowedTypes: string[], contentFree: true,
 *   error?: string }} — contentFree:true marks the no-DB guarantee.
 */
export function resolveExternalSource(rawUrl) {
  const allowedTypes = playerAllowedTypes();
  const url = String(rawUrl || '').trim();

  if (!url) return { ok: false, error: 'Missing url', allowedTypes, url, contentFree: true };

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: 'Invalid url — expected an absolute http(s) URL', allowedTypes, url, contentFree: true };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'Unsupported protocol — expected http or https', allowedTypes, url, contentFree: true };
  }
  if (isPrivateNetworkUrl(url)) {
    return { ok: false, error: 'Private network URLs are blocked by the player policy', allowedTypes, url, contentFree: true };
  }

  const type = inferType(url);
  const policy = policyAllows();
  if (!policy[type]) {
    return {
      ok: false,
      error: `Sources of type "${type}" are disabled by player policy`,
      allowedTypes,
      url,
      contentFree: true,
    };
  }

  let embedUrl = url;
  let label = 'Sursă externă';
  if (type === 'youtube') {
    const id = youtubeIdOf(url);
    if (id) {
      embedUrl = `https://www.youtube-nocookie.com/embed/${id}`;
      label = 'YouTube embed';
    }
  } else if (type === 'vimeo') {
    const id = vimeoIdOf(url);
    if (id) {
      embedUrl = `https://player.vimeo.com/video/${id}`;
      label = 'Vimeo embed';
    }
  } else if (type === 'rumble') {
    label = 'Rumble embed';
    // rumble.com/embed/… is already the embeddable form; watch pages keep the
    // original URL and play through the sandboxed generic iframe.
  } else if (type === 'mp4') {
    label = 'Video MP4 direct';
  } else if (type === 'm3u8') {
    label = 'Stream HLS (m3u8)';
  } else {
    label = 'Embed extern (iframe)';
  }

  return { ok: true, type, url, embedUrl, label, allowedTypes, contentFree: true };
}

function normalizeSources(rawSources) {
  if (!Array.isArray(rawSources)) return [];
  return rawSources
    .filter((s) => s && typeof s === 'object' && (s.url || s.src))
    .map((s) => ({
      type: s.type || inferType(s.url || s.src),
      url: s.url || s.src,
      label: s.label || s.type || 'Source',
    }));
}

async function searchYouTubeTrailer(title) {
  const key = process.env.YOUTUBEAPIKEY;
  const base = process.env.YOUTUBEBASEURL || 'https://www.googleapis.com/youtube/v3';
  if (!key || !title) return null;
  try {
    const data = await fetchProviderJson('youtube', `${base}/search`, {
      params: {
        part: 'snippet',
        q: `${title} official trailer`,
        type: 'video',
        maxResults: 1,
        videoEmbeddable: 'true',
        key,
      },
      timeoutMs: 10000,
      retries: 1,
    });
    const videoId = data?.items?.[0]?.id?.videoId;
    if (!videoId) return null;
    return {
      type: 'youtube',
      url: `https://www.youtube.com/embed/${videoId}`,
      label: 'Official trailer · YouTube',
    };
  } catch (err) {
    logger.warn(`[player] YouTube trailer search failed: ${err.message}`);
    return null;
  }
}

/**
 * Resolve playable sources for a content row.
 * @param {object} content - DB content row (with metadata.player.sources).
 * @returns {Promise<{ content: object, mode: string, allowedTypes: string[], sources: object[], primary?: object, note?: string }>}
 */
export async function resolvePlayer(content) {
  const policy = policyAllows();
  const allowedTypes = playerAllowedTypes();

  const rawSources = content?.metadata?.player?.sources || content?.metadata?.sources || [];
  const normalized = normalizeSources(rawSources);
  const hasAnyRaw = normalized.length > 0;
  const sources = normalized.filter((s) => policy[s.type]);

  if (hasAnyRaw && sources.length === 0) {
    return {
      content,
      mode: 'none',
      allowedTypes,
      sources: [],
      note: 'All sources are disabled by player policy',
    };
  }

  if (sources.length > 0) {
    const primary =
      sources.find((s) => s.type === 'mp4') ||
      sources.find((s) => s.type === 'm3u8') ||
      sources.find((s) => s.type === 'youtube') ||
      sources.find((s) => s.type === 'vimeo') || // FAZA 14
      sources.find((s) => s.type === 'rumble') || // FAZA 14
      sources.find((s) => s.type === 'iframe') ||
      null;
    return { content, mode: 'direct', allowedTypes, sources, primary };
  }

  // No direct sources — try to find an official trailer on YouTube.
  if (process.env.YOUTUBEAPIKEY && policy.youtube) {
    const trailer = await searchYouTubeTrailer(content?.title);
    if (trailer) {
      return {
        content,
        mode: 'trailer',
        allowedTypes,
        sources: [trailer],
        primary: trailer,
      };
    }
  }

  return {
    content,
    mode: 'none',
    allowedTypes,
    sources: [],
    note: 'No stream sources available for this title yet. Use the Miner to attach one.',
  };
}
