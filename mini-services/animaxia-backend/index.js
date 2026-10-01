/**
 * index.js — FAZA 28-E public-deploy entry shim (INFRA-ONLY, ADDITIVE).
 *
 * WHY THIS FILE EXISTS — the exact root cause of the public 502s (2026-09-24):
 * the platform deploy builder (.zscripts/mini-services-build.sh) discovers a
 * mini-service entry as src/index.ts | index.ts | src/index.js | index.js.
 * The Animaxia backend's real entry is `server.js`, so the backend was
 * SILENTLY SKIPPED by the public build: nothing listened on :4000 on the
 * deployed instance, every `/api/*?XTransformPort=4000` browser call hit a
 * dead port, and the whole public site showed "Request failed with status
 * 502" while the sandbox itself was fully green.
 *
 * This shim lets the standard discovery find the backend WITHOUT touching a
 * single byte of the protected server.js (FAZA 18/20/21/23/24/25/28, Neon
 * FTS, pipeline, hub, player, AI Hub/Home — all untouched; AR10M: fostul 30B
 * simulat a fost eliminat din platformă).
 *
 * ESM evaluation order (what makes the shim safe):
 *   1. ./deploy-shim.mjs  — deploy boot hygiene: PORT inheritance fix +
 *                           baked env fallback (runs its side effects first)
 *   2. ./server.js        — the real, protected Animaxia entry (UNMODIFIED)
 *
 * Sandbox dev flow is unaffected: `bun run dev` runs `bun --watch server.js`
 * directly (this file is never executed locally).
 */
import './deploy-shim.mjs';
import './server.js';
