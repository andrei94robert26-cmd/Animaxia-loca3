/**
 * AR10M shard router
 * SQLite-only local implementation.
 *
 * Logical shards are preserved for compatibility, but every shard is stored
 * in the same local SQLite database.
 *
 * No PostgreSQL.
 * No Neon.
 * No remote pools.
 * No DATABASE_URL.
 */

import { query, queryOnShard } from '../../db.js';
import { AR10M_SHARD_COUNT } from './normalize.js';

export const SLOT_COUNT = 15;
export const IDLE_CLOSE_MS = 0;

let lastWriteAt = null;
let lastSpaceBytes = null;
let lastRowCount = null;

let distCache = {
  at: 0,
  data: null,
};

const WRITE_RE =
  /^\s*(insert|update|delete|create|drop|alter|truncate|replace)\b/i;

function trackWrite(text) {
  if (typeof text === 'string' && WRITE_RE.test(text)) {
    lastWriteAt = Date.now();
    invalidateDistributionCache();
  }
}

export function invalidateDistributionCache() {
  distCache = {
    at: 0,
    data: null,
  };
}

export function getLastWriteAt() {
  return lastWriteAt;
}

/**
 * Logical shard compatibility.
 * All logical shards physically resolve to the same local SQLite database.
 */
export function resolvePhysicalSlot(logicalShardId) {
  const sid = Number(logicalShardId);

  if (
    !Number.isInteger(sid) ||
    sid < 0 ||
    sid >= AR10M_SHARD_COUNT
  ) {
    throw new Error(
      `invalid logical shard id: ${logicalShardId} ` +
      `(valid: 0..${AR10M_SHARD_COUNT - 1})`
    );
  }

  return 1;
}

/**
 * Execute through the existing local SQLite shard compatibility layer.
 */
export async function shardQuery(
  logicalShardId,
  text,
  params = [],
  opts = {}
) {
  resolvePhysicalSlot(logicalShardId);

  const startedAt = Date.now();

  try {
    const result = await queryOnShard(
      logicalShardId,
      text,
      params
    );

    trackWrite(text);

    return result;
  } catch (err) {
    err.shardId = logicalShardId;
    err.sqliteLocal = true;
    throw err;
  } finally {
    void opts;
    void startedAt;
  }
}

/**
 * Primary database query.
 * Primary is simply the single local SQLite database.
 */
export async function primaryQuery(
  text,
  params = [],
  opts = {}
) {
  try {
    const result = await query(text, params);

    trackWrite(text);

    return result;
  } finally {
    void opts;
  }
}

/**
 * Compatibility status.
 *
 * Slot 1 represents the physical local SQLite database.
 * Slots 2..15 remain logical compatibility slots.
 */
function slotReport(slot) {
  const primary = slot === 1;

  return {
    slot,
    name: `SQLITE_LOCAL_${String(slot).padStart(2, '0')}`,
    configured: primary,
    mode: primary ? 'sqlite-local' : 'logical-local',
    isPrimary: primary,
    dedicated: false,
    hostMasked: null,
    poolActive: primary,
    openConnections: primary ? 1 : 0,
    inFlight: 0,
    state: 'closed',
    failures: 0,
    lastLatencyMs: null,
    lastError: null,
    lastUsedAt: null,
    lastRowCount: primary ? lastRowCount : null,
    lastSpaceBytes: primary ? lastSpaceBytes : null,
    totalQueries: 0,
    routesTo: primary ? null : 1,
  };
}

export function shardStatus() {
  const slots = Array.from(
    { length: SLOT_COUNT },
    (_, i) => slotReport(i + 1)
  );

  return {
    primary: slots[0],
    slots,
    shardCount: AR10M_SHARD_COUNT,
    backend: 'sqlite',
    storage: 'local',
    physicalDatabases: 1,
  };
}

/**
 * Manual local metrics refresh.
 */
export async function refreshShardMetrics() {
  const startedAt = Date.now();

  try {
    let rows = null;

    try {
      const result = await primaryQuery(
        'SELECT COUNT(*) AS n FROM ar10m.content'
      );

      rows = Number(result.rows?.[0]?.n ?? 0);
      lastRowCount = rows;
    } catch {
      rows = null;
    }

    try {
      const pageCount = await primaryQuery(
        'PRAGMA page_count'
      );

      const pageSize = await primaryQuery(
        'PRAGMA page_size'
      );

      const count =
        Number(
          pageCount.rows?.[0]?.page_count ??
          Object.values(pageCount.rows?.[0] ?? {})[0] ??
          0
        );

      const size =
        Number(
          pageSize.rows?.[0]?.page_size ??
          Object.values(pageSize.rows?.[0] ?? {})[0] ??
          0
        );

      if (count > 0 && size > 0) {
        lastSpaceBytes = count * size;
      }
    } catch {
      // Metric remains unknown.
    }

    return {
      ok: true,
      backend: 'sqlite',
      storage: 'local',
      results: [
        {
          slot: 1,
          skipped: false,
          rows,
          spaceBytes: lastSpaceBytes,
          latencyMs: Date.now() - startedAt,
        },
      ],
      refreshedAt: new Date().toISOString(),
    };
  } catch (err) {
    return {
      ok: false,
      backend: 'sqlite',
      storage: 'local',
      results: [
        {
          slot: 1,
          skipped: false,
          error: String(err?.message ?? err),
        },
      ],
      refreshedAt: new Date().toISOString(),
    };
  }
}

/**
 * Logical shard distribution.
 */
export async function distributionSnapshot() {
  if (
    distCache.data &&
    Date.now() - distCache.at < 60_000
  ) {
    return distCache.data;
  }

  let result;

  try {
    result = await primaryQuery(
      'SELECT shard_id, COUNT(*) AS rows FROM ar10m.content GROUP BY shard_id'
    );
  } catch {
    const empty = Array.from(
      { length: AR10M_SHARD_COUNT },
      (_, shardId) => ({
        shardId,
        rows: 0,
        pct: 0,
      })
    );

    distCache = {
      at: Date.now(),
      data: empty,
    };

    return empty;
  }

  const byShard = new Map(
    (result.rows ?? []).map((row) => [
      Number(row.shard_id),
      Number(row.rows ?? 0),
    ])
  );

  const total = [...byShard.values()].reduce(
    (sum, value) => sum + value,
    0
  );

  const data = Array.from(
    { length: AR10M_SHARD_COUNT },
    (_, shardId) => {
      const rows = byShard.get(shardId) ?? 0;

      return {
        shardId,
        rows,
        pct:
          total > 0
            ? Math.round((rows * 10000) / total) / 100
            : 0,
      };
    }
  );

  distCache = {
    at: Date.now(),
    data,
  };

  return data;
}

/**
 * One physical SQLite database is active.
 */
export function activeShardCount() {
  return 1;
}

/**
 * Compatibility gauges.
 */
export function poolGauges() {
  return {
    poolsActive: 1,
    totalConnections: 1,
    inFlight: 0,
    backend: 'sqlite',
  };
}

export function primaryStorageBytes() {
  return lastSpaceBytes;
}

export function recordPrimaryMetrics({
  rowCount = null,
  spaceBytes = null,
} = {}) {
  if (rowCount !== null) {
    lastRowCount = Number(rowCount);
  }

  if (spaceBytes !== null) {
    lastSpaceBytes = Number(spaceBytes);
  }
}

/**
 * PostgreSQL pool compatibility API.
 * SQLite has no remote connection pools to close.
 */
export function closeIdlePools() {
  return 0;
}
