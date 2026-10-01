/**
 * main/ipc/tray.js — System-tray icon + context menu.
 *
 * • Click / "Show Animaxia" → restore + focus the main window.
 * • "Mini-player" → pops the mini-player with the last watched title
 *   (resume position comes from the persisted playback store).
 * • "Check for Updates…" → triggers the same updater flow as the app menu.
 * • "Quit Animaxia" → real quit (bypasses close-to-tray).
 *
 * The tray is what makes "close to tray" meaningful: closing the window
 * keeps Animaxia running in the tray (setting: closeToTray, default on in
 * packaged builds).
 */

const { Tray, Menu, nativeImage, app } = require('electron');
const path = require('node:path');

let tray = null;

function initTray({ onShow, onMiniPlayer, onCheckUpdates, onQuit }) {
  if (tray) return tray;

  const iconPath = path.join(__dirname, '..', '..', '..', 'build', 'tray.png');
  let image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) {
    // Never crash on a missing/odd icon — fall back to the app icon resized.
    image = nativeImage.createFromPath(path.join(__dirname, '..', '..', '..', 'build', 'icon.png'));
  }
  if (!image.isEmpty()) image = image.resize({ width: 16, height: 16 });
  if (image.isEmpty()) return null; // headless / no build resources — skip tray

  tray = new Tray(image);
  tray.setToolTip('Animaxia');

  const template = [
    { label: 'Show Animaxia', click: onShow },
    { label: 'Mini-player', click: onMiniPlayer },
  ];
  if (typeof onCheckUpdates === 'function') {
    template.push({ label: 'Check for Updates…', click: onCheckUpdates });
  }
  template.push({ type: 'separator' }, { label: 'Quit Animaxia', click: onQuit });

  tray.setContextMenu(Menu.buildFromTemplate(template));
  tray.on('click', onShow);

  app.on('before-quit', () => {
    try {
      if (tray) tray.destroy();
    } catch {
      /* ignore */
    }
    tray = null;
  });

  return tray;
}

module.exports = { initTray };
