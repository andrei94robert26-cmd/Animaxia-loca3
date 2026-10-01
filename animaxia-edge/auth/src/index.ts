/**
 * auth/src/index.ts — animaxia-edge-auth: the FAZA 8 authentication edge.
 *
 * The gateway worker routes /auth/* here with the URL preserved. This worker
 * TERMINATES access-token verification at the edge (no cloud round-trip on
 * the hot path) and proxies every credential-handling endpoint to the cloud
 * auth API (mini-services/animaxia-backend/modules/users/auth.js →
 * /api/auth/*), layering two edge-side replay guards on top of the cloud's
 * own server-side rotation.
 *
 * ── Secret model (shared/jwt.ts::resolveAuthSecret) ──────────────────────────
 * Identical precedence to the cloud's authSecret() (common/jwt.js):
 *   1. JWT_SECRET  — edge override carrying the EXACT HS256 secret bytes
 *                    (set when the cloud runs with an explicit AUTHSECRET);
 *   2. AUTHSECRET  — cloud env passthrough (the same bytes the cloud signs
 *                    with);
 *   3. derived     — sha256hex("animaxia-auth:<DATABASEURL>") from the
 *                    DATABASEURL passthrough — the same deterministic
 *                    derivation the cloud performs, so cloud-issued tokens
 *                    verify at the edge without sharing a secret store.
 * With none configured, verification ALWAYS fails safely (never accepts) and
 * /auth/device/token refuses to mint (500 secret_unconfigured). /auth/health
 * reports which source is live (`secretFrom`) — never the value itself.
 *
 * ── Access-token verification (GET /auth/verify) ─────────────────────────────
 * Cloud tokens are HS256 with payload { sub, email, plan, typ: 'access',
 * iat, exp } (cloud ACCESS_TTL_SEC = 900s). verifyEdgeJwt re-signs the header
 * and body and compares constant-time, then rejects non-access typ and
 * expired tokens. The payload is decoded WITHOUT verification first (local
 * helper) so a failure can be reported precisely: auth_expired when the
 * (unverified) exp is in the past, auth_invalid otherwise.
 *
 * ── jti anti-replay (EDGE_REPLAY KV) ─────────────────────────────────────────
 * With cfg.auth.enforceReplay (default on), every token presented to
 * /auth/verify registers its jti in EDGE_REPLAY (TTL = remaining token
 * lifetime); a second presentation of the same jti is rejected 401
 * auth_replay. Cloud-issued tokens carry no jti → unlimited use (documented
 * fail-open in shared/jwt.ts); tokens minted by /auth/device/token are
 * single-use by construction. The registry is best-effort: a KV outage fails
 * open (the signature check still holds) and the replay check runs BEFORE
 * the device check on purpose — a used jti is burned even if the device
 * verdict fails, so replayed tokens cannot probe device headers.
 *
 * ── dvp device binding (x-animaxia-device) ───────────────────────────────────
 * /auth/device/token mints a wrapper access token carrying dvp =
 * sha256hex("animaxia-device:<deviceId>") plus a fresh jti. On /auth/verify,
 * cfg.auth.deviceBinding governs the check:
 *   off    → never checked;
 *   soft   → tokens WITH a dvp claim must be presented together with the
 *            x-animaxia-device header whose deviceHash matches dvp (tokens
 *            without dvp pass — cloud compatibility);
 *   strict → every token must carry a matching dvp + header pair.
 *
 * ── Refresh replay guard (POST /auth/refresh) ────────────────────────────────
 * The cloud already ROTATES refresh tokens server-side (the presented token
 * is revoked and a fresh pair issued — see issueSession in auth.js). The
 * edge adds an independent second-presentation guard: sha256hex(refreshToken)
 * is stored as rth:<hash> in EDGE_REPLAY for 30 days (the cloud's
 * REFRESH_TTL_MS) on first successful use, so a replayed/stolen refresh
 * token is rejected at the edge (401 refresh_replay) before it can race the
 * legitimate client to the cloud. Successful (2xx) rotations are tagged
 * x-edge-auth: refresh-rotated.
 *
 * ── Route map (exact pathnames) ──────────────────────────────────────────────
 *   GET  /auth/verify                    edge-terminated verification:
 *                                        signature + expiry + jti replay +
 *                                        device binding
 *   POST /auth/refresh                   passthrough + refresh-replay guard
 *   POST /auth/login                     passthrough → /api/auth/login
 *   POST /auth/register                  passthrough → /api/auth/register
 *   POST /auth/logout                    passthrough → /api/auth/logout +
 *                                        best-effort jti revocation of the
 *                                        presented access token
 *   POST /auth/forgot-password           passthrough → /api/auth/forgot-password
 *   POST /auth/reset-password            passthrough → /api/auth/reset-password
 *   GET  /auth/me                        passthrough → /api/auth/me
 *   POST /auth/revoke                    revoke the presented token's jti
 *                                        (revoked=false when it has none)
 *   POST /auth/device/token              mint a device-bound single-use
 *                                        wrapper token
 *   GET  /auth/health                    liveness + effective auth policy
 *   anything else                        404 not_found
 *
 * ── Cloud session shape (read from auth.js — never guessed) ──────────────────
 * login/register respond { ok, user: publicUser, accessToken, refreshToken,
 * expiresIn: 900 } — the access token field is `accessToken` (NOT `token`);
 * refresh expects a body of { refreshToken } and answers
 * { ok, accessToken, refreshToken, expiresIn }; logout answers { ok, revoked }.
 * All passthroughs preserve the method, query string, exact body bytes
 * (request.clone().arrayBuffer()) and every client header incl. authorization
 * and x-animaxia-device (buildForwardedHeaders).
 *
 * Zero runtime dependencies; Web APIs only (WebCrypto, fetch, atob/btoa).
 * No console logging — failures surface as JSON error envelopes.
 */

