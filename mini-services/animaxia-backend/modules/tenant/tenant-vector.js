/**
 * modules/tenant/tenant-vector.js — FAZA 11 per-tenant vector indexes
 * (additive; vector-service.js itself is untouched).
 *
 * Isolation model — "index-uri separate per-tenant":
 *   • pgvector: the FAZA 11 migration adds `vectorembeddings.tenantid`
 *     (default 'global'). A tenant's index is the set of rows with
 *     tenantid = <slug> and refkeys namespaced `t:<slug>:<kind>:<refid>:0`,
 *     so upserts never collide with the global index and a tenant search
 *     never leaks another tenant's (or the platform's) embeddings.
 *   • Memory fallback: when the SQL layer is unavailable the module keeps a
 *     per-tenant in-process Map with the same namespaced keys (cosine in JS).
 *   • The implicit 'global' tenant delegates to the existing vectorSearch() —
 *     the full-library behavior is unchanged.
 *
 * Exposed API (used by tenant-ai.js router):
 *   indexTenantContent(tenant, { limit }) — (re)index up to `limit` library
 *       rows into the tenant namespace (usage event `vector_index`)
 *   tenantVectorSearch({ query, tenant, kind, topK }) — scoped similarity
 *   tenantMoreLikeThis(tenant, contentId, k) — scoped neighbors
 *   tenantVectorStatus(tenant) — per-kind counts for the tenant namespace
 */

import { listContent, getContentById } from '../../db.js';
import { rows, one } from '../platform/sql.js';
import { logger } from '../../utils/logger.js';
import { embedTexts, vectorSearch, contentDocText } from '../aicloud/vector-service.js';
import { recordTenantUsage, GLOBAL_TENANT_SLUG } from './core.js';

const EMBED_DIMS = 256;
const TENANT_INDEX_CAP = 300; // rows per tenant index pass

