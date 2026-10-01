/**
 * player/tracking.ts — Progress persistence for the Player screen.
 *
 * createProgressReporter(contentId) returns a tiny sink fed by VideoPlayer's
 * `onPosition` callback:
 *
 *   • tick(position, duration)  — throttled internally to ~15s; each due tick
 *     fires BOTH the server save (POST /api/users/me/history with a 0–100
 *     percentage — the rolling watch-history window) and the local Electron
 *     playback store (window.animaxia.playback.save → cross-window resume
 *     positions that survive restarts).
 *   • flush(position, duration) — unthrottled final save (on ended / unmount).
 *
 * Everything is fire-and-forget: progress persistence must never throw into
 * playback, and a missing bridge (plain-browser dev) is silently ignored.
 */

import { saveProgress } from '../api/users';

const DEFAULT_THROTTLE_MS = 15_000;

export interface ProgressReporter {
  /** Feed the live position; network/local writes are throttled inside. */
  tick: (position: number, duration: number) => void;
  /** Force a save now (end of playback, leaving the screen). */
  flush: (position: number, duration: number) => void;
}

export function createProgressReporter(contentId: number, throttleMs = DEFAULT_THROTTLE_MS): ProgressReporter {
  let lastTickAt = 0;
  let saveInFlight = false;

  const push = (position: number, duration: number): void => {
    if (!Number.isFinite(position) || position <= 0) return;
    const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
    const percent =
      safeDuration > 0 ? Math.max(0, Math.min(100, Math.round((position / safeDuration) * 100))) : 0;

    if (!saveInFlight) {
      saveInFlight = true;
      saveProgress(contentId, percent)
        .catch(() => undefined)
        .finally(() => {
          saveInFlight = false;
        });
    }

    try {
      window.animaxia?.playback.save({
        contentId,
        position: Math.floor(position),
        duration: Math.floor(safeDuration),
      });
    } catch {
      /* best-effort — never break playback over bookkeeping */
    }
  };

  return {
    tick(position, duration) {
      const now = Date.now();
      if (now - lastTickAt < throttleMs) return;
      lastTickAt = now;
      push(position, duration);
    },
    flush(position, duration) {
      lastTickAt = Date.now();
      push(position, duration);
    },
  };
}

export default createProgressReporter;
