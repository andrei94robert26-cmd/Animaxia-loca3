/**
 * Authenticated JSON metadata import for activated hub/API/addon adapters.
 * No arbitrary remote URL is fetched; payloads are supplied by trusted admins.
 * This is a bounded, synchronous single-node importer, not a distributed crawler.
 */
import express from 'express';
import { upsertContent } from '../../db.js';
import { events } from '../platform/events.js';
import { cache } from '../../cache.js';
import { requireMetadataIngestAccess, allowedMetadataServiceSource } from './service-auth.js';
import { userRateLimit } from '../security/security.js';
import { normalizedType } from '../search/sqlite-advanced.js';

const router = express.Router();
const limiter = userRateLimit({ scope: 'ip', max: 20, windowMs: 60_000, key: 'metadata-import' });
const SOURCE_TYPES = new Set(['hub', 'api', 'addon']);
const MEDIA_TYPES = new Set(['mp4', 'm3u8', 'mpd', 'iframe', 'youtube']);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v, limit = 300) => (typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)))
  ? String(v).trim().slice(0, limit) : '';
const asNames = (raw) => {
  const list = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  return [...new Set(list.map((x) => text(isObject(x) ? x.name : x, 120)).filter(Boolean))].slice(0, 40);
};
const safeUrl = (raw) => {
  try {
    if (typeof raw !== 'string' || raw.length > 2048) return null;
    const url = new URL(raw);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    return url.toString();
  } catch { return null; }
};
function playerSources(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  return raw.slice(0, 15).flatMap((entry) => {
    if (!isObject(entry)) return [];
    const url = safeUrl(entry.url || entry.src);
    if (!url || seen.has(url)) return [];
    const declared = text(entry.type, 20).toLowerCase();
    const pathname = new URL(url).pathname.toLowerCase();
    const inferred = pathname.endsWith('.mp4') ? 'mp4'
      : pathname.endsWith('.m3u8') ? 'm3u8'
      : pathname.endsWith('.mpd') ? 'mpd' : 'iframe';
    const type = MEDIA_TYPES.has(declared) ? declared : inferred;
    seen.add(url);
    return [{ url, type, label: text(entry.label, 90) || 'External source' }];
  });
}
function toMetadata(item, source) {
  const m = isObject(item.metadata) ? item.metadata : {};
  // Partial updates must preserve existing fields and media sources.
  const result = {
    source: source.type + ':' + source.id,
    origin: { providerType: source.type, providerId: source.id, itemId: String(item.id) },
  };
  const maybeField = (key, raw, transform) => {
    if (raw !== undefined && raw !== null) result[key] = transform(raw);
  };
  maybeField('genres', item.genres ?? item.genre ?? m.genres, asNames);
  maybeField('actors', item.actors ?? item.cast ?? m.actors, asNames);
  maybeField('studios', item.studios ?? item.studio ?? item.production_companies ?? m.studios, asNames);
  for (const key of ['franchise', 'trilogy', 'collection']) {
    const raw = item[key] ?? m[key] ?? (key === 'collection' ? item.belongs_to_collection : undefined);
    maybeField(key, raw, (v) => text(isObject(v) ? v.name : v, 160));
  }
  maybeField('posterId', item.posterId ?? item.poster_id ?? m.posterId, (v) => text(v, 160));
  maybeField('overview', item.description ?? item.overview ?? m.overview ?? m.description ?? m.synopsis,
    (v) => text(v, 5000));
  const yearInput = item.year ?? m.year ?? item.release_date?.slice?.(0, 4)
    ?? item.first_air_date?.slice?.(0, 4);
  if (yearInput !== undefined && yearInput !== null) {
    const year = Number(yearInput);
    if (Number.isInteger(year) && year >= 1880 && year <= 2200) result.year = year;
  }
  const ratingInput = item.rating ?? m.rating;
  if (ratingInput !== undefined && ratingInput !== null) {
    const rating = Number(ratingInput);
    if (Number.isFinite(rating) && rating >= 0 && rating <= 10) result.rating = rating;
  }
  const sources = item.sources ?? m.player?.sources;
  if (sources !== undefined) result.player = { sources: playerSources(sources) };
  return result;
}

router.post('/metadata', requireMetadataIngestAccess, limiter, async (req, res, next) => {
  try {
    const { source, items } = req.body || {};
    if (!isObject(source) || !SOURCE_TYPES.has(source.type)
      || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(source.id || '')
      || !Array.isArray(items) || items.length < 1 || items.length > 100) {
      return res.status(400).json({
        error: 'Expected source:{type:hub|api|addon,id:slug} and items array (1..100)',
      });
    }
    if (req.metadataIngestService && !allowedMetadataServiceSource(source)) {
      return res.status(403).json({ error: 'Source is not enabled for metadata service ingestion' });
    }
    const successes = [];
    const errors = [];
    const changedIds = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const category = normalizedType(item?.category || item?.type || item?.mediaType || item?.media_type || item?.metadata?.mediaType || '');
      const title = text(item?.title || item?.name || item?.original_title || item?.original_name, 300);
      const itemId = item?.id == null ? '' : String(item.id).trim();
      if (!isObject(item) || !title || !category || !/^[a-zA-Z0-9._:-]{1,128}$/.test(itemId)) {
        errors.push({ index: i, error: 'Missing/invalid item id, title or category' });
        continue;
      }
      const externalid = [source.type, source.id, category, itemId].join(':');
      const metadata = toMetadata(item, source);
      const thumbnail = safeUrl(item.thumbnail || item.poster || item.posterUrl || item.metadata?.thumbnail);
      try {
        const result = await upsertContent({ externalid, title, type: category, thumbnail, metadata });
        changedIds.push(result.record.id);
        successes.push({ index: i, id: result.record.id, externalid, created: result.created });
      } catch (err) {
        errors.push({ index: i, error: 'Content could not be stored (check duplicate identifiers or metadata)' });
      }
    }
    if (changedIds.length) {
      cache.clearPrefix('http:');
      events.emit('content:changed:ids', { ids: [...new Set(changedIds)], action: 'update' });
      events.emit('content:changed');
    }
    return res.json({
      ok: errors.length === 0, partial: errors.length > 0 && successes.length > 0,
      source: { type: source.type, id: source.id },
      accepted: successes.length, created: successes.filter((s) => s.created).length,
      updated: successes.filter((s) => !s.created).length,
      rejected: errors.length, data: successes, errors,
      mode: 'sqlite-synchronous', indexed: 'scheduled',
    });
  } catch (err) { return next(err); }
});
export default router;
