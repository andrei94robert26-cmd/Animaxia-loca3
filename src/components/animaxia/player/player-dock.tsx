'use client';

/**
 * player-dock.tsx — FAZA 19 (task 19-3a): the global persistent mini-player.
 *
 * `PlayerDockProvider` keeps an in-memory dock state alive across hash-route
 * navigations (no persistence across reloads — by design). When the user
 * minimizes an mp4/HLS playback from the player view, the SAME source keeps
 * playing in a fixed bottom-right dock built on the existing `<VideoStage>`
 * (custom controls included), starting from the position at minimize time.
 *
 *   • «Extinde» — saves the dock's current position via
 *     POST /api/playerhub/progress (the real watchhistory) and navigates back
 *     to /player/:id, where the normal resume flow takes over;
 *   • «Închide» — saves the position and drops the dock;
 *   • the dock is HIDDEN while the user is on the player page of the very
 *     same content id (the main stage already plays it — redundant);
 *   • progress keeps saving every ~10s of dock playback (same throttle as the
 *     main player) for signed-in users with saveProgress enabled.
 *
 * Only mp4/m3u8 sources can be docked — embeds (YouTube/Vimeo/Rumble/iframe)
 * cannot be kept alive across pages, so `minimizeToDock` is simply never
 * offered for them in the player view.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Maximize2, X } from 'lucide-react';
import { api } from '@/lib/animaxia/api';
import { navigate, useRoute } from '@/lib/animaxia/router';
import { usePlayerSettings } from '@/lib/animaxia/player-settings';
import { useAuth } from '@/components/animaxia/auth-provider';
import { VideoStage, type VideoStageHandle } from '@/components/animaxia/player/player-controls';

/* --------------------------------- state ---------------------------------- */

/** Dockable source — mirrors PlayerSource but loosened for the context API. */
export interface DockSource {
  type: string;
  url: string;
  label?: string;
}

/** The dock payload — `startedAt` is the playback position (seconds) at the
 *  moment the main stage was minimized. */
export interface DockState {
  contentId: number | null;
  title: string | null;
  thumbnail: string | null;
  source: DockSource | null;
  startedAt: number;
  open: boolean;
}

interface PlayerDockContextValue {
  /** The active dock payload, or null when nothing is docked. */
  docked: DockState | null;
  /** Park the current playback in the dock (called by the player view). */
  minimizeToDock: (state: DockState) => void;
  /** Drop the dock state — used by «Extinde» after the position was saved. */
  restore: () => void;
  /** Drop the dock state without navigating («Închide»). */
  close: () => void;
}

const PlayerDockContext = createContext<PlayerDockContextValue | null>(null);

export function usePlayerDock(): PlayerDockContextValue {
  const ctx = useContext(PlayerDockContext);
  if (!ctx) throw new Error('usePlayerDock trebuie folosit în <PlayerDockProvider>');
  return ctx;
}

export function PlayerDockProvider({ children }: { children: ReactNode }) {
  const [docked, setDocked] = useState<DockState | null>(null);

  const minimizeToDock = useCallback((state: DockState) => {
    setDocked({ ...state, open: true });
  }, []);
  const restore = useCallback(() => setDocked(null), []);
  const close = useCallback(() => setDocked(null), []);

  const value = useMemo(
    () => ({ docked, minimizeToDock, restore, close }),
    [docked, minimizeToDock, restore, close],
  );

  return <PlayerDockContext.Provider value={value}>{children}</PlayerDockContext.Provider>;
}

/* ------------------------------- the dock UI ------------------------------- */

