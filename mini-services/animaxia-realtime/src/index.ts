/**
 * src/index.ts — FAZA 28-E public-deploy entry shim (INFRA-ONLY, ADDITIVE).
 *
 * The platform deploy builder (.zscripts/mini-services-build.sh) picks the
 * entry by priority: src/index.ts | index.ts | src/index.js | index.js.
 * This shim therefore FRONTS the real entry (../index.js — the protected
 * FAZA 10/21 realtime service, UNMODIFIED) and fixes exactly one
 * deploy-environment hazard that killed :4010 on the public instance:
 *
 * PORT INHERITANCE — the platform start.sh exports PORT for the Next.js
 * server (default 3000) and every bundled mini-service inherits it. The
 * realtime config (env.js) resolves `port` as `process.env.PORT || 4010`,
 * so the deployed bundle tried to bind :3000 (already taken by Next.js) →
 * "Failed to start server. Is port 3000 in use?" → EADDRINUSE crash →
 * realtime dead → socket.io / watch-party calls 502 in production.
 * (Reproduced and proven locally with the exact platform bundle + PORT=3000.)
 *
 * Rule: an explicit REALTIMEPORT always wins; otherwise any inherited PORT
 * is discarded so env.js falls back to its own 4010 — the port the public
 * Caddyfile XTransformPort routing expects.
 *
 * The sandbox dev flow is unaffected: `bun run dev` runs `bun --hot index.js`
 * (the real entry directly — this file is never executed locally).
 */
if (process.env.REALTIMEPORT) {
  process.env.PORT = process.env.REALTIMEPORT;
} else {
  delete process.env.PORT; // never inherit the Next.js/deploy PORT=3000
}

/* The real, protected realtime entry — bundled after the hygiene above. */
await import('../index.js');
