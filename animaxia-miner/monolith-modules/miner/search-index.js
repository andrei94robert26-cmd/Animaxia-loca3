/**
 * modules/miner/search-index.js — FAZA 12 miner → search catalog push.
 *
 * Additive module with a PLUGGABLE pusher:
 *   • External search engine configured → real push. Set OPENSEARCHURL
 *     (e.g. 'https://search.internal:9200') and optionally OPENSEARCHINDEX
 *     (default 'animaxia') + OPENSEARCHAPIKEY. Documents are bulk-indexed
 *     per tenant: index '<index>-<tenantid>' (global → '<index>-global',
 *     keeping tenant corpora isolated, same policy as the edge search
 *     worker's per-tenant KV catalogs from FAZA 11).
 *   • No engine configured → local fallback: the compact catalog document
 *     is cached under advancedCache with the 'miner' tag (mirrors the
 *     workers.js prefetch pattern) so /api/miner/status can report it and
 *     other modules can read it without a search engine dependency.
 *
 * API:
 *   pushToSearchIndex(contentRows, tenantid) — bulk push / local catalog
 *   searchIndexBackend()                      — 'opensearch' | 'local'
 *   localCatalogSnapshot(tenantid)            — read back the local catalog
 */

import { logger } from '../../utils/logger.js';
import { advancedCache } from '../cache/advancedCache.js';
import { GLOBAL_TENANT_SLUG } from '../tenant/core.js';

const CATALOG_TTL_MS = 30 * 60 * 1000; // 30 min

function tenantSlug(tenantid) {
  return String(tenantid || GLOBAL_TENANT_SLUG);
}

/** Compact search document for one content row. */
function toSearchDoc(row) {
  const meta = row?.metadata || {};
  return {
    id: row?.id,
    title: row?.title,
    type: row?.type,
    thumbnail: row?.thumbnail ?? null,
    externalid: row?.externalid ?? null,
    rating: meta.rating ?? meta.score ?? null,
    year: meta.year ?? null,
    genres: Array.isArray(meta.genres) ? meta.genres : [],
    keywords: buildKeywords(row),
  };
}

function buildKeywords(row) {
  const meta = row?.metadata || {};
  const words = new Set();
  for (const token of String(row?.title || '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (token.length >= 3) words.add(token);
  }
  for (const g of Array.isArray(meta.genres) ? meta.genres : []) {
    words.add(String(g).toLowerCase());
  }
  if (meta.source) words.add(String(meta.source).toLowerCase());
  return [...words].slice(0, 24);
}

export function searchIndexBackend() {
  return process.env.OPENSEARCHURL ? 'opensearch' : 'local';
}

function opensearchIndexName(tenantid) {
  const base = process.env.OPENSEARCHINDEX || 'animaxia';
  return `${base}-${tenantSlug(tenantid)}`;
}

/** Real OpenSearch/Elasticsearch _bulk push (best-effort, never throws). */
async function pushToOpenSearch(docs, tenantid) {
  const base = String(process.env.OPENSEARCHURL).replace(/\/+$/, '');
  const index = opensearchIndexName(tenantid);
  const body = docs
    .map((doc) => `${JSON.stringify({ index: { _index: index, _id: doc.id } })}\n${JSON.stringify(doc)}`)
    .join('\n') + '\n';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  if (typeof timer.unref === 'function') timer.unref();
  try {
    const headers = { 'Content-Type': 'application/x-ndjson' };
    if (process.env.OPENSEARCHAPIKEY) headers.Authorization = `ApiKey ${process.env.OPENSEARCHAPIKEY}`;
    const res = await fetch(`${base}/_bulk`, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`opensearch bulk ${res.status}`);
    return { pushed: docs.length, backend: 'opensearch', index };
  } catch (err) {
    clearTimeout(timer);
    logger.warn(`[miner] OpenSearch push failed (${index}): ${err.message} — falling back to local catalog`);
    return writeLocalCatalog(docs, tenantid);
  }
}

/** Local fallback: cache the compact catalog under advancedCache. */
function writeLocalCatalog(docs, tenantid) {
  const slug = tenantSlug(tenantid);
  const key = `miner:search-catalog:${slug}`;
  advancedCache.set(key, { tenant: slug, docs, updatedat: new Date().toISOString(), count: docs.length }, { ttlMs: CATALOG_TTL_MS, tags: ['miner'] });
  return { pushed: docs.length, backend: 'local', key };
}

/**
 * Push content rows to the search index for a tenant.
 * @param {Array} contentRows content-table rows (id/title/type/metadata…)
 * @param {string} tenantid tenant slug (default 'global')
 */
export async function pushToSearchIndex(contentRows, tenantid) {
  const rowsIn = Array.isArray(contentRows) ? contentRows : [];
  const docs = rowsIn.map(toSearchDoc).filter((d) => d.id != null && d.title);
  if (!docs.length) return { pushed: 0, backend: searchIndexBackend(), reason: 'no documents' };
  if (searchIndexBackend() === 'opensearch') {
    return pushToOpenSearch(docs, tenantid);
  }
  return writeLocalCatalog(docs, tenantid);
}

/** Read back the local catalog snapshot for a tenant (status endpoint). */
export function localCatalogSnapshot(tenantid) {
  const slug = tenantSlug(tenantid);
  const entry = advancedCache.get(`miner:search-catalog:${slug}`);
  if (!entry) return { tenant: slug, count: 0, updatedat: null };
  return { tenant: slug, count: entry.count ?? 0, updatedat: entry.updatedat ?? null };
}

export default { pushToSearchIndex, searchIndexBackend, localCatalogSnapshot };
