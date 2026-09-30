/**
 * modules/aicloud/vector-service.js — Vector DB + embeddings (Phase 4, req 2).
 *
 * Embeds three families of Animaxia data and answers similarity searches:
 *   • content embeddings — titles, descriptions, genres, tags of every
 *     library row (auto-indexed at boot and on the `content:changed` event)
 *   • user embeddings    — preferences + watch-history + likes per user
 *   • feed embeddings    — recent platform activity (comments, new content)
 *   • memory embeddings  — animaxiaAssistant long-term memory (kind 'memory')
 *
 * Pluggable backend selected by VECTOR_BACKEND (default 'auto'):
 *   • 'pgvector'  — Neon Postgres + pgvector (`vectorembeddings` table,
 *                   cosine via the `<=>` operator, ivfflat index)
 *   • 'mock'      — in-memory store with JS cosine (offline fallback, always
 *                   available — the "mock vector" of the config contract)
 *   • 'qdrant'    — external Qdrant adapter (QDRANTURL[, QDRANTAPIKEY]),
 *                   one collection per kind (animaxia-content, animaxia-user…)
 *   • 'pinecone'  — external Pinecone adapter (PINECONEURL + PINECONEAPIKEY)
 *   • 'auto'      — pgvector when the extension + table initialized, else mock
 * Any backend failure (offline adapter, SQL hiccup) auto-degrades to mock.
 *
 * Embedding provider: 'local-hash-256' by default (deterministic FNV-1a
 * bag-of-words + bigrams over 256 dims — no key needed); when
 * AI_PROVIDER=openai + AI_API_KEY are set, OpenAI text-embedding-3-small with
 * dimensions=256 is used instead. All vectors are L2-normalized.
 *
 * Programmatic API (used by rag-engine / tools / agent / personal):
 *   initVectorBackend(), vectorStatus(), embedTexts(texts),
 *   indexContent({ids}), indexUser(user), indexFeed(limit),
 *   vectorSearch({ query, kind, topK, userId }),
 *   storeMemory(userId, text, metadata), searchMemories(userId, query, k)
 */

import crypto from 'node:crypto';
import { listContent, getContentById } from '../../db.js';
import { rows, one, jsonb, parseJsonb } from '../platform/sql.js';
import { events } from '../platform/events.js';
import { logger } from '../../utils/logger.js';
import { computeShardIdFromVectorRef } from '../sharding/model.js'; // FAZA 13 (sharding): vectorembeddings.shardid
import { vectorCluster } from '../../services/vector-cluster/index.js'; // FAZA 13 (Task 13-3): vector cluster — pgvector fan-out over per-shard vectorembeddings nodes

const EMBED_DIMS = 256;
const MEMORY_CAP_PER_USER = 50; // mock backend retention cap
const CONTENT_INDEX_CAP = 600; // max content rows to index per pass

/* ------------------------------ text utilities ----------------------------- */

/** Lowercase, split on non-alphanumerics, drop tokens shorter than 2 chars. */
function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

