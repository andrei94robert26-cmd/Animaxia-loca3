/**
 * shared/jwt.ts — JWT (HS256) verification on the edge with WebCrypto,
 * with EXACTLY the same semantics as animaxia-cloud/common/jwt.js:
 *
 *   • secret = env.JWT_SECRET, else env.AUTHSECRET, else the deterministic
 *     derived secret sha256hex("animaxia-auth:<DATABASEURL>") — identical
 *     derivation to the cloud, so tokens issued by auth-service verify here.
 *   • access tokens carry { sub, email, plan, typ: 'access', iat, exp }
 *   • verification is constant-time on the signature and rejects
 *     non-access / expired tokens
 *
 * Edge extensions (FAZA 8):
 *   • anti-replay — `jti` claims are registered in EDGE_REPLAY KV on first
 *     use (TTL = token lifetime); a second presentation of the same jti
 *     is rejected.
 *   • device-bound tokens — tokens carrying `dvp` (sha256hex(deviceId)) are
 *     checked against the x-animaxia-device header. Modes: off / soft
 *     (tokens without dvp pass) / strict (dvp required).
 */

import type { EdgeEnv, EdgeJwtPayload } from './types';
import type { EdgeConfig } from './config';

const encoder = new TextEncoder();

/* ------------------------------------------------------------- b64url ----- */

function b64UrlToBytes(input: string): Uint8Array {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const b64 = padded + '='.repeat((4 - (padded.length % 4)) % 4);
  const raw = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export function bytesToB64Url(bytes: Uint8Array): string {
  let raw = '';
  for (const b of bytes) raw += String.fromCharCode(b);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function utf8ToB64Url(text: string): string {
  return bytesToB64Url(encoder.encode(text));
}

/* -------------------------------------------------------------- hashing --- */

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* -------------------------------------------------------------- secret ---- */

let secretCache: { value: string; from: string } | null = null;

/** FAZA 11: per-tenant derived secret — EXACTLY the monolith derivation
 *  (modules/tenant/jwt-tenant.js): sha256hex(`<baseSecret>:tenant:<slug>`).
 *  The 'global' tenant (and every pre-FAZA-11 token) uses the base secret. */
const tenantSecretCache = new Map<string, string>();

export async function tenantSecretFor(baseSecret: string, slug: string): Promise<string> {
  const tenant = String(slug || '').trim().toLowerCase();
  if (!tenant || tenant === 'global') return baseSecret;
  const hit = tenantSecretCache.get(tenant);
  if (hit) return hit;
  const derived = await sha256Hex(`${baseSecret}:tenant:${tenant}`);
  tenantSecretCache.set(tenant, derived);
  return derived;
};

/**
 * Resolve the HS256 secret with the cloud's exact precedence:
 * JWT_SECRET (edge override) → AUTHSECRET (cloud env) → derived
 * sha256hex("animaxia-auth:<DATABASEURL>").
 */
export async function resolveAuthSecret(env: EdgeEnv): Promise<{ value: string; from: string }> {
  if (secretCache) return secretCache;
  let value: string;
  let from: string;
  if (env.JWT_SECRET) {
    value = env.JWT_SECRET;
    from = 'JWT_SECRET';
  } else if (env.AUTHSECRET) {
    value = env.AUTHSECRET;
    from = 'AUTHSECRET';
  } else if (env.DATABASEURL) {
    value = await sha256Hex(`animaxia-auth:${env.DATABASEURL}`);
    from = 'derived:DATABASEURL';
  } else {
    // No secret configured: verification always fails safely (never accepts).
    value = '';
    from = 'none';
  }
  secretCache = { value, from };
  return secretCache;
}

/** Test hook: drop the cached secret (env changes between tests). */
export function resetSecretCache(): void {
  secretCache = null;
  tenantSecretCache.clear();
}

/* ----------------------------------------------------------- verify ------- */

function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function hmacSign(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  return new Uint8Array(sig);
}

function decodeJwtParts(token: string): { header: string; body: string; sig: string } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  return { header: parts[0], body: parts[1], sig: parts[2] };
}

function acceptPayload(body: string): EdgeJwtPayload | null {
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64UrlToBytes(body)));
    if (!payload || typeof payload !== 'object') return null;
    if (payload.typ !== 'access') return null;
    if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload as EdgeJwtPayload;
  } catch {
    return null;
  }
}

