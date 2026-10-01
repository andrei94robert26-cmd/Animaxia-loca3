/**
 * services/gateway-service/auth.js — Global edge auth: verify-only JWT
 * verification + route ACL, applied to every /api/* request BEFORE proxying.
 *
 * Design (edge-appropriate, mirrors BLUEPRINT §3):
 *   • Verify the Bearer access token LOCALLY (HS256 via common/jwt.js — the
 *     same secret derivation as auth-service). Valid → `req.edgeUser` = the
 *     JWT payload ({ sub, email, plan, typ, iat, exp } — the JWT has NO role
 *     claim); missing/invalid → `req.edgeUser = null`. Anonymous requests are
 *     NEVER rejected just for lacking a token — public routes exist.
 *   • The original Authorization header is ALWAYS forwarded upstream
 *     (proxy.js) — services run their own attachUser and make final calls.
 *   • Route ACL enforced AT THE EDGE (cheap rejection before the hop):
 *       – /api/users/*                              → token required (all methods)
 *       – /api/social/*                             → token required on POST/PUT/DELETE
 *       – /api/premium/checkout                     → token required on POST
 *       – /api/admin/*, /api/security/*,
 *         /api/cache/admin/*, /api/queue/admin/*    → token + ADMIN required
 *   • Admin gating: the JWT carries no role, so the edge asks auth-service
 *     `POST /internal/verify-admin { sub }` (contract with agent 3-b):
 *         200 { ok: true, admin: true|false, user: {...} }  → gate on body.admin
 *         404 (unknown user)                                → admin: false
 *         5xx / network error                               → FAIL CLOSED (503)
 *     Results (true AND false) are cached per sub for 60s (isAdminCached).
 *     A promotion to admin therefore lags at most 60s at the edge.
 */

import { createCache } from '@animaxia/common/cache.js';
import { verifyJwt, bearerToken } from '@animaxia/common/jwt.js';
import { serviceFetch } from '@animaxia/common/telemetry.js';
import { serviceUrl } from '@animaxia/common/services.js';
import { wrap } from '@animaxia/common/middleware.js';
import { logger } from '@animaxia/common/logger.js';

const ADMIN_CHECK_TTL_MS = 60000;
const ADMIN_CHECK_TIMEOUT_MS = 5000;

/** Edge cache of auth-service admin verifications, keyed by user sub. */
const adminCache = createCache({ ttlMs: ADMIN_CHECK_TTL_MS, maxEntries: 2000, name: 'gateway-admin-check' });

/** Token-required routes (`methods: null` = every method). */
const AUTH_RULES = [
  { prefix: '/api/users', methods: null },
  { prefix: '/api/social', methods: ['POST', 'PUT', 'DELETE'] },
  { prefix: '/api/premium/checkout', methods: ['POST'] },
];

/** Admin-required routes (every method). */
const ADMIN_RULES = [
  { prefix: '/api/admin' },
  { prefix: '/api/security' },
  { prefix: '/api/cache/admin' },
  { prefix: '/api/queue/admin' },
];

const counters = {
  requests: 0,
  anonymous: 0,
  tokensVerified: 0,
  tokensInvalid: 0,
  authRejections: 0,
  adminChecks: 0,
  adminAllowed: 0,
  adminDenied: 0,
  adminUnavailable: 0,
};

