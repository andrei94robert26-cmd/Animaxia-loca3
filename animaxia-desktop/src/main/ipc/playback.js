/**
 * main/ipc/playback.js — Cross-window resume positions.
 *
 * Playback positions must survive:
 *   • main window ↔ mini-player hand-offs (both windows report progress)
 *   • app restarts (userData/playback.json)
 *
 * IPC surface:
 *   invoke playback:get  (contentId)  → { position, duration, updatedAt } | null
 *   on     playback:save { contentId, position, duration }
 *
 * The store is pruned to the 50 most recently updated titles.
 */

const { app, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const FILE = () => path.join(app.getPath('userData'), 'playback.json');
const MAX_ENTRIES = 50;

/** contentId (string) → { position, duration, updatedAt } */
let store = {};
let loaded = false;

function load() {
  if (loaded) return;
  loaded = true;
  try {
    store = JSON.parse(fs.readFileSync(FILE(), 'utf8')) || {};
  } catch {
    store = {};
  }
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(FILE()), { recursive: true });
    fs.writeFileSync(FILE(), JSON.stringify(store));
  } catch {
    /* best-effort */
  }
}

function prune() {
  const keys = Object.keys(store);
  if (keys.length <= MAX_ENTRIES) return;
  keys
    .sort((a, b) => (store[a].updatedAt || 0) - (store[b].updatedAt || 0))
    .slice(0, keys.length - MAX_ENTRIES)
    .forEach((key) => delete store[key]);
}

function save({ contentId, position, duration }) {
  const id = String(contentId);
  if (!id) return;
  store[id] = {
    position: Number.isFinite(position) ? Math.max(0, position) : 0,
    duration: Number.isFinite(duration) ? Math.max(0, duration) : 0,
    updatedAt: Date.now(),
  };
  prune();
  persist();
}

function get(contentId) {
  load();
  return store[String(contentId)] || null;
}

function init() {
  load();
  ipcMain.handle('playback:get', (_event, contentId) => get(contentId));
  ipcMain.on('playback:save', (_event, payload) => {
    if (payload && typeof payload === 'object') save(payload);
  });
}

module.exports = { init, get, save };
