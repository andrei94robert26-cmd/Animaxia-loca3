/**
 * modules/platform/shared-state.js — TS3: distributed rate-limiter state layer
 * (Redis-ready interface, honest sandbox implementation).
 *
 * Interface: createSharedLimiter({ name, capacity, refillPerSec }) →
 *   { take(key) → { allowed, remaining, retryAfterMs }, stats() }
 * — a token-bucket limiter whose STATE can live outside the process:
 *
 *   • driver 'memory' (default): in-process buckets — honest about being
 *     single-node. Zero external dependencies; used out of the box.
 *   • driver 'neon' (SHAREDSTATE=neon): buckets stored in the `sharedlimits`
 *     table on the shared Neon Postgres — take() is an atomic UPSERT
 *     (UPDATE … SET tokens = LEAST(cap, tokens + elapsed·refill) − 1 …
 *     RETURNING tokens; INSERT … ON CONFLICT DO NOTHING when the row is new,
 *     with a single re-UPDATE on the lost-insert race). Works correctly across
 *     multiple backend nodes pointing at the same database.
 *   • driver 'redis' (REDISURL): NOT implemented — would need ioredis, which is
 *     deliberately not a dependency of this repo. Documented intent only: the
 *     interface is intentionally Redis-shaped so a Redis driver can slot in at
 *     multi-node deploy without touching callers.
 *
 * IMPORTANT (zero-risk wiring): this layer is NOT wired into rateLimit.js or
 * any live request path. Documented migration intent: at multi-node deploy,
 * rateLimit.js can swap its in-memory bucket store for createSharedLimiter()
 * with the same {capacity, refillPerSec} semantics — a one-line store change,
 * not a behavior change.
 *
 * The only exposure is the read-only demo endpoint (mounted in server.js):
 *   GET /api/platform/shared-state/status → active driver + a live 'demo'
 *   bucket take on every call (proves the layer works end-to-end).
 */

import express from 'express';
import { one, rows } from './sql.js';
import { driverInfo } from '../../db.js'; // read-only import (db.js itself is protected/unmodified)
import { logger } from '../../utils/logger.js';

const REFILL_FLOOR = -1.0; // max token debt after a denied take (no runaway deficit)

/* ------------------------------ memory driver ------------------------------- */

function createMemoryLimiter({ name, capacity, refillPerSec }) {
  const buckets = new Map(); // key → { tokens, updatedAt }
  return {
    name,
    driver: 'memory',
    capacity,
    refillPerSec,
    async take(key) {
      const now = Date.now();
      let b = buckets.get(key);
      if (!b) {
        b = { tokens: capacity, updatedAt: now };
        buckets.set(key, b);
      }
      const elapsedSec = Math.max(0, (now - b.updatedAt) / 1000);
      b.tokens = Math.min(capacity, b.tokens + elapsedSec * refillPerSec);
      b.updatedAt = now;
      if (b.tokens >= 1) {
        b.tokens -= 1;
        return { allowed: true, remaining: Math.floor(b.tokens), retryAfterMs: 0 };
      }
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.ceil(((1 - b.tokens) / refillPerSec) * 1000),
      };
    },
    stats() {
      return { driver: 'memory', buckets: buckets.size };
    },
  };
}

/* -------------------------------- neon driver -------------------------------- */

let neonSchemaReady = false;

