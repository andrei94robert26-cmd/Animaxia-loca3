/**
 * main/ipc/deepLink.js — animaxia:// deep links + in-app navigation fan-out.
 *
 * EVERY navigation that originates outside the renderer (deep links, tray,
 * app menu, notification clicks, mini-player "expand") is funneled through
 * sendNavigate() → 'app:navigate' → the main window's router:
 *
 *   animaxia://home                → /
 *   animaxia://content/42          → /content/42
 *   animaxia://player/42           → /player/42
 *   animaxia://feed                → /feed
 *   animaxia://ai                  → /ai
 *   animaxia://watchlist           → /watchlist
 *   animaxia://premium             → /premium
 *   animaxia://profile             → /profile
 *   animaxia://auth?mode=reset&…  → /auth?mode=reset&…
 *
 * Lifecycle:
 *   • macOS   — 'open-url' event while running; at cold start the link is in
 *               process.argv (handled by findLinkArg before ready).
 *   • win/lin — a second launch passes the link via argv → single-instance
 *               'second-instance' forwards it here.
 *   • The very first link (window not ready yet) is parked and replayed via
 *     'app:initial-route' as soon as the renderer asks.
 */

const { ipcMain, BrowserWindow } = require('electron');

const SCHEME = 'animaxia:';

let getWindow = () => null;
let focusMain = () => {};
let initialRoute = null;

/** Map an animaxia:// URL to a renderer route, or null when unparsable. */
function parseLink(url) {
  if (typeof url !== 'string' || !url.startsWith(SCHEME)) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const segments = parsed.pathname.split('/').filter(Boolean);
  const search = parsed.search; // leading '?' — appended verbatim when non-empty

  switch (host) {
    case 'home':
    case '':
      return '/';
    case 'content':
      return segments[0] ? `/content/${encodeURIComponent(segments[0])}` : '/';
    case 'player':
      return segments[0] ? `/player/${encodeURIComponent(segments[0])}${search}` : '/';
    case 'feed':
      return '/feed';
    case 'ai':
      return '/ai';
    case 'watchlist':
      return '/watchlist';
    case 'premium':
      return '/premium';
    case 'profile':
      return '/profile';
    case 'auth':
      return `/auth${search || '?mode=login'}`;
    default:
      return '/';
  }
}

/** Scan an argv array (cold start / second instance) for an animaxia:// link. */
function findLinkArg(argv = []) {
  for (const arg of argv) {
    if (typeof arg === 'string' && arg.startsWith(SCHEME)) return arg;
  }
  return null;
}

/** Route a raw animaxia:// URL to the main window. */
function handleDeepLink(url) {
  const route = parseLink(url);
  if (!route) return;
  sendNavigate(route);
}

/** Push a route to the main window renderer (and bring the window forward). */
function sendNavigate(route) {
  const win = getWindow();
  if (!win || win.isDestroyed()) {
    initialRoute = route; // parked — replayed on 'app:initial-route'
    return;
  }
  try {
    win.webContents.send('app:navigate', route);
    focusMain();
  } catch {
    initialRoute = route;
  }
}

function init({ getWindow: getWindowFn, focusMain: focusFn }) {
  getWindow = getWindowFn || getWindow;
  focusMain = focusFn || focusMain;

  ipcMain.handle('app:initial-route', () => {
    const route = initialRoute;
    initialRoute = null;
    return route;
  });
}

/** Remember a link that arrived before the renderer was ready to ask. */
function parkInitialLink(url) {
  const route = parseLink(url);
  if (route) initialRoute = route;
}

module.exports = { SCHEME, init, parseLink, findLinkArg, handleDeepLink, sendNavigate, parkInitialLink };