function tenantRefKey(slug, kind, refid) {
  return `t:${slug}:${kind}:${refid}:0`;
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/* ------------------------------ memory fallback ------------------------------ */

const tenantStore = new Map(); // slug → Map(refkey → rec)

function memoryUpsert(slug, items) {
  if (!tenantStore.has(slug)) tenantStore.set(slug, new Map());
  const store = tenantStore.get(slug);
  for (const item of items) {
    store.set(tenantRefKey(slug, item.kind, item.refid), {
      ...item,
      tenantid: slug,
      updatedat: new Date().toISOString(),
    });
  }
  return items.length;
}

function memorySearch(slug, vector, kind, topK) {
  const store = tenantStore.get(slug);
  if (!store) return [];
  const results = [];
  for (const rec of store.values()) {
    if (kind && rec.kind !== kind) continue;
    results.push({
      refkey: tenantRefKey(slug, rec.kind, rec.refid),
      kind: rec.kind,
      refid: rec.refid,
      userid: null,
      score: cosine(vector, rec.vector),
      text: rec.text,
      metadata: rec.metadata,
    });
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, topK);
}

/* --------------------------------- indexing --------------------------------- */

/**
 * (Re)index library content into the tenant namespace. Returns
 * { indexed, backend }. Mirrors indexContent() semantics but writes only
 * tenant-namespaced rows.
 */
export async function indexTenantContent(tenant, { limit = TENANT_INDEX_CAP } = {}) {
  if (!tenant || tenant.isfallback || tenant.slug === GLOBAL_TENANT_SLUG) {
    return { indexed: 0, backend: 'none', reason: 'global tenant uses the platform index' };
  }
  const slug = tenant.slug;
  const cap = Math.max(1, Math.min(TENANT_INDEX_CAP, Number(limit) || TENANT_INDEX_CAP));

  const docs = [];
  let page = 1;
  let total = Infinity;
  while (docs.length < Math.min(cap, total)) {
    const result = await listContent({ page, limit: 100 });
    total = result.total;
    docs.push(...result.data);
    if (page >= result.totalPages || result.data.length === 0) break;
    page += 1;
  }
  if (!docs.length) return { indexed: 0, backend: 'none' };
  const slice = docs.slice(0, cap);

  const vectors = await embedTexts(slice.map((row) => contentDocText(row)));
  const items = slice.map((row, i) => ({
    kind: 'content',
    refid: row.id,
    vector: vectors[i],
    text: contentDocText(row),
    metadata: {
      title: row.title,
      type: row.type || 'title',
      thumbnail: row.thumbnail ?? null,
      genres: Array.isArray(row.metadata?.genres) ? row.metadata.genres : [],
      year: row.metadata?.year ?? null,
      rating: row.metadata?.rating ?? row.metadata?.score ?? null,
      tenant: slug,
    },
  }));

  // pgvector first, memory fallback on any SQL failure.
  let backend = 'pgvector';
  try {
    for (const item of items) {
      await rows(
        `INSERT INTO vectorembeddings (refkey, kind, refid, userid, dims, embedding, metadata, contenttext, tenantid)
         VALUES ($1,$2,$3,$4,$5,$6::vector,$7,$8,$9)
         ON CONFLICT (refkey) DO UPDATE SET
           embedding = EXCLUDED.embedding,
           dims = EXCLUDED.dims,
           metadata = EXCLUDED.metadata,
           contenttext = EXCLUDED.contenttext,
           tenantid = EXCLUDED.tenantid,
           updatedat = CURRENT_TIMESTAMP`,
        [
          tenantRefKey(slug, item.kind, item.refid),
          item.kind,
          item.refid,
          null,
          EMBED_DIMS,
          `[${item.vector.join(',')}]`,
          JSON.stringify(item.metadata || {}),
          String(item.text || '').slice(0, 4000),
          slug,
        ],
      );
    }
  } catch (err) {
    backend = 'memory';
    logger.debug(`[tenant] pgvector upsert failed for '${slug}' (${err.message}) — memory fallback`);
    memoryUpsert(slug, items);
  }
  void recordTenantUsage(tenant, { metric: 'vector_index', quantity: items.length, unit: 'doc', meta: { backend } });
  logger.info(`[tenant] indexed ${items.length} content embeddings into namespace '${slug}' (${backend})`);
  return { indexed: items.length, backend, tenant: slug };
}

/* ---------------------------------- search ---------------------------------- */

/**
 * Tenant-scoped similarity search. 'global' delegates to the platform
 * vectorSearch (unchanged behavior).
 */
export async function tenantVectorSearch({ query, tenant, kind = 'content', topK = 8 }) {
  if (!tenant || tenant.isfallback || tenant.slug === GLOBAL_TENANT_SLUG) {
    const result = await vectorSearch({ query, kind, topK });
    return { ...result, tenant: GLOBAL_TENANT_SLUG, scoped: false };
  }
  const slug = tenant.slug;
  const safeKind = ['content', 'user', 'feed'].includes(kind) ? kind : 'content';
  const k = Math.max(1, Math.min(24, Number(topK) || 8));
  const started = Date.now();
  const [vector] = await embedTexts([String(query || '').slice(0, 600)]);

  let results = null;
  try {
    const found = await rows(
      `SELECT refkey, refid, 1 - (embedding <=> $1::vector) AS score, metadata, contenttext
       FROM vectorembeddings
       WHERE tenantid = $2 AND kind = $3
       ORDER BY embedding <=> $1::vector
       LIMIT $4`,
      [`[${vector.join(',')}]`, slug, safeKind, k],
    );
    results = found.map((r) => ({
      refkey: r.refkey,
      kind: safeKind,
      refid: Number(r.refid),
      score: Number(r.score),
      text: r.contenttext,
      metadata: typeof r.metadata === 'object' && r.metadata ? r.metadata : JSON.parse(r.metadata || '{}'),
    }));
  } catch {
    results = null; // SQL unavailable
  }
  if (results === null || results.length === 0) {
    const mem = memorySearch(slug, vector, safeKind, k);
    if (mem.length) results = mem;
    else if (results === null) results = [];
  }

  return {
    backend: results === null ? 'memory' : 'pgvector',
    embedProvider: 'local-hash-256',
    dims: EMBED_DIMS,
    took: Date.now() - started,
    tenant: slug,
    scoped: true,
    data: results.map((r) => ({
      id: r.refkey,
      kind: r.kind,
      refid: r.refid,
      score: Number((r.score || 0).toFixed(4)),
      title: r.metadata?.title ?? r.text?.slice(0, 60) ?? '',
      type: r.metadata?.type ?? safeKind,
      thumbnail: r.metadata?.thumbnail ?? null,
      genres: Array.isArray(r.metadata?.genres) ? r.metadata.genres : [],
      snippet: String(r.text || '').slice(0, 220),
      metadata: r.metadata,
    })),
  };
}

/** Tenant-scoped neighbors of a content row (cosine over the tenant index). */
export async function tenantMoreLikeThis(tenant, contentId, k = 5) {
  const row = await getContentById(contentId);
  if (!row) return [];
  const result = await tenantVectorSearch({ query: contentDocText(row), tenant, kind: 'content', topK: k + 1 });
  return result.data.filter((d) => d.refid !== Number(contentId)).slice(0, k);
}

/** Per-kind counts for the tenant namespace (pgvector, memory fallback). */
export async function tenantVectorStatus(tenant) {
  if (!tenant || tenant.isfallback || tenant.slug === GLOBAL_TENANT_SLUG) {
    return { tenant: GLOBAL_TENANT_SLUG, scoped: false, counts: {} };
  }
  const slug = tenant.slug;
  try {
    const found = await rows(
      `SELECT kind, COUNT(*) AS count FROM vectorembeddings WHERE tenantid = $1 GROUP BY kind`,
      [slug],
    );
    const counts = {};
    for (const r of found) counts[r.kind] = Number(r.count);
    const store = tenantStore.get(slug);
    if (store && Object.keys(counts).length === 0) {
      for (const rec of store.values()) counts[rec.kind] = (counts[rec.kind] || 0) + 1;
    }
    return { tenant: slug, scoped: true, counts };
  } catch {
    const store = tenantStore.get(slug);
    const counts = {};
    if (store) for (const rec of store.values()) counts[rec.kind] = (counts[rec.kind] || 0) + 1;
    return { tenant: slug, scoped: true, counts, backend: 'memory' };
  }
}

/** Delete a tenant's whole namespace (used by admin cleanup — NOT wired to
 *  tenant delete because tenants cannot be deleted via the API; kept for
 *  completeness + tests). */
export async function purgeTenantVectors(slug) {
  try {
    const res = await one(`DELETE FROM vectorembeddings WHERE tenantid = $1 RETURNING id`, [slug]);
    tenantStore.delete(slug);
    return { purged: true, lastid: res?.id ?? null };
  } catch {
    tenantStore.delete(slug);
    return { purged: true, backend: 'memory' };
  }
}
