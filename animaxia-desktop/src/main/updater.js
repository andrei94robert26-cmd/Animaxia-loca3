/**
 * main/updater.js — Auto-update via electron-updater.
 *
 * • Feed: the `publish` generic provider in electron-builder.yml
 *   (https://updates.animaxia.io/desktop), overridable with the
 *   ANIMAXIA_UPDATE_URL environment variable.
 * • On packaged builds: checks at startup + every 4 hours, downloads in the
 *   background, and the renderer offers "Restart to update" via IPC.
 * • In dev (`electron .` unpackaged) the updater is a documented no-op —
 *   electron-updater needs the packaged app-update.yml manifest.
 *
 * Events → renderer ('updater:status'):
 *   { event: 'checking' | 'available' | 'not-available' | 'downloading'
 *           | 'progress' | 'downloaded' | 'error' | 'dev-noop', info }
 *
 * IPC surface:
 *   on  updater:check          → manual check (menu / Profile screen)
 *   on  updater:install        → quitAndInstall()
 */

const { app, ipcMain, BrowserWindow } = require('electron');

let autoUpdater = null;
let getWindow = () => null;

function send(event, info = null) {
  const payload = JSON.stringify({ event, info });
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.webContents.send('updater:status', payload);
    } catch {
      /* window mid-destroy */
    }
  }
}

function init({ getWindow: getWindowFn }) {
  getWindow = getWindowFn || getWindow;

  try {
    // Required lazily so a broken/missing electron-updater install never
    // takes the whole app down.
    autoUpdater = require('electron-updater').autoUpdater;
  } catch (err) {
    send('error', { message: `electron-updater unavailable: ${err.message}` });
    return;
  }

  if (process.env.ANIMAXIA_UPDATE_URL) {
    try {
      autoUpdater.setFeedURL({ provider: 'generic', url: process.env.ANIMAXIA_UPDATE_URL });
    } catch {
      /* keep the packaged feed */
    }
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;

  autoUpdater.on('checking-for-update', () => send('checking'));
  autoUpdater.on('update-available', (info) => send('available', { version: info && info.version }));
  autoUpdater.on('update-not-available', () => send('not-available'));
  autoUpdater.on('download-progress', (progress) =>
    send('progress', {
      percent: progress && progress.percent,
      bytesPerSecond: progress && progress.bytesPerSecond,
      transferred: progress && progress.transferred,
      total: progress && progress.total,
    }),
  );
  autoUpdater.on('update-downloaded', (info) => send('downloaded', { version: info && info.version }));
  autoUpdater.on('error', (err) => send('error', { message: err ? err.message : 'unknown error' }));

  ipcMain.on('updater:check', () => checkNow());

  ipcMain.on('updater:install', () => {
    if (!autoUpdater) return;
    try {
      autoUpdater.quitAndInstall();
    } catch {
      /* not downloaded yet — ignore */
    }
  });

  if (app.isPackaged && autoUpdater) {
    // Small delay so startup IO settles first.
    setTimeout(checkNow, 10 * 1000);
    setInterval(checkNow, 4 * 3600 * 1000);
  }
}

/** Manual / scheduled check — callable from the menu, tray and IPC. */
function checkNow() {
  if (!app.isPackaged || !autoUpdater) {
    send('dev-noop', { message: 'Updates are checked in packaged builds only.' });
    return;
  }
  autoUpdater.checkForUpdates().catch((err) => send('error', { message: err.message }));
}

module.exports = { init, checkNow };
