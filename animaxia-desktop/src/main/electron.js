/**
 * main/electron.js — Animaxia Desktop main process entry.
 *
 *   • 1280×800 main window (min 1024×640), rose-on-charcoal, sandboxed
 *     renderer (contextIsolation + sandbox + preload bridge, no node access)
 *   • animaxia:// deep links (macOS open-url, win/linux single-instance argv)
 *   • system tray + close-to-tray
 *   • mini-player window (always-on-top, frameless)
 *   • dark/light/system theme persisted before first paint (no white flash)
 *   • auto-update (electron-updater), 4-hourly checks in packaged builds
 *   • external links open in the OS browser — never in-app
 *
 * Module map:
 *   ipc/settings.js       settings.json + theme
 *   ipc/deepLink.js       animaxia:// parsing + 'app:navigate' fan-out
 *   ipc/miniPlayer.js     pop-out player window
 *   ipc/playback.js       resume positions (userData/playback.json)
 *   ipc/notifications.js  scheduled + pushed desktop notifications
 *   ipc/tray.js           tray icon & menu
 *   updater.js            electron-updater wrapper
 *   menu.js               native application menu
 */

const { app, BrowserWindow, ipcMain, nativeTheme, shell } = require('electron');
const path = require('node:path');

const { buildMenu } = require('./menu');
const { initUpdater, checkNow: checkUpdates } = require('./updater');
const settings = require('./ipc/settings');
const deepLink = require('./ipc/deepLink');
const miniPlayer = require('./ipc/miniPlayer');
const playback = require('./ipc/playback');
const notifications = require('./ipc/notifications');
const { initTray } = require('./ipc/tray');

const WINDOW = { width: 1280, height: 800, minWidth: 1024, minHeight: 640 };

let mainWindow = null;
let quitting = false;

/* -------------------------------- main window ------------------------------- */

function rendererTarget() {
  const dev = process.env.VITE_DEV_SERVER_URL;
  if (dev) return { url: dev };
  return { file: path.join(__dirname, '..', '..', 'dist-renderer', 'index.html') };
}

function loadInto(win, hash) {
  const target = rendererTarget();
  if (target.url) {
    win.loadURL(hash ? `${target.url}#${hash}` : target.url);
  } else if (hash) {
    win.loadFile(target.file, { hash });
  } else {
    win.loadFile(target.file);
  }
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: WINDOW.width,
    height: WINDOW.height,
    minWidth: WINDOW.minWidth,
    minHeight: WINDOW.minHeight,
    backgroundColor: '#0a0a10',
    show: false,
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.on('close', (event) => {
    // Close-to-tray keeps Animaxia running (tray Quit / menu Quit exits for
    // real). Dev builds close for real so `electron .` sessions don't linger.
    if (!quitting && app.isPackaged && settings.getCloseToTray()) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Deep links / tray / notifications can arrive before the renderer is up —
  // deepLink.sendNavigate parks them; the renderer replays via initial-route.
  loadInto(mainWindow);

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // External http(s) links → the user's browser, never a new Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  return mainWindow;
}

function focusMain() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/* --------------------------------- lifecycle -------------------------------- */

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    // Windows/Linux: a second launch carries the animaxia:// link in argv.
    const link = deepLink.findLinkArg(argv);
    if (link) deepLink.handleDeepLink(link);
    focusMain();
  });

  // Register the protocol before ready. In dev (electron .) Electron must be
  // registered with the executable + script path so the OS can re-enter it.
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('animaxia', process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient('animaxia');
  }

  // Theme from the last session, applied before any window paints.
  settings.primeTheme();

  // Cold-start deep link (win/linux): parked until the renderer asks.
  const coldLink = deepLink.findLinkArg(process.argv);
  if (coldLink) deepLink.parkInitialLink(coldLink);

  app.whenReady().then(() => {
    createMainWindow();

    deepLink.init({ getWindow: () => mainWindow, focusMain });
    playback.init();
    miniPlayer.init({ getMain: () => mainWindow, playback });
    notifications.init({
      navigate: (route) => deepLink.sendNavigate(route),
      focusMain,
    });
    settings.init();
    initUpdater({ getWindow: () => mainWindow });

    // About card / diagnostics.
    ipcMain.handle('app:info', () => ({
      version: app.getVersion(),
      platform: process.platform,
      isPackaged: app.isPackaged,
      userDataPath: app.getPath('userData'),
    }));

    const actions = {
      navigate: (route) => deepLink.sendNavigate(route),
      openMiniPlayer: () => miniPlayer.openMiniWithLast(),
      checkUpdates,
      getThemeSetting: () => settings.getTheme(),
      setTheme: (setting) => {
        settings.patch({ theme: setting });
        buildMenu(actions); // refresh the Theme label
      },
    };
    buildMenu(actions);

    initTray({
      onShow: focusMain,
      onMiniPlayer: () => miniPlayer.openMiniWithLast(),
      onCheckUpdates: checkUpdates,
      onQuit: () => {
        quitting = true;
        app.quit();
      },
    });

    // macOS: animaxia:// while the app is already running.
    app.on('open-url', (event, url) => {
      event.preventDefault();
      deepLink.handleDeepLink(url);
    });

    app.on('activate', () => {
      if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
      else focusMain();
    });
  });

  app.on('before-quit', () => {
    quitting = true;
  });

  app.on('window-all-closed', () => {
    // With close-to-tray the main window hides instead of closing, so this
    // only fires when the user really exited — quit everywhere except macOS.
    if (process.platform !== 'darwin') app.quit();
  });
}