import {
  DEVICE_HEADER,
  assertNotReplayed,
  bearerOf,
  deviceHash,
  edgeSignJwt,
  resolveAuthSecret,
  revokeToken,
  sha256Hex,
  verifyDeviceBindingAsync,
  verifyEdgeJwt,
} from '../../shared/jwt';
import { loadEdgeConfig } from '../../shared/config';
import { jsonError, jsonOk, readJsonBody, withCors, withSecurityHeaders } from '../../shared/http';
import { buildForwardedHeaders, upstreamFetch } from '../../shared/upstream';
import { withMetrics } from '../../shared/metrics'; // FAZA 9 ops
import type { EdgeCtx, EdgeEnv, EdgeJwtPayload } from '../../shared/types';

/* ------------------------------------------------------------- constants --- */

/** 30 days in seconds — mirrors the cloud's REFRESH_TTL_MS rotation window. */
const REFRESH_REPLAY_TTL_SEC = 2_592_000;

/** KV key prefix for the refresh-token replay registry. */
const REFRESH_REPLAY_PREFIX = 'rth:';

/** Pure POST passthrough routes (logout gets extra treatment below). */
const PASSTHROUGH_POST = new Set([
  '/auth/login',
  '/auth/register',
  '/auth/forgot-password',
  '/auth/reset-password',
]);

/* --------------------------------------------------------------- helpers --- */

/**
 * Decode a JWT payload WITHOUT verifying the signature. Error triage only:
 * reading `exp` lets /auth/verify distinguish auth_expired from
 * auth_invalid. Never trust the result for authorization decisions.
 */
function decodeJwtPayloadUnverified(token: string): EdgeJwtPayload | null {
  const body = token.split('.')[1];
  if (!body) return null;
  try {
    const b64 = body.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const raw = atob(padded);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    const payload = JSON.parse(new TextDecoder().decode(bytes));
    return payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as EdgeJwtPayload)
      : null;
  } catch {
    return null;
  }
}

/** 405 envelope with an Allow header. */
function methodNotAllowed(allowed: string): Response {
  return jsonError(405, 'method_not_allowed', `Method not allowed — use ${allowed}.`, {}, { allow: allowed });
}

/**
 * Proxy a request to the cloud auth API at /api/auth/<suffix>, preserving
 * the method, query string, exact body bytes and all client headers
 * (authorization + x-animaxia-device included, via buildForwardedHeaders).
 */
async function passthroughAuth(
  request: Request,
  env: EdgeEnv,
  suffix: string,
  search: string,
): Promise<Response> {
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const body = hasBody ? await request.clone().arrayBuffer() : null;
  return upstreamFetch({
    env,
    kind: 'cloud',
    path: `/api/auth/${suffix}`,
    search,
    method: request.method,
    headers: buildForwardedHeaders(request),
    body,
  });
}

/* ------------------------------------------------------ GET /auth/verify --- */

/**
 * Edge-terminated Bearer verification: signature → expiry → jti replay →
 * device binding. No cloud round-trip.
 */
