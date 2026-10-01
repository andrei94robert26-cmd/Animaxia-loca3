/**
 * deploy-shim.mjs — FAZA 28-E deploy boot hygiene (INFRA-ONLY, ADDITIVE).
 * FAZA 32 repair (2026-09-26): the static `import './.env-deploy.mjs'` broke
 * the whole public build when that GENERATED artifact was wiped by a sandbox
 * reset → bun build failed → the backend was silently skipped → every public
 * /api call 502 (exact FAZA 28-E symptom, new root cause). The import is now
 * a GUARDED runtime dynamic import with a variable specifier: the bundler
 * never resolves it statically, so a missing file can never fail the build —
 * on the deployed instance the gap-fill loads only if the artifact ships
 * next to the bundle; otherwise dotenv (.env copied into the dist CWD by
 * .zscripts/mini-services-build.sh) covers the environment.
 *
 * 1) PORT INHERITANCE — the platform start.sh exports PORT for the Next.js
 *    server (default 3000) and bundled mini-services inherit it. The backend
 *    honors `process.env.PORT || 4000`, so on the deployed instance it would
 *    try to bind :3000 → EADDRINUSE crash. Rule: an explicit BACKENDPORT
 *    always wins; otherwise any inherited PORT is discarded so server.js
 *    falls back to its own 4000 — the port the public Caddyfile
 *    XTransformPort routing expects.
 *
 * 2) ENV FALLBACK (best-effort, never fatal) — see .env-deploy.mjs header.
 */

const envBakeModule = './.env-deploy.mjs';
try {
  /* Variable specifier: bundled as a RUNTIME import (or skipped) — never a
   * build-time dependency. Missing file → catch → boot continues via dotenv. */
  await import(envBakeModule);
} catch {
  /* Optional artifact — .env in the dist CWD is the primary env source. */
}

/* PORT hygiene — evaluated after the optional env bake, still BEFORE server.js. */
if (process.env.BACKENDPORT) {
  process.env.PORT = process.env.BACKENDPORT;
} else {
  delete process.env.PORT; // never inherit the Next.js/deploy PORT=3000
}
