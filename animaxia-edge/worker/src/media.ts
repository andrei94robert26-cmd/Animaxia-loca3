/**
 * worker/src/media.ts — R2 media serving for /media/* (thumbnails and the
 * bundled offline-test.mp4). Range requests are supported so video clients
 * can seek; ETag + accept-ranges + immutable-ish cache-control come standard.
 * The gateway owns this route directly — media never leaves the edge.
 */

import type { EdgeEnv } from '../../shared/types';
import { jsonError } from '../../shared/http';

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.ts': 'video/mp2t',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

function extOf(key: string): string {
  const i = key.lastIndexOf('.');
  return i === -1 ? '' : key.slice(i).toLowerCase();
}

/** Parse a single-range `bytes=` header against a known object size. */
function parseRange(
  header: string | null,
  size: number,
): { offset: number; length: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, startRaw, endRaw] = m;
  if (startRaw === '' && endRaw === '') return null;

  let offset = 0;
  let length = size;
  if (startRaw !== '') {
    offset = Number(startRaw);
    const end = endRaw !== '' ? Number(endRaw) : size - 1;
    if (!Number.isFinite(offset) || !Number.isFinite(end) || end < offset) return null;
    length = end - offset + 1;
  } else {
    // Suffix range: bytes=-N → last N bytes.
    const suffix = Number(endRaw);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    offset = Math.max(0, size - suffix);
    length = size - offset;
  }
  if (offset < 0 || length <= 0 || offset >= size) return null;
  return { offset, length: Math.min(length, size - offset) };
}

export async function serveR2Media(request: Request, env: EdgeEnv, url: URL): Promise<Response> {
  const bucket = env.MEDIA_BUCKET;
  if (!bucket) {
    return jsonError(501, 'media_unavailable', 'R2 MEDIA_BUCKET is not bound at this edge deployment.');
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return jsonError(405, 'method_not_allowed', 'R2 media is read-only at the edge (upload via the cloud API).');
  }

  const raw = url.pathname.replace(/^\/media\//, '');
  let key: string;
  try {
    key = decodeURIComponent(raw);
  } catch {
    return jsonError(400, 'bad_key', 'Media key is not valid percent-encoding.');
  }
  if (!key || key.includes('..') || key.startsWith('/')) {
    return jsonError(400, 'bad_key', 'Invalid media key.');
  }

  const rangeHeader = request.headers.get('range');

  if (!rangeHeader) {
    // Whole-object path — a single R2 get provides size + body.
    const obj = await bucket.get(key).catch(() => null);
    if (!obj) return jsonError(404, 'media_not_found', `No R2 object at "${key}".`);
    const headers = new Headers();
    obj.writeHttpMetadata(headers);
    headers.set('etag', obj.httpEtag);
    headers.set('accept-ranges', 'bytes');
    headers.set('content-length', String(obj.size));
    headers.set('cache-control', 'public, max-age=86400');
    if (!headers.get('content-type')) {
      headers.set('content-type', MIME_BY_EXT[extOf(key)] ?? 'application/octet-stream');
    }
    return new Response(request.method === 'HEAD' ? null : (obj.body ?? null), {
      status: 200,
      headers,
    });
  }

  // Range path — head first for the authoritative size, then a ranged get.
  const head = await bucket.head(key).catch(() => null);
  if (!head) return jsonError(404, 'media_not_found', `No R2 object at "${key}".`);
  const range = parseRange(rangeHeader, head.size);
  if (!range) {
    return new Response(null, {
      status: 416,
      headers: { 'content-range': `bytes */${head.size}` },
    });
  }
  const obj = await bucket.get(key, { range }).catch(() => null);
  if (!obj) return jsonError(404, 'media_not_found', `No R2 object at "${key}".`);

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  headers.set('accept-ranges', 'bytes');
  headers.set('cache-control', 'public, max-age=86400');
  headers.set('content-length', String(range.length));
  headers.set('content-range', `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`);
  if (!headers.get('content-type')) {
    headers.set('content-type', MIME_BY_EXT[extOf(key)] ?? 'application/octet-stream');
  }
  return new Response(request.method === 'HEAD' ? null : (obj.body ?? null), {
    status: 206,
    headers,
  });
}
