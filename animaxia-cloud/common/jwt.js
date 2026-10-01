/**
 * common/jwt.js — JWT (HS256) token layer extracted verbatim from the
 * monolith users/auth.js so every microservice and the gateway can verify
 * tokens issued by auth-service with identical semantics:
 *   • secret = AUTHSECRET env, else deterministic sha256("animaxia-auth:<DATABASEURL>")
 *   • access tokens carry { sub, email, plan, typ: 'access', iat, exp }
 *   • 15-minute access TTL is applied when the payload has no `exp` override
 *   • verification is timing-safe and rejects non-access / expired tokens
 */

import crypto from 'node:crypto';

const DEFAULT_ACCESS_TTL_SEC = 15 * 60; // 15 minutes

export function authSecret() {
  if (process.env.AUTHSECRET) return process.env.AUTHSECRET;
  // Deterministic derived secret: stable across restarts without extra config,
  // unique per deployment (bound to the DATABASEURL). Same rule as the monolith.
  return crypto
    .createHash('sha256')
    .update(`animaxia-auth:${process.env.DATABASEURL || 'local'}`)
    .digest('hex');
}

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

export function signJwt(payload, { ttlSec = DEFAULT_ACCESS_TTL_SEC } = {}) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const nowSec = Math.floor(Date.now() / 1000);
  const body = b64url(JSON.stringify({ ...payload, iat: nowSec, exp: nowSec + ttlSec }));
  const sig = crypto.createHmac('sha256', authSecret()).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

export function verifyJwt(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = crypto.createHmac('sha256', authSecret()).update(`${header}.${body}`).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload || typeof payload !== 'object') return null;
    if (payload.typ !== 'access') return null;
    if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Extract the Bearer token from an Express request (or null). */
export function bearerToken(req) {
  const header = req.headers && req.headers.authorization;
  if (!header || typeof header !== 'string') return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}