async function handleVerify(request: Request, env: EdgeEnv): Promise<Response> {
  const token = bearerOf(request);
  if (!token) return jsonError(401, 'auth_missing', 'Authorization: Bearer <token> required');

  const payload = await verifyEdgeJwt(token, env);
  if (!payload) {
    // Signature/format failed — use the unverified exp for a precise error.
    const decoded = decodeJwtPayloadUnverified(token);
    const expired = decoded !== null
      && typeof decoded.exp === 'number'
      && decoded.exp < Math.floor(Date.now() / 1000);
    if (expired) {
      return jsonError(401, 'auth_expired', 'Access token expired — refresh it via POST /auth/refresh.');
    }
    return jsonError(401, 'auth_invalid', 'Bad signature or malformed token.');
  }

  const cfg = await loadEdgeConfig(env);

  if (cfg.auth.enforceReplay) {
    const firstUse = await assertNotReplayed(env, payload);
    if (!firstUse) {
      return jsonError(401, 'auth_replay', 'This token (jti) was already used — replay rejected.');
    }
  }

  const verdict = await verifyDeviceBindingAsync(payload, request, cfg);
  if (!verdict.ok) return jsonError(401, 'auth_device', verdict.reason);

  return jsonOk({
    ok: true,
    user: { sub: payload.sub, email: payload.email, plan: payload.plan },
    tenant: typeof payload.tenant === 'string' ? payload.tenant : 'global', // FAZA 11
    iat: payload.iat,
    exp: payload.exp,
    checks: { signature: true, replay: true, device: verdict.reason },
  });
}

/* ----------------------------------------------------- POST /auth/refresh -- */

/**
 * Passthrough refresh + edge second-presentation guard. The cloud rotates
 * the token server-side; the edge registry (rth:<sha256(refreshToken)>,
 * 30-day TTL) makes a replayed token fail fast at the edge.
 */
async function handleRefresh(request: Request, env: EdgeEnv, ctx: EdgeCtx, search: string): Promise<Response> {
  const raw = await request.clone().arrayBuffer(); // exact bytes for the passthrough
  const body = await readJsonBody(request);
  const refreshToken = body && typeof body.refreshToken === 'string' ? body.refreshToken : '';
  if (!refreshToken) {
    return jsonError(400, 'bad_request', 'JSON body { "refreshToken": "..." } is required.');
  }

  const hash = await sha256Hex(refreshToken);
  const key = `${REFRESH_REPLAY_PREFIX}${hash}`;
  if (env.EDGE_REPLAY) {
    let seen: string | null = null;
    try {
      seen = await env.EDGE_REPLAY.get(key);
    } catch {
      seen = null; // KV hiccup → fail open; the cloud still rotates
    }
    if (seen !== null) {
      return jsonError(401, 'refresh_replay', 'This refresh token was already presented — possible replay/theft.');
    }
  }

  const upstream = await upstreamFetch({
    env,
    kind: 'cloud',
    path: '/api/auth/refresh',
    search,
    method: 'POST',
    headers: buildForwardedHeaders(request),
    body: raw,
  });

  if (upstream.status >= 200 && upstream.status < 300) {
    if (env.EDGE_REPLAY) {
      ctx.waitUntil(
        env.EDGE_REPLAY
          .put(key, String(Date.now()), { expirationTtl: REFRESH_REPLAY_TTL_SEC })
          .catch(() => undefined), // best-effort registry
      );
    }
    const headers = new Headers(upstream.headers);
    headers.set('x-edge-auth', 'refresh-rotated');
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
  }

  return upstream; // cloud verdict (e.g. 401 REFRESH_INVALID) passes through as-is
}

/* ------------------------------------------------------ POST /auth/logout -- */

/**
 * Passthrough logout (the cloud revokes the refresh token) + best-effort
 * edge revocation of the presented access token's jti, so a copied access
 * token dies with the session when replay enforcement is on.
 */
async function handleLogout(request: Request, env: EdgeEnv, ctx: EdgeCtx, search: string): Promise<Response> {
  const body = await request.clone().arrayBuffer();

  const token = bearerOf(request);
  if (token) {
    const payload = await verifyEdgeJwt(token, env);
    if (payload) ctx.waitUntil(revokeToken(env, payload)); // best-effort, no jti → no-op
  }

  return upstreamFetch({
    env,
    kind: 'cloud',
    path: '/api/auth/logout',
    search,
    method: request.method,
    headers: buildForwardedHeaders(request),
    body,
  });
}

/* ------------------------------------------------------ POST /auth/revoke -- */

/** Revoke the presented access token's jti in the EDGE_REPLAY registry. */
async function handleRevoke(request: Request, env: EdgeEnv): Promise<Response> {
  const token = bearerOf(request);
  if (!token) return jsonError(401, 'auth_missing', 'Authorization: Bearer <token> required');

  const payload = await verifyEdgeJwt(token, env);
  if (!payload) return jsonError(401, 'auth_invalid', 'Bad signature or malformed token — nothing revoked.');

  const revoked = await revokeToken(env, payload); // false when the token carries no jti
  return jsonOk({ ok: true, revoked });
}

/* ------------------------------------------------ POST /auth/device/token -- */

/**
 * Mint a device-bound wrapper token: same HS256 format as the cloud, plus
 * jti (single-use id) and dvp (sha256hex("animaxia-device:<deviceId>")).
 * Carry it with the SAME x-animaxia-device header on every call.
 */
