'use client';

/**
 * player-view.tsx — Stream player for library titles. Renders mp4 <video>,
 * HLS (m3u8) via dynamic hls.js import, YouTube embeds and sandboxed iframes,
 * with a source switcher, playback-policy line and an inline stream miner
 * for titles without sources — plus the Phase-4 personal "AI companion" card
 * for signed-in users (before-you-watch, predicted rating, more like this,
 * next up).
 *
 * FAZA 17 — hardening: a real fallback chain over `sources`. mp4/HLS errors
 * and a 12s load watchdog advance `sourceIndex` to the next source (with a
 * toast per hop); when every source has failed, a friendly end-of-chain card
 * replaces the player instead of crashing. hls.js instances are destroyed,
 * the <video> decoder/buffer is released on every source change/unmount and
 * all timers are cleared.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  Captions,
  ExternalLink,
  Film,
  Loader2,
  Maximize,
  MonitorPlay,
  Pause,
  Pickaxe,
  Play,
  RefreshCw,
  RotateCcw,
  RotateCw,
  SkipForward,
  Sparkles,
  Star,
  Volume1,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, apiUrl } from '@/lib/animaxia/api';
import { platform, type AiPersonalPlayerResponse } from '@/lib/animaxia/platform';
import { useApi } from '@/lib/animaxia/hooks';
import { navigate, type AppRoute } from '@/lib/animaxia/router';
import type { PlayerResponse, PlayerSource } from '@/lib/animaxia/types';
import { useAuth } from '@/components/animaxia/auth-provider';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { Container } from '../section';
import { BrandPlaceholder, EmptyState, ErrorState, TypeBadge } from '../states';

function isNotFound(message?: string | null): boolean {
  return Boolean(message && message.toLowerCase().includes('not found'));
}

/** FAZA 21 — mm:ss clock for the resume toast. */
function formatClock(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** TS2a — m:ss / h:mm:ss clock for the custom control bar. */
function formatTime(sec: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(sec) ? sec : 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
    : `${m}:${String(ss).padStart(2, '0')}`;
}

/** TS2a — playback rates offered by the custom control bar. */
const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

/** TS2a — custom control bar rendered under the native video surface
 *  (mp4/HLS renderers only; YouTube/iframe embeds keep their own controls).
 *  Purely presentational: all state lives in PlayerView and arrives via props.
 *  The native `controls` attribute stays on the <video> — this bar is a
 *  supplementary control surface, not a replacement. */
function PlayerControlBar({
  playing,
  currentTime,
  duration,
  progressValue,
  progressDragging,
  volume,
  muted,
  rate,
  subsCount,
  subsOn,
  firstSubtitleLabel,
  onTogglePlay,
  onSeekBy,
  onSeekPercent,
  onProgressRelease,
  onVolume,
  onToggleMute,
  onRate,
  onToggleSubs,
  onSkipIntro,
  onFullscreen,
}: {
  playing: boolean;
  currentTime: number;
  duration: number;
  progressValue: number;
  progressDragging: boolean;
  volume: number;
  muted: boolean;
  rate: number;
  subsCount: number;
  subsOn: boolean;
  firstSubtitleLabel?: string;
  onTogglePlay: () => void;
  onSeekBy: (delta: number) => void;
  onSeekPercent: (v: number) => void;
  onProgressRelease: () => void;
  onVolume: (v: number) => void;
  onToggleMute: () => void;
  onRate: (r: number) => void;
  onToggleSubs: () => void;
  onSkipIntro: () => void;
  onFullscreen: () => void;
}) {
  const ctrlBtn =
    'grid h-9 w-9 place-items-center rounded-lg text-zinc-300 transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60';
  const silent = muted || volume === 0;
  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] p-2.5"
      role="group"
      aria-label="Bară de controale player"
    >
      <button type="button" onClick={onTogglePlay} aria-label={playing ? 'Pauză' : 'Redă'} title={playing ? 'Pauză (Space / K)' : 'Redă (Space / K)'} className={ctrlBtn}>
        {playing ? <Pause className="h-5 w-5" aria-hidden /> : <Play className="h-5 w-5 fill-current" aria-hidden />}
      </button>
      <button type="button" onClick={() => onSeekBy(-10)} aria-label="Înapoi 10 secunde" title="Înapoi 10 secunde (← / J)" className={ctrlBtn}>
        <RotateCcw className="h-4.5 w-4.5" aria-hidden />
      </button>
      <button type="button" onClick={() => onSeekBy(10)} aria-label="Înainte 10 secunde" title="Înainte 10 secunde (→ / L)" className={ctrlBtn}>
        <RotateCw className="h-4.5 w-4.5" aria-hidden />
      </button>

      {/* Progress — synced by timeupdate except while dragging. */}
      <input
        type="range"
        min={0}
        max={100}
        step={0.1}
        value={progressValue}
        onChange={(e) => onSeekPercent(Number(e.target.value))}
        onPointerUp={onProgressRelease}
        onPointerCancel={onProgressRelease}
        onKeyUp={onProgressRelease}
        onBlur={onProgressRelease}
        aria-label="Bară de progres"
        aria-valuetext={`${formatTime(currentTime)} din ${formatTime(duration)}`}
        className="h-1.5 min-w-[140px] flex-1 cursor-pointer accent-rose-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60"
      />
      <span className="whitespace-nowrap tabular-nums text-xs font-medium text-zinc-400">
        {formatTime(currentTime)} / {formatTime(duration)}
      </span>

      {/* Skip intro — only visible during the first two minutes. */}
      {currentTime < 120 && (
        <button
          type="button"
          onClick={onSkipIntro}
          title="Sare 85 de secunde înainte"
          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-fuchsia-500/30 bg-fuchsia-500/10 px-3 text-xs font-semibold text-fuchsia-200 transition hover:bg-fuchsia-500/20 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60"
        >
          <SkipForward className="h-4 w-4" aria-hidden />
          Sari intro-ul +85s
        </button>
      )}

      {/* Volume */}
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={onToggleMute}
          aria-label={silent ? 'Activează sunetul' : 'Dezactivează sunetul (M)'}
          title={silent ? 'Activează sunetul' : 'Dezactivează sunetul (M)'}
          className={ctrlBtn}
        >
          {silent ? <VolumeX className="h-4.5 w-4.5" aria-hidden /> : volume < 50 ? <Volume1 className="h-4.5 w-4.5" aria-hidden /> : <Volume2 className="h-4.5 w-4.5" aria-hidden />}
        </button>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={volume}
          onChange={(e) => onVolume(Number(e.target.value))}
          aria-label="Volum"
          className="h-1.5 w-16 cursor-pointer accent-rose-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60 sm:w-20"
        />
      </div>

      {/* Playback speed */}
      <label className="flex items-center gap-1.5">
        <span className="sr-only">Viteză de redare</span>
        <select
          value={rate}
          onChange={(e) => onRate(Number(e.target.value))}
          aria-label="Viteză de redare"
          className="h-9 cursor-pointer rounded-lg border border-white/10 bg-black/40 px-2 text-xs font-semibold text-zinc-300 transition hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60"
        >
          {PLAYBACK_RATES.map((r) => (
            <option key={r} value={r}>
              {r === 1 ? '1× (normal)' : `${r}×`}
            </option>
          ))}
        </select>
      </label>

      {/* FAZA 21 CC toggle (moved into the bar — same toggleSubs logic). */}
      <button
        type="button"
        onClick={onToggleSubs}
        disabled={subsCount === 0}
        aria-pressed={subsOn}
        title={
          subsCount === 0
            ? 'Fără subtitrări încărcate'
            : subsOn
              ? `Subtitrări: ${firstSubtitleLabel ?? ''} — apasă pentru a opri`
              : `Activează subtitrările${subsCount > 0 ? ` (${subsCount})` : ''}`
        }
        aria-label="Comută subtitrările"
        className={cn(
          'inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60',
          subsCount === 0
            ? 'cursor-not-allowed text-zinc-600'
            : subsOn
              ? 'bg-teal-500/20 text-teal-200 hover:bg-teal-500/30'
              : 'text-zinc-300 hover:bg-white/10 hover:text-white',
        )}
      >
        <Captions className="h-4.5 w-4.5" aria-hidden />
        CC{subsCount > 0 ? ` · ${subsCount}` : ''}
      </button>

      <button
        type="button"
        onClick={onFullscreen}
        aria-label="Ecran complet"
        title="Ecran complet (F)"
        className={ctrlBtn}
      >
        <Maximize className="h-4.5 w-4.5" aria-hidden />
      </button>

      {progressDragging && <span className="sr-only" aria-live="polite">Se caută în clip</span>}
    </div>
  );
}

