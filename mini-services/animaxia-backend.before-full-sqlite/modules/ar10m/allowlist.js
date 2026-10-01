/**
 * modules/ar10m/allowlist.js — AR10M source validation (Task AR10M-2-BE).
 *
 * PURE policy module: decides which video/embed sources are allowed in the
 * real AR10M catalog and sanitizes embed codes so NO arbitrary JavaScript
 * can ever enter the pipeline. The only import is node:crypto for the
 * deterministic source hash.
 *
 *   • ALLOWED_SOURCE_TYPES — the 6 source types accepted by ar10m.content_sources.
 *   • DOMAIN_ALLOWLIST — base allowlist + env EXTRA_ALLOWED_DOMAINS.
 *   • detectSourceType(url) — classifies an URL into a source type; the host
 *     must be in the allowlist (exact or subdomain), else null.
 *   • sanitizeEmbedCode(code, domain) — accepts ONLY a single <iframe> whose
 *     src is https and allowlisted; strips on* handlers; rejects everything
 *     suspicious (scripts, javascript:, non-iframe tags) with null.
 *   • sourceHash(type, url) — sha256('type|url') — the dedupe key used by
 *     ar10m.content_sources.source_hash.
 */

import { createHash } from 'node:crypto';

/** The 6 source types accepted by ar10m.content_sources (CHECK constraint). */
export const ALLOWED_SOURCE_TYPES = ['direct_url', 'youtube', 'rumble', 'iframe', 'embed', 'hls'];

/** Base allowlist of video/embed domains (trusted, no arbitrary embeds). */
const BASE_DOMAINS = [
  'youtube.com',
  'youtu.be',
  'youtube-nocookie.com',
  'rumble.com',
  'cdn.jsdelivr.net',
  'commondatastorage.googleapis.com',
  'test-videos.co.uk',
  /* legit HLS test CDNs already used by the platform player demos */
  'test-streams.mux.dev',
  'devstreaming-cdn.apple.com',
  'storage.googleapis.com',
  'vjs.zencdn.net',
  'download.blender.org',
  'peach.blender.org',
  'media.w3.org',
];

