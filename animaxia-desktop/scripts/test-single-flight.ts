/**
 * scripts/test-single-flight.ts — QA: "10 parallel 401s must share ONE refresh".
 *
 * Exercises the REAL renderer modules (no mocks of the code under test):
 *   src/renderer/api/client.ts  — request() + refreshSession() single-flight
 *   src/renderer/auth/tokenStore.ts — localStorage-backed session persistence
 *
 * Browser globals are stubbed BEFORE the imports (the modules read
 * window.localStorage at call time, never at import time), then `fetch` is
 * replaced with a scripted server:
 *
 *   • GET anything with `Authorization: Bearer expired-…`  → 401 once
 *   • POST /api/auth/refresh with the valid rotating token  → new session
 *   • GET anything with `Authorization: Bearer fresh-…`    → 200 payload
 *
 * Scenarios:
 *   A. 10 parallel authenticated requests hit 401 → exactly ONE refresh call,
 *      every request retried once and resolved with the fresh token.
 *   B. refresh endpoint refuses (session revoked) → still ONE refresh call,
 *      all 10 reject with the ORIGINAL 401, session cleared, 'logout' emitted.
 *   C. /api/auth/* paths never enter the refresh-retry loop (AUTH_PATHS).
 *
 * Run: `bun scripts/test-single-flight.ts` (bun executes TS directly;
 * invoked by scripts/smoke-test.mjs when bun is on PATH).
 */

/* ---------------------- browser globals stub (BEFORE imports) ---------------- */

