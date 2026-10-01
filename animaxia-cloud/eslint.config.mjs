// eslint.config.mjs — minimal zero-dependency ESLint FLAT config for Animaxia Cloud.
//
// Why this file exists: CI (`.github/workflows/ci.yml`, job `lint`) runs
// `bunx eslint . --ext .js,.mjs` from the repo root. Without a config at the
// root ESLint exits non-zero ("couldn't find an ESLint config") and the lint
// job fails — so the config is committed here and must NOT be deleted.
//
// Design notes:
// - Flat config (ESLint 9+/10 style). Extensions live in `files` below, which
//   is the flat-config equivalent of the legacy `--ext`/`overrides` combo.
// - Zero dependencies: no `globals` / `@eslint/js` imports — the runner
//   (`bunx eslint`) must work even when `node_modules` only holds the
//   workspace runtime deps (express, pg, ...). Host globals are declared
//   inline for the Bun/Node/Web overlap the services run with.
// - Deliberately minimal: syntax/undefined/unused-var catching only. Style is
//   not enforced by CI; `bun run verify` (scripts/verify-syntax.mjs) is the
//   syntax gate for every .js/.mjs under common/, domain/ and services/.

// Bun + Node + Web host globals available to Animaxia Cloud code (ESM, Bun
// runtime). All `readonly` — CI should fail on assignments to globals, not on
// legitimate use of the platform.
const hostGlobals = {
  // language / runtime
  console: 'readonly',
  globalThis: 'readonly',
  global: 'readonly', // Bun's Node-compat alias for globalThis
  Bun: 'readonly',
  process: 'readonly',
  Buffer: 'readonly',
  navigator: 'readonly',
  performance: 'readonly',
  crypto: 'readonly',
  require: 'readonly', // supported by Bun even in ESM
  __dirname: 'readonly', // Bun injects these into ESM too
  __filename: 'readonly',
  // timers & microtasks
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  clearImmediate: 'readonly',
  queueMicrotask: 'readonly',
  // fetch / web platform
  fetch: 'readonly',
  Request: 'readonly',
  Response: 'readonly',
  Headers: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  Blob: 'readonly',
  FormData: 'readonly',
  File: 'readonly',
  ReadableStream: 'readonly',
  WritableStream: 'readonly',
  TransformStream: 'readonly',
  CompressionStream: 'readonly',
  DecompressionStream: 'readonly',
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  WebSocket: 'readonly',
  structuredClone: 'readonly',
  atob: 'readonly',
  btoa: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  Event: 'readonly',
  EventTarget: 'readonly',
  CustomEvent: 'readonly',
  MessageChannel: 'readonly',
  MessagePort: 'readonly',
  Worker: 'readonly',
  SharedArrayBuffer: 'readonly',
  Atomics: 'readonly',
};

export default [
  {
    // Flat-config equivalent of `--ext .js,.mjs` (extensions are declared
    // here; the CI command keeps the flag for eslintrc-style compatibility).
    files: ['**/*.js', '**/*.mjs'],
    ignores: ['**/node_modules/**', '**/dist/**', '**/build/**'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: hostGlobals,
    },
    rules: {
      // Real bug catchers — these FAIL CI (exit code 1).
      'no-undef': 'error', // caught a genuine ReferenceError in common/ during setup
      'no-redeclare': 'error',
      'no-dupe-keys': 'error',
      'no-unreachable': 'error',
      'no-constant-condition': 'error', // default option set allows `while (true)`
      'no-self-assign': 'error',
      // Unused vars are WARNINGS, not errors: the frozen blueprint (§4)
      // mandates named re-exports/imports (e.g. `authSecret` in
      // domain/users/auth.js) that are not referenced locally, and the repo is
      // authored by many agents in parallel — blocking on unused imports would
      // fight the contract. Warnings stay visible in the job log.
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
    },
  },
];
