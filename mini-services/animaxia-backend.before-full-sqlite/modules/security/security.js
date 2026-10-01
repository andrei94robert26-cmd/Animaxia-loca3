/**
 * modules/security/security.js — Security layer:
 *   • userRateLimit({ scope, max, windowMs, key }) — per-user / per-IP fixed-window
 *     rate limiting middleware factory with named buckets + stats.
 *   • bruteForce — login attempt tracking with progressive lockout
 *     (5 failures per ip+email within 15 min → 15 min lockout).
 *   • auditLog() — append-only audit trail in the `auditlogs` table.
 *   • GET /api/security/status, GET /api/security/audit — admin inspection
 *     endpoints (mount is gated by requireAuth + requireAdmin in server.js).
 */

import express from 'express';
import { rows, one, jsonb, isoOrNull, num } from '../platform/sql.js';
import { logger } from '../../utils/logger.js';

/* ------------------------------- rate limiting ------------------------------ */

const buckets = new Map(); // `${key}` → { windowMs, max, clients: Map<id, {count, resetAt}>, limited }
const BUCKET_SWEEP_MS = 60000;

function sweepBuckets() {
  const now = Date.now();
  for (const bucket of buckets.values()) {
    for (const [id, entry] of bucket.clients) {
      if (entry.resetAt <= now) bucket.clients.delete(id);
    }
  }
}
const sweepTimer = setInterval(sweepBuckets, BUCKET_SWEEP_MS);
if (typeof sweepTimer.unref === 'function') sweepTimer.unref();

export function clientIpOf(req) {
  // TS1 (security): Express sets 'trust proxy 1' (server.js), so req.ip is the
  // trustworthy client identity — behind the gateway (:81 caddy) it is the
  // XFF value APPENDED by the gateway (client-forged left entries are ignored
  // by proxy-addr); direct :4000 connections fall back to the socket address.
  // The manual header parsing below is kept ONLY as a legacy fallback for
  // callers that run without the Express proxy trust (req.ip undefined).
  if (req.ip !== undefined && req.ip !== null && req.ip !== '') {
    return req.ip;
  }
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const first = String(xff).split(',')[0].trim();
    if (first) return first;
  }
  if (req.headers['x-real-ip']) return String(req.headers['x-real-ip']);
  if (req.socket && req.socket.remoteAddress) return req.socket.remoteAddress;
  return 'unknown';
}

/**
 * Rate-limiting middleware factory.
 * @param {object} opts
 * @param {'user'|'ip'} opts.scope  - 'user' keys on the authenticated user id
 *   (falls back to IP for anonymous callers), 'ip' keys on the client IP.
 * @param {number} opts.max         - max requests per window (default 30).
 * @param {number} opts.windowMs    - window in ms (default 60000).
 * @param {string} opts.key         - bucket name for stats (default 'default').
 */
export function userRateLimit({ scope = 'user', max = 30, windowMs = 60000, key = 'default' } = {}) {
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { windowMs, max, clients: new Map(), limited: 0 };
    buckets.set(key, bucket);
  }
  return (req, res, next) => {
    const identity =
      scope === 'user' && req.user?.id != null ? `u:${req.user.id}` : `ip:${clientIpOf(req)}`;
    const now = Date.now();
    let entry = bucket.clients.get(identity);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + bucket.windowMs };
      bucket.clients.set(identity, entry);
    }
    entry.count += 1;
    const remaining = Math.max(0, bucket.max - entry.count);
    res.set('X-RateLimit-Limit', String(bucket.max));
    res.set('X-RateLimit-Remaining', String(remaining));
    res.set('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));
    if (entry.count > bucket.max) {
      bucket.limited += 1;
      const retryAfterSec = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      res.set('Retry-After', String(retryAfterSec));
      return res.status(429).json({
        error: `Rate limit exceeded (${bucket.max} per ${Math.round(bucket.windowMs / 1000)}s) — retry in ${retryAfterSec}s`,
        retryAfterSec,
        scope,
        bucket: key,
      });
    }
    return next();
  };
}

export function rateLimitBucketsStats() {
  const out = [];
  for (const [key, bucket] of buckets.entries()) {
    out.push({
      key,
      max: bucket.max,
      windowMs: bucket.windowMs,
      trackedClients: bucket.clients.size,
      totalLimited: bucket.limited,
    });
  }
  return out;
}

/* ------------------------------- brute force -------------------------------- */

const BF_WINDOW_MS = 15 * 60 * 1000; // count failures within 15 minutes
const BF_MAX_FAILS = 5; // 5 failures → lockout
const BF_LOCK_MS = 15 * 60 * 1000; // lockout duration 15 minutes

