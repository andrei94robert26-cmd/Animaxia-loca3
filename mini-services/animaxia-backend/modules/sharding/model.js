/**
 * modules/sharding/model.js — FAZA 13/14 → AR10M: the LEGACY sharding model
 * for the pre-AR10M tables (content / searchdocs / vectorembeddings), kept
 * for compatibility. AR10M note: the REAL catalog architecture lives in
 * modules/ar10m/ — 15 shards, routing by hash(normalized_title + year)
 * (computeShardId in ar10m/normalize.js) — while this module keeps the legacy
 * RANGE rule below for the existing tables.
 *
 * MODEL (single source of truth for the LEGACY tables):
 *   • SHARDCOUNT = parseInt(env.SHARDCOUNT || '15', 10), minimum 1; NaN or
 *     negative (or 0) safely falls back to 15 (AR10M 15-shard architecture;
 *     fost 30 — fost 30B simulat, eliminat). All real content ids are < 1B
 *     → shard 0, so the count change never moves a real row.
 *   • Shard map is GENERATED: { 0: 'neon-main', 1: 'neon-shard-1',
 *     2: 'neon-shard-2', … } for 0..SHARDCOUNT-1.
 *   • CATALOG/CONTENT — shard by RANGE of content id (legacy rule, kept for
 *     compat): computeShardIdFromContentId(id) =
 *     Math.floor(Number(id) / 1_000_000_000) % SHARDCOUNT. All current SERIAL
 *     ids are < 1B → shard 0 → legacy-compatible with every existing row.
 *     AR10M: fostul „logical address space” simulat (30 × 1B = 30B —
 *     SHARD_SPAN_IDS + logicalAddressSpace) a fost ELIMINAT — volumul real
 *     este numărul real de rânduri, nu un spațiu de adresare simulat.
 *   • VECTOR — shard per TENANT: computeShardIdFromTenant(tenantId) =
 *     fnv1a('tenant:' + tenantId) % SHARDCOUNT.
 *   • VECTOR REF — computeShardIdFromVectorRef(refkey) =
 *     fnv1a('vectorref:' + refkey) % SHARDCOUNT.
 *   • SEARCH CLUSTER — searchdocs.shardid = the range shard of the document's
 *     contentid (the catalog shard of the row it indexes).
 *   • HASH: FNV-1a 32-bit (house style, identical to hashToken in
 *     vector-service.js): h = 0x811c9dc5; per char: h ^= charCode;
 *     h = Math.imul(h, 0x01000193) >>> 0; result h % N.
 *
 * LOGICAL vs PHYSICAL mode: every shard N ≥ 1 may have a dedicated Neon branch
 * URL in env SHARD{N}URL (SHARD1URL, SHARD2URL, …). When the env var is absent
 * or empty, that shard's pool resolves to the MAIN pool ("logical sharding" on
 * a single physical database — shardid columns, routing, metrics and health are
 * all real; physical isolation is activated purely by configuration, no code
 * change). The mode is reported by shardingModelSnapshot() ('logical' unless
 * at least one SHARD{N}URL is set → 'physical').
 *
 * GATEWAY contract: requests may carry header `X-Animaxia-Shard: <shardId>`
 * (lowercase x-animaxia-shard on the wire) which overrides resolution — see
 * resolveShardFromRequest().
 *
 * This module is PURE computation: it imports NOTHING (no db.js, no env side
 * effects beyond reads) so it can be statically imported anywhere, including
 * db.js, without circular-import risk.
 */

