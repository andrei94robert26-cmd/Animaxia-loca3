/**
 * main/ipc/settings.js — Persisted user settings + theme bridge.
 *
 * Settings live in userData/settings.json (survives restarts):
 *   {
 *     theme: 'system' | 'dark' | 'light',   // drives nativeTheme.themeSource
 *     closeToTray: boolean,                 // window close → hide to tray
 *     notifications: { dailyPicks, weeklyRecap, newContent, premiumRenewal },
 *     fired: { … per-notification markers … }   // owned by notifications.js
 *   }
 *
 * IPC surface (all renderer access goes through preload):
 *   invoke  settings:get            → full settings object
 *   invoke  settings:patch          → shallow merge + persist, returns settings
 *   invoke  theme:get               → { setting, resolved }
 *   invoke  theme:set  (setting)    → persist + apply + broadcast
 *   event   theme:changed { setting, resolved }   → all windows
 *
 * `resolved` is what the renderer should paint (nativeTheme.shouldUseDarkColors)
 * so the OS "auto" switch (macOS schedule, Windows registry) is honored live.
 */

const { app, ipcMain, nativeTheme, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');

const DEFAULTS = {
  theme: 'system',
  closeToTray: true,
  notifications: {
    dailyPicks: true,
    weeklyRecap: true,
    newContent: true,
    premiumRenewal: true,
  },
  fired: {},
  premium: { plan: null, planExpiresAt: null },
};

let state = { ...DEFAULTS, notifications: { ...DEFAULTS.notifications } };
let loaded = false;

/* --------------------------------- storage --------------------------------- */

function load() {
  if (loaded) return state;
  loaded = true;
  try {
    const raw = fs.readFileSync(SETTINGS_FILE(), 'utf8');
    const parsed = JSON.parse(raw);
    state = {
      ...DEFAULTS,
      ...parsed,
      notifications: { ...DEFAULTS.notifications, ...(parsed.notifications || {}) },
      fired: { ...(parsed.fired || {}) },
      premium: { ...DEFAULTS.premium, ...(parsed.premium || {}) },
    };
  } catch {
    /* first boot or corrupt file — defaults are fine */
  }
  return state;
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(state, null, 2));
  } catch {
    /* best-effort — read-only userData should not crash the app */
  }
}

/* ---------------------------------- theme ----------------------------------- */

function resolvedTheme() {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

function applyTheme(setting) {
  // nativeTheme.themeSource accepts 'system' | 'dark' | 'light'.
  nativeTheme.themeSource = setting;
}

function broadcastTheme() {
  const payload = JSON.stringify({ setting: state.theme, resolved: resolvedTheme() });
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.webContents.send('theme:changed', payload);
    } catch {
      /* window may be mid-destroy */
    }
  }
}

/* --------------------------------- lifecycle -------------------------------- */

function init() {
  load();
  applyTheme(state.theme);

  // OS-level theme change (auto schedule / system setting) → tell renderers
  // what to paint when the app is following "system".
  nativeTheme.on('updated', () => broadcastTheme());

  ipcMain.handle('settings:get', () => ({ ...state }));

  ipcMain.handle('settings:patch', (_event, patch) => {
    if (!patch || typeof patch !== 'object') return { ...state };
    const { theme, ...rest } = patch;
    if (theme === 'system' || theme === 'dark' || theme === 'light') {
      state.theme = theme;
      applyTheme(theme);
      broadcastTheme();
    }
    if (typeof rest.closeToTray === 'boolean') state.closeToTray = rest.closeToTray;
    if (rest.notifications && typeof rest.notifications === 'object') {
      state.notifications = { ...state.notifications, ...rest.notifications };
    }
    if (rest.premium && typeof rest.premium === 'object') {
      state.premium = { ...state.premium, ...rest.premium };
    }
    persist();
    return { ...state };
  });

  ipcMain.handle('theme:get', () => ({ setting: state.theme, resolved: resolvedTheme() }));

  ipcMain.handle('theme:set', (_event, setting) => {
    if (setting !== 'system' && setting !== 'dark' && setting !== 'light') return { setting: state.theme, resolved: resolvedTheme() };
    state.theme = setting;
    applyTheme(setting);
    persist();
    broadcastTheme();
    return { setting: state.theme, resolved: resolvedTheme() };
  });
}

/** Apply the persisted theme before the first window paints (no white flash). */
function primeTheme() {
  load();
  applyTheme(state.theme);
}

module.exports = {
  init,
  primeTheme,
  get: () => load(),
  patch: (patch) => {
    load();
    const merged = { ...state, ...patch };
    state = merged;
    persist();
    return { ...state };
  },
  getTheme: () => load().theme,
  getCloseToTray: () => load().closeToTray,
  resolvedTheme,
};
