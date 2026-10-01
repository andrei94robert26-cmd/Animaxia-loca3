#!/usr/bin/env node
/**
 * scripts/check-deeplink.cjs — Functional animaxia:// deep-link contract test.
 *
 * Requires src/main/ipc/deepLink.js with an Electron STUB injected via
 * Module._load (no Electron binary needed — the deep-link module only touches
 * ipcMain.handle at init() and BrowserWindow types, neither runs here).
 *
 * Verifies:
 *   1. parseLink() maps every documented animaxia:// link to the exact
 *      renderer route the HashRouter in src/renderer/app.tsx declares.
 *   2. findLinkArg() scans argv for cold-start / second-instance links.
 *   3. parkInitialLink() + init() + 'app:initial-route' replay a link that
 *      arrived before the window was ready (cold-start deep link).
 *   4. sendNavigate() pushes 'app:navigate' to a live window and focuses it;
 *      with no window it parks the route instead of crashing.
 *   5. Non-animaxia:// URLs are rejected (null) — no open-redirect surface.
 *
 * Run: `node scripts/check-deeplink.cjs` (invoked by scripts/smoke-test.mjs).
 */

'use strict';

const Module = require('node:module');
const path = require('node:path');
const assert = require('node:assert');
const { readFileSync } = require('node:fs');

/* ------------------------------ electron stub ------------------------------- */

const ipcHandlers = new Map(); // channel → handler fn (captures init() wiring)
const electronStub = {
  ipcMain: {
    handle: (channel, fn) => ipcHandlers.set(channel, fn),
    on: () => {},
  },
  BrowserWindow: class StubBrowserWindow {},
};

const origLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') return electronStub;
  return origLoad.apply(this, arguments);
};

const deepLink = require(path.join(__dirname, '..', 'src', 'main', 'ipc', 'deepLink.js'));

/* --------------------------------- helpers ---------------------------------- */

let checked = 0;
function ok(label) {
  checked += 1;
  console.log(`  ✓ ${label}`);
}

/* 1 — parseLink mapping (exactly the table documented in deepLink.js header) */
const CASES = [
  ['animaxia://home', '/'],
  ['animaxia://content/42', '/content/42'],
  ['animaxia://player/42', '/player/42'],
  ['animaxia://player/42?resume=95', '/player/42?resume=95'],
  ['animaxia://feed', '/feed'],
  ['animaxia://ai', '/ai'],
  ['animaxia://watchlist', '/watchlist'],
  ['animaxia://premium', '/premium'],
  ['animaxia://profile', '/profile'],
  ['animaxia://auth', '/auth?mode=login'],
  ['animaxia://auth?mode=reset&email=a%40b.c&code=123456', '/auth?mode=reset&email=a%40b.c&code=123456'],
  ['animaxia://', '/'],
  ['animaxia://unknown/screen', '/'], // unknown host → safe fallback Home
  ['https://evil.example/content/1', null], // foreign scheme → rejected
  // The URL parser percent-encodes once, encodeURIComponent again — the id is
  // double-encoded, which is SAFE (over-encoding; screens run Number(id) on it
  // anyway, so nothing raw ever reaches the DOM).
  ['animaxia://content/<script>', '/content/%253Cscript%253E'],
];

for (const [link, expected] of CASES) {
  const actual = deepLink.parseLink(link);
  assert.strictEqual(
    actual,
    expected,
    `parseLink(${link}) → ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
  );
}
ok(`parseLink maps all ${CASES.length} links (incl. XSS-id encoding + foreign-scheme reject)`);

/* 2 — the mapped routes must exist in the renderer router (app.tsx parity) */
const appTsx = readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.tsx'), 'utf8');
const declared = [...appTsx.matchAll(/path="([^"]+)"/g)].map((m) => m[1]);

function routeMatches(pattern, route) {
  const p = pattern.split('/').filter(Boolean);
  const r = route.split('/').filter(Boolean);
  if (pattern === '/' || pattern === '*') return pattern === route || pattern === '*';
  if (p.length !== r.length) return false;
  return p.every((seg, i) => seg.startsWith(':') || seg === r[i]);
}

const routerTargets = [...new Set(CASES.map(([, route]) => route).filter((r) => r !== null))];
const unroutable = [];
for (const target of routerTargets) {
  const base = target.split('?')[0];
  if (!declared.some((pattern) => pattern !== '*' && routeMatches(pattern, base))) {
    unroutable.push(target);
  }
}
assert.deepStrictEqual(unroutable, [], `deep-link targets missing from app.tsx routes: ${unroutable.join(', ')}`);
ok(`every mapped target exists in the app.tsx router (${declared.filter((d) => d !== '*').length} routes declared)`);

/* 3 — cold-start argv scan */
assert.strictEqual(deepLink.findLinkArg(['animaxia', '--foo', 'animaxia://feed']), 'animaxia://feed');
assert.strictEqual(deepLink.findLinkArg(['animaxia', '--no-sandbox']), null);
assert.strictEqual(deepLink.findLinkArg([]), null);
ok('findLinkArg finds the cold-start link in argv and rejects argv without one');

/* 4 — parked link replayed via app:initial-route (link arrived pre-window) */
deepLink.init({ getWindow: () => null, focusMain: () => {} });
assert.ok(ipcHandlers.has('app:initial-route'), "init() must register the 'app:initial-route' handler");
deepLink.parkInitialLink('animaxia://premium');
assert.strictEqual(ipcHandlers.get('app:initial-route')(), '/premium');
assert.strictEqual(ipcHandlers.get('app:initial-route')(), null, 'parked route must be consumed exactly once');
deepLink.handleDeepLink('animaxia://ai'); // no window yet → parks instead of crashing
assert.strictEqual(ipcHandlers.get('app:initial-route')(), '/ai');
ok("cold-start links park + replay once through 'app:initial-route'");

/* 5 — live-window navigation fan-out */
let sent = null;
let focused = 0;
const liveWindow = {
  isDestroyed: () => false,
  webContents: { send: (channel, payload) => (sent = { channel, payload }) },
};
deepLink.init({ getWindow: () => liveWindow, focusMain: () => (focused += 1) });
deepLink.handleDeepLink('animaxia://watchlist');
assert.deepStrictEqual(sent, { channel: 'app:navigate', payload: '/watchlist' });
assert.strictEqual(focused, 1, 'sendNavigate must focus the main window');
deepLink.sendNavigate('/player/7?resume=12');
assert.deepStrictEqual(sent, { channel: 'app:navigate', payload: '/player/7?resume=12' });
ok("runtime links fan out via 'app:navigate' + focus (tray/menu/notification path)");

console.log(`check-deeplink: ${checked} assertions passed`);