/** FNV-1a 32-bit hash of a string (unsigned). Pinned algorithm — do not change. */
export function fnv1a(str) {
  const s = String(str ?? '');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Active shard count from env SHARDCOUNT (AR10M default: 15 — the real
 * 15-shard architecture; fost 30/30B simulat — eliminat). NaN/negative/< 1 → 15.
 * Safe for real data: every real content id is < 1B → shard 0 regardless.
 */
export function shardCount() {
  const n = parseInt(process.env.SHARDCOUNT || '15', 10);
  if (!Number.isInteger(n) || n < 1) return 15;
  return n;
}

/**
 * Generated shard map: { shardId: branchName } for 0..SHARDCOUNT-1 —
 * { 0: 'neon-main', 1: 'neon-shard-1', 2: 'neon-shard-2', … }.
 */
export function shardMap() {
  const map = {};
  const n = shardCount();
  for (let i = 0; i < n; i += 1) map[i] = shardBranchName(i);
  return map;
}

/** Branch name for a shard id: 0 → 'neon-main', N ≥ 1 → 'neon-shard-N'. */
export function shardBranchName(shardId) {
  const n = Number(shardId);
  if (!Number.isInteger(n) || n < 1) return 'neon-main';
  return `neon-shard-${n}`;
}

/**
 * Catalog/content shard by RANGE rule (LEGACY, kept for compat — the real
 * AR10M catalog routes by hash(normalized_title+year) in modules/ar10m):
 * Math.floor(Number(id) / 1_000_000_000) % SHARDCOUNT.
 * Non-finite ids and negative ids clamp to shard 0 (legacy-compatible — all
 * pre-FAZA-13 SERIAL ids are < 1B and therefore live on shard 0).
 */
export function computeShardIdFromContentId(id) {
  const n = Number(id);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n / 1_000_000_000) % shardCount();
}

/** Vector shard per TENANT: fnv1a('tenant:' + tenantId) % SHARDCOUNT. */
export function computeShardIdFromTenant(tenantId) {
  return fnv1a('tenant:' + String(tenantId ?? '')) % shardCount();
}

/** Vector shard per REFKEY: fnv1a('vectorref:' + refkey) % SHARDCOUNT. */
export function computeShardIdFromVectorRef(refkey) {
  return fnv1a('vectorref:' + String(refkey ?? '')) % shardCount();
}

/**
 * Resolve the shard for an incoming request. Priority:
 *   1. explicit header value (integer 0..SHARDCOUNT-1) — gateway verdict wins;
 *   2. contentId — the RANGE rule (any finite id resolves, < 1B → 0);
 *   3. tenant — the tenant hash ('global', empty or missing → skip);
 *   4. shard 0 (main/legacy).
 *
 * @param {{ tenant?: string|null, contentId?: number|string|null, header?: number|string|null }} input
 * @returns {number} shard id in 0..SHARDCOUNT-1 (15 shards under AR10M)
 */
export function resolveShardFromRequest({ tenant, contentId, header } = {}) {
  const n = shardCount();

  // 1. Explicit gateway header (X-Animaxia-Shard) — must be an int in range.
  const hint = parseInt(header, 10);
  if (Number.isInteger(hint) && hint >= 0 && hint < n) return hint;

  // 2. Content id — RANGE rule (all current SERIAL ids → shard 0).
  if (contentId !== undefined && contentId !== null && contentId !== '') {
    const id = Number(contentId);
    if (Number.isFinite(id)) return computeShardIdFromContentId(id);
  }

  // 3. Tenant hash — 'global'/empty skips (the platform tenant is everywhere).
  const t = String(tenant ?? '').trim();
  if (t && t !== 'global') return computeShardIdFromTenant(t);

  // 4. Legacy default.
  return 0;
}

/**
 * Human/metrics snapshot of the sharding model:
 * { shardcount, shards: [{ shardid, branch, urlConfigured }], mode } —
 * mode 'physical' when at least one SHARD{N}URL (N ≥ 1) is configured,
 * 'logical' when every shard resolves to the main pool.
 */
export function shardingModelSnapshot() {
  const n = shardCount();
  const shards = [];
  let physical = false;
  for (let i = 0; i < n; i += 1) {
    const urlConfigured =
      i === 0
        ? Boolean(String(process.env.DATABASEURL || '').trim()) // shard 0 is backed by the main DATABASEURL
        : Boolean(String(process.env[`SHARD${i}URL`] || '').trim());
    if (i >= 1 && urlConfigured) physical = true;
    shards.push({ shardid: i, branch: shardBranchName(i), urlConfigured });
  }
  return { shardcount: n, shards, mode: physical ? 'physical' : 'logical' };
}