export function PlayerDock() {
  const { docked, restore, close } = usePlayerDock();
  const route = useRoute();
  const { user } = useAuth();
  const { settings } = usePlayerSettings();
  const stageRef = useRef<VideoStageHandle>(null);
  const lastSavedRef = useRef(-1);

  const contentId = docked?.contentId ?? null;
  const sourceUrl = docked?.source?.url ?? null;
  const progressEnabled = settings.saveProgress && user != null && contentId != null;

  /* Every docked title/source restarts the throttle bookkeeping. */
  useEffect(() => {
    lastSavedRef.current = -1;
  }, [contentId, sourceUrl]);

  /** Throttled progress ping (≥10s of new playback) — fire-and-forget POST
   *  /api/playerhub/progress, the SAME watchhistory the profile page reads. */
  const handleTimeUpdate = useCallback(
    (t: number, duration: number) => {
      if (!progressEnabled || contentId == null) return;
      const sec = Math.floor(t);
      if (sec < 5 || sec - lastSavedRef.current < 10) return;
      lastSavedRef.current = sec;
      api
        .playerHubSaveProgress(contentId, sec, duration > 0 ? Math.floor(duration) : undefined)
        .catch(() => {});
    },
    [progressEnabled, contentId],
  );

  /** «Extinde» — save the dock's live position, drop the dock, navigate back
   *  to the full player; it resumes from the saved progress as usual. */
  const handleExpand = () => {
    if (!docked) return;
    const t = stageRef.current?.getCurrentTime() ?? docked.startedAt;
    const cid = docked.contentId;
    if (cid != null && t >= 1) {
      api.playerHubSaveProgress(cid, Math.floor(t)).catch(() => {});
    }
    restore();
    navigate(cid != null ? `/player/${cid}` : '/home');
  };

  /** «Închide» — save the final position (so the title can be resumed later)
   *  and drop the dock. */
  const handleClose = () => {
    if (docked?.contentId != null) {
      const t = stageRef.current?.getCurrentTime() ?? 0;
      if (t >= 5) {
        api.playerHubSaveProgress(docked.contentId, Math.floor(t)).catch(() => {});
      }
    }
    close();
  };

  if (!docked || !docked.open || !docked.source) return null;
  const { source } = docked;
  /* Only direct media can be docked — embeds cannot survive cross-page. */
  if (source.type !== 'mp4' && source.type !== 'm3u8') return null;
  /* Redundant while the main stage of the SAME title is on screen. */
  if (
    route?.view === 'player' &&
    docked.contentId != null &&
    Number(route.params[0]) === docked.contentId
  ) {
    return null;
  }

  return (
    <aside
      aria-label="Mini-player Animaxia"
      className="fixed bottom-4 right-4 z-50 w-80 sm:w-96"
    >
      <div className="overflow-hidden rounded-2xl border border-white/15 bg-zinc-950/95 shadow-2xl shadow-black/70 ring-1 ring-black/40 backdrop-blur">
        <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
          <span
            className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-rose-500"
            aria-hidden
          />
          <p
            className="min-w-0 flex-1 truncate text-xs font-bold text-white"
            title={docked.title ?? undefined}
          >
            {docked.title ?? 'Redare în curs'}
          </p>
          <button
            type="button"
            onClick={handleExpand}
            title="Extinde — revino la playerul complet"
            aria-label="Extinde playerul"
            className="grid h-8 w-8 place-items-center rounded-lg text-zinc-300 transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/70"
          >
            <Maximize2 className="h-4 w-4" aria-hidden />
          </button>
          <button
            type="button"
            onClick={handleClose}
            title="Închide mini-playerul"
            aria-label="Închide mini-playerul"
            className="grid h-8 w-8 place-items-center rounded-lg text-zinc-300 transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/70"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        {/* The SAME <VideoStage> as the main surface — custom controls,
            subtitles and quality included, resuming from startedAt. */}
        <VideoStage
          key={`dock-${String(docked.contentId)}-${source.url}`}
          ref={stageRef}
          src={source.url}
          type={source.type === 'm3u8' ? 'm3u8' : 'mp4'}
          contentId={docked.contentId}
          autoPlay
          initialTime={docked.startedAt > 1 ? docked.startedAt : undefined}
          onTimeUpdate={handleTimeUpdate}
        />
      </div>
    </aside>
  );
}
