/**
 * main/menu.js — Native application menu.
 *
 * Beyond the standard Edit/View roles, the menu is a first-class navigation
 * surface: Navigate ▸ Home / Feed / AI Hub / Watchlist / Premium / Profile
 * funnel through the same deep-link fan-out as animaxia:// links, and
 * View ▸ Theme cycles system → dark → light (persisted).
 *
 * buildMenu(actions) is called once after the main window exists.
 */

const { app, Menu, shell } = require('electron');

const DOCS_URL = 'https://animaxia.io/docs/desktop';
const ISSUES_URL = 'https://animaxia.io/support';

function nextThemeSetting(current) {
  if (current === 'system') return 'dark';
  if (current === 'dark') return 'light';
  return 'system';
}

function themeLabel(setting) {
  if (setting === 'dark') return 'Theme: Dark (switch to Light)';
  if (setting === 'light') return 'Theme: Light (switch to System)';
  return 'Theme: System (switch to Dark)';
}

function buildMenu(actions) {
  const { navigate, openMiniPlayer, checkUpdates, getThemeSetting, setTheme } = actions;

  const isMac = process.platform === 'darwin';

  const template = [
    // macOS app menu
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { label: 'Check for Updates…', click: checkUpdates },
              { type: 'separator' },
              { label: 'Preferences…', accelerator: 'CmdOrCtrl+,', click: () => navigate('/profile') },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ]
      : []),
    // File
    {
      label: 'File',
      submenu: [
        { label: 'Home', accelerator: 'CmdOrCtrl+1', click: () => navigate('/') },
        { label: 'AI Hub', accelerator: 'CmdOrCtrl+2', click: () => navigate('/ai') },
        { label: 'Feed', accelerator: 'CmdOrCtrl+3', click: () => navigate('/feed') },
        { type: 'separator' },
        { label: 'Mini-player', accelerator: 'CmdOrCtrl+M', click: openMiniPlayer },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    // Edit
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    // View
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        {
          label: themeLabel(getThemeSetting()),
          click: () => setTheme(nextThemeSetting(getThemeSetting())),
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    // Navigate
    {
      label: 'Navigate',
      submenu: [
        { label: 'Home', click: () => navigate('/') },
        { label: 'Feed', click: () => navigate('/feed') },
        { label: 'AI Hub', click: () => navigate('/ai') },
        { label: 'Watchlist', click: () => navigate('/watchlist') },
        { label: 'Premium', click: () => navigate('/premium') },
        { label: 'Profile', click: () => navigate('/profile') },
        { type: 'separator' },
        { label: 'Sign In / Register', click: () => navigate('/auth') },
      ],
    },
    // Window
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, ...(isMac ? [{ type: 'separator' }, { role: 'close' }] : [])],
    },
    // Help
    {
      role: 'help',
      submenu: [
        { label: 'Animaxia Docs', click: () => shell.openExternal(DOCS_URL) },
        { label: 'Report an Issue', click: () => shell.openExternal(ISSUES_URL) },
        { type: 'separator' },
        { label: `Version ${app.getVersion()}`, enabled: false },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
  return menu;
}

module.exports = { buildMenu, nextThemeSetting };