/** FNV-1a 32-bit hash of a token. */
function hashToken(token) {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i += 1) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Deterministic local embedding: unigrams + bigrams hashed into EMBED_DIMS. */
function embedLocal(text) {
  const vec = new Array(EMBED_DIMS).fill(0);
  const tokens = tokenize(text);
  const grams = [...tokens];
  for (let i = 0; i + 1 < tokens.length; i += 1) grams.push(`${tokens[i]}_${tokens[i + 1]}`);
  for (const gram of grams) vec[hashToken(gram) % EMBED_DIMS] += 1;
  const norm = Math.sqrt(vec.reduce((acc, v) => acc + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

/** Cosine similarity between two equal-length vectors. */
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

function refKey(item) {
  return `${item.kind}:${item.refid ?? 0}:${item.userid ?? 0}`;
}

/* ---------------------------- embedding provider --------------------------- */

let embedProvider = 'local-hash-256';

/** Batch-embed texts with the active embedding provider. */
export async function embedTexts(texts) {
  const list = Array.isArray(texts) ? texts : [texts];
  const useOpenai =
    (process.env.AI_PROVIDER || 'z-ai').toLowerCase() === 'openai' && Boolean(process.env.AI_API_KEY);
  if (useOpenai) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      if (typeof timer.unref === 'function') timer.unref();
      const res = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.AI_API_KEY}` },
        body: JSON.stringify({ model: 'text-embedding-3-small', input: list, dimensions: EMBED_DIMS }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`openai embeddings ${res.status}`);
      const json = await res.json();
      const vectors = json.data
        .sort((a, b) => a.index - b.index)
        .map((d) => d.embedding.map(Number));
      if (vectors.length === list.length) {
        embedProvider = 'openai-256';
        return vectors;
      }
      throw new Error('embedding count mismatch');
    } catch (err) {
      logger.warn(`[aicloud] openai embeddings failed (${err.message}) — using local-hash`);
    }
  }
  embedProvider = 'local-hash-256';
  return list.map((t) => embedLocal(t));
}

/* ------------------------------ mock backend ------------------------------- */

class MemoryBackend {
  constructor() {
    this.name = 'mock';
    /** @type {Map<string, object>} refkey → record */
    this.store = new Map();
  }

  async upsert(items) {
    for (const item of items) {
      const key = refKey(item);
      this.store.set(key, {
        kind: item.kind,
        refid: item.refid ?? 0,
        userid: item.userid ?? null,
        vector: item.vector,
        text: item.text || '',
        metadata: item.metadata || {},
        updatedat: new Date().toISOString(),
      });
    }
    // Memory retention cap (per user, newest wins).
    if (items.some((i) => i.kind === 'memory')) {
      const byUser = new Map();
      for (const rec of [...this.store.values()].filter((r) => r.kind === 'memory')) {
        const uid = rec.userid ?? 0;
        if (!byUser.has(uid)) byUser.set(uid, []);
        byUser.get(uid).push(rec);
      }
      for (const [uid, recs] of byUser) {
        if (recs.length > MEMORY_CAP_PER_USER) {
          recs.sort((a, b) => String(a.updatedat).localeCompare(String(b.updatedat)));
          for (const old of recs.slice(0, recs.length - MEMORY_CAP_PER_USER)) {
            this.store.delete(refKey({ kind: 'memory', refid: old.refid, userid: uid }));
          }
        }
      }
    }
    return items.length;
  }

  async search({ vector, kind, topK, userId }) {
    const results = [];
    for (const rec of this.store.values()) {
      if (kind && rec.kind !== kind) continue;
      if (userId != null && rec.userid !== userId) continue;
      if (kind === 'memory' && userId == null) continue; // memories are private
      results.push({
        refkey: refKey(rec),
        kind: rec.kind,
        refid: rec.refid,
        userid: rec.userid,
        score: cosine(vector, rec.vector),
        text: rec.text,
        metadata: rec.metadata,
      });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  async counts() {
    const acc = {};
    for (const rec of this.store.values()) acc[rec.kind] = (acc[rec.kind] || 0) + 1;
    return acc;
  }

  async removeKind(kind) {
    let removed = 0;
    for (const [key, rec] of this.store) {
      if (rec.kind === kind) {
        this.store.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}

/* ----------------------------- pgvector backend ---------------------------- */

class PgVectorBackend {
  constructor() {
    this.name = 'pgvector';
  }

  async upsert(items) {
    if (!items.length) return 0;
    for (const item of items) {
      // FAZA 13 (sharding): stamp the vector shard id per refkey
      // (fnv1a('vectorref:' + refkey) % SHARDCOUNT) on every upsert.
      const shardid = computeShardIdFromVectorRef(refKey(item));
      await rows(
        `INSERT INTO vectorembeddings (refkey, kind, refid, userid, dims, embedding, metadata, contenttext, shardid)
         VALUES ($1,$2,$3,$4,$5,$6::vector,$7::jsonb,$8,$9)
         ON CONFLICT (refkey) DO UPDATE SET
           embedding = EXCLUDED.embedding,
           dims = EXCLUDED.dims,
           metadata = EXCLUDED.metadata,
           contenttext = EXCLUDED.contenttext,
           shardid = EXCLUDED.shardid,
           updatedat = NOW()`,
        [
          refKey(item),
          item.kind,
          item.refid ?? 0,
          item.userid ?? null,
          EMBED_DIMS,
          `[${item.vector.join(',')}]`,
          jsonb(item.metadata || {}),
          String(item.text || '').slice(0, 4000),
          shardid,
        ],
      );
    }
    return items.length;
  }

  async search({ vector, kind, topK, userId, shardHint = null }) {
    const vectorLiteral = `[${vector.join(',')}]`;
    const params = [vectorLiteral];
    let where = 'kind = $2';
    params.push(kind);
    if (kind === 'memory' && userId != null) {
      where += ' AND userid = $3';
      params.push(userId);
    } else if (userId != null && kind === 'user') {
      where += ' AND userid = $3';
      params.push(userId);
    }
    // FAZA 13 (sharding): optional shard affinity — when shardHint is an
    // integer ≥ 0, append AND shardid = $N to the WHERE.
    const hint = Number.isInteger(shardHint) && shardHint >= 0 ? shardHint : null;
    const paramsNoHint = [...params]; // pre-shard params for the legacy fallback
    const whereNoHint = where;
    if (hint != null) {
      params.push(hint);
      where += ` AND shardid = $${params.length}`;
    }
    params.push(Math.max(1, Math.min(50, topK)));
    let found = await rows(
      `SELECT refkey, kind, refid, userid, 1 - (embedding <=> $1::vector) AS score,
              metadata, contenttext
       FROM vectorembeddings
       WHERE ${where}
       ORDER BY embedding <=> $1::vector
       LIMIT $${params.length}`,
      params,
    );
    // FAZA 13 (sharding): legacy fallback — a shard hint that returns 0 rows
    // triggers one retry without the filter (a mis-routed hint never blanks
    // the results).
    if (hint != null && found.length === 0) {
      logger.debug(`[aicloud] vector search on shard ${hint} returned 0 rows — retrying without the shard filter`);
      const retryParams = [...paramsNoHint, Math.max(1, Math.min(50, topK))];
      found = await rows(
        `SELECT refkey, kind, refid, userid, 1 - (embedding <=> $1::vector) AS score,
                metadata, contenttext
         FROM vectorembeddings
         WHERE ${whereNoHint}
         ORDER BY embedding <=> $1::vector
         LIMIT $${retryParams.length}`,
        retryParams,
      );
    }
    return found.map((r) => ({
      refkey: r.refkey,
      kind: r.kind,
      refid: Number(r.refid),
      userid: r.userid == null ? null : Number(r.userid),
      score: Number(r.score),
      text: r.contenttext,
      metadata: parseJsonb(r.metadata, {}),
    }));
  }

  async counts() {
    const found = await rows(`SELECT kind, COUNT(*)::int AS count FROM vectorembeddings GROUP BY kind`);
    return found.reduce((acc, r) => {
      acc[r.kind] = r.count;
      return acc;
    }, {});
  }

  async removeKind(kind) {
    await rows(`DELETE FROM vectorembeddings WHERE kind = $1`, [kind]);
    return true;
  }
}

/* ------------------------- external REST adapters --------------------------- */

/** Minimal shared REST helper with timeout. */
async function restJson(url, { method = 'POST', headers = {}, body = null, timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`${res.status}`);
    return res.status === 204 ? null : res.json();
  } finally {
    clearTimeout(timer);
  }
}

function pointId(refkey) {
  return crypto.createHash('sha1').update(refkey).digest('hex').slice(0, 16);
}

/** Qdrant adapter — one collection per kind, points carry the full payload. */
class QdrantBackend {
  constructor(baseUrl) {
    this.name = 'qdrant';
    this.baseUrl = String(baseUrl || 'http://localhost:6333').replace(/\/$/, '');
    this.headers = process.env.QDRANTAPIKEY ? { 'api-key': process.env.QDRANTAPIKEY } : {};
  }

  collection(kind) {
    return `animaxia-${kind}`;
  }

  async upsert(items) {
    for (const item of items) {
      const collection = this.collection(item.kind);
      try {
        await restJson(`${this.baseUrl}/collections/${collection}`, {
          method: 'PATCH',
          headers: this.headers,
          body: { vectors: { size: EMBED_DIMS, distance: 'Cosine' } },
        });
      } catch {
        /* collection exists — ignore create errors */
      }
      await restJson(`${this.baseUrl}/collections/${collection}/points?wait=true`, {
        headers: this.headers,
        body: {
          points: [
            {
              id: pointId(refKey(item)),
              vector: item.vector,
              payload: {
                refkey: refKey(item),
                kind: item.kind,
                refid: item.refid ?? 0,
                userid: item.userid ?? null,
                text: String(item.text || '').slice(0, 4000),
                metadata: item.metadata || {},
              },
            },
          ],
        },
      });
    }
    return items.length;
  }

  async search({ vector, kind, topK, userId }) {
    const filter =
      kind === 'memory' && userId != null
        ? { must: [{ key: 'kind', match: { value: kind } }, { key: 'userid', match: { integer: userId } }] }
        : { must: [{ key: 'kind', match: { value: kind } }] };
    const json = await restJson(`${this.baseUrl}/collections/${this.collection(kind)}/points/search`, {
      headers: this.headers,
      body: { vector, limit: topK, with_payload: true, filter },
    });
    return (json?.result || []).map((p) => ({
      refkey: p.payload?.refkey ?? p.id,
      kind: p.payload?.kind ?? kind,
      refid: p.payload?.refid ?? 0,
      userid: p.payload?.userid ?? null,
      score: p.score,
      text: p.payload?.text ?? '',
      metadata: p.payload?.metadata ?? {},
    }));
  }

  async counts() {
    const kinds = ['content', 'user', 'feed', 'memory'];
    const acc = {};
    for (const kind of kinds) {
      try {
        const json = await restJson(`${this.baseUrl}/collections/${this.collection(kind)}`, {
          method: 'GET',
          headers: this.headers,
        });
        acc[kind] = json?.result?.points_count ?? 0;
      } catch {
        acc[kind] = 0;
      }
    }
    return acc;
  }

  async removeKind(kind) {
    await restJson(`${this.baseUrl}/collections/${this.collection(kind)}`, {
      method: 'DELETE',
      headers: this.headers,
    });
    return true;
  }
}

/** Pinecone adapter — single namespace-per-kind over one index. */
class PineconeBackend {
  constructor(baseUrl) {
    this.name = 'pinecone';
    this.baseUrl = String(baseUrl || '').replace(/\/$/, '');
    this.headers = { 'Api-Key': process.env.PINECONEAPIKEY || '' };
  }

  async upsert(items) {
    const vectors = items.map((item) => ({
      id: pointId(refKey(item)),
      values: item.vector,
      metadata: {
        refkey: refKey(item),
        kind: item.kind,
        refid: Number(item.refid ?? 0),
        userid: item.userid == null ? -1 : Number(item.userid),
        text: String(item.text || '').slice(0, 1000),
        ...Object.fromEntries(
          Object.entries(item.metadata || {}).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : v]),
        ),
      },
    }));
    await restJson(`${this.baseUrl}/vectors/upsert`, {
      headers: this.headers,
      body: { vectors, namespace: 'animaxia' },
    });
    return items.length;
  }

  async search({ vector, kind, topK, userId }) {
    const filter = { kind: { $eq: kind } };
    if (kind === 'memory' && userId != null) filter.userid = { $eq: userId };
    const json = await restJson(`${this.baseUrl}/query`, {
      headers: this.headers,
      body: { vector, topK, includeMetadata: true, namespace: 'animaxia', filter },
    });
    return (json?.matches || []).map((m) => ({
      refkey: m.metadata?.refkey ?? m.id,
      kind: m.metadata?.kind ?? kind,
      refid: Number(m.metadata?.refid ?? 0),
      userid: m.metadata?.userid == null || m.metadata?.userid === -1 ? null : Number(m.metadata?.userid),
      score: m.score,
      text: m.metadata?.text ?? '',
      metadata: { ...m.metadata, text: undefined, refkey: undefined, kind: undefined, refid: undefined, userid: undefined },
    }));
  }

  async counts() {
    // Pinecone has no cheap count — describe_index_stats on the namespace.
    try {
      const json = await restJson(`${this.baseUrl}/describe_index_stats`, {
        headers: this.headers,
        body: { filter: {} },
      });
      const total = json?.namespaces?.animaxia?.vectorCount ?? 0;
      return { total };
    } catch {
      return { total: 0 };
    }
  }

  async removeKind(kind) {
    await restJson(`${this.baseUrl}/vectors/delete`, {
      headers: this.headers,
      body: { deleteAll: false, filter: { kind: { $eq: kind } }, namespace: 'animaxia' },
    });
    return true;
  }
}

/* ----------------------------- backend resolution --------------------------- */

const memoryBackend = new MemoryBackend();
let activeBackend = memoryBackend;
let configuredBackend = 'auto';
let lastIndexedAt = null;
let reindexTimer = null;

/**
 * Try to initialize pgvector (extension + table + index). Returns true when
 * the pgvector backend is usable. Never throws.
 */
export async function ensureVectorSchema() {
  try {
    await rows('CREATE EXTENSION IF NOT EXISTS vector');
    const ext = await one(`SELECT extname FROM pg_extension WHERE extname = 'vector'`);
    if (!ext) return false;
    await rows(`
      CREATE TABLE IF NOT EXISTS vectorembeddings (
        id SERIAL PRIMARY KEY,
        refkey TEXT UNIQUE NOT NULL,
        kind TEXT NOT NULL,
        refid INTEGER NOT NULL DEFAULT 0,
        userid INTEGER,
        dims INTEGER NOT NULL DEFAULT ${EMBED_DIMS},
        embedding vector(${EMBED_DIMS}) NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        contenttext TEXT,
        createdat TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updatedat TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    await rows(`CREATE INDEX IF NOT EXISTS idx_vectorembeddings_kind ON vectorembeddings (kind)`);
    // Exact (seq-scan) cosine search is faster AND correct for small/medium
    // corpora: an ivfflat index with lists > row count returns empty results
    // (pgvector probes only 1 list by default), so we drop any stale one.
    await rows(`DROP INDEX IF EXISTS idx_vectorembeddings_cos`);
    return true;
  } catch (err) {
    logger.debug(`[aicloud] pgvector unavailable: ${err.message}`);
    return false;
  }
}

/** Resolve the active backend from VECTOR_BACKEND + availability. Idempotent. */
export async function initVectorBackend() {
  configuredBackend = (process.env.VECTOR_BACKEND || 'auto').toLowerCase();
  const fallbackToMock = (reason) => {
    activeBackend = memoryBackend;
    logger.warn(`[aicloud] vector backend → mock (${reason})`);
  };

  if (configuredBackend === 'mock') {
    activeBackend = memoryBackend;
  } else if (configuredBackend === 'qdrant') {
    const backend = new QdrantBackend(process.env.QDRANTURL);
    try {
      await restJson(`${backend.baseUrl}/collections`, { method: 'GET', headers: backend.headers, timeoutMs: 4000 });
      activeBackend = backend;
    } catch (err) {
      fallbackToMock(`qdrant unreachable: ${err.message}`);
    }
  } else if (configuredBackend === 'pinecone') {
    if (process.env.PINECONEURL && process.env.PINECONEAPIKEY) {
      activeBackend = new PineconeBackend(process.env.PINECONEURL);
    } else {
      fallbackToMock('pinecone requires PINECONEURL + PINECONEAPIKEY');
    }
  } else {
    // 'auto' | 'pgvector' — pgvector when the extension is available.
    const ok = await ensureVectorSchema();
    if (ok) activeBackend = new PgVectorBackend();
    else if (configuredBackend === 'pgvector') fallbackToMock('pgvector extension not available');
    else activeBackend = memoryBackend;
  }

  logger.info(
    `[aicloud] vector backend: ${activeBackend.name} (configured: ${configuredBackend}, embeds: ${embedProvider})`,
  );
  return activeBackend.name;
}

/** Run an operation on the active backend, auto-degrading to mock on failure. */
async function withBackend(fn) {
  try {
    return await fn(activeBackend);
  } catch (err) {
    logger.warn(`[aicloud] vector backend ${activeBackend.name} failed (${err.message}) — degrading to mock`);
    activeBackend = memoryBackend;
    return fn(activeBackend);
  }
}

/* ------------------------------ doc construction --------------------------- */

function metaOf(row) {
  const meta = row?.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  return {
    contentid: Number(row?.id ?? 0),
    title: row?.title ?? '',
    type: row?.type ?? '',
    thumbnail: row?.thumbnail ?? null,
    genres: Array.isArray(meta.genres) ? meta.genres.map(String) : [],
    rating: typeof meta.rating === 'number' ? meta.rating : typeof meta.score === 'number' ? meta.score : null,
    year: meta.year ?? null,
    source: typeof meta.source === 'string' ? meta.source : null,
  };
}

/** Embedding text for a content row: title + type + genres + description. */
export function contentDocText(row) {
  const meta = row?.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  const genres = Array.isArray(meta.genres) ? meta.genres.join(', ') : '';
  const description = [meta.overview, meta.synopsis, meta.description].filter(Boolean).join(' ');
  const tags = Array.isArray(meta.tags) ? meta.tags.join(', ') : '';
  return [
    `${row?.title || ''} [${row?.type || 'title'}]`,
    genres ? `genres: ${genres}` : '',
    tags ? `tags: ${tags}` : '',
    description,
  ]
    .filter(Boolean)
    .join('. ')
    .slice(0, 1800);
}

/* --------------------------------- indexing -------------------------------- */

/** Index (all or selected) content rows. @returns {{ indexed, backend }} */
export async function indexContent({ ids = null } = {}) {
  let docs = [];
  if (Array.isArray(ids) && ids.length > 0) {
    const rowsOut = [];
    for (const id of ids.slice(0, 100)) {
      const row = await getContentById(id);
      if (row) rowsOut.push(row);
    }
    docs = rowsOut.map((row) => ({ row, text: contentDocText(row), meta: metaOf(row) }));
  } else {
    let page = 1;
    let total = Infinity;
    while (docs.length < Math.min(CONTENT_INDEX_CAP, total)) {
      const result = await listContent({ page, limit: 100 });
      total = result.total;
      for (const row of result.data) {
        docs.push({ row, text: contentDocText(row), meta: metaOf(row) });
      }
      if (page >= result.totalPages || result.data.length === 0) break;
      page += 1;
    }
  }
  if (docs.length === 0) return { indexed: 0, backend: activeBackend.name };

  const vectors = await embedTexts(docs.map((d) => d.text));
  const items = docs.map((doc, i) => ({
    kind: 'content',
    refid: doc.row.id,
    userid: null,
    vector: vectors[i],
    text: doc.text,
    metadata: doc.meta,
  }));
  await withBackend((backend) => backend.upsert(items));
  lastIndexedAt = new Date().toISOString();
  logger.info(`[aicloud] indexed ${items.length} content embeddings (${activeBackend.name})`);
  return { indexed: items.length, backend: activeBackend.name };
}

/**
 * Index one user's taste embedding: preferences + watch history + likes.
 * @returns {{ indexed: number, backend: string, text: string }}
 */
export async function indexUser(user) {
  if (!user || user.id == null) throw Object.assign(new Error('Authentication required'), { status: 401 });
  const prefs = user.preferences && typeof user.preferences === 'object' ? user.preferences : {};
  const parts = [
    `user ${user.username} on the ${user.plan || 'free'} plan`,
    Array.isArray(prefs.types) && prefs.types.length ? `favorite types: ${prefs.types.join(', ')}` : '',
    Array.isArray(prefs.genres) && prefs.genres.length ? `favorite genres: ${prefs.genres.join(', ')}` : '',
    Array.isArray(prefs.franchises) && prefs.franchises.length ? `loves franchises: ${prefs.franchises.join(', ')}` : '',
  ];

  try {
    const history = await rows(
      `SELECT c.title, c.metadata FROM watchhistory wh JOIN content c ON c.id = wh.contentid
       WHERE wh.userid = $1 ORDER BY wh.watchedat DESC LIMIT 15`,
      [user.id],
    );
    const titles = [];
    const genres = new Set();
    for (const r of history) {
      titles.push(r.title);
      const meta = parseJsonb(r.metadata, {});
      if (Array.isArray(meta.genres)) meta.genres.forEach((g) => genres.add(String(g)));
    }
    if (titles.length) parts.push(`recently watched: ${titles.join(', ')}`);
    if (genres.size) parts.push(`watch-history genres: ${[...genres].join(', ')}`);

    const likes = await rows(
      `SELECT c.title FROM contentlikes cl JOIN content c ON c.id = cl.contentid
       WHERE cl.userid = $1 AND cl.value = 1 ORDER BY cl.createdat DESC LIMIT 10`,
      [user.id],
    );
    if (likes.length) parts.push(`liked: ${likes.map((r) => r.title).join(', ')}`);
  } catch (err) {
    logger.debug(`[aicloud] indexUser history enrichment skipped: ${err.message}`);
  }

  const text = parts.filter(Boolean).join('. ').slice(0, 1500);
  const [vector] = await embedTexts([text]);
  await withBackend((backend) =>
    backend.upsert([{ kind: 'user', refid: user.id, userid: user.id, vector, text, metadata: { username: user.username, plan: user.plan || 'free' } }]),
  );
  return { indexed: 1, backend: activeBackend.name, text };
}

/**
 * Index recent feed activity (comments + new content) for feed RAG.
 * @returns {{ indexed: number, backend: string }}
 */
export async function indexFeed(limit = 40) {
  const activities = [];
  try {
    const comments = await rows(
      `SELECT cm.id, cm.body, cm.createdat, c.title AS contenttitle
       FROM comments cm LEFT JOIN content c ON c.id = cm.contentid
       ORDER BY cm.createdat DESC LIMIT $1`,
      [limit],
    );
    for (const r of comments) {
      activities.push({
        kind: 'feed',
        refid: Number(r.id),
        text: `comment on ${r.contenttitle || 'content'}: ${r.body}`.slice(0, 500),
        metadata: { feedtype: 'comment', contenttitle: r.contenttitle },
      });
    }
    const content = await listContent({ page: 1, limit });
    for (const row of content.data) {
      activities.push({
        kind: 'feed',
        refid: Number(row.id) + 1000000, // avoid ref collisions with comment ids
        text: `new ${row.type || 'title'} on Animaxia: ${row.title}`.slice(0, 500),
        metadata: { feedtype: 'content', contentid: row.id, title: row.title, thumbnail: row.thumbnail, type: row.type },
      });
    }
  } catch (err) {
    logger.debug(`[aicloud] indexFeed enrichment skipped: ${err.message}`);
  }
  if (!activities.length) return { indexed: 0, backend: activeBackend.name };

  const vectors = await embedTexts(activities.map((a) => a.text));
  const items = activities.map((a, i) => ({
    kind: 'feed',
    refid: a.refid,
    userid: null,
    vector: vectors[i],
    text: a.text,
    metadata: a.metadata,
  }));
  await withBackend((backend) => backend.upsert(items));
  return { indexed: items.length, backend: activeBackend.name };
}

/* ------------------------------ memory (agent) ----------------------------- */

/** Store one long-term agent memory for a user. */
export async function storeMemory(userId, text, metadata = {}) {
  const [vector] = await embedTexts([String(text).slice(0, 1000)]);
  // refid must fit a Postgres INTEGER (2^31-1) — ms timestamp modulo keeps it
  // unique enough per (kind, userid) while staying in range.
  await withBackend((backend) =>
    backend.upsert([
      {
        kind: 'memory',
        refid: Date.now() % 2000000000,
        userid: Number(userId),
        vector,
        text: String(text).slice(0, 1000),
        metadata,
      },
    ]),
  );
  return true;
}

/** Recall the user's most similar long-term memories. */
export async function searchMemories(userId, query, k = 3) {
  const [vector] = await embedTexts([query]);
  const results = await withBackend((backend) =>
    backend.search({ vector, kind: 'memory', topK: Math.max(1, Math.min(10, k)), userId: Number(userId) }),
  );
  return results.map((r) => ({ score: r.score, text: r.text, metadata: r.metadata }));
}

/* --------------------------------- search ---------------------------------- */

/**
 * Vector similarity search (backs POST /api/vector/search and the RAG retrieve
 * step). Memories are never returned here — use searchMemories().
 *
 * @param {object} opts { query, kind ('content'|'user'|'feed'), topK, userId }
 * @returns {{ backend, embedProvider, dims, took, data }}
 */
export async function vectorSearch({ query, kind = 'content', topK = 8, userId = null, shardHint = null }) {
  const started = Date.now();
  const safeKind = ['content', 'user', 'feed'].includes(kind) ? kind : 'content';
  /* NEON FREE PLAN: indexare LAZY — primul search real declanșează indexarea
   * în fundal dacă nu a fost făcută încă (fostul auto-index la boot, 1.5s
   * după start, ținea Neon treaz la fiecare restart fără niciun utilizator). */
  ensureContentIndexedLazily();
  const [vector] = await embedTexts([String(query || '').slice(0, 600)]);
  // FAZA 13 (Task 13-3): when the vector cluster is enabled AND the active
  // backend is pgvector, the query fans out over the per-shard vector nodes
  // (query-side affinity: shardHint/tenant node first, remaining nodes
  // complete the result set). On ANY cluster error we log a warning and fall
  // back to the existing backend.search — a cluster failure NEVER fails a
  // user query. When disabled or the backend is mock (or another adapter),
  // the legacy path below runs byte-identical.
  let clusterMeta = null;
  const results = await withBackend(async (backend) => {
    const clampedTopK = Math.max(1, Math.min(24, topK));
    if (vectorCluster.enabled() && backend.name === 'pgvector') {
      try {
        const clusterResult = await vectorCluster.query({
          vector,
          kind: safeKind,
          topK: clampedTopK,
          userId,
          tenant: null,
          shardHint,
        });
        clusterMeta = clusterResult.cluster; // additive response field
        return clusterResult.hits; // same row shape as backend.search
      } catch (err) {
        logger.warn(`[aicloud] vector cluster failed (${err.message}) — falling back to backend.search`);
        clusterMeta = null;
      }
    }
    // FAZA 13 (sharding): shardHint is threaded through to the backend search
    // (pgvector appends AND shardid = $N with a 0-row legacy fallback; the mock
    // backend ignores it — backends destructure only what they know).
    return backend.search({ vector, kind: safeKind, topK: clampedTopK, userId, shardHint });
  });
  return {
    backend: activeBackend.name,
    embedProvider,
    dims: EMBED_DIMS,
    took: Date.now() - started,
    data: results.map((r) => ({
      id: r.refkey,
      kind: r.kind,
      refid: r.refid,
      score: Number(r.score.toFixed(4)),
      title: r.metadata?.title ?? r.metadata?.username ?? r.text?.slice(0, 60) ?? '',
      type: r.metadata?.type ?? safeKind,
      thumbnail: r.metadata?.thumbnail ?? null,
      genres: Array.isArray(r.metadata?.genres) ? r.metadata.genres : [],
      snippet: String(r.text || '').slice(0, 220),
      metadata: r.metadata,
    })),
    // FAZA 13 (Task 13-3): additive cluster report — present only when the
    // cluster path actually served the query (legacy responses unchanged).
    ...(clusterMeta ? { cluster: clusterMeta } : {}),
  };
}

/** Status for GET /api/vector/status. */
export async function vectorStatus() {
  let counts = {};
  try {
    counts = await withBackend((backend) => backend.counts());
  } catch {
    counts = {};
  }
  return {
    backend: activeBackend.name,
    configured: configuredBackend,
    active: true,
    embedProvider,
    dims: EMBED_DIMS,
    counts,
    lastIndexedAt,
  };
}

/* ------------------------- auto-index lifecycle ---------------------------- */

let bootIndexed = false;
let lazyIndexStarted = false;

/** NEON FREE PLAN: indexarea de content rulează LA PRIMA UTILIZARE REALĂ
 * (primul vectorSearch / indexContent explicit), nu la boot — zero activitate
 * DB fără trafic. Rulează o singură dată pe proces, în fundal. */
function ensureContentIndexedLazily() {
  if (bootIndexed || lazyIndexStarted) return;
  lazyIndexStarted = true;
  setTimeout(() => {
    indexContent()
      .then(() => indexFeed(30).catch(() => ({ indexed: 0 })))
      .then(() => {
        bootIndexed = true;
      })
      .catch((err) => {
        lazyIndexStarted = false; // permis retry la următoarea utilizare reală
        logger.warn(`[aicloud] lazy auto-index failed: ${err.message}`);
      });
  }, 0).unref?.();
}

/**
 * Boot hook (called by the aicloud router): resolve the backend (în memorie,
 * zero query) și re-index (debounced 30 s) la `content:changed` — eveniment
 * real de mutație. Auto-indexul de la boot a fost convertit în lazy
 * (ensureContentIndexedLazily) pentru NEON FREE PLAN scale-to-zero.
 */
export async function aicloudVectorBoot() {
  await initVectorBackend();
  events.on('content:changed', () => {
    clearTimeout(reindexTimer);
    reindexTimer = setTimeout(() => {
      indexContent().catch((err) => logger.warn(`[aicloud] re-index failed: ${err.message}`));
    }, 30000);
    if (typeof reindexTimer.unref === 'function') reindexTimer.unref();
  });
}