const attempts = new Map(); // `${ip}|${email}` → { fails, firstFailAt, lockedUntil }

function bfKey(ip, email) {
  return `${ip}|${String(email || '').toLowerCase()}`;
}

function sweepAttempts() {
  const now = Date.now();
  for (const [key, entry] of attempts) {
    const expiredWindow = entry.lockedUntil === 0 && now - entry.firstFailAt > BF_WINDOW_MS;
    const expiredLock = entry.lockedUntil !== 0 && entry.lockedUntil <= now;
    if (expiredWindow || expiredLock) attempts.delete(key);
  }
}
const bfSweepTimer = setInterval(sweepAttempts, 60000);
if (typeof bfSweepTimer.unref === 'function') bfSweepTimer.unref();

export const bruteForce = {
  /** Check whether a login attempt is currently allowed. */
  check(ip, email) {
    const entry = attempts.get(bfKey(ip, email));
    if (!entry) return { allowed: true, remaining: BF_MAX_FAILS, retryAfterSec: 0 };
    if (entry.lockedUntil > Date.now()) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSec: Math.max(1, Math.ceil((entry.lockedUntil - Date.now()) / 1000)),
      };
    }
    return { allowed: true, remaining: Math.max(0, BF_MAX_FAILS - entry.fails), retryAfterSec: 0 };
  },

  /** Record a login outcome; starts/resets lockouts. */
  record(ip, email, ok) {
    const key = bfKey(ip, email);
    const now = Date.now();
    if (ok) {
      attempts.delete(key);
      return;
    }
    let entry = attempts.get(key);
    if (!entry || now - entry.firstFailAt > BF_WINDOW_MS) {
      entry = { fails: 0, firstFailAt: now, lockedUntil: 0 };
      attempts.set(key, entry);
    }
    entry.fails += 1;
    if (entry.fails >= BF_MAX_FAILS) {
      entry.lockedUntil = now + BF_LOCK_MS;
      logger.warn(`[security] Brute-force lockout triggered for ${key} (${entry.fails} failures)`);
    }
  },

  stats() {
    let locked = 0;
    for (const entry of attempts.values()) {
      if (entry.lockedUntil > Date.now()) locked += 1;
    }
    return {
      maxFails: BF_MAX_FAILS,
      windowMs: BF_WINDOW_MS,
      lockMs: BF_LOCK_MS,
      tracked: attempts.size,
      lockedNow: locked,
    };
  },
};

/* -------------------------------- audit log --------------------------------- */

/**
 * Append an audit entry. NEVER throws into the request path — a failed audit
 * write is logged but the originating request still succeeds.
 */
export async function auditLog({ userid = null, action, ip = null, meta = {} } = {}) {
  if (!action) return;
  try {
    await rows(
      `INSERT INTO auditlogs (userid, action, ip, meta) VALUES ($1, $2, $3, $4::jsonb)`,
      [userid, String(action).slice(0, 120), ip ? String(ip).slice(0, 64) : null, jsonb(meta)],
    );
  } catch (err) {
    logger.warn(`[security] auditLog write failed for "${action}": ${err.message}`);
  }
}

/* --------------------------------- router ----------------------------------- */

export const securityRouter = express.Router();

securityRouter.get('/status', async (req, res) => {
  const total = await one(`SELECT COUNT(*)::int AS count FROM auditlogs`);
  res.json({
    bruteForce: bruteForce.stats(),
    buckets: rateLimitBucketsStats(),
    auditTotal: num(total?.count),
  });
});

securityRouter.get('/audit', async (req, res) => {
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const action = req.query.action ? String(req.query.action) : null;
  const where = action ? `WHERE a.action = $3` : '';
  const params = action ? [limit, offset, action] : [limit, offset];
  const data = await rows(
    `SELECT a.id, a.action, a.ip, a.meta, a.createdat, u.username, u.email
     FROM auditlogs a LEFT JOIN users u ON u.id = a.userid
     ${where}
     ORDER BY a.createdat DESC, a.id DESC
     LIMIT $1 OFFSET $2`,
    params,
  );
  const totalRow = await one(
    action
      ? `SELECT COUNT(*)::int AS count FROM auditlogs WHERE action = $1`
      : `SELECT COUNT(*)::int AS count FROM auditlogs`,
    action ? [action] : [],
  );
  res.json({
    data: data.map((r) => ({
      id: num(r.id),
      action: r.action,
      ip: r.ip,
      meta: typeof r.meta === 'string' ? JSON.parse(r.meta) : r.meta ?? {},
      createdat: isoOrNull(r.createdat),
      user: r.username ? { username: r.username, email: r.email } : null,
    })),
    total: num(totalRow?.count),
    limit,
    offset,
  });
});

export default securityRouter;
