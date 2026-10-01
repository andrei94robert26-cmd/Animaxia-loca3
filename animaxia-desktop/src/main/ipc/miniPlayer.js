/**
 * main/ipc/miniPlayer.js — The always-on-top mini-player window.
 *
 * Flow:
 *   1. Main window PlayerScreen → 'mini-player:open' with
 *      { contentId, title, thumbnail, source: { type, url, label },
 *        position, duration }
 *   2. This module opens (or reuses) a small frameless always-on-top window
 *      that loads the SAME renderer bundle at the #/mini-player hash route.
 *   3. The mini window asks 'mini-player:get-data' on mount and plays from
 *      `position`; its progress is reported back via 'mini-player:progress'
 *      and persisted through the shared playback store.
 *   4. "Expand" → 'mini-player:expand' { position } — the main window gets an
 *      'app:navigate' to /player/:id?resume=<position>, is focused, and the
 *      mini window closes itself.
 *
 * Events to the main window:
 *   'mini-player:opened'  — a mini window exists now (PlayerScreen can pause)
 *   'mini-player:closed'  — it was closed (PlayerScreen can resume)
 */

const { BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');

const MINI_SIZE = { width: 440, height: 330 };

let miniWindow = null;
let payload = null;
let lastPayload = null; // survives mini window close — powers tray "Mini-player"
let getMain = () => null;
let playback = { save: () => {} };

function sendToMain(channel, data) {
  const main = getMain();
  if (main && !main.isDestroyed()) {
    try {
      main.webContents.send(channel, data);
    } catch {
      /* mid-destroy */
    }
  }
}

function loadRenderer(win) {
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    win.loadURL(`${devUrl}#/mini-player`);
  } else {
    win.loadFile(path.join(__dirname, '..', '..', '..', 'dist-renderer', 'index.html'), { hash: 'mini-player' });
  }
}

function createMiniWindow() {
  miniWindow = new BrowserWindow({
    width: MINI_SIZE.width,
    height: MINI_SIZE.height,
    minWidth: 320,
    minHeight: 200,
    frame: false,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: false,
    show: false,
    backgroundColor: '#0a0a10',
    title: 'Animaxia — Mini-player',
    icon: path.join(__dirname, '..', '..', '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  miniWindow.once('ready-to-show', () => miniWindow.show());

  miniWindow.on('closed', () => {
    miniWindow = null;
    sendToMain('mini-player:closed', null);
  });

  // The renderer owns dragging via -webkit-app-region; window position is
  // remembered by the OS between sessions.
  loadRenderer(miniWindow);
  return miniWindow;
}

function openMini(next) {
  if (!next || typeof next !== 'object' || !next.source || !next.source.url) return;
  payload = next;
  lastPayload = next;
  sendToMain('mini-player:opened', { contentId: payload.contentId });

  if (miniWindow && !miniWindow.isDestroyed()) {
    // Reuse the live window — tell it to swap content.
    try {
      miniWindow.webContents.send('mini-player:data', payload);
      miniWindow.show();
      miniWindow.focus();
    } catch {
      /* fall through — window is dying; recreate below */
    }
    return;
  }
  createMiniWindow();
}

function closeMini() {
  if (miniWindow && !miniWindow.isDestroyed()) miniWindow.close();
}

function expand(position) {
  if (!payload) return;
  const pos = Number.isFinite(position) ? Math.max(0, position) : 0;
  const route = `/player/${payload.contentId}?resume=${pos.toFixed(2)}`;
  const main = getMain();
  if (main && !main.isDestroyed()) {
    try {
      main.webContents.send('app:navigate', route);
      if (main.isMinimized()) main.restore();
      main.show();
      main.focus();
    } catch {
      /* ignore */
    }
  }
  closeMini();
}

/** Tray/menu entry: reopen the last mini payload of this session (if any). */
function openMiniWithLast() {
  if (lastPayload) {
    openMini(lastPayload);
    return;
  }
  // Nothing played this session — just surface the hint on the main window.
  sendToMain('app:navigate', '/');
  const main = getMain();
  if (main && !main.isDestroyed()) {
    if (main.isMinimized()) main.restore();
    main.show();
    main.focus();
  }
}

function init({ getMain: getMainFn, playback: playbackModule }) {
  getMain = getMainFn || getMain;
  playback = playbackModule || playback;

  ipcMain.on('mini-player:open', (_event, next) => openMini(next));
  ipcMain.handle('mini-player:get-data', () => payload);
  ipcMain.on('mini-player:progress', (_event, progress) => {
    if (!payload || !progress || typeof progress !== 'object') return;
    playback.save({
      contentId: payload.contentId,
      position: progress.position,
      duration: progress.duration,
    });
  });
  ipcMain.on('mini-player:expand', (_event, position) => expand(position));
  ipcMain.on('mini-player:close', () => closeMini());
}

module.exports = { init, openMini, openMiniWithLast, closeMini, hasWindow: () => Boolean(miniWindow) };