async function ensureSharedLimitsTable() {
  if (neonSchemaReady) return;
  await rows(
    `CREATE TABLE IF NOT EXISTS sharedlimits (
      bucketkey TEXT PRIMARY KEY,
      tokens REAL NOT NULL,
      updatedat TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
  );
  neonSchemaReady = true;
}

function neonUpdateSql() {
  // Atomic refill + consume in one statement; row lock serializes concurrent
  // nodes. tokens >= 0 after the statement → the take was allowed.
  return `UPDATE sharedlimits
          SET tokens = GREATEST($4::real, LEAST($2::real, tokens + EXTRACT(EPOCH FROM (now() - updatedat)) * $3::real) - 1),
              updatedat = now()
          WHERE bucketkey = $1
          RETURNING tokens`;
}

function createNeonLimiter({ name, capacity, refillPerSec }) {
  return {
    name,
    driver: 'neon',
    capacity,
    refillPerSec,
    async take(key) {
      await ensureSharedLimitsTable();
      const bucketKey = `${name}:${key}`;
      let row = await one(neonUpdateSql(), [bucketKey, capacity, refillPerSec, REFILL_FLOOR]);
      if (!row) {
        // Bucket does not exist yet — seed it (capacity − 1 = first take allowed).
        row = await one(
          `INSERT INTO sharedlimits (bucketkey, tokens, updatedat)
           VALUES ($1, $2::real - 1, now())
           ON CONFLICT (bucketkey) DO NOTHING
           RETURNING tokens`,
          [bucketKey, capacity],
        );
        if (!row) {
          // Lost the insert race against another node → re-run the atomic update once.
          row = await one(neonUpdateSql(), [bucketKey, capacity, refillPerSec, REFILL_FLOOR]);
        }
      }
      const tokens = Number(row?.tokens ?? 0);
      const allowed = tokens >= 0;
      return {
        allowed,
        remaining: Math.max(0, Math.floor(tokens)),
        retryAfterMs: allowed ? 0 : Math.ceil(((1 - Math.max(tokens, 0)) / refillPerSec) * 1000),
      };
    },
    async stats() {
      try {
        const r = await one(`SELECT COUNT(*)::int AS count FROM sharedlimits`);
        return { driver: 'neon', buckets: Number(r?.count ?? 0) };
      } catch {
        return { driver: 'neon', buckets: null };
      }
    },
  };
}

/* --------------------------------- factory ----------------------------------- */

/**
 * Shared-state token-bucket limiter. Driver selection:
 *   SHAREDSTATE=neon (and the PostgreSQL driver connected) → neon driver;
 *   otherwise → memory driver (single-node, honest default).
 */
export function createSharedLimiter({ name = 'limiter', capacity = 30, refillPerSec = 0.5 } = {}) {
  const wantNeon = (process.env.SHAREDSTATE || '').trim().toLowerCase() === 'neon';
  if (wantNeon && driverInfo().connected) {
    logger.info(`[shared-state] limiter '${name}' using the NEON driver (sharedlimits table)`);
    return createNeonLimiter({ name, capacity, refillPerSec });
  }
  if (wantNeon) {
    logger.warn(`[shared-state] SHAREDSTATE=neon requested but PostgreSQL is not connected — falling back to the memory driver`);
  }
  return createMemoryLimiter({ name, capacity, refillPerSec });
}

/* ------------------------------ demo/status API ------------------------------ */

/* Demo limiter — NOT used by any live request path; each /status call takes one
 * token from the 'demo' bucket to prove the layer works (remaining decrements
 * and refills over time). capacity 10, refill 1/s. Created LAZILY on the first
 * status call so the driver is selected AFTER boot/initDb (SHAREDSTATE=neon
 * needs the PostgreSQL driver to be connected, which is never true at module
 * import time). */
let demoLimiter = null;
function getDemoLimiter() {
  if (!demoLimiter) {
    demoLimiter = createSharedLimiter({ name: 'shared-state-demo', capacity: 10, refillPerSec: 1 });
  }
  return demoLimiter;
}

export const sharedStateRouter = express.Router();

/** GET /status — public, read-only: active driver + one live demo take. */
sharedStateRouter.get('/status', async (req, res) => {
  try {
    const demoLimiter = getDemoLimiter();
    const demo = await demoLimiter.take('demo');
    const st = await demoLimiter.stats();
    res.json({
      ok: true,
      driver: demoLimiter.driver,
      limiter: { name: demoLimiter.name, capacity: demoLimiter.capacity, refillPerSec: demoLimiter.refillPerSec },
      stats: st,
      demo: { bucket: 'demo', ...demo },
      note:
        'Shared-state limiter demo — driver: memory (single-node, default) or neon (SHAREDSTATE=neon, sharedlimits table, multi-node safe). ' +
        'Redis interface documented but intentionally not implemented (no ioredis dependency). ' +
        'Not wired into rateLimit.js yet — documented migration path for multi-node deploy.',
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
    logger.error(`[shared-state] status failed: ${err?.message || err}`);
  }
});

export default sharedStateRouter;