/**
 * Verify an access token. Returns the payload or null (bad format, bad
 * signature, wrong typ, expired). Mirrors common/jwt.js::verifyJwt.
 *
 * FAZA 11 — dual-path verification (mirrors modules/tenant/jwt-tenant.js):
 * the base secret is tried first (the hot path — every pre-FAZA-11 token and
 * 'global'-tenant token); on signature mismatch the still-untrusted payload
 * is decoded ONLY to select the candidate tenant secret, and the signature
 * is re-verified with it. A token is accepted only after a signature
 * validates under one of the two paths.
 */
export async function verifyEdgeJwt(token: string | null | undefined, env: EdgeEnv): Promise<EdgeJwtPayload | null> {
  if (!token) return null;
  const { value: secret } = await resolveAuthSecret(env);
  if (!secret) return null;

  const parts = decodeJwtParts(String(token));
  if (!parts) return null;
  const { header, body, sig } = parts;

  try {
    const headerJson = JSON.parse(new TextDecoder().decode(b64UrlToBytes(header)));
    if (headerJson?.alg !== 'HS256') return null;

    // Path 1 — base secret (legacy + 'global' tenant tokens). A base-signed
    // token carrying a NON-global tenant claim is rejected: tenant claims
    // must be backed by the tenant-derived signature (strict policy, mirrors
    // modules/tenant/jwt-tenant.js).
    const expected = await hmacSign(secret, `${header}.${body}`);
    if (timingSafeEqualBytes(b64UrlToBytes(sig), expected)) {
      const payload = acceptPayload(body);
      if (payload && typeof payload.tenant === 'string' && payload.tenant !== 'global') return null;
      return payload;
    }

    // Path 2 — tenant-derived secret, selected via the untrusted claim; the
    // signature check below is what makes the token trustworthy.
    const candidate = acceptPayload(body);
    const tenant = typeof candidate?.tenant === 'string' ? candidate.tenant : '';
    if (!tenant || tenant === 'global') return null;
    const tenantSecret = await tenantSecretFor(secret, tenant);
    const tenantExpected = await hmacSign(tenantSecret, `${header}.${body}`);
    if (timingSafeEqualBytes(b64UrlToBytes(sig), tenantExpected)) {
      return candidate;
    }
    return null;
  } catch {
    return null;
  }
}

