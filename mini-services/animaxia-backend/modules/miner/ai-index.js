/**
 * modules/miner/ai-index.js — FAZA 12 miner → AI Cloud indexing pipeline.
 *
 * Additive module: vector-service.js itself is untouched. This pipeline
 * reuses its exported primitives (embedTexts, contentDocText, EMBED_DIMS
 * conventions) and the FAZA 11 vectorembeddings.tenantid column to write
 * per-tenant embeddings with exactly the same key semantics:
 *
 *   global tenant  → platform refkeys  `content:{id}:0`  (tenantid 'global')
 *   named tenant   → namespaced keys   `t:{slug}:content:{id}:0` (FAZA 11
 *                     isolation — a tenant search never leaks other rows)
 *
 * API (used by the miner core + routes):
 *   indexContentForTenant(tenantid, contentIds[]) — granular upsert
 *   rebuildTenantIndex(tenantid, { limit })        — bulk (re)index pass
 *   minerIndexStatus(tenantid)                    — per-tenant doc counts
 */

import { listContent, getContentById } from '../../db.js';
import { rows, one, num } from '../platform/sql.js';
import { logger } from '../../utils/logger.js';
import { embedTexts, contentDocText } from '../aicloud/vector-service.js';
import { GLOBAL_TENANT_SLUG } from '../tenant/core.js';

const REINDEX_CAP = 300; // rows per rebuild pass (matches tenant-vector cap)

/** Refkey for a content row in the given tenant's namespace. */
function indexRefKey(tenantid, contentId) {
  const slug = String(tenantid || GLOBAL_TENANT_SLUG);
  return slug === GLOBAL_TENANT_SLUG
    ? `content:${contentId}:0`
    : `t:${slug}:content:${contentId}:0`;
}

/** Upsert one batch of embeddings for a tenant (SQL layer; no-op locally).
 * Matches vector-service.js pgvector upsert semantics exactly: embedding is
 * a vector(EMBED_DIMS) column, passed as '[1,2,…]'::vector. */
async function upsertEmbeddings(tenantid, items) {
  if (!items.length) return 0;
  let written = 0;
  for (const item of items) {
    try {
      await rows(
        `INSERT INTO vectorembeddings (refkey, kind, refid, userid, dims, embedding, metadata, contenttext, tenantid)
         VALUES ($1, $2, $3, 0, $4, $5::vector, $6, $7, $8)
         ON CONFLICT (refkey) DO UPDATE SET
           dims = EXCLUDED.dims,
           embedding = EXCLUDED.embedding,
           metadata = EXCLUDED.metadata,
           contenttext = EXCLUDED.contenttext,
           updatedat = CURRENT_TIMESTAMP`,
        [
          item.refkey,
          'content',
          item.refid,
          item.dims,
          `[${item.vector.join(',')}]`,
          JSON.stringify(item.metadata ?? {}),
          String(item.text || '').slice(0, 4000),
          String(tenantid || GLOBAL_TENANT_SLUG),
        ],
      );
      written += 1;
    } catch (err) {
      logger.debug(`[miner] embedding upsert failed for ${item.refkey}: ${err.message}`);
    }
  }
  return written;
}

/**
 * Index specific content rows into a tenant's vector namespace.
 * Returns { indexed, requested, backend }.
 */
export async function indexContentForTenant(tenantid, contentIds = []) {
  const ids = [...new Set((contentIds || []).map((v) => Number(v)).filter((v) => Number.isInteger(v) && v > 0))];
  if (!ids.length) return { indexed: 0, requested: 0, backend: 'none' };

  const slug = String(tenantid || GLOBAL_TENANT_SLUG);
  const docs = [];
  for (const id of ids.slice(0, REINDEX_CAP)) {
    const row = await getContentById(id);
    if (!row) continue;
    docs.push({ id: row.id, text: contentDocText(row), metadata: { title: row.title, type: row.type } });
  }
  if (!docs.length) return { indexed: 0, requested: ids.length, backend: 'none' };

  try {
    const vectors = await embedTexts(docs.map((d) => d.text));
    const items = docs.map((d, i) => ({
      refkey: indexRefKey(slug, d.id),
      kind: 'content',
      refid: d.id,
      dims: vectors[i].length,
      vector: vectors[i],
      metadata: d.metadata,
      text: d.text,
    }));
    const written = await upsertEmbeddings(slug, items);
    return { indexed: written, requested: ids.length, backend: 'sql' };
  } catch (err) {
    logger.warn(`[miner] indexContentForTenant('${slug}') degraded: ${err.message}`);
    return { indexed: 0, requested: ids.length, backend: 'error', error: err.message };
  }
}

/**
 * Bulk (re)index a tenant's library share into its vector namespace.
 * For the global tenant this repopulates the platform index keys; for a
 * named tenant it (re)builds the FAZA 11 namespaced index.
 * Returns { indexed, scanned, backend }.
 */
export async function rebuildTenantIndex(tenantid, { limit = REINDEX_CAP } = {}) {
  const slug = String(tenantid || GLOBAL_TENANT_SLUG);
  const cap = Math.max(1, Math.min(REINDEX_CAP, Number(limit) || REINDEX_CAP));

  const list = await listContent({ page: 1, limit: cap, sort: 'createdat' });
  const rowsAll = list?.data || [];
  if (!rowsAll.length) return { indexed: 0, scanned: 0, backend: 'none' };

  try {
    const vectors = await embedTexts(rowsAll.map((r) => contentDocText(r)));
    const items = rowsAll.map((r, i) => ({
      refkey: indexRefKey(slug, r.id),
      kind: 'content',
      refid: r.id,
      dims: vectors[i].length,
      vector: vectors[i],
      metadata: { title: r.title, type: r.type },
      text: contentDocText(r),
    }));
    const written = await upsertEmbeddings(slug, items);
    return { indexed: written, scanned: rowsAll.length, backend: 'sql' };
  } catch (err) {
    logger.warn(`[miner] rebuildTenantIndex('${slug}') degraded: ${err.message}`);
    return { indexed: 0, scanned: rowsAll.length, backend: 'error', error: err.message };
  }
}

/** Per-tenant vector doc counts for the miner status endpoint. */
export async function minerIndexStatus(tenantid) {
  const slug = String(tenantid || GLOBAL_TENANT_SLUG);
  try {
    const r = await one(
      `SELECT COUNT(*) AS docs FROM vectorembeddings WHERE tenantid = $1 AND kind = 'content'`,
      [slug],
    );
    return { tenant: slug, docs: num(r?.docs) };
  } catch {
    return { tenant: slug, docs: 0 };
  }
}

export default { indexContentForTenant, rebuildTenantIndex, minerIndexStatus };