function pathMatches(path, prefix) {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * Cache-verified admin check against auth-service (agent 3-b contract):
 *   POST ${AUTHSERVICEURL}/internal/verify-admin  body { sub }
 *     → 200 { ok: true, admin: true|false, user: {...} } | 404 (unknown user)
 * Returns `true | false | null`. `null` means "verification unavailable"
 * (auth-service unreachable / 5xx) and MUST be treated as fail-closed (503) —
 * it is never cached, so recovery is immediate once auth-service is back.
 */
export async function isAdminCached(sub) {
  const key = String(sub);
  const cached = adminCache.get(key);
  if (cached !== undefined) return cached;

  let admin = null;
  try {
    const res = await serviceFetch(
      `${serviceUrl('auth')}/internal/verify-admin`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ sub: key }),
      },
      { timeoutMs: ADMIN_CHECK_TIMEOUT_MS, spanName: 'gateway admin-check' },
    );
    if (res.status === 200) {
      const body = await res.json().catch(() => null);
      admin = Boolean(body && body.admin === true);
    } else if (res.status === 404) {
      admin = false; // unknown user → definitely not an admin
    } else {
      admin = null; // unexpected status (5xx…) → fail closed, do not cache
    }
  } catch (err) {
    admin = null; // auth-service unreachable → fail closed, do not cache
    logger.debug(`[auth] admin check failed for sub=${key}: ${err?.message || err}`);
  }

  if (admin !== null) adminCache.set(key, admin);
  return admin;
}

/**
 * Global edge-auth middleware — verify-only token check + route ACL.
 * Mounted in server.js's global router, before management/proxy routes.
 */
export const authEdge = wrap(async (req, res, next) => {
  counters.requests += 1;

  const token = bearerToken(req);
  if (token) {
    const payload = verifyJwt(token);
    if (payload && payload.sub) {
      req.edgeUser = payload; // { sub, email, plan, typ, iat, exp } — no role claim
      counters.tokensVerified += 1;
    } else {
      req.edgeUser = null;
      counters.tokensInvalid += 1;
    }
  } else {
    req.edgeUser = null;
    counters.anonymous += 1;
  }

  const path = req.path;
  const method = req.method;

  /* ---- token-required routes ---------------------------------------------- */
  for (const rule of AUTH_RULES) {
    if (!pathMatches(path, rule.prefix)) continue;
    if (rule.methods && !rule.methods.includes(method)) continue;
    if (!req.edgeUser) {
      counters.authRejections += 1;
      return res.status(401).json({ error: 'Authentication required' });
    }
  }

  /* ---- admin-required routes ---------------------------------------------- */
  for (const rule of ADMIN_RULES) {
    if (!pathMatches(path, rule.prefix)) continue;
    if (!req.edgeUser) {
      counters.authRejections += 1;
      return res.status(401).json({ error: 'Authentication required' });
    }
    counters.adminChecks += 1;
    const admin = await isAdminCached(req.edgeUser.sub);
    if (admin === null) {
      counters.adminUnavailable += 1;
      res.set('Retry-After', '5');
      return res.status(503).json({
        error: 'Admin verification unavailable — auth-service unreachable',
        service: 'auth',
        degraded: true,
        retryAfterSec: 5,
      });
    }
    if (!admin) {
      counters.adminDenied += 1;
      return res.status(403).json({ error: 'Admin access required' });
    }
    counters.adminAllowed += 1;
  }

  return next();
});

/** Management-route guard: valid token + edge-verified admin. */
export const requireEdgeAdmin = wrap(async (req, res, next) => {
  const token = bearerToken(req);
  const payload = token ? verifyJwt(token) : null;
  if (!payload || !payload.sub) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  req.edgeUser = payload; // set even when mounted standalone (no global chain)
  const admin = await isAdminCached(payload.sub);
  if (admin === null) {
    res.set('Retry-After', '5');
    return res.status(503).json({
      error: 'Admin verification unavailable — auth-service unreachable',
      service: 'auth',
      degraded: true,
      retryAfterSec: 5,
    });
  }
  if (!admin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  return next();
});

/** Edge-auth stats for GET /api/gateway/stats. */
export function authEdgeStats() {
  return {
    ...counters,
    adminCheckTtlMs: ADMIN_CHECK_TTL_MS,
    adminCheckCache: adminCache.stats(),
    acl: { authRequired: AUTH_RULES, adminRequired: ADMIN_RULES },
  };
}

export default authEdge;