const mem = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = {
  localStorage: {
    getItem: (k: string) => (mem.has(k) ? (mem.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      mem.set(k, String(v));
    },
    removeItem: (k: string) => {
      mem.delete(k);
    },
    clear: () => mem.clear(),
  },
};

/* --------------------------------- imports ----------------------------------- */

const { request, refreshSession, isApiError, onAuthChange } = await import('../src/renderer/api/client.ts');
const { saveSession, getAccessToken, getRefreshToken } = await import('../src/renderer/auth/tokenStore.ts');

/* ------------------------------ scripted server ------------------------------- */

let refreshCalls = 0;
let fetchCalls = 0;
let refreshMode: 'ok' | 'revoke' = 'ok';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const realFetch = globalThis.fetch;
(globalThis as unknown as { fetch: unknown }).fetch = async (
  input: unknown,
  init: { headers?: Record<string, string>; body?: unknown } = {},
) => {
  const url = typeof input === 'string' ? input : (input as URL).toString();
  const headers = init.headers ?? {};
  const authorization = headers['Authorization'] ?? '';
  fetchCalls += 1;
  await new Promise((r) => setTimeout(r, 5)); // async boundary → real interleaving

  if (url.endsWith('/api/auth/refresh')) {
    refreshCalls += 1;
    if (refreshMode === 'revoke') return json(401, { error: 'Refresh token revoked', code: 'AUTH_REQUIRED' });
    const body = JSON.parse(String(init.body ?? '{}')) as { refreshToken?: string };
    if (body.refreshToken !== 'rt-valid') return json(401, { error: 'Invalid refresh token' });
    return json(200, { accessToken: 'fresh-access-token', refreshToken: 'rt-rotated', expiresIn: 900 });
  }

  if (authorization === 'Bearer expired-access-token') {
    return json(401, { error: 'Access token expired', code: 'AUTH_REQUIRED' });
  }
  if (authorization === 'Bearer fresh-access-token') {
    return json(200, { ok: true, via: 'fresh' });
  }
  if (!authorization) return json(200, { ok: true, via: 'anonymous' });
  return json(401, { error: 'Unknown token' });
};

/* --------------------------------- helpers ------------------------------------ */

let passed = 0;
function ok(label: string) {
  passed += 1;
  console.log(`  ✓ ${label}`);
}
function reset(store: { access: string; refresh: string }) {
  mem.clear();
  refreshCalls = 0;
  fetchCalls = 0;
  return saveSession({ accessToken: store.access, refreshToken: store.refresh, expiresIn: 900 });
}

/* ------------------------------- scenario A ----------------------------------- */

console.log('scenario A — 10 parallel 401s share one refresh, all retry successfully');
await reset({ access: 'expired-access-token', refresh: 'rt-valid' });

const results = await Promise.allSettled(Array.from({ length: 10 }, () => request('/api/mobile/home')));
assertEqual(results.filter((r) => r.status === 'fulfilled').length, 10, 'all 10 parallel requests resolve');
assertEqual(refreshCalls, 1, 'exactly ONE /api/auth/refresh call for 10 concurrent 401s');
assertEqual(fetchCalls, 21, '10 failed + 1 refresh + 10 retried = 21 fetch calls (single retry each)');
for (const r of results) {
  if (r.status !== 'fulfilled') throw new Error('unreachable — checked above');
  assertEqual((r.value as { via: string }).via, 'fresh', 'retry used the fresh access token');
}
assertEqual(await getAccessToken(), 'fresh-access-token', 'rotated session persisted to the token store');
assertEqual(await getRefreshToken(), 'rt-rotated', 'rotating refresh token persisted');
ok('scenario A passed');

/* ------------------------------- scenario B ----------------------------------- */

console.log('scenario B — revoked refresh: one attempt, original 401s, session cleared, logout emitted');
await reset({ access: 'expired-access-token', refresh: 'rt-valid' });
refreshMode = 'revoke';

let logoutEvents = 0;
const off = onAuthChange((event) => {
  if (event === 'logout') logoutEvents += 1;
});

const rejected = await Promise.allSettled(Array.from({ length: 10 }, () => request('/api/users/me')));
off();
assertEqual(rejected.filter((r) => r.status === 'rejected').length, 10, 'all 10 requests reject');
assertEqual(refreshCalls, 1, 'revoked refresh attempted exactly once (single-flight even on failure)');
for (const r of rejected) {
  if (r.status !== 'rejected') throw new Error('unreachable — checked above');
  if (!isApiError(r.reason)) throw new Error('rejection must be an ApiError');
  assertEqual(r.reason.status, 401, 'rejection keeps the ORIGINAL 401 status');
}
assertEqual(await getAccessToken(), null, 'session cleared from the token store');
assertEqual(logoutEvents, 1, "'logout' emitted exactly once to the auth event bus");
ok('scenario B passed');

/* ------------------------------- scenario C ----------------------------------- */

console.log('scenario C — /api/auth/* never enters the refresh-retry loop');
await reset({ access: 'expired-access-token', refresh: 'rt-valid' });
refreshMode = 'ok';

// /api/auth/login is in AUTH_PATHS → its 401 must NOT trigger a refresh.
let loginRejected: unknown = null;
try {
  await request('/api/auth/login', { method: 'POST', body: { email: 'x@y.z', password: 'nope' } });
} catch (err) {
  loginRejected = err;
}
if (!isApiError(loginRejected) || loginRejected.status !== 401) throw new Error('login 401 must surface directly');
assertEqual(refreshCalls, 0, 'no refresh issued for AUTH_PATHS requests');
assertEqual(fetchCalls, 1, 'no silent retry for AUTH_PATHS requests');

// Direct refreshSession() while idle → single-flight promise, callable standalone.
const token = await refreshSession();
assertEqual(token, 'fresh-access-token', 'refreshSession() standalone returns the new access token');
assertEqual(refreshCalls, 1, 'one refresh for the direct call');
ok('scenario C passed');

/* ---------------------------------- done -------------------------------------- */

(globalThis as unknown as { fetch: unknown }).fetch = realFetch;
console.log(`test-single-flight: ${passed}/3 scenarios passed (10-parallel-401 single-flight verified)`);

/* -------------------------------- assert helper -------------------------------- */

function assertEqual<T>(actual: T, expected: T, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAIL: ${label} — got ${a}, expected ${e}`);
}
