/**
 * player/src/hls.ts — line-based HLS (m3u8) manifest rewriter + media types.
 *
 * rewriteManifest(text, manifestUrl) maps every URI a player would fetch to
 * an edge path on the same host, so the whole stream flows through this
 * worker where the allowlist + caching apply:
 *
 *   • non-comment URI lines (nested variant playlists + media segments) are
 *     resolved against manifestUrl to an absolute URL first, then
 *       pathname ends .m3u8   → /player/manifest/variant?src=<enc>
 *       anything else         → /hls?u=<enc>            (segment)
 *   • URI="…" attributes inside #EXT-X-KEY / #EXT-X-MAP / #EXT-X-MEDIA /
 *     #EXT-X-I-FRAME-STREAM-INF tags follow the same rule (keys + init
 *     segments → /hls, rendition playlists → the variant endpoint)
 *
 * Absolute upstream URIs are resolved too (new URL(uri, manifestUrl)); URIs
 * with a non-http(s) scheme (e.g. data: keys) are left untouched. Output
 * uses LF line endings (legal per the HLS spec, which allows LF or CRLF).
 */

export const M3U8_CONTENT_TYPE = 'application/vnd.apple.mpegurl';

const VARIANT_PATH = '/player/manifest/variant';
const SEGMENT_PATH = '/hls';

/** Tags whose URI="…" attribute points at another HLS resource. */
const URI_TAG_RE = /^#EXT-X-(?:KEY|MAP|MEDIA|I-FRAME-STREAM-INF):/i;

/** Map an absolute upstream URL to an edge path (playlist vs segment). */
function toEdgePath(abs: URL): string {
  const isPlaylist = abs.pathname.toLowerCase().endsWith('.m3u8');
  const prefix = isPlaylist ? `${VARIANT_PATH}?src=` : `${SEGMENT_PATH}?u=`;
  return `${prefix}${encodeURIComponent(abs.href)}`;
}

/** Resolve one URI against the manifest base; unrewritable URIs pass through. */
function rewriteUri(uri: string, base: URL): string {
  let abs: URL;
  try {
    abs = new URL(uri, base);
  } catch {
    return uri; // unparseable → leave the original for the client
  }
  if (abs.protocol !== 'http:' && abs.protocol !== 'https:') {
    return uri; // data: keys and friends stay inline
  }
  return toEdgePath(abs);
}

/**
 * Rewrite a manifest line by line. `manifestUrl` is the absolute URL the
 * manifest was fetched from — the base for resolving relative URIs.
 */
export function rewriteManifest(text: string, manifestUrl: string): string {
  let base: URL;
  try {
    base = new URL(manifestUrl);
  } catch {
    return text; // no base to resolve against → cannot rewrite
  }

  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw; // tolerate CRLF

    if (line.startsWith('#')) {
      if (URI_TAG_RE.test(line)) {
        out.push(line.replace(/URI="([^"]*)"/gi, (_whole, uri: string) => `URI="${rewriteUri(uri, base)}"`));
      } else {
        out.push(line);
      }
      continue;
    }
    if (line.trim() === '') {
      out.push(line);
      continue;
    }
    out.push(rewriteUri(line.trim(), base));
  }
  return out.join('\n');
}

/* ------------------------------------------------------ content types ----- */

/** Content type by file extension (R2 media objects + HLS segments). */
export function contentTypeForPath(pathname: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(pathname)?.[1]?.toLowerCase();
  switch (ext) {
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'png': return 'image/png';
    case 'webp': return 'image/webp';
    case 'gif': return 'image/gif';
    case 'mp4': return 'video/mp4';
    case 'webm': return 'video/webm';
    case 'ts': return 'video/mp2t';
    case 'm3u8': return M3U8_CONTENT_TYPE;
    case 'json': return 'application/json';
    case 'txt': return 'text/plain; charset=utf-8';
    default: return 'application/octet-stream';
  }
}

/** Extensions eligible for the R2 write-through (cfg.player.r2WriteThrough). */
export function writeThroughExt(pathname: string): 'ts' | 'm4s' | 'mp4' | null {
  const lower = pathname.toLowerCase();
  if (lower.endsWith('.ts')) return 'ts';
  if (lower.endsWith('.m4s')) return 'm4s';
  if (lower.endsWith('.mp4')) return 'mp4';
  return null;
}