/** Extra domains from env EXTRA_ALLOWED_DOMAINS (comma separated). */
const EXTRA_DOMAINS = (process.env.EXTRA_ALLOWED_DOMAINS || '')
  .split(',')
  .map((d) => d.trim().toLowerCase())
  .filter((d) => d.length > 0 && d.includes('.') && !/[/?#\s]/.test(d));

/** Full allowlist (deduped, lowercase). */
export const DOMAIN_ALLOWLIST = [...new Set([...BASE_DOMAINS, ...EXTRA_DOMAINS])];

const DOMAIN_SET = new Set(DOMAIN_ALLOWLIST);

/** True when host is an allowlisted domain or a subdomain of one. */
export function isAllowedDomain(host) {
  if (!host) return false;
  const h = String(host).toLowerCase();
  if (DOMAIN_SET.has(h)) return true;
  // subdomain: walk up the labels (a.b.youtube.com → b.youtube.com → youtube.com)
  let idx = h.indexOf('.');
  while (idx !== -1) {
    const parent = h.slice(idx + 1);
    if (DOMAIN_SET.has(parent)) return true;
    idx = h.indexOf('.', idx + 1);
  }
  return false;
}

/** File extensions classified as direct video files. */
const DIRECT_VIDEO_EXT = /\.(mp4|webm|mkv|mov)(\?|#|$)/i;

/**
 * Classify a source URL.
 * Returns { sourceType, normalizedUrl, domain } or null when the URL is
 * malformed, not http(s), or its domain is not allowlisted.
 *
 * Rules (in order):
 *   youtube.com/watch?v=… or youtu.be/…      → 'youtube'
 *   youtube.com/embed/… (and -nocookie)      → 'embed'
 *   rumble.com/embed…                        → 'rumble'
 *   *.m3u8                                   → 'hls'
 *   .mp4/.webm/.mkv/.mov over http(s)        → 'direct_url'
 *   any other allowlisted domain             → 'iframe'
 */
export function detectSourceType(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl ?? '').trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const domain = url.hostname.toLowerCase();
  if (!isAllowedDomain(domain)) return null;

  const path = url.pathname;
  const host = domain.replace(/^www\./, '');

  if ((host === 'youtube.com' || host === 'youtube-nocookie.com') && /^\/watch\/?$/.test(path) && url.searchParams.has('v')) {
    return { sourceType: 'youtube', normalizedUrl: url.toString(), domain };
  }
  if (host === 'youtu.be' && path.length > 1) {
    return { sourceType: 'youtube', normalizedUrl: url.toString(), domain };
  }
  if ((host === 'youtube.com' || host === 'youtube-nocookie.com') && /^\/embed\//.test(path)) {
    return { sourceType: 'embed', normalizedUrl: url.toString(), domain };
  }
  if (host === 'rumble.com' || domain.endsWith('.rumble.com')) {
    if (/^\/embed[a-z0-9.-]*\//.test(path) || /^\/embed/.test(path)) {
      return { sourceType: 'rumble', normalizedUrl: url.toString(), domain };
    }
    // non-embed rumble pages are not playable sources
    return null;
  }
  if (/\.m3u8(\?|#|$)/i.test(url.pathname + url.search)) {
    return { sourceType: 'hls', normalizedUrl: url.toString(), domain };
  }
  if (DIRECT_VIDEO_EXT.test(url.pathname)) {
    return { sourceType: 'direct_url', normalizedUrl: url.toString(), domain };
  }
  return { sourceType: 'iframe', normalizedUrl: url.toString(), domain };
}

/* ------------------------------ embed sanitizer ----------------------------- */

/** Max accepted embed code length. */
const MAX_EMBED_LEN = 2000;

/** Anything with an event-handler attribute is rejected (not even stripped
 *  silently — suspicious input returns null so the caller can log it). */
const ON_ATTR = /\son[a-z]+\s*=/i;

/** A single <iframe …></iframe> (no inner content beyond whitespace). */
const IFRAME_ONLY = /^\s*<iframe\b[^>]*>\s*<\/iframe>\s*$/i;

/** Extract the src="…" value from an iframe tag. */
const SRC_ATTR = /\ssrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i;

/** Strip <script>…</script> blocks (case-insensitive, multiline). */
const SCRIPT_BLOCK = /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi;

/**
 * Sanitize an embed code. Accepts ONLY a single <iframe …></iframe> whose
 * src is an https URL on an allowlisted domain (optionally the given
 * `domain` when provided). Strips <script> blocks defensively, but ANY
 * remaining suspicious construct (on* handlers, javascript:, non-iframe
 * tags, >2000 chars, non-https src, disallowed src host) returns null.
 * Never returns anything except a clean iframe tag — no arbitrary JS ever.
 */
export function sanitizeEmbedCode(code, domain) {
  if (typeof code !== 'string' || code.length === 0 || code.length > MAX_EMBED_LEN) return null;
  // Hard rejects first — anything scripty or javascript:-flavored is fatal.
  if (/<script\b/i.test(code)) return null;
  if (/javascript\s*:/i.test(code)) return null;
  if (/data\s*:/i.test(code)) return null;
  if (ON_ATTR.test(code)) return null;
  // Must be exactly one iframe element (no sibling tags, no inner content).
  if (!IFRAME_ONLY.test(code)) return null;

  const srcMatch = code.match(SRC_ATTR);
  if (!srcMatch) return null;
  const src = (srcMatch[2] ?? srcMatch[3] ?? srcMatch[4] ?? '').trim();
  let url;
  try {
    url = new URL(src);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (!isAllowedDomain(url.hostname)) return null;
  if (domain) {
    // When an expected domain is given, the src host must be it (or subdomain).
    const expected = String(domain).toLowerCase().replace(/^www\./, '');
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (host !== expected && !host.endsWith(`.${expected}`)) return null;
  }
  // Re-emit a minimal, canonical iframe: only allowlisted src survives.
  return `<iframe src="${src}" allowfullscreen loading="lazy" referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
}

/**
 * Deterministic dedupe key for ar10m.content_sources.source_hash:
 * sha256(sourceType + '|' + normalizedUrl), hex.
 */
export function sourceHash(sourceType, sourceUrl) {
  const key = `${String(sourceType ?? '')}|${String(sourceUrl ?? '')}`;
  return createHash('sha256').update(key, 'utf8').digest('hex');
}
