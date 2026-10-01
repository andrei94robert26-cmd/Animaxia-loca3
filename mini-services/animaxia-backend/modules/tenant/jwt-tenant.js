/**
 * modules/tenant/jwt-tenant.js — FAZA 11 tenant-aware JWT helpers (additive).
 *
 * Secret model (dual-path verification, zero breakage for existing tokens):
 *   • Base secret — exactly the derivation auth.js has always used
 *     (AUTHSECRET env, else sha256('animaxia-auth:sqlite-local')).
 *   • Tenant secret — sha256(baseSecret + ':tenant:' + slug). Tokens carrying
 *     a `tenant` claim other than 'global' are signed with their tenant
 *     secret; every other token (all pre-FAZA-11 tokens, anonymous traffic,
 *     and 'global'-tenant accounts) keeps using the base secret — so
 *     verification of the entire existing token population is unchanged.
 *
 * verifyTenantJwt(token) tries the base secret first (the hot path — the
 * vast majority of tokens), then falls back to reading the (still untrusted)
 * payload ONLY to select the candidate tenant secret, and re-verifies the
 * signature with timing-safe comparison. A token is only accepted after the
 * signature validates under one of the two paths.
 *
 * The same derivation is mirrored in animaxia-edge/shared/jwt.ts so the edge
 * auth worker can verify tenant tokens without calling the origin.
 */

import crypto from 'node:crypto';

/** Base signing secret — identical to auth.js authSecret(). */
export function baseAuthSecret() {
  if (process.env.AUTHSECRET) return process.env.AUTHSECRET;
  return crypto
    .createHash('sha256')
    .update('animaxia-auth:sqlite-local')
    .digest('hex');
}

/** Per-tenant derived signing secret (sha256, hex). */
export function tenantSecretFor(slug) {
  const tenant = String(slug || '').toLowerCase().trim();
  if (!tenant || tenant === 'global') return baseAuthSecret();
  return crypto
    .createHash('sha256')
    .update(`${baseAuthSecret()}:tenant:${tenant}`)
    .digest('hex');
}

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

/** Sign a JWT payload with the secret for payload.tenant (or the base one). */
export function signTenantJwt(payload, ttlSec = 15 * 60) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const nowSec = Math.floor(Date.now() / 1000);
  const secret = tenantSecretFor(payload?.tenant);
  const body = b64url(JSON.stringify({ ...payload, iat: nowSec, exp: nowSec + ttlSec }));
  const sig = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

function hmacMatches(secret, header, body, sig) {
  const expected = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function decodePayload(body) {
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

/**
 * Dual-path verify: base secret first, then (only to pick the candidate
 * secret) the untrusted payload's tenant claim. Returns the verified payload
 * or null. Accepts every token the legacy verifyJwt accepted, plus tenant
 * tokens.
 */
export function verifyTenantJwt(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const nowSec = Math.floor(Date.now() / 1000);

  const accept = (payload) => {
    if (!payload) return null;
    if (payload.typ !== 'access') return null;
    if (typeof payload.exp !== 'number' || payload.exp < nowSec) return null;
    return payload;
  };

  // Path 1 — base secret (legacy + 'global' tenant tokens). A base-signed
  // token carrying a NON-global tenant claim is rejected here: tenant claims
  // must be backed by the tenant-derived signature (strict policy — the auth
  // service never issues such tokens, so only a secret-holder could, and the
  // tenant secret is the designated holder).
  if (hmacMatches(baseAuthSecret(), header, body, sig)) {
    const payload = decodePayload(body);
    if (payload && typeof payload.tenant === 'string' && payload.tenant !== 'global') return null;
    return accept(payload);
  }
  // Path 2 — tenant-derived secret, selected via the untrusted claim; the
  // signature check below is what makes the token trustworthy.
  const candidate = decodePayload(body);
  if (!candidate?.tenant || candidate.tenant === 'global') return null;
  if (hmacMatches(tenantSecretFor(candidate.tenant), header, body, sig)) {
    return accept(candidate);
  }
  return null;
}

/** Extract the tenant slug a verified payload belongs to ('global' default). */
export function tenantOfPayload(payload) {
  const slug = String(payload?.tenant || '').toLowerCase().trim();
  return slug || 'global';
}
