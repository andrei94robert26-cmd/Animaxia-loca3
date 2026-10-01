/**
 * main/ipc/notifications.js — Desktop notifications (Netflix-style parity
 * with the mobile app, minus the push backend: local scheduling).
 *
 * Categories (each individually toggleable, persisted in settings.json):
 *   dailyPicks      09:00 local, once per day  → "Your daily picks are ready"
 *   weeklyRecap     Saturday 18:00, once/week  → "Your weekly recap is here"
 *   premiumRenewal  3 days before plan expiry, once per expiry date
 *   newContent      pushed by the renderer when the Home screen detects new
 *                   titles (compares the BFF payload against the cache)
 *
 * IPC surface:
 *   invoke notifications:get-settings   → { dailyPicks, weeklyRecap, newContent, premiumRenewal }
 *   invoke notifications:save-settings  → persist + reschedule
 *   on     notifications:new-content { title, body, route? }   (setting-gated)
 *   on     notifications:test { title, body, route? }          (always fires)
 *   on     notifications:set-premium { plan, planExpiresAt }   (renderer → renewal context)
 *
 * Clicking a notification focuses the main window and navigates via the
 * deep-link fan-out ('app:navigate').
 */

const { Notification, app, ipcMain } = require('electron');
const settings = require('./settings');

const CHECK_INTERVAL_MS = 60 * 1000;

const DAILY_PICKS_HOUR = 9;    // 09:00 local
const WEEKLY_RECAP_HOUR = 18;  // Saturday 18:00 local
const RENEWAL_LEAD_DAYS = 3;
const RENEWAL_HOUR = 12;       // noon on the reminder day

let navigate = () => {};
let focusMain = () => {};
let timer = null;

/* --------------------------------- helpers ---------------------------------- */

function isoDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** ISO-like week key (year-Www) so the recap fires once per calendar week. */
function isoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7; // Mon=1..Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function show({ title, body, route }) {
  if (!Notification.isSupported()) return;
  try {
    const note = new Notification({ title, body: body || '', silent: false });
    note.on('click', () => {
      if (route) navigate(route);
      focusMain();
    });
    note.show();
  } catch {
    /* notification failures must never break the app */
  }
}

function notificationsEnabled() {
  return settings.get().notifications || {};
}

/* -------------------------------- scheduler --------------------------------- */

function checkSchedules() {
  const now = new Date();
  const enabled = notificationsEnabled();
  const fired = settings.get().fired || {};

  /* daily picks — 09:00, once per date */
  if (enabled.dailyPicks && now.getHours() >= DAILY_PICKS_HOUR) {
    const key = `daily-picks:${isoDate(now)}`;
    if (!fired[key]) {
      settings.patch({ fired: { ...fired, [key]: Date.now() } });
      show({
        title: 'Your daily picks are ready 🎬',
        body: 'Animaxia AI curated a fresh batch just for you.',
        route: '/ai',
      });
    }
  }

  /* weekly recap — Saturday ≥18:00, once per ISO week */
  if (enabled.weeklyRecap && now.getDay() === 6 && now.getHours() >= WEEKLY_RECAP_HOUR) {
    const key = `weekly-recap:${isoWeek(now)}`;
    if (!fired[key]) {
      settings.patch({ fired: { ...fired, [key]: Date.now() } });
      show({
        title: 'Your weekly recap is here ✨',
        body: 'See what you watched and what Animaxia AI lined up next.',
        route: '/ai',
      });
    }
  }

  /* premium renewal — RENEWAL_LEAD_DAYS before expiry at noon, once per expiry */
  const { premium } = settings.get();
  if (enabled.premiumRenewal && premium && premium.planExpiresAt) {
    const expiry = new Date(premium.planExpiresAt);
    if (!Number.isNaN(expiry.getTime())) {
      const remindAt = new Date(expiry);
      remindAt.setDate(remindAt.getDate() - RENEWAL_LEAD_DAYS);
      remindAt.setHours(RENEWAL_HOUR, 0, 0, 0);
      const key = `premium-renewal:${isoDate(expiry)}`;
      const inWindow = now >= remindAt && now <= expiry;
      if (inWindow && now.getHours() >= RENEWAL_HOUR && !fired[key]) {
        settings.patch({ fired: { ...fired, [key]: Date.now() } });
        show({
          title: 'Your Animaxia plan renews soon',
          body: `The ${premium.plan || 'premium'} plan renews on ${isoDate(expiry)}. Manage it any time.`,
          route: '/premium',
        });
      }
    }
  }
}

/* --------------------------------- lifecycle --------------------------------- */

function init({ navigate: navigateFn, focusMain: focusFn }) {
  navigate = navigateFn || navigate;
  focusMain = focusFn || focusMain;

  ipcMain.handle('notifications:get-settings', () => ({ ...notificationsEnabled() }));

  ipcMain.handle('notifications:save-settings', (_event, next) => {
    const clean = {};
    for (const key of ['dailyPicks', 'weeklyRecap', 'newContent', 'premiumRenewal']) {
      if (next && typeof next[key] === 'boolean') clean[key] = next[key];
    }
    const current = notificationsEnabled();
    const merged = { ...current, ...clean };
    settings.patch({ notifications: merged });
    return { ...merged };
  });

  ipcMain.on('notifications:set-premium', (_event, ctx) => {
    if (!ctx || typeof ctx !== 'object') return;
    settings.patch({
      premium: {
        plan: typeof ctx.plan === 'string' ? ctx.plan : null,
        planExpiresAt: typeof ctx.planExpiresAt === 'string' ? ctx.planExpiresAt : null,
      },
    });
  });

  ipcMain.on('notifications:new-content', (_event, note) => {
    if (!note || typeof note !== 'object') return;
    if (!notificationsEnabled().newContent) return;
    show({ title: note.title || 'New on Animaxia', body: note.body || '', route: note.route || '/' });
  });

  ipcMain.on('notifications:test', (_event, note) => {
    show({
      title: (note && note.title) || 'Animaxia notifications',
      body: (note && note.body) || 'Working — this is how they will look.',
      route: (note && note.route) || '/',
    });
  });

  // Prune fired markers older than 60 days so settings.json stays small.
  const cutoff = Date.now() - 60 * 24 * 3600 * 1000;
  const fired = settings.get().fired || {};
  const fresh = {};
  for (const [key, at] of Object.entries(fired)) {
    if (typeof at === 'number' && at >= cutoff) fresh[key] = at;
  }
  if (Object.keys(fresh).length !== Object.keys(fired).length) {
    settings.patch({ fired: fresh });
  }

  if (timer) clearInterval(timer);
  timer = setInterval(checkSchedules, CHECK_INTERVAL_MS);
  // One immediate pass so a app-start after 09:00 still notifies same-day.
  setTimeout(checkSchedules, 5000);

  app.on('before-quit', () => {
    if (timer) clearInterval(timer);
  });
}

module.exports = { init };