/** Extract the Bearer token from a Request (or null). */
export function bearerOf(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/** Verify the request's Bearer token in one call. */
export async function verifyRequest(request: Request, env: EdgeEnv): Promise<EdgeJwtPayload | null> {
  return verifyEdgeJwt(bearerOf(request), env);
}

/* --------------------------------------------------------- anti-replay ---- */

const REPLAY_PREFIX = 'replay:';

/**
 * Register first use of a jti. Returns true when this is the FIRST
 * presentation (allowed); false when the token was already used (replay).
 * Tokens without jti are always allowed (cloud currently issues none).
 * Best-effort against KV races — see README "anti-replay" notes.
 */
export async function assertNotReplayed(env: EdgeEnv, payload: EdgeJwtPayload): Promise<boolean> {
  if (!payload.jti) return true;
  if (!env.EDGE_REPLAY) return true; // no registry → fail open (documented)
  const key = `${REPLAY_PREFIX}${payload.jti}`;
  try {
    const existing = await env.EDGE_REPLAY.get(key);
    if (existing !== null) return false;
    const nowSec = Math.floor(Date.now() / 1000);
    const ttl = Math.max(60, Math.floor((payload.exp ?? nowSec + 900) - nowSec));
    await env.EDGE_REPLAY.put(key, String(Date.now()), { expirationTtl: ttl });
    return true;
  } catch {
    return true; // KV unavailable → fail open, origin still verifies signature
  }
}

/** Explicitly revoke a jti (auth worker /auth/revoke). */
export async function revokeToken(env: EdgeEnv, payload: EdgeJwtPayload): Promise<boolean> {
  if (!payload.jti || !env.EDGE_REPLAY) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  const ttl = Math.max(60, Math.floor((payload.exp ?? nowSec + 900) - nowSec));
  try {
    await env.EDGE_REPLAY.put(`${REPLAY_PREFIX}${payload.jti}`, `revoked:${Date.now()}`, { expirationTtl: ttl });
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------ device binding ---- */

export const DEVICE_HEADER = 'x-animaxia-device';

/** dvp claim value = sha256hex(deviceId). */
export async function deviceHash(deviceId: string): Promise<string> {
  return sha256Hex(`animaxia-device:${deviceId}`);
}

export interface DeviceVerdict {
  ok: boolean;
  mode: 'off' | 'soft' | 'strict';
  reason: string;
  deviceBound: boolean;
}

/**
 * Check device binding for a token payload:
 *  • off    → always ok
 *  • soft   → tokens WITH dvp must match the header; tokens without dvp pass
 *  • strict → dvp claim AND matching header are required
 */
export function verifyDeviceBinding(
  payload: EdgeJwtPayload,
  request: Request,
  cfg: EdgeConfig,
): DeviceVerdict {
  const mode = cfg.auth.deviceBinding;
  if (mode === 'off') return { ok: true, mode, reason: 'device binding disabled', deviceBound: false };
  const headerDevice = request.headers.get(DEVICE_HEADER);
  const hasClaim = typeof payload.dvp === 'string' && payload.dvp.length > 0;
  if (!hasClaim) {
    if (mode === 'strict') {
      return { ok: false, mode, reason: 'strict device binding requires a dvp claim', deviceBound: false };
    }
    return { ok: true, mode, reason: 'token not device-bound', deviceBound: false };
  }
  if (!headerDevice) {
    return { ok: false, mode, reason: `missing ${DEVICE_HEADER} header`, deviceBound: true };
  }
  return { ok: true, mode, reason: 'device bound', deviceBound: true };
  // NOTE: headerDevice is the raw device id; the caller compares its hash to
  // payload.dvp asynchronously — see verifyDeviceBindingAsync below.
}

/** Full async check: hashes the header device id and compares with dvp. */
export async function verifyDeviceBindingAsync(
  payload: EdgeJwtPayload,
  request: Request,
  cfg: EdgeConfig,
): Promise<DeviceVerdict> {
  const mode = cfg.auth.deviceBinding;
  if (mode === 'off') return { ok: true, mode, reason: 'device binding disabled', deviceBound: false };
  const headerDevice = request.headers.get(DEVICE_HEADER);
  const hasClaim = typeof payload.dvp === 'string' && payload.dvp.length > 0;
  if (!hasClaim) {
    if (mode === 'strict') {
      return { ok: false, mode, reason: 'strict device binding requires a dvp claim', deviceBound: false };
    }
    return { ok: true, mode, reason: 'token not device-bound', deviceBound: false };
  }
  if (!headerDevice) {
    return { ok: false, mode, reason: `missing ${DEVICE_HEADER} header`, deviceBound: true };
  }
  const hash = await deviceHash(headerDevice);
  if (hash !== payload.dvp) {
    return { ok: false, mode, reason: 'device hash mismatch', deviceBound: true };
  }
  return { ok: true, mode, reason: 'device bound', deviceBound: true };
}

/* ------------------------------------------------------------ sign (tools) - */

/**
 * Sign an HS256 access token with the SAME format as the cloud
 * (used by tests and by /auth/device to mint device-bound wrappers).
 */
export async function edgeSignJwt(
  payload: EdgeJwtPayload,
  secret: string,
  ttlSec = 900,
): Promise<string> {
  const header = utf8ToB64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const nowSec = Math.floor(Date.now() / 1000);
  const body = utf8ToB64Url(JSON.stringify({ ...payload, iat: nowSec, exp: nowSec + ttlSec }));
  const sig = await hmacSign(secret, `${header}.${body}`);
  return `${header}.${body}.${bytesToB64Url(sig)}`;
}

/** Constant-time compare helper exposed for WAF/tests. */
export { timingSafeEqualBytes };
