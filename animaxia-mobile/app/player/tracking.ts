/**
 * player/tracking.ts — Analytics + progress reporting for playback.
 *
 *   • view events  — POST /api/analytics/views { contentId, event } with
 *                    event ∈ view | play | complete (fire-and-forget, never
 *                    blocks or breaks playback; 120/min per-IP limit)
 *   • progress     — POST /api/users/me/history { contentId, progress } with
 *                    a throttled 0–100 percentage (rolling window server-side)
 *
 * createProgressTracker() returns a sink you feed on every playback status
 * tick; it only fires a network write every `intervalPct` percent (default 5)
 * and always at 100%.
 */

import { trackView, type ViewEvent } from '../api/analytics';
import { saveProgress } from '../api/users';

/** Record a lifecycle view event (view/play/complete). */
export function trackPlayback(contentId: number, event: ViewEvent): void {
  void trackView(contentId, event);
}

export interface ProgressTracker {
  /** Feed the current 0–100 percentage; throttled network writes inside. */
  update: (progressPct: number) => void;
  /** Force a final save (e.g. on unmount / screen blur). */
  flush: () => void;
}

export function createProgressTracker(contentId: number, intervalPct = 5): ProgressTracker {
  let lastSent = -1;
  let lastSeen = 0;
  let sending = false;

  const push = (pct: number) => {
    if (sending) return;
    sending = true;
    saveProgress(contentId, Math.round(pct))
      .catch(() => undefined)
      .finally(() => {
        sending = false;
      });
    lastSent = pct;
  };

  return {
    update(pct) {
      const clamped = Math.max(0, Math.min(100, pct));
      lastSeen = clamped;
      const due = clamped - lastSent >= intervalPct || (clamped >= 100 && lastSent < 100);
      if (due && lastSent < 100) push(clamped);
    },
    flush() {
      if (lastSeen > lastSent && lastSeen > 0) push(lastSeen);
    },
  };
}