async function handleDeviceToken(request: Request, env: EdgeEnv): Promise<Response> {
  const token = bearerOf(request);
  if (!token) return jsonError(401, 'auth_missing', 'Authorization: Bearer <token> required');

  const payload = await verifyEdgeJwt(token, env);
  if (!payload) {
    return jsonError(401, 'auth_invalid', 'A valid (signed, unexpired) access token is required to mint a device-bound token.');
  }

  const body = await readJsonBody(request);
  const bodyDevice = body && typeof body.deviceId === 'string' ? body.deviceId.trim() : '';
  const headerDevice = (request.headers.get(DEVICE_HEADER) ?? '').trim();
  const deviceId = bodyDevice || headerDevice;
  if (!deviceId) {
    return jsonError(
      400,
      'device_required',
      `deviceId is required — pass {"deviceId": "..."} in the JSON body or the ${DEVICE_HEADER} header.`,
    );
  }

  const { value: secret } = await resolveAuthSecret(env);
  if (!secret) {
    return jsonError(
      500,
      'secret_unconfigured',
      'No auth secret is configured (JWT_SECRET / AUTHSECRET / DATABASEURL) — the edge cannot mint tokens.',
    );
  }

  const cfg = await loadEdgeConfig(env);
  const wrapped = await edgeSignJwt(
    {
      sub: payload.sub,
      email: payload.email,
      plan: payload.plan,
      typ: 'access',
      jti: crypto.randomUUID(),
      dvp: await deviceHash(deviceId),
    },
    secret,
    cfg.auth.accessTtlSec,
  );

  return jsonOk({
    ok: true,
    token: wrapped,
    expiresIn: cfg.auth.accessTtlSec,
    deviceBound: true,
    note: 'Carry this token + the same x-animaxia-device header; single-use jti enforced on /auth/verify when auth.enforceReplay is on.',
  });
}

/* ------------------------------------------------------- GET /auth/health -- */

/** Liveness + the effective auth policy. Reports the secret SOURCE only. */
async function handleHealth(env: EdgeEnv): Promise<Response> {
  const [secret, cfg] = await Promise.all([resolveAuthSecret(env), loadEdgeConfig(env)]);
  return jsonOk({
    ok: true,
    worker: 'animaxia-edge-auth',
    secretFrom: secret.from, // NEVER the secret value
    replayRegistry: !!env.EDGE_REPLAY,
    deviceBinding: cfg.auth.deviceBinding,
    enforceReplay: cfg.auth.enforceReplay,
  });
}

/* --------------------------------------------------------------- routing --- */

async function route(request: Request, env: EdgeEnv, ctx: EdgeCtx): Promise<Response> {
  const { pathname, search } = new URL(request.url);

  if (pathname === '/auth/verify') {
    if (request.method !== 'GET') return methodNotAllowed('GET');
    return handleVerify(request, env);
  }

  if (pathname === '/auth/refresh') {
    if (request.method !== 'POST') return methodNotAllowed('POST');
    return handleRefresh(request, env, ctx, search);
  }

  if (PASSTHROUGH_POST.has(pathname)) {
    if (request.method !== 'POST') return methodNotAllowed('POST');
    return passthroughAuth(request, env, pathname.slice('/auth/'.length), search);
  }

  if (pathname === '/auth/logout') {
    if (request.method !== 'POST') return methodNotAllowed('POST');
    return handleLogout(request, env, ctx, search);
  }

  if (pathname === '/auth/me') {
    if (request.method !== 'GET') return methodNotAllowed('GET');
    return passthroughAuth(request, env, 'me', search);
  }

  if (pathname === '/auth/revoke') {
    if (request.method !== 'POST') return methodNotAllowed('POST');
    return handleRevoke(request, env);
  }

  if (pathname === '/auth/device/token') {
    if (request.method !== 'POST') return methodNotAllowed('POST');
    return handleDeviceToken(request, env);
  }

  if (pathname === '/auth/health') {
    if (request.method !== 'GET') return methodNotAllowed('GET');
    return handleHealth(env);
  }

  return jsonError(404, 'not_found', `No auth route for ${request.method} ${pathname}`);
}

/* ----------------------------------------------------------- entrypoint ---- */

export default {
  fetch: withMetrics('auth', async (request: Request, env: EdgeEnv, ctx: EdgeCtx): Promise<Response> => {
    let response: Response;
    try {
      response = await route(request, env, ctx);
    } catch (err) {
      response = jsonError(500, 'edge_auth_error', 'Unhandled auth-worker failure.', {
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    // Hardened headers on everything; withCors also short-circuits OPTIONS
    // preflights (any /auth/* path) with a 204 carrying the CORS policy.
    return withCors(withSecurityHeaders(response), request);
  }), // FAZA 9 ops: /metrics + request counters
};
