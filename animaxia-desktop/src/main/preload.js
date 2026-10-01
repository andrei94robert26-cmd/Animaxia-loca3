/**
 * main/preload.js — The ONLY bridge between the sandboxed renderer and the
 * main process (contextIsolation: true, sandbox: true, nodeIntegration: false).
 *
 * Exposed as window.animaxia. Rules:
 *   • Request/response → ipcRenderer.invoke (promise-based).
 *   • Events → ONE ipcRenderer.on subscription per channel, fanned out to
 *     registered renderer callbacks (payload-only — Electron events never
 *     leak into the sandbox).
 *   • Every channel name is hardcoded here — the renderer cannot invent IPC.
 *
 * Shape mirrors the AnimaxiaBridge type in src/renderer/types/global.d.ts.
 */

const { contextBridge, ipcRenderer } = require('electron');

/* ------------------------------ event fan-out ------------------------------- */

const subscribers = new Map(); // channel → Set<Function>

function onEvent(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  if (!subscribers.has(channel)) {
    subscribers.set(channel, new Set());
    ipcRenderer.on(channel, (_event, payload) => {
      let data = payload;
      // Main sends JSON strings for resilience across sandbox boundaries.
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data);
        } catch {
          /* keep raw string */
        }
      }
      for (const fn of subscribers.get(channel)) {
        try {
          fn(data);
        } catch {
          /* a broken listener must not break the rest */
        }
      }
    });
  }
  const set = subscribers.get(channel);
  set.add(callback);
  return () => set.delete(callback);
}

/* --------------------------------- bridge ----------------------------------- */

contextBridge.exposeInMainWorld('animaxia', {
  /* navigation (deep links, tray, menu, notification clicks, mini expand) */
  onNavigate: (callback) => onEvent('app:navigate', callback),
  getInitialRoute: () => ipcRenderer.invoke('app:initial-route'),

  /* theme (dark/light/system, OS-synced) */
  theme: {
    get: () => ipcRenderer.invoke('theme:get'),
    set: (setting) => ipcRenderer.invoke('theme:set', setting),
    onChanged: (callback) => onEvent('theme:changed', callback),
  },

  /* persisted user settings (close-to-tray, …) */
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    patch: (patch) => ipcRenderer.invoke('settings:patch', patch),
  },

  /* mini-player */
  miniPlayer: {
    open: (payload) => ipcRenderer.send('mini-player:open', payload),
    getData: () => ipcRenderer.invoke('mini-player:get-data'),
    reportProgress: (progress) => ipcRenderer.send('mini-player:progress', progress),
    onReplaced: (callback) => onEvent('mini-player:data', callback),
    onClosed: (callback) => onEvent('mini-player:closed', callback),
    close: () => ipcRenderer.send('mini-player:close'),
    expand: (position) => ipcRenderer.send('mini-player:expand', position),
  },

  /* cross-window resume positions (survive restarts) */
  playback: {
    get: (contentId) => ipcRenderer.invoke('playback:get', contentId),
    save: (payload) => ipcRenderer.send('playback:save', payload),
  },

  /* auto-update */
  updater: {
    check: () => ipcRenderer.send('updater:check'),
    install: () => ipcRenderer.send('updater:install'),
    onStatus: (callback) => onEvent('updater:status', callback),
  },

  /* desktop notifications */
  notifications: {
    getSettings: () => ipcRenderer.invoke('notifications:get-settings'),
    saveSettings: (settings) => ipcRenderer.invoke('notifications:save-settings', settings),
    setPremium: (context) => ipcRenderer.send('notifications:set-premium', context),
    newContent: (note) => ipcRenderer.send('notifications:new-content', note),
    test: (note) => ipcRenderer.send('notifications:test', note),
  },

  /* app info (About card, connection diagnostics) */
  app: {
    getInfo: () =>
      ipcRenderer
        .invoke('app:info')
        .catch(() => ({ version: '0.0.0-dev', platform: process.platform, isPackaged: false, userDataPath: '' })),
  },
});
