/**
 * auth.js — JWT verification with EXACT parity to the monolith
 * (mini-services/animaxia-backend/modules/users/auth.js):
 *
 *   header {alg: 'HS256', typ: 'JWT'}, payload {sub, email, plan,
 *   typ: 'access', iat, exp}, signature = HMAC-SHA256(secret,
 *   `${header}.${body}`) base64url, secret = AUTHSECRET env.
 *
 * Zero dependencies (node:crypto only). Returns the payload object or null.
 * Access tokens only (typ !== 'access' rejected), exp enforced with a 5s
 * clock skew tolerance.
 */

import crypto from 'node:crypto';
import { config } from './env.js';

const CLOCK_SKEW_SEC = 5;

/**
 * Resolve the signing secret with EXACT parity to the monolith's
 * modules/users/auth.js authSecret(): AUTHSECRET when set, otherwise the
 * deterministic derived secret sha256(`animaxia-auth:${DATABASEURL|'local'}`).
 * The monolith .env (restored from the ZIP) carries DATABASEURL, so parity
 * survives env wipes automatically via env.js fallback loading.
 */
let cachedSecret = null;
function authSecret() {
  if (cachedSecret) return cachedSecret;
  cachedSecret =
    config.authSecret ||
    crypto.createHash('sha256').update(`animaxia-auth:${config.databaseUrl || 'local'}`).digest('hex');
  return cachedSecret;
}

function b64urlToJson(part) {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * Verify a monolith access token. Returns {sub, email, plan, exp, …} or null.
 */
export function verifyAccessToken(token) {
  const secret = authSecret();
  if (!secret) return null; // no secret configured → reject (fail closed)
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;

  let expected;
  try {
    expected = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  } catch {
    return null;
  }
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  const headerObj = b64urlToJson(header);
  const payload = b64urlToJson(body);
  if (!headerObj || !payload || typeof payload !== 'object') return null;
  if (headerObj.alg !== 'HS256') return null;
  if (payload.typ !== 'access') return null;
  if (typeof payload.exp !== 'number') return null;
  if (payload.exp + CLOCK_SKEW_SEC < Math.floor(Date.now() / 1000)) return null;
  if (!Number.isInteger(payload.sub)) return null;

  return payload;
}

/** Shape the public socket identity from a verified payload. */
export function identityOf(payload) {
  if (!payload) return null;
  return {
    userid: payload.sub,
    email: payload.email || null,
    plan: payload.plan || 'free',
  };
}
