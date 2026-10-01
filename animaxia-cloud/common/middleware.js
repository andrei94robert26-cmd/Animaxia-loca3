/**
 * common/middleware.js — Shared Express middleware: request ids, bearer-token
 * user attachment (verify-only, DB-backed), 404 + JSON error handlers and the
 * async `wrap` helper used across every Animaxia Cloud microservice.
 */

import crypto from 'node:crypto';
import { verifyJwt, bearerToken } from './jwt.js';
import { one } from './sql.js';
import { parseJsonb, isoOrNull, num } from './sql.js';
import { logger } from './logger.js';

/** Attach a short unique request id (x-request-id aware). */
export function requestId() {
  return (req, res, next) => {
    req.requestId = String(req.headers['x-request-id'] || crypto.randomUUID());
    res.set('x-request-id', req.requestId);
    next();
  };
}

/** Async handler wrapper — forwards rejections to the error middleware. */
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * attachUserFromToken — verifies the Bearer access token (issued by
 * auth-service) and loads the fresh user row from the shared database so
 * `req.user` always reflects the current plan/role. Anonymous requests pass
 * through with req.user = null. Never rejects.
 */
export function attachUserFromToken(req, res, next) {
  const token = bearerToken(req);
  if (!token) {
    req.user = null;
    return next();
  }
  const payload = verifyJwt(token);
  if (!payload || !payload.sub) {
    req.user = null;
    return next();
  }
  one('SELECT * FROM users WHERE id = $1', [Number(payload.sub)])
    .then((row) => {
      if (!row) {
        req.user = null;
        return;
      }
      req.user = {
        id: num(row.id),
        email: row.email,
        username: row.username,
        avatar: row.avatar || null,
        role: row.role || 'user',
        plan: row.plan || 'free',
        planexpiresat: isoOrNull(row.planexpiresat),
        preferences: parseJsonb(row.preferences, {}),
        createdat: isoOrNull(row.createdat),
        lastloginat: isoOrNull(row.lastloginat),
      };
      req.jwt = payload;
    })
    .catch((err) => {
      logger.debug(`[auth] user attach failed: ${err.message}`);
      req.user = null;
    })
    .finally(() => next());
}

/** Guard: require an authenticated user. */
export function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  return next();
}

/** Guard: require an admin user. */
export function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  return next();
}

/** JSON 404 for unmatched routes. */
export function notFoundHandler(req, res) {
  res.status(404).json({ error: 'Route not found' });
}

/** Central error handler — respects err.status, logs with request context. */
export function errorHandler(err, req, res, next) { // next: Express error-handler arity (required)
  const status = err.status || 500;
  const context = {
    ...(req.requestId ? { requestId: req.requestId } : {}),
    ...(req.traceId ? { traceId: req.traceId } : {}),
  };
  if (status >= 500) {
    logger.error(`[error] ${req.method} ${req.originalUrl} → ${status}: ${err.message}`, context);
  } else {
    logger.warn(`[error] ${req.method} ${req.originalUrl} → ${status}: ${err.message}`, context);
  }
  if (res.headersSent) return next(err);
  res.status(status).json({ error: err.message || 'Internal server error', ...context });
}