function PlayerModeBadge({ mode }: { mode: PlayerResponse['mode'] }) {
  if (mode === 'direct') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-[11px] font-semibold text-emerald-300">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden />
        Stream direct
      </span>
    );
  }
  if (mode === 'trailer') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-[11px] font-semibold text-amber-300">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-400" aria-hidden />
        Trailer YouTube
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] font-semibold text-zinc-400">
      <span className="h-1.5 w-1.5 rounded-full bg-zinc-500" aria-hidden />
      Fără sursă
    </span>
  );
}

export function PlayerView({ route }: { route: AppRoute }) {
  const { user } = useAuth();
  const id = Number(route.params[0]);
  const validId = Number.isInteger(id) && id > 0;
  const player = useApi(`player-${id}`, () => api.player(id), { enabled: validId });

  /* FAZA 17 — source fallback chain. `sourceIndex` walks data.sources on any
     load failure (mp4/HLS error, 12s load timeout). `failedState` marks the
     friendly end-of-chain card and is scoped to the content id so it can
     never leak across titles. `reloadNonce` forces a fresh <video> mount when
     retrying the same source. */
  const [sourceIndex, setSourceIndex] = useState(0);
  const [failedState, setFailedState] = useState<{ contentId: number; reason: string } | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [mineUrl, setMineUrl] = useState('');
  const [mining, setMining] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const sourcesRef = useRef<PlayerSource[]>([]);
  const sourceIndexRef = useRef(0);
  const loadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastAdvanceRef = useRef<{ key: string; at: number } | null>(null);

  /* Only trust data matching the requested id — useApi keeps the previous
     record alive while the key changes (stale data across titles). */
  const current = player.data && player.data.content.id === id ? player.data : null;
  const sources = current?.sources ?? [];
  const exhausted = failedState != null && failedState.contentId === id && sources.length > 0;
  const activeSource: PlayerSource | null = exhausted
    ? null
    : sources[sourceIndex] ?? current?.primary ?? null;

  /** Clears the 12s load watchdog — any progress event calls this. */
  const clearLoadTimer = useCallback(() => {
    if (loadTimerRef.current) {
      clearTimeout(loadTimerRef.current);
      loadTimerRef.current = null;
    }
  }, []);

  /** Advance to the next source on failure; when none remain, switch to the
      friendly end-of-chain card instead of crashing. Duplicate signals for the
      same attempt (e.g. hls.js error + element error) are coalesced. */
  const advanceSource = useCallback(
    (reason: string) => {
      clearLoadTimer();
      const list = sourcesRef.current;
      const i = sourceIndexRef.current;
      const key = `${id}:${i}:${reason}`;
      const now = Date.now();
      if (lastAdvanceRef.current && lastAdvanceRef.current.key === key && now - lastAdvanceRef.current.at < 1500) {
        return;
      }
      lastAdvanceRef.current = { key, at: now };
      if (i + 1 < list.length) {
        sourceIndexRef.current = i + 1;
        setSourceIndex(i + 1);
        toast.info(`Sursa ${i + 1} nu răspunde (${reason}) — trec la următoarea…`);
      } else {
        setFailedState({ contentId: id, reason });
      }
    },
    [id, clearLoadTimer],
  );

  /** Manual source chip click — clears the chain failure; clicking the chip of
      the current source forces a clean reload of that source. */
  const selectSource = (i: number) => {
    if (i < 0 || i >= sources.length) return;
    setFailedState(null);
    if (i === sourceIndex) {
      setReloadNonce((n) => n + 1);
    } else {
      sourceIndexRef.current = i;
      setSourceIndex(i);
    }
  };

  /** "Reîncearcă de la prima sursă" — reset the chain and remount the video. */
  const retryFromFirst = () => {
    setFailedState(null);
    sourceIndexRef.current = 0;
    setSourceIndex(0);
    setReloadNonce((n) => n + 1);
  };

  /* New title (route change) → reset the fallback chain before the new data
     ever renders, so no stale index/failure can flash. */
  useEffect(() => {
    sourceIndexRef.current = 0;
    setSourceIndex(0);
    setFailedState(null);
  }, [id]);

  /* Fresh sources (first load or refetch after mining) → start at the primary
     source and force a clean reload of the player surface. */
  useEffect(() => {
    const d = player.data;
    if (!d || d.content.id !== id) return;
    sourcesRef.current = d.sources;
    const primary = d.primary;
    const primaryIndex = primary
      ? d.sources.findIndex((s) => s.url === primary.url && s.type === primary.type)
      : -1;
    const start = primaryIndex >= 0 ? primaryIndex : 0;
    sourceIndexRef.current = start;
    setSourceIndex(start);
    setFailedState(null);
    setReloadNonce((n) => n + 1);
  }, [player.data, id]);

  /* ------------------------- analytics tracking ------------------------- */

  const trackedViewRef = useRef<number | null>(null);
  const trackedPlayRef = useRef<number | null>(null);

  /* Fire-and-forget 'view' event, once per content id per mount. */
  useEffect(() => {
    if (!player.data || player.data.content.id !== id) return;
    if (trackedViewRef.current === id) return;
    trackedViewRef.current = id;
    platform.recordView(id, 'view').catch(() => {});
  }, [player.data, id]);

  /* 'play' event for embed renderers (youtube/iframe), once per content id. */
  useEffect(() => {
    if (!player.data || player.data.content.id !== id) return;
    const src = activeSource;
    if (!src || (src.type !== 'youtube' && src.type !== 'iframe')) return;
    if (trackedPlayRef.current === id) return;
    trackedPlayRef.current = id;
    platform.recordView(id, 'play').catch(() => {});
  }, [player.data, activeSource, id]);

  const trackPlay = () => {
    if (trackedPlayRef.current === id) return;
    trackedPlayRef.current = id;
    platform.recordView(id, 'play').catch(() => {});
  };

  const trackComplete = () => {
    platform.recordView(id, 'complete').catch(() => {});
  };

  /* ------------------- FAZA 21: history / resume / subtitles ------------------- */

  /** Resume position from ?t= (seconds) — validated once per route param. */
  const tParam = route.query.get('t');
  const resumeT = (() => {
    const t = Number(tParam);
    return Number.isFinite(t) && t > 0 && t < 86_400 ? Math.floor(t) : 0;
  })();

  /** recordHistory — POST /api/users/me/history {contentId, progress} via the
   *  existing platform client. Fire-and-forget, silent failures: never breaks
   *  playback. Only native renderers expose video.currentTime (YouTube/iframe
   *  embeds are honestly skipped). */
  const recordTick = useCallback(() => {
    if (!user || !validId) return;
    const el = videoRef.current;
    if (!el) return;
    const t = Math.floor(el.currentTime);
    if (!Number.isFinite(t) || t <= 0) return;
    platform.recordHistory(id, t).catch(() => {});
  }, [user, id, validId]);

  /* Progress sync: every 10s while playing + a final flush on pause handled
     by the onPause prop; the cleanup below flushes on unmount AND on source
     change (deps include the active source), recording the last position of
     the outgoing element before the decoder-release effect resets it. */
  useEffect(() => {
    if (!user || !validId) return undefined;
    recordTick(); /* mount-time flush (e.g. after a resume seek) */
    const timer = setInterval(() => {
      const el = videoRef.current;
      if (el && !el.paused && !el.ended) recordTick();
    }, 10_000);
    return () => {
      clearInterval(timer);
      recordTick(); /* best-effort final flush */
    };
  }, [user, validId, id, recordTick, activeSource?.type, activeSource?.url, sourceIndex, reloadNonce]);

  /** Resume seek — applied once per (content id + source + reload nonce) on
   *  the first loadedmetadata of the current <video>. The applied key is
   *  stamped on the DOM element itself (dataset), so a remount that somehow
   *  preserves React state (e.g. dev Fast Refresh) still re-arms the seek,
   *  while the same playing element never seeks twice. */
  const maybeResume = useCallback(() => {
    if (resumeT <= 0) return;
    const el = videoRef.current;
    if (!el) return;
    const key = `${id}:${sourceIndex}:${activeSource?.url ?? ''}:${reloadNonce}`;
    if (el.dataset.faza21Resume === key) return;
    try {
      el.currentTime = resumeT;
      el.dataset.faza21Resume = key;
      toast.info(`Reia de la ${formatClock(resumeT)}`);
    } catch {
      /* seek not possible yet — allow a later loadedmetadata to retry */
    }
  }, [resumeT, id, sourceIndex, activeSource?.url, reloadNonce]);

  /** WebVTT subtitles — public listing, fetched once per content id (silent
   *  fail: the player works fine without tracks). */
  const subs = useApi(`player-subs-${id}`, () => api.subtitles.forContent(id), { enabled: validId });
  const subtitleTracks = subs.data && subs.data.contentId === id ? subs.data.data : [];

  /** CC toggle: off → first subtitle track showing → off. Tracks default to
   *  disabled (no `default` attr) so nothing shows until the user opts in. */
  const [subsOn, setSubsOn] = useState(false);
  useEffect(() => {
    setSubsOn(false); /* the element remounts per source — tracks reset too */
  }, [id, sourceIndex, reloadNonce]);
  const toggleSubs = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    const tracks = Array.from(el.textTracks ?? []);
    const anyShowing = tracks.some((t) => t.mode === 'showing');
    tracks.forEach((t) => {
      t.mode = 'disabled';
    });
    if (anyShowing) {
      setSubsOn(false);
      return;
    }
    const first = tracks.find((t) => t.kind === 'subtitles');
    if (first) {
      first.mode = 'showing';
      setSubsOn(true);
    }
  }, []);

  /* --------------------- TS2a: custom control bar --------------------- */

  /* Bar state is mirrored from the live <video> element via DOM listeners
     (fully additive — the protected FAZA 17/21 handler props are untouched).
     The element remounts per source (key includes index/url/nonce), so the
     listener effect re-runs and re-seeds current values on every source. */
  const playerShellRef = useRef<HTMLDivElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [videoTime, setVideoTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const [videoVolume, setVideoVolume] = useState(100);
  const [videoMuted, setVideoMuted] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [progressDrag, setProgressDrag] = useState(false);
  const [dragPercent, setDragPercent] = useState(0);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return undefined;
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onEnded = () => setIsPlaying(false);
    const onTime = () => {
      setVideoTime(el.currentTime);
      if (Number.isFinite(el.duration) && el.duration > 0) setVideoDuration(el.duration);
    };
    const onDuration = () => {
      if (Number.isFinite(el.duration) && el.duration > 0) setVideoDuration(el.duration);
    };
    const onVolume = () => {
      setVideoVolume(Math.round(el.volume * 100));
      setVideoMuted(el.muted);
    };
    const onRate = () => {
      if (Number.isFinite(el.playbackRate) && el.playbackRate > 0) setPlaybackRate(el.playbackRate);
    };
    el.addEventListener('play', onPlay);
    el.addEventListener('pause', onPause);
    el.addEventListener('ended', onEnded);
    el.addEventListener('timeupdate', onTime);
    el.addEventListener('durationchange', onDuration);
    el.addEventListener('loadedmetadata', onDuration);
    el.addEventListener('volumechange', onVolume);
    el.addEventListener('ratechange', onRate);
    onVolume(); /* seed initial values (volume/muted survive remounts) */
    return () => {
      el.removeEventListener('play', onPlay);
      el.removeEventListener('pause', onPause);
      el.removeEventListener('ended', onEnded);
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('durationchange', onDuration);
      el.removeEventListener('loadedmetadata', onDuration);
      el.removeEventListener('volumechange', onVolume);
      el.removeEventListener('ratechange', onRate);
    };
  }, [activeSource?.type, activeSource?.url, sourceIndex, reloadNonce]);

  /* Source change → reset bar state honestly: a fresh element starts at
     1× speed, time 0 (the resume seek re-syncs via timeupdate). */
  useEffect(() => {
    queueMicrotask(() => {
      setPlaybackRate(1);
      setIsPlaying(false);
      setVideoTime(0);
      setVideoDuration(0);
      setProgressDrag(false);
      setDragPercent(0);
    });
    const el = videoRef.current;
    if (el) {
      try {
        el.playbackRate = 1;
      } catch {
        /* element not seekable yet — fresh elements default to 1× anyway */
      }
    }
  }, [id, sourceIndex, reloadNonce, activeSource?.url]);

  const togglePlayPause = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    if (el.paused || el.ended) {
      el.play().catch(() => {
        /* autoplay policy or source error — the fallback chain handles it */
      });
    } else {
      el.pause();
    }
  }, []);

  const seekBy = useCallback((delta: number) => {
    const el = videoRef.current;
    if (!el) return;
    const target = el.currentTime + delta;
    const max = Number.isFinite(el.duration) && el.duration > 0 ? Math.max(0, el.duration - 0.25) : null;
    el.currentTime = max == null ? Math.max(0, target) : Math.max(0, Math.min(target, max));
  }, []);

  const seekPercent = useCallback((v: number) => {
    setDragPercent(v);
    setProgressDrag(true);
    const el = videoRef.current;
    if (!el) return;
    if (Number.isFinite(el.duration) && el.duration > 0) {
      el.currentTime = (v / 100) * el.duration;
    }
  }, []);

  const releaseProgress = useCallback(() => setProgressDrag(false), []);

  const setVolumePercent = useCallback((pct: number) => {
    const el = videoRef.current;
    if (!el) return;
    const clamped = Math.max(0, Math.min(100, pct));
    el.volume = clamped / 100;
    if (clamped > 0 && el.muted) el.muted = false;
  }, []);

  const nudgeVolume = useCallback(
    (delta: number) => {
      const el = videoRef.current;
      const current = el ? Math.round(el.volume * 100) : 100;
      setVolumePercent(current + delta);
    },
    [setVolumePercent],
  );

  const toggleMute = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    el.muted = !el.muted;
  }, []);

  const changeRate = useCallback((rate: number) => {
    setPlaybackRate(rate);
    const el = videoRef.current;
    if (!el) return;
    try {
      el.playbackRate = rate;
    } catch {
      /* rate rejected by the browser — state stays honest via ratechange */
    }
  }, []);

  const skipIntro = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    seekBy(85);
  }, [seekBy]);

  const toggleFullscreen = useCallback(() => {
    const shell = playerShellRef.current;
    if (!shell) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    } else {
      void shell.requestFullscreen().catch(() => {
        /* fullscreen denied — the video element's native control still works */
      });
    }
  }, []);

  /* Keyboard shortcuts on the player shell. Space/K always preventDefault so
     a focused button/video never double-toggles (canceling the default also
     cancels the native <video> space handling and button keyup activation). */
  const handleShellKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName ?? '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) {
        return;
      }
      switch (e.key) {
        case ' ':
        case 'k':
        case 'K':
          e.preventDefault();
          togglePlayPause();
          return;
        case 'ArrowLeft':
        case 'j':
        case 'J':
          e.preventDefault();
          seekBy(-10);
          return;
        case 'ArrowRight':
        case 'l':
        case 'L':
          e.preventDefault();
          seekBy(10);
          return;
        case 'ArrowUp':
          e.preventDefault();
          nudgeVolume(10);
          return;
        case 'ArrowDown':
          e.preventDefault();
          nudgeVolume(-10);
          return;
        case 'f':
        case 'F':
          e.preventDefault();
          toggleFullscreen();
          return;
        case 'm':
        case 'M':
          e.preventDefault();
          toggleMute();
          return;
        default:
          return;
      }
    },
    [togglePlayPause, seekBy, nudgeVolume, toggleFullscreen, toggleMute],
  );

  const progressPercent =
    videoDuration > 0 ? Math.min(100, Math.max(0, (videoTime / videoDuration) * 100)) : 0;
  const isNativeRenderer = activeSource?.type === 'mp4' || activeSource?.type === 'm3u8';

  useEffect(() => {
    const url = activeSource?.url;
    const el = videoRef.current;
    if (activeSource?.type !== 'm3u8' || !url || !el) return;
    let hls: { destroy: () => void } | null = null;
    let cancelled = false;
    (async () => {
      try {
        const mod = await import('hls.js');
        const Hls = mod.default;
        if (cancelled) return;
        if (Hls.isSupported()) {
          const instance = new Hls({ enableWorker: true });
          /* FAZA 17 — fatal HLS errors destroy the instance and advance the
             source chain; non-fatal ones get a light startLoad() retry. */
          instance.on(Hls.Events.ERROR, (_event, data) => {
            if (cancelled) return;
            if (data?.fatal) {
              try {
                instance.destroy();
              } catch {
                /* already destroyed */
              }
              advanceSource('eroare HLS');
            } else {
              try {
                instance.startLoad();
              } catch {
                /* retry not possible — the load watchdog will advance */
              }
            }
          });
          instance.loadSource(url);
          instance.attachMedia(el);
          hls = instance;
        } else if (el.canPlayType('application/vnd.apple.mpegurl')) {
          el.src = url;
        }
      } catch {
        /* hls.js failed to init — hand over to the fallback chain. */
        if (!cancelled) advanceSource('eroare HLS');
      }
    })();
    return () => {
      cancelled = true;
      hls?.destroy();
    };
  }, [activeSource?.type, activeSource?.url, sourceIndex, reloadNonce, advanceSource]);

  /* FAZA 17 — 12s load watchdog: if a video source produces no loadeddata /
     canplay within the window, advance to the next source. */
  useEffect(() => {
    const t = activeSource?.type;
    if (!activeSource?.url || exhausted) return undefined;
    if (t !== 'mp4' && t !== 'm3u8') return undefined;
    clearLoadTimer();
    loadTimerRef.current = setTimeout(() => {
      loadTimerRef.current = null;
      advanceSource('timeout sursă');
    }, 12_000);
    return clearLoadTimer;
  }, [activeSource?.type, activeSource?.url, sourceIndex, reloadNonce, exhausted, advanceSource, clearLoadTimer]);

  /* FAZA 17 — release the decoder/buffer whenever the current video element
     goes away (source change, retry or unmount): pause, drop the src and run
     load() so the browser frees the media pipeline. */
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return undefined;
    return () => {
      clearLoadTimer();
      try {
        el.pause();
        el.removeAttribute('src');
        el.load();
      } catch {
        /* element already detached */
      }
    };
  }, [activeSource?.type, activeSource?.url, sourceIndex, reloadNonce, clearLoadTimer]);

  async function handleMine(e: React.FormEvent) {
    e.preventDefault();
    if (!mineUrl.trim() || !player.data || mining) return;
    setMining(true);
    try {
      await api.miner({
        url: mineUrl.trim(),
        externalId: player.data.content.externalid,
        type: player.data.content.type,
      });
      toast.success('Stream atașat');
      setMineUrl('');
      await player.refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Extragerea a eșuat');
    } finally {
      setMining(false);
    }
  }

  if (!validId) {
    return (
      <Container className="py-20">
        <EmptyState
          title="Titlu negăsit"
          message="URL-ul playerului nu conține un id de titlu valid."
          action={
            <Button className="bg-rose-600 font-bold hover:bg-rose-500" onClick={() => navigate('/home')}>
              Înapoi acasă
            </Button>
          }
        />
      </Container>
    );
  }

  if (player.loading && !current) {
    return (
      <Container className="py-8 sm:py-12">
        <div className="mx-auto w-full max-w-5xl space-y-5">
          <div className="flex items-center justify-between">
            <Skeleton className="h-9 w-36" />
            <Skeleton className="h-7 w-28 rounded-full" />
          </div>
          <Skeleton className="aspect-video w-full rounded-2xl" />
          <Skeleton className="h-24 w-full rounded-xl" />
        </div>
      </Container>
    );
  }

  if (player.error && !current) {
    if (isNotFound(player.error)) {
      return (
        <Container className="py-20">
          <EmptyState
            title="Titlu negăsit"
            message={player.error}
            action={
              <Button className="bg-rose-600 font-bold hover:bg-rose-500" onClick={() => navigate('/home')}>
                Înapoi acasă
              </Button>
            }
          />
        </Container>
      );
    }
    return (
      <Container className="py-20">
        <ErrorState message={player.error} onRetry={player.refetch} />
      </Container>
    );
  }

  const data = current;
  if (!data) return null;

  const content = data.content;
  const md = content.metadata || {};
  const overview =
    [md.overview, md.synopsis, md.description].find((v) => typeof v === 'string' && v.trim() !== '') ||
    'Niciun synopsis disponibil pentru acest titlu.';
  const thumb = content.thumbnail || (typeof md.backdrop === 'string' ? md.backdrop : null);
  const noSource = data.mode === 'none' || !data.primary;

  /* FAZA 17 — "open the stream externally" suggestion: the original page
     URL from metadata when available, else the last source in the chain. */
  const externalHref =
    (typeof md.url === 'string' && /^https?:\/\//.test(md.url) ? md.url : null) ??
    (typeof md.mined?.url === 'string' && /^https?:\/\//.test(md.mined.url) ? md.mined.url : null) ??
    (sources.length > 0 ? sources[sources.length - 1].url : null);

  return (
    <Container className="py-6 sm:py-8">
      <div className="mx-auto w-full max-w-5xl space-y-5">
        {/* Top bar */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button
            variant="outline"
            className="border-white/15 bg-white/5 font-semibold hover:bg-white/10"
            onClick={() => navigate(`/content/${id}`)}
          >
            <ArrowLeft aria-hidden /> Înapoi la detalii
          </Button>
          <PlayerModeBadge mode={data.mode} />
        </div>

        {/* Player surface */}
        {noSource ? (
          <div className="space-y-4">
            <EmptyState
              title="Nicio sursă de stream disponibilă"
              message={
                data.note ||
                'Acest titlu nu are încă surse redabile. Extrage un stream mai jos și va fi atașat instant.'
              }
              icon={<MonitorPlay className="h-6 w-6" aria-hidden />}
            />
            <Card className="border-white/10 bg-white/[0.03]">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Pickaxe className="h-4 w-4 text-rose-400" aria-hidden />
                  Extrage un stream
                </CardTitle>
                <CardDescription>
                  Îndreaptă extractorul către o pagină sau un URL media direct — extrage surse mp4,
                  m3u8, iframe și YouTube și le atașează acestui titlu.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form className="flex flex-col gap-3 sm:flex-row" onSubmit={handleMine}>
                  <div className="flex-1">
                    <label htmlFor="player-mine-url" className="sr-only">
                      URL de stream sau de pagină
                    </label>
                    <Input
                      id="player-mine-url"
                      value={mineUrl}
                      onChange={(e) => setMineUrl(e.target.value)}
                      placeholder="https://example.com/page-or-stream"
                      className="border-white/10 bg-black/40"
                    />
                  </div>
                  <Button
                    type="submit"
                    disabled={mining || !mineUrl.trim()}
                    className="bg-rose-600 font-bold hover:bg-rose-500"
                  >
                    {mining ? <Loader2 className="animate-spin" aria-hidden /> : <Pickaxe aria-hidden />}
                    Extrage și atașează
                  </Button>
                </form>
              </CardContent>
            </Card>
          </div>
        ) : exhausted ? (
          /* FAZA 17 — every source in the chain failed: friendly end-of-chain
              card (never a crash). Retry restarts the chain from source 1. */
          <Card className="border-rose-500/30 bg-rose-500/[0.07]">
            <CardContent className="flex flex-col items-center gap-4 p-8 text-center sm:p-10">
              <span className="grid h-12 w-12 place-items-center rounded-2xl border border-rose-500/30 bg-rose-500/10">
                <MonitorPlay className="h-6 w-6 text-rose-400" aria-hidden />
              </span>
              <div className="space-y-1.5">
                <h3 className="text-lg font-bold text-white">Nu am putut reda nicio sursă pentru acest titlu</h3>
                <p className="mx-auto max-w-md text-sm leading-relaxed text-zinc-400">
                  Am încercat pe rând toate cele {sources.length} surse — ultima a eșuat ("
                  {failedState?.reason}"). Poți porni lanțul de la început sau poți deschide sursa direct în browser.
                </p>
              </div>
              <div className="flex flex-wrap items-center justify-center gap-2.5">
                <Button className="bg-rose-600 font-bold hover:bg-rose-500" onClick={retryFromFirst}>
                  <RefreshCw className="mr-1.5 h-4 w-4" aria-hidden />
                  Reîncearcă de la prima sursă
                </Button>
                {externalHref && (
                  <a
                    href={externalHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-white/15 bg-white/5 px-4 text-sm font-semibold text-zinc-200 transition hover:border-white/30 hover:bg-white/10 hover:text-white"
                  >
                    <ExternalLink className="h-4 w-4" aria-hidden />
                    Deschide sursa externă
                  </a>
                )}
              </div>
            </CardContent>
          </Card>
        ) : (
          /* TS2a — player shell: fullscreen target + keyboard-shortcut scope
              (tabIndex=0; inner surface untouched). */
          <div
            ref={playerShellRef}
            tabIndex={0}
            role="region"
            aria-label={`Player ${content.title} — spațiu de redare cu controale`}
            onKeyDown={handleShellKeyDown}
            className="space-y-2 rounded-2xl focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60"
          >
          <div className="aspect-video w-full overflow-hidden rounded-2xl border border-white/10 bg-black">
            {activeSource?.type === 'mp4' && (
              <video
                key={`mp4-${sourceIndex}-${activeSource.url}-${reloadNonce}`}
                ref={videoRef}
                controls
                autoPlay
                playsInline
                className="h-full w-full"
                src={activeSource.url}
                onPlay={trackPlay}
                onEnded={trackComplete}
                onPause={recordTick}
                onError={() => advanceSource('eroare mp4')}
                onLoadedMetadata={maybeResume}
                onLoadedData={clearLoadTimer}
                onCanPlay={clearLoadTimer}
                onProgress={clearLoadTimer}
              >
                {/* FAZA 21 — WebVTT tracks (default OFF; gateway-prefixed src). */}
                {subtitleTracks.map((sub) => (
                  <track
                    key={sub.id}
                    kind="subtitles"
                    src={apiUrl(sub.src)}
                    srcLang={sub.lang}
                    label={sub.label}
                  />
                ))}
              </video>
            )}
            {activeSource?.type === 'm3u8' && (
              <video
                key={`m3u8-${sourceIndex}-${activeSource.url}-${reloadNonce}`}
                ref={videoRef}
                controls
                autoPlay
                playsInline
                className="h-full w-full"
                onPlay={trackPlay}
                onEnded={trackComplete}
                onPause={recordTick}
                onError={() => advanceSource('eroare HLS')}
                onLoadedMetadata={maybeResume}
                onLoadedData={clearLoadTimer}
                onCanPlay={clearLoadTimer}
                onProgress={clearLoadTimer}
              >
                {/* FAZA 21 — WebVTT tracks (default OFF; gateway-prefixed src). */}
                {subtitleTracks.map((sub) => (
                  <track
                    key={sub.id}
                    kind="subtitles"
                    src={apiUrl(sub.src)}
                    srcLang={sub.lang}
                    label={sub.label}
                  />
                ))}
              </video>
            )}
            {activeSource?.type === 'youtube' && (
              <iframe
                key={activeSource.url}
                src={`${activeSource.url}${activeSource.url.includes('?') ? '&' : '?'}autoplay=1&rel=0`}
                title={content.title}
                className="h-full w-full"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
              />
            )}
            {activeSource?.type === 'iframe' && (
              <iframe
                key={activeSource.url}
                src={activeSource.url}
                title="Player încorporat"
                className="h-full w-full"
                sandbox="allow-scripts; allow-same-origin; allow-presentation; allow-popups; allow-forms"
                allowFullScreen
                referrerPolicy="no-referrer"
              />
            )}
          </div>
          {/* TS2a — custom control bar (native mp4/HLS renderers only; the
              FAZA 21 CC toggle now lives inside the bar). */}
          {isNativeRenderer && (
            <PlayerControlBar
              playing={isPlaying}
              currentTime={videoTime}
              duration={videoDuration}
              progressValue={progressDrag ? dragPercent : progressPercent}
              progressDragging={progressDrag}
              volume={videoVolume}
              muted={videoMuted}
              rate={playbackRate}
              subsCount={subtitleTracks.length}
              subsOn={subsOn}
              firstSubtitleLabel={subtitleTracks[0]?.label}
              onTogglePlay={togglePlayPause}
              onSeekBy={seekBy}
              onSeekPercent={seekPercent}
              onProgressRelease={releaseProgress}
              onVolume={setVolumePercent}
              onToggleMute={toggleMute}
              onRate={changeRate}
              onToggleSubs={toggleSubs}
              onSkipIntro={skipIntro}
              onFullscreen={toggleFullscreen}
            />
          )}
          </div>
        )}

        {/* Source switcher */}
        {data.sources.length > 1 && (
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Surse de stream">
            {data.sources.map((s, i) => {
              const isActive = activeSource?.url === s.url && activeSource?.type === s.type;
              return (
                <button
                  key={`${s.type}-${i}-${s.url}`}
                  type="button"
                  onClick={() => selectSource(i)}
                  aria-pressed={isActive}
                  className={cn(
                    'rounded-full border px-3 py-1.5 text-xs font-semibold transition',
                    isActive
                      ? 'border-rose-500/60 bg-rose-600 text-white shadow-lg shadow-rose-900/30'
                      : 'border-white/10 bg-white/[0.04] text-zinc-300 hover:border-white/25 hover:bg-white/10',
                  )}
                >
                  {s.label || `${s.type} ${i + 1}`}
                </button>
              );
            })}
          </div>
        )}

        {/* Policy line */}
        <p className="flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
          <span>Permise de politică:</span>
          {data.allowedTypes.map((t) => (
            <span
              key={t}
              className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 font-mono text-[10px] text-zinc-400"
            >
              {t}
            </span>
          ))}
        </p>

        {/* Info card */}
        <Card className="border-white/10 bg-white/[0.03] p-4 sm:p-5">
          <div className="flex flex-wrap items-start gap-4">
            {thumb ? (
              <img
                src={thumb}
                alt={`Miniatură ${content.title}`}
                className="h-20 w-14 shrink-0 rounded object-cover"
              />
            ) : (
              <div className="grid h-20 w-14 shrink-0 place-items-center rounded bg-gradient-to-br from-white/10 to-white/[0.03]">
                <Film className="h-5 w-5 text-zinc-500" aria-hidden />
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-bold text-white">{content.title}</h2>
                <TypeBadge type={content.type} />
              </div>
              <p className="mt-1.5 line-clamp-3 text-sm text-zinc-400">{overview}</p>
            </div>
            <Button
              variant="outline"
              className="shrink-0 border-white/15 bg-white/5 font-semibold hover:bg-white/10"
              onClick={() => navigate(`/content/${id}`)}
            >
              Vezi detaliile
            </Button>
          </div>
        </Card>

        {/* Phase-4 AI companion (signed-in users, numeric db ids only) */}
        {user && <PlayerAiCompanion contentId={id} enabled={validId} />}
      </div>
    </Container>
  );
}

/* ---------------------------- AI companion card ---------------------------- */

/** Renders the personal "before you watch" companion below the player. Hidden
 *  entirely on error so it never breaks the player page; silent for signed-out
 *  visitors and external (non-db) items. */
function PlayerAiCompanion({ contentId, enabled }: { contentId: number; enabled: boolean }) {
  const ai = useApi(`player-ai-${contentId}`, () => platform.aiPersonalPlayer(contentId), { enabled });

  if (!enabled) return null;
  if (ai.loading) {
    return (
      <Card className="border-white/10 bg-white/[0.03]" aria-busy="true" aria-label="Se încarcă companionul AI">
        <CardContent className="space-y-3 p-5">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-11/12" />
          <div className="flex gap-2">
            <Skeleton className="h-16 w-11" />
            <Skeleton className="h-16 w-11" />
            <Skeleton className="h-16 w-11" />
          </div>
        </CardContent>
      </Card>
    );
  }
  /* Errors are silently swallowed — the companion is strictly optional. */
  if (ai.error || !ai.data) return null;

  const data: AiPersonalPlayerResponse = ai.data;
  const nextUp = data.nextUp;

  return (
    <Card className="border-fuchsia-500/20 bg-gradient-to-br from-fuchsia-500/[0.06] via-white/[0.03] to-white/[0.02]">
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2.5 text-sm font-bold uppercase tracking-widest text-zinc-400">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-rose-500/30 to-fuchsia-500/30">
            <Sparkles className="h-4 w-4 text-fuchsia-300" aria-hidden />
          </span>
          Companion AI
          {data.predictedRating != null && (
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-0.5 text-[11px] font-bold normal-case tracking-normal text-amber-300">
              <Star className="h-3 w-3 fill-amber-300" aria-hidden /> estimat {data.predictedRating}/10
            </span>
          )}
          {data.matchScore != null && (
            <span className="inline-flex items-center gap-1 rounded-full border border-rose-500/30 bg-rose-500/10 px-2.5 py-0.5 text-[11px] font-bold normal-case tracking-normal text-rose-300">
              {Math.round(data.matchScore * 100)}% potrivire
            </span>
          )}
          {data.degraded && (
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider text-amber-300">
              mod offline
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-widest text-zinc-500">Înainte să vizionezi</p>
          <div className="space-y-1.5">
            {data.beforeYouWatch
              .split('\n')
              .map((l) => l.trim())
              .filter(Boolean)
              .map((line, i) => (
                <p key={i} className="text-sm leading-relaxed text-zinc-300">
                  {line}
                </p>
              ))}
          </div>
        </div>

        {data.moreLikeThis.length > 0 && (
          <div className="space-y-2">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">Semănătoare cu aceasta</p>
            <div className="custom-scrollbar flex gap-2.5 overflow-x-auto pb-1">
              {data.moreLikeThis.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => navigate(`/content/${item.id}`)}
                  aria-label={`Deschide ${item.title}`}
                  className="group flex w-[132px] shrink-0 items-center gap-2.5 rounded-xl border border-white/10 bg-white/[0.03] p-2 text-left transition hover:border-fuchsia-500/40 hover:bg-white/[0.06] focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60"
                >
                  <span className="h-14 w-10 shrink-0 overflow-hidden rounded-md border border-white/10 bg-white/[0.03]">
                    {item.thumbnail ? (
                      <img src={item.thumbnail} alt="" loading="lazy" className="h-full w-full object-cover" />
                    ) : (
                      <BrandPlaceholder title={item.title} />
                    )}
                  </span>
                  <span className="min-w-0">
                    <span className="block line-clamp-2 text-xs font-semibold leading-tight text-zinc-100">
                      {item.title}
                    </span>
                    <TypeBadge type={item.type} className="mt-1" />
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {nextUp && (
          <button
            type="button"
            onClick={() => navigate(`/player/${nextUp.id}`)}
            aria-label={`Redă următorul: ${nextUp.title}`}
            className="flex w-full items-center gap-3 rounded-xl border border-rose-500/25 bg-rose-500/[0.08] p-2.5 text-left transition hover:border-rose-500/50 hover:bg-rose-500/[0.14] focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60"
          >
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-rose-600 text-white">
              <Play className="h-4 w-4 fill-white" aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[10px] font-semibold uppercase tracking-widest text-rose-300">Urmează</span>
              <span className="block truncate text-sm font-semibold text-zinc-100">{nextUp.title}</span>
            </span>
          </button>
        )}
      </CardContent>
    </Card>
  );
}
