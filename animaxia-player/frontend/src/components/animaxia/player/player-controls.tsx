'use client';

/**
 * player-controls.tsx — FAZA 19 (task 19-2): the custom video stage.
 *
 * `VideoStage` replaces the native-controls `<video>` of the main player
 * surface for the 'mp4' and 'm3u8' source types (YouTube / Vimeo / Rumble /
 * iframe embeds keep their own controls — untouched). It renders a `<video>`
 * WITHOUT the native `controls` attribute plus a fully custom overlay:
 *
 *   • play/pause (Space / K), custom timeline with buffered ranges, scrub by
 *     click + drag (pointer capture) and a hover time tooltip;
 *   • volume icon + slider (M mute, ↑/↓), speed popover 0.25–2× persisted in
 *     the player settings (localStorage), fullscreen (F), PiP (I), ±10s skips
 *     (←/→, J/L on mobile), cinema mode toggle (C — applied by player-view);
 *   • REAL WebVTT subtitles: tracks come from /api/playerhub/subtitles/:contentId
 *     and are rendered as real `<track kind="subtitles">` elements pointing at
 *     /api/playerhub/subtitles/:contentId/:trackId; the language preference is
 *     persisted;
 *   • quality switching for HLS via hls.js levels (MANIFEST_PARSED /
 *     LEVEL_SWITCHED) — button visible only when hls.js exposes >1 level;
 *   • keyboard-shortcuts popover ("?" key or the keyboard button).
 *
 * FAZA 17 discipline preserved: hls.js errors (fatal/non-fatal) are delegated
 * through `onError` so the existing source fallback chain keeps working
 * exactly as before; the 12s load watchdog keeps working through
 * onLoadedData / onCanPlay / onLoadProgress; hls.destroy() runs on every
 * unmount/source change; the video element is released (pause + remove src +
 * load()) and an active PiP is exited on unmount.
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import type Hls from 'hls.js';
import {
  Captions,
  Check,
  Keyboard,
  Loader2,
  Maximize,
  Minimize,
  MonitorPlay,
  Pause,
  PictureInPicture2,
  Play,
  RectangleHorizontal,
  RotateCcw,
  RotateCw,
  Volume1,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { api, playerHubSubtitleUrl } from '@/lib/animaxia/api';
import { useApi } from '@/lib/animaxia/hooks';
import {
  getPlayerSettings,
  updatePlayerSettings,
  usePlayerSettings,
} from '@/lib/animaxia/player-settings';
import type { PlayerHubSubtitleTrack } from '@/lib/animaxia/types';
import { cn } from '@/lib/utils';

/* --------------------------------- types ---------------------------------- */

/** Imperative API for resume / progress saving / mini-player (task 19-3). */
export interface VideoStageHandle {
  getCurrentTime(): number;
  getDuration(): number;
}

export interface VideoStageProps {
  /** Direct media URL (mp4 file or HLS manifest). */
  src: string;
  type: 'mp4' | 'm3u8';
  /** Numeric db content id — powers subtitles + progress. Null disables both. */
  contentId: number | null;
  autoPlay?: boolean;
  /** Resume point (seconds) — seeked once, after loadedmetadata. */
  initialTime?: number;
  onPlay?: () => void;
  /** FAZA 19 (19-3a) — fired on a real pause (NOT at 'ended') so parents can
   *  save the watch progress at the exact stopping point. */
  onPause?: () => void;
  onEnded?: () => void;
  /** Fatal load error — delegated to the FAZA 17 fallback chain. */
  onError?: (reason: string) => void;
  /** Watchdog hooks — called like the native <video> events they replace. */
  onLoadedData?: () => void;
  onCanPlay?: () => void;
  onLoadProgress?: () => void;
  /** Playback heartbeat (t = currentTime, duration) — used for progress saving. */
  onTimeUpdate?: (t: number, duration: number) => void;
  className?: string;
}

/* -------------------------------- helpers --------------------------------- */

const PLAYBACK_SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;
const SKIP_SECONDS = 10;
const UI_HIDE_DELAY_MS = 2_800;

/** mm:ss or h:mm:ss. */
function fmtTime(sec: number): string {
  const n = Number.isFinite(sec) && sec > 0 ? Math.floor(sec) : 0;
  const s = n % 60;
  const m = Math.floor(n / 60) % 60;
  const h = Math.floor(n / 3600);
  const p = (v: number) => String(v).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
}

/* ------------------------------ tiny UI bits ------------------------------ */

function CtrlBtn({
  label,
  onClick,
  active,
  disabled,
  wide,
  children,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={cn(
        'grid h-10 w-10 shrink-0 place-items-center rounded-lg text-zinc-100 transition hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/70 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent',
        wide && 'w-auto gap-1 px-2.5 text-xs font-bold tabular-nums',
        active && 'bg-rose-600 text-white hover:bg-rose-500',
      )}
    >
      {children}
    </button>
  );
}

function MenuRow({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={active}
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs font-semibold transition',
        active ? 'bg-rose-600/20 text-white' : 'text-zinc-300 hover:bg-white/10 hover:text-white',
      )}
    >
      <span className="grid w-3.5 shrink-0 place-items-center">
        {active ? <Check className="h-3.5 w-3.5 text-rose-400" aria-hidden /> : null}
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  );
}

/** Popover panel anchored above its trigger — inline (no portal), so it also
 *  renders inside the fullscreened stage. */
function Popover({
  open,
  title,
  children,
  align = 'left',
  widthClass = 'w-36',
}: {
  open: boolean;
  title: string;
  children: React.ReactNode;
  align?: 'left' | 'right';
  widthClass?: string;
}) {
  if (!open) return null;
  return (
    <div
      role="menu"
      aria-label={title}
      className={cn(
        'absolute bottom-12 z-40 rounded-xl border border-white/10 bg-zinc-950/95 p-1.5 shadow-2xl backdrop-blur',
        widthClass,
        align === 'left' ? 'left-0' : 'right-0',
      )}
    >
      <p className="px-2.5 pb-1 pt-0.5 text-[10px] font-bold uppercase tracking-widest text-zinc-500">
        {title}
      </p>
      {children}
    </div>
  );
}

/** Thin custom volume slider — pointer-driven, commits on release so the
 *  settings store is not hammered 60×/s while dragging. */
function VolumeBar({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const shown = drag ?? value;

  const ratioFrom = useCallback((clientX: number): number => {
    const el = ref.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return clamp01((clientX - rect.left) / rect.width);
  }, []);

  return (
    <div
      ref={ref}
      role="slider"
      aria-label="Volum"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(shown * 100)}
      tabIndex={0}
      className="relative h-9 w-16 cursor-pointer touch-none sm:w-20"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        setDrag(ratioFrom(e.clientX));
      }}
      onPointerMove={(e) => {
        if (drag != null) setDrag(ratioFrom(e.clientX));
      }}
      onPointerUp={(e) => {
        if (drag != null) onChange(drag);
        setDrag(null);
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          /* pointer already released */
        }
      }}
    >
      <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 overflow-hidden rounded-full bg-white/25">
        <div
          className="h-full rounded-full bg-rose-500"
          style={{ width: `${clamp01(shown) * 100}%` }}
        />
      </div>
    </div>
  );
}

/* ------------------------------- VideoStage ------------------------------- */

export const VideoStage = forwardRef<VideoStageHandle, VideoStageProps>(function VideoStage(
  {
    src,
    type,
    contentId,
    autoPlay = true,
    initialTime,
    onPlay,
    onPause,
    onEnded,
    onError,
    onLoadedData,
    onCanPlay,
    onLoadProgress,
    onTimeUpdate,
    className,
  },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<Hls | null>(null);

  /* ---- playback state (mirror of the element — render only) ---- */
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [bufferedRanges, setBufferedRanges] = useState<{ start: number; end: number }[]>([]);
  const [fullscreen, setFullscreen] = useState(false);
  const [pipActive, setPipActive] = useState(false);
  const [pipSupported, setPipSupported] = useState(false);

  /* ---- control surface state ---- */
  const [uiVisible, setUiVisible] = useState(true);
  const [openMenu, setOpenMenu] = useState<'speed' | 'subs' | 'quality' | 'shortcuts' | null>(null);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const [scrubbing, setScrubbing] = useState(false);

  /* ---- persisted settings (volume / speed / cinema / subtitle lang) ---- */
  const { settings } = usePlayerSettings();

  /* ---- HLS quality levels (original hls.js level indices are preserved —
     duplicate heights are collapsed for the menu, but `index` is the raw
     hls.levels index used for switching) ---- */
  const [levels, setLevels] = useState<{ index: number; height: number }[]>([]);
  const [currentLevel, setCurrentLevel] = useState(-1);
  const [pinnedLevel, setPinnedLevel] = useState<number | null>(null);

  /* ---- subtitles (REAL WebVTT from the Player Hub) ---- */
  const subsEnabled = contentId != null && Number.isInteger(contentId) && contentId > 0;
  const subs = useApi(
    `playerhub-subs-${contentId}`,
    () => api.playerHubSubtitles(contentId as number),
    { enabled: subsEnabled },
  );
  const tracks: PlayerHubSubtitleTrack[] = subs.data?.data ?? [];
  const [activeSub, setActiveSub] = useState<number | null>(null);
  const subsInitRef = useRef(false);

  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seekedInitialRef = useRef(false);

  /* ------------------------- imperative handle ------------------------- */

  useImperativeHandle(
    ref,
    () => ({
      getCurrentTime: () => videoRef.current?.currentTime ?? 0,
      getDuration: () => {
        const d = videoRef.current?.duration;
        return Number.isFinite(d) ? (d as number) : 0;
      },
    }),
    [],
  );

  /* ---------------------- persisted settings → video ---------------------- */

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.volume = clamp01(settings.volume);
    el.muted = settings.muted;
  }, [settings.volume, settings.muted]);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    try {
      el.playbackRate = settings.defaultSpeed;
    } catch {
      /* rate rejected (e.g. before metadata) — retried on loadedmetadata */
    }
  }, [settings.defaultSpeed]);

  /* ------------------------ subtitles: selection ------------------------- */

  /* Pick the initial track from the persisted language preference, once per
     track list (the stage remounts per source/content, so no reset needed). */
  useEffect(() => {
    if (subsInitRef.current || tracks.length === 0) return;
    subsInitRef.current = true;
    const pref = getPlayerSettings().preferredSubtitleLang;
    if (!pref) return;
    const wanted = pref.toLowerCase();
    let idx = tracks.findIndex((t) => t.lang.toLowerCase() === wanted);
    if (idx < 0) {
      idx = tracks.findIndex(
        (t) => t.lang.toLowerCase().split('-')[0] === wanted.split('-')[0],
      );
    }
    if (idx >= 0) setActiveSub(idx);
  }, [tracks]);

  /* Apply the selection to the real <track> elements. Native HLS text
     tracks (embedded captions exposed by hls.js) sit in the SAME textTracks
     list as the hub <track> elements, so the hub selection is matched BY ID
     (data-hub-id) — never by index. */
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    for (let i = 0; i < el.textTracks.length; i += 1) {
      el.textTracks[i].mode = 'disabled';
    }
    if (activeSub == null) return;
    const wanted = tracks[activeSub];
    if (!wanted) return;
    const trackEl = el.querySelector<HTMLTrackElement>(`track[data-hub-id="${wanted.id}"]`);
    try {
      if (trackEl?.track) trackEl.track.mode = 'showing';
    } catch {
      /* track not ready yet — retried on the next tracks.length change */
    }
  }, [activeSub, tracks.length, tracks]);

  /* Select a track (or «Oprit») — persists the language preference. */
  const chooseSubtitle = useCallback(
    (idx: number | null) => {
      setActiveSub(idx);
      const lang = idx != null ? (tracks[idx]?.lang ?? null) : null;
      updatePlayerSettings({ preferredSubtitleLang: lang });
    },
    [tracks],
  );

  /* ------------------------- media source loading ------------------------- */

  /* HLS via hls.js (dynamic import, same pattern as FAZA 17) — mp4 plays
     straight from the `src` attribute. Fatal errors destroy the instance and
     delegate to onError so the FAZA 17 source chain advances exactly as
     before; non-fatal errors get a light startLoad() retry. */
  useEffect(() => {
    if (type !== 'm3u8') return undefined;
    const el = videoRef.current;
    if (!el) return undefined;
    let cancelled = false;
    let instance: Hls | null = null;
    (async () => {
      try {
        const mod = await import('hls.js');
        const HlsCtor = mod.default;
        if (cancelled) return;
        if (HlsCtor.isSupported()) {
          const hls = new HlsCtor({ enableWorker: true });
          hls.on(HlsCtor.Events.ERROR, (_event, data) => {
            if (cancelled) return;
            if (data?.fatal) {
              try {
                hls.destroy();
              } catch {
                /* already destroyed */
              }
              onError?.('eroare HLS');
            } else {
              try {
                hls.startLoad();
              } catch {
                /* retry not possible — the load watchdog (player-view) advances */
              }
            }
          });
          /* FAZA 19 — quality levels for the custom quality popover. */
          hls.on(HlsCtor.Events.MANIFEST_PARSED, (_event, data) => {
            if (cancelled) return;
            const seen = new Set<number>();
            const list: { index: number; height: number }[] = [];
            data.levels.forEach((level, i) => {
              const height = Number(level?.height) || 0;
              if (height <= 0 || seen.has(height)) return;
              seen.add(height);
              list.push({ index: i, height });
            });
            list.sort((a, b) => b.height - a.height);
            setLevels(list);
          });
          hls.on(HlsCtor.Events.LEVEL_SWITCHED, (_event, data) => {
            if (cancelled) return;
            setCurrentLevel(Number(data?.level));
          });
          hls.loadSource(src);
          hls.attachMedia(el);
          instance = hls;
          hlsRef.current = hls;
        } else if (el.canPlayType('application/vnd.apple.mpegurl')) {
          el.src = src;
        } else {
          onError?.('eroare HLS');
        }
      } catch {
        if (!cancelled) onError?.('eroare HLS');
      }
    })();
    return () => {
      cancelled = true;
      hlsRef.current = null;
      try {
        instance?.destroy();
      } catch {
        /* already destroyed */
      }
    };
  }, [src, type]);

  /* ----------------------------- ui visibility ---------------------------- */

  const pokeUi = useCallback(() => {
    setUiVisible(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => {
      hideTimerRef.current = null;
      const el = videoRef.current;
      if (el && !el.paused) setUiVisible(false);
    }, UI_HIDE_DELAY_MS);
  }, []);

  const updateBuffered = useCallback(() => {
    const el = videoRef.current;
    if (!el || el.buffered.length === 0) {
      setBufferedRanges((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    const out: { start: number; end: number }[] = [];
    for (let i = 0; i < el.buffered.length; i += 1) {
      out.push({ start: el.buffered.start(i), end: el.buffered.end(i) });
    }
    setBufferedRanges(out);
  }, []);

  /* ------------------------------ playback ops ---------------------------- */

  const togglePlay = useCallback(() => {
    const el = videoRef.current;
    if (!el || failed) return;
    if (el.paused) {
      void el.play().catch(() => {
        /* autoplay rejected — the user can click play again */
      });
    } else {
      el.pause();
    }
  }, [failed]);

  const skip = useCallback((delta: number) => {
    const el = videoRef.current;
    if (!el || !Number.isFinite(el.duration)) return;
    el.currentTime = Math.min(el.duration, Math.max(0, el.currentTime + delta));
    setCurrentTime(el.currentTime);
    pokeUi();
  }, [pokeUi]);

  const setVolume = useCallback((v: number) => {
    const vol = clamp01(v);
    updatePlayerSettings({ volume: vol, muted: vol > 0 ? false : getPlayerSettings().muted });
  }, []);

  const nudgeVolume = useCallback((delta: number) => {
    setVolume(getPlayerSettings().volume + delta);
  }, [setVolume]);

  const toggleMute = useCallback(() => {
    updatePlayerSettings({ muted: !getPlayerSettings().muted });
  }, []);

  const toggleCinema = useCallback(() => {
    updatePlayerSettings({ cinemaMode: !getPlayerSettings().cinemaMode });
  }, []);

  const toggleFullscreen = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    } else {
      void el.requestFullscreen?.().catch(() => {});
    }
  }, []);

  const togglePip = useCallback(async () => {
    const el = videoRef.current;
    if (!el || !document.pictureInPictureEnabled) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else {
        await el.requestPictureInPicture();
      }
    } catch {
      /* PiP rejected — ignore */
    }
  }, []);

  const toggleSubtitles = useCallback(() => {
    const el = videoRef.current;
    if (!el || tracks.length === 0) return;
    /* A hub track counts as active only when ITS <track> element (matched by
       id) is showing — native HLS caption tracks never satisfy the toggle. */
    const hubShowing = tracks.some((t) => {
      const trackEl = el.querySelector<HTMLTrackElement>(`track[data-hub-id="${t.id}"]`);
      return trackEl?.track?.mode === 'showing';
    });
    if (hubShowing) {
      chooseSubtitle(null);
      return;
    }
    const pref = getPlayerSettings().preferredSubtitleLang;
    let idx = 0;
    if (pref) {
      const wanted = pref.toLowerCase();
      const match = tracks.findIndex(
        (t) => t.lang.toLowerCase() === wanted || t.lang.toLowerCase().split('-')[0] === wanted.split('-')[0],
      );
      if (match >= 0) idx = match;
    }
    chooseSubtitle(idx);
  }, [chooseSubtitle, tracks]);

  const setSpeed = useCallback((speed: number) => {
    updatePlayerSettings({ defaultSpeed: speed });
  }, []);

  const setQuality = useCallback((idx: number | null) => {
    setPinnedLevel(idx);
    const hls = hlsRef.current;
    if (!hls) return;
    try {
      hls.currentLevel = idx == null ? -1 : idx;
    } catch {
      /* level switch rejected — stays on the current level */
    }
  }, []);

  /* Resume: seek once to initialTime — runs when both the resume point and
     the metadata (duration) are available, whichever arrives first. */
  useEffect(() => {
    if (seekedInitialRef.current) return;
    if (initialTime == null || initialTime <= 0) return;
    const el = videoRef.current;
    if (!el || !Number.isFinite(el.duration) || el.duration <= 0) return;
    seekedInitialRef.current = true;
    const t = Math.min(initialTime, Math.max(0, el.duration - 5));
    try {
      el.currentTime = t;
      setCurrentTime(t);
    } catch {
      /* seek rejected — playback starts from 0 */
    }
  }, [initialTime, duration]);

  /* ------------------------------ click layer ----------------------------- */

  const onStageClick = useCallback(() => {
    if (openMenu) {
      setOpenMenu(null);
      return;
    }
    if (clickTimerRef.current) return; // part of an upcoming double click
    clickTimerRef.current = setTimeout(() => {
      clickTimerRef.current = null;
      togglePlay();
    }, 220);
  }, [openMenu, togglePlay]);

  const onStageDoubleClick = useCallback(() => {
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    toggleFullscreen();
  }, [toggleFullscreen]);

  /* -------------------------------- timeline ------------------------------ */

  const ratioFromClientX = useCallback((clientX: number): number => {
    const el = barRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return clamp01((clientX - rect.left) / rect.width);
  }, []);

  const seekToRatio = useCallback((ratio: number) => {
    const el = videoRef.current;
    if (!el || !Number.isFinite(el.duration) || el.duration <= 0) return;
    el.currentTime = ratio * el.duration;
    setCurrentTime(el.currentTime);
    onTimeUpdate?.(el.currentTime, el.duration);
  }, [onTimeUpdate]);

  /* --------------------------- keyboard shortcuts -------------------------- */

  /* Bound once; the handler closure is refreshed after every render so it
     always sees the latest state without rebinding the listener. */
  const keyHandlerRef = useRef<(e: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    keyHandlerRef.current = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      switch (e.key) {
        case ' ':
        case 'k':
        case 'K':
          e.preventDefault();
          pokeUi();
          togglePlay();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          skip(-SKIP_SECONDS);
          break;
        case 'ArrowRight':
          e.preventDefault();
          skip(SKIP_SECONDS);
          break;
        case 'j':
        case 'J':
          skip(-SKIP_SECONDS);
          break;
        case 'l':
        case 'L':
          skip(SKIP_SECONDS);
          break;
        case 'ArrowUp':
          e.preventDefault();
          nudgeVolume(0.05);
          pokeUi();
          break;
        case 'ArrowDown':
          e.preventDefault();
          nudgeVolume(-0.05);
          pokeUi();
          break;
        case 'm':
        case 'M':
          pokeUi();
          toggleMute();
          break;
        case 'f':
        case 'F':
          toggleFullscreen();
          break;
        case 'c':
        case 'C':
          toggleCinema();
          break;
        case 's':
        case 'S':
          pokeUi();
          toggleSubtitles();
          break;
        case 'i':
        case 'I':
          void togglePip();
          break;
        case '?':
          setOpenMenu((v) => (v === 'shortcuts' ? null : 'shortcuts'));
          break;
        case 'Escape':
          setOpenMenu(null);
          break;
        default:
          break;
      }
    };
  });

  useEffect(() => {
    const listener = (e: KeyboardEvent) => keyHandlerRef.current(e);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);

  /* ----------------------- element / document events ----------------------- */

  useEffect(() => {
    const onFsChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  useEffect(() => {
    setPipSupported(
      typeof document !== 'undefined' &&
        document.pictureInPictureEnabled &&
        'requestPictureInPicture' in HTMLVideoElement.prototype,
    );
    const el = videoRef.current;
    if (!el) return undefined;
    const enter = () => setPipActive(true);
    const leave = () => setPipActive(false);
    el.addEventListener('enterpictureinpicture', enter);
    el.addEventListener('leavepictureinpicture', leave);
    return () => {
      el.removeEventListener('enterpictureinpicture', enter);
      el.removeEventListener('leavepictureinpicture', leave);
    };
  }, []);

  /* Total cleanup on unmount (FAZA 17 discipline): timers, PiP, decoder. */
  useEffect(() => {
    const el = videoRef.current;
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
      try {
        if (el) {
          el.pause();
          el.removeAttribute('src');
          el.load();
        }
      } catch {
        /* element already detached */
      }
      if (typeof document !== 'undefined' && document.pictureInPictureElement) {
        void document.exitPictureInPicture().catch(() => {});
      }
    };
  }, []);

  /* --------------------------------- render -------------------------------- */

  const controlsVisible = uiVisible || openMenu != null || !playing || loading;
  const progress = duration > 0 ? clamp01(currentTime / duration) : 0;
  const hasSubs = tracks.length > 0;
  const autoQuality = pinnedLevel == null;
  const currentLevelHeight = levels.find((l) => l.index === currentLevel)?.height ?? 0;
  const pinnedHeight = pinnedLevel != null ? (levels.find((l) => l.index === pinnedLevel)?.height ?? 0) : 0;
  const VolumeIcon = settings.muted || settings.volume === 0 ? VolumeX : settings.volume < 0.5 ? Volume1 : Volume2;

  return (
    <div
      ref={wrapRef}
      className={cn(
        'relative aspect-video w-full select-none overflow-hidden bg-black',
        controlsVisible ? 'cursor-auto' : 'cursor-none',
        className,
      )}
      onMouseMove={pokeUi}
      onMouseLeave={() => {
        const el = videoRef.current;
        if (el && !el.paused) setUiVisible(false);
      }}
      onTouchStart={pokeUi}
    >
      {/* The media element — NO native controls; mp4 declarative src, HLS via hls.js */}
      <video
        ref={videoRef}
        className="absolute inset-0 h-full w-full"
        autoPlay={autoPlay}
        playsInline
        src={type === 'mp4' ? src : undefined}
        onPlay={() => {
          setPlaying(true);
          setLoading(false);
          pokeUi();
          onPlay?.();
        }}
        onPause={() => {
          setPlaying(false);
          setUiVisible(true);
          onPause?.();
        }}
        onEnded={() => {
          setPlaying(false);
          setUiVisible(true);
          onEnded?.();
        }}
        onError={() => {
          setFailed(true);
          setLoading(false);
          onError?.(type === 'mp4' ? 'eroare mp4' : 'eroare HLS');
        }}
        onLoadedMetadata={() => {
          const el = videoRef.current;
          if (!el) return;
          setDuration(Number.isFinite(el.duration) ? el.duration : 0);
          try {
            el.playbackRate = settings.defaultSpeed;
          } catch {
            /* rate not applicable yet */
          }
        }}
        onLoadedData={() => {
          setLoading(false);
          onLoadedData?.();
        }}
        onCanPlay={() => {
          setLoading(false);
          onCanPlay?.();
        }}
        onWaiting={() => setLoading(true)}
        onPlaying={() => setLoading(false)}
        onProgress={() => {
          updateBuffered();
          onLoadProgress?.();
        }}
        onTimeUpdate={() => {
          const el = videoRef.current;
          if (!el) return;
          const d = Number.isFinite(el.duration) ? el.duration : 0;
          setCurrentTime(el.currentTime);
          setDuration(d);
          updateBuffered();
          onTimeUpdate?.(el.currentTime, d);
        }}
      >
        {/* REAL WebVTT subtitle tracks from the Player Hub (task 19-1).
            data-hub-id is the selection key: native HLS caption tracks share
            the same textTracks list, so indexes can never be trusted. */}
        {subsEnabled && contentId != null
          ? tracks.map((t) => (
              <track
                key={t.id}
                kind="subtitles"
                src={playerHubSubtitleUrl(contentId, t.id)}
                srcLang={t.lang}
                label={t.label}
                data-hub-id={t.id}
              />
            ))
          : null}
      </video>

      {/* Click layer: single click = play/pause, double click = fullscreen */}
      <div
        role="button"
        tabIndex={0}
        aria-label="Comută redarea (dublu-click: ecran complet)"
        className="absolute inset-0 z-10 focus-visible:outline-none"
        onClick={onStageClick}
        onDoubleClick={onStageDoubleClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            togglePlay();
          }
        }}
      />

      {/* Center states */}
      {loading && !failed ? (
        <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center" aria-hidden>
          <Loader2 className="h-10 w-10 animate-spin text-white/80" />
        </div>
      ) : null}
      {!playing && !loading && !failed ? (
        <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center" aria-hidden>
          <span className="grid h-16 w-16 place-items-center rounded-full bg-black/55 shadow-2xl backdrop-blur-sm">
            <Play className="ml-1 h-8 w-8 fill-white text-white" />
          </span>
        </div>
      ) : null}

      {/* Backdrop that closes any open popover */}
      {openMenu ? (
        <div className="absolute inset-0 z-20" onClick={() => setOpenMenu(null)} aria-hidden />
      ) : null}

      {/* Custom control bar */}
      <div
        className={cn(
          'absolute inset-x-0 bottom-0 z-30 transition-opacity duration-200',
          controlsVisible ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
      >
        <div className="bg-gradient-to-t from-black/90 via-black/55 to-transparent px-3 pb-2.5 pt-12 sm:px-4">
          {/* Timeline: buffered + played + scrub + hover tooltip */}
          <div
            ref={barRef}
            role="slider"
            aria-label="Bară de progres video"
            aria-valuemin={0}
            aria-valuemax={Math.round(duration)}
            aria-valuenow={Math.round(currentTime)}
            aria-valuetext={`${fmtTime(currentTime)} din ${fmtTime(duration)}`}
            tabIndex={0}
            className="relative h-5 cursor-pointer touch-none"
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              setScrubbing(true);
              setHoverX(ratioFromClientX(e.clientX));
              seekToRatio(ratioFromClientX(e.clientX));
            }}
            onPointerMove={(e) => {
              const r = ratioFromClientX(e.clientX);
              setHoverX(r);
              if (scrubbing) seekToRatio(r);
            }}
            onPointerUp={(e) => {
              setScrubbing(false);
              try {
                e.currentTarget.releasePointerCapture(e.pointerId);
              } catch {
                /* pointer already released */
              }
            }}
            onPointerLeave={() => {
              if (!scrubbing) setHoverX(null);
            }}
          >
            <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 overflow-hidden rounded-full bg-white/20">
              {/* buffered ranges (gray) */}
              {duration > 0
                ? bufferedRanges.map((r, i) => (
                    <div
                      key={i}
                      className="absolute inset-y-0 bg-white/30"
                      style={{
                        left: `${clamp01(r.start / duration) * 100}%`,
                        width: `${clamp01((r.end - r.start) / duration) * 100}%`,
                      }}
                    />
                  ))
                : null}
              {/* played (rose) */}
              <div className="absolute inset-y-0 left-0 bg-rose-500" style={{ width: `${progress * 100}%` }} />
            </div>
            {/* playhead knob */}
            <div
              className={cn(
                'absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-rose-500 shadow-[0_0_6px_rgba(244,63,94,0.8)] transition-transform',
                scrubbing ? 'scale-125' : 'scale-100',
              )}
              style={{ left: `${progress * 100}%` }}
            />
            {/* hover time tooltip */}
            {hoverX != null && duration > 0 ? (
              <div
                className="pointer-events-none absolute bottom-5 -translate-x-1/2 whitespace-nowrap rounded-md bg-black/90 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-white shadow-lg"
                style={{ left: `${hoverX * 100}%` }}
              >
                {fmtTime(hoverX * duration)}
              </div>
            ) : null}
          </div>

          {/* Buttons row */}
          <div className="mt-0.5 flex items-center gap-0.5">
            <CtrlBtn label={playing ? 'Pauză (Space/K)' : 'Redare (Space/K)'} onClick={togglePlay}>
              {playing ? (
                <Pause className="h-5 w-5 fill-current" aria-hidden />
              ) : (
                <Play className="h-5 w-5 fill-current" aria-hidden />
              )}
            </CtrlBtn>

            <CtrlBtn label="Înapoi 10 secunde (←)" onClick={() => skip(-SKIP_SECONDS)}>
              <span className="relative grid place-items-center">
                <RotateCcw className="h-5 w-5" aria-hidden />
                <span className="absolute -right-0.5 -top-1 text-[8px] font-black leading-none">10</span>
              </span>
            </CtrlBtn>
            <CtrlBtn label="Înainte 10 secunde (→)" onClick={() => skip(SKIP_SECONDS)}>
              <span className="relative grid place-items-center">
                <RotateCw className="h-5 w-5" aria-hidden />
                <span className="absolute -right-1 -top-1 text-[8px] font-black leading-none">10</span>
              </span>
            </CtrlBtn>

            {/* Volume */}
            <div className="ml-0.5 flex items-center gap-1">
              <CtrlBtn label={settings.muted ? 'Activează sunetul (M)' : 'Mut (M)'} onClick={toggleMute}>
                <VolumeIcon className="h-5 w-5" aria-hidden />
              </CtrlBtn>
              <VolumeBar value={settings.muted ? 0 : settings.volume} onChange={setVolume} />
            </div>

            <span className="ml-1.5 whitespace-nowrap px-1 text-xs font-semibold tabular-nums text-zinc-200">
              {fmtTime(currentTime)} <span className="text-zinc-500">/</span> {fmtTime(duration)}
            </span>

            <div className="flex-1" />

            {/* Speed */}
            <div className="relative">
              <CtrlBtn
                wide
                label="Viteză de redare"
                active={openMenu === 'speed'}
                onClick={() => setOpenMenu(openMenu === 'speed' ? null : 'speed')}
              >
                {settings.defaultSpeed}×
              </CtrlBtn>
              <Popover open={openMenu === 'speed'} title="Viteză" align="right">
                {PLAYBACK_SPEEDS.map((s) => (
                  <MenuRow key={s} active={settings.defaultSpeed === s} onClick={() => setSpeed(s)}>
                    {s === 1 ? 'Normal (1×)' : `${s}×`}
                  </MenuRow>
                ))}
              </Popover>
            </div>

            {/* Subtitles — REAL tracks from /api/playerhub/subtitles/:contentId */}
            <div className="relative">
              <CtrlBtn
                label={hasSubs ? 'Subtitrări (S)' : 'Fără subtitrări disponibile'}
                disabled={!hasSubs}
                active={openMenu === 'subs' || activeSub != null}
                onClick={() => setOpenMenu(openMenu === 'subs' ? null : 'subs')}
              >
                <Captions className="h-5 w-5" aria-hidden />
              </CtrlBtn>
              <Popover
                open={openMenu === 'subs' && hasSubs}
                title="Subtitrări"
                align="right"
                widthClass="w-44"
              >
                <MenuRow active={activeSub == null} onClick={() => chooseSubtitle(null)}>
                  Oprit
                </MenuRow>
                {tracks.map((t, i) => (
                  <MenuRow key={t.id} active={activeSub === i} onClick={() => chooseSubtitle(i)}>
                    {t.label}{' '}
                    <span className="font-mono text-[10px] font-normal uppercase text-zinc-500">{t.lang}</span>
                  </MenuRow>
                ))}
              </Popover>
            </div>

            {/* Quality — HLS only, only when hls.js exposes multiple levels */}
            {type === 'm3u8' && levels.length > 1 ? (
              <div className="relative">
                <CtrlBtn
                  wide
                  label="Calitate video"
                  active={openMenu === 'quality'}
                  onClick={() => setOpenMenu(openMenu === 'quality' ? null : 'quality')}
                >
                  {autoQuality
                    ? `Auto${currentLevelHeight > 0 ? ` ${currentLevelHeight}p` : ''}`
                    : `${pinnedHeight > 0 ? `${pinnedHeight}p` : '—'}`}
                </CtrlBtn>
                <Popover open={openMenu === 'quality'} title="Calitate" align="right" widthClass="w-44">
                  <MenuRow active={autoQuality} onClick={() => setQuality(null)}>
                    {autoQuality && currentLevelHeight > 0 ? `Auto (${currentLevelHeight}p)` : 'Auto'}
                  </MenuRow>
                  {levels.map((l) => (
                    <MenuRow
                      key={`${l.index}-${l.height}`}
                      active={pinnedLevel === l.index}
                      onClick={() => setQuality(l.index)}
                    >
                      {l.height}p
                    </MenuRow>
                  ))}
                </Popover>
              </div>
            ) : null}

            {/* Cinema mode — the layout change lives in player-view */}
            <CtrlBtn
              label={settings.cinemaMode ? 'Ieși din modul cinema (C)' : 'Mod cinema (C)'}
              active={settings.cinemaMode}
              onClick={toggleCinema}
            >
              {settings.cinemaMode ? (
                <MonitorPlay className="h-5 w-5" aria-hidden />
              ) : (
                <RectangleHorizontal className="h-5 w-5" aria-hidden />
              )}
            </CtrlBtn>

            {pipSupported ? (
              <CtrlBtn
                label={pipActive ? 'Ieși din Picture-in-Picture (I)' : 'Picture-in-Picture (I)'}
                active={pipActive}
                onClick={() => void togglePip()}
              >
                <PictureInPicture2 className="h-5 w-5" aria-hidden />
              </CtrlBtn>
            ) : null}

            <CtrlBtn
              label={fullscreen ? 'Ieși din ecran complet (F)' : 'Ecran complet (F)'}
              onClick={toggleFullscreen}
            >
              {fullscreen ? (
                <Minimize className="h-5 w-5" aria-hidden />
              ) : (
                <Maximize className="h-5 w-5" aria-hidden />
              )}
            </CtrlBtn>

            {/* Keyboard shortcuts */}
            <div className="relative">
              <CtrlBtn
                label="Comenzi rapide tastatură (?)"
                active={openMenu === 'shortcuts'}
                onClick={() => setOpenMenu(openMenu === 'shortcuts' ? null : 'shortcuts')}
              >
                <Keyboard className="h-5 w-5" aria-hidden />
              </CtrlBtn>
              <Popover
                open={openMenu === 'shortcuts'}
                title="Comenzi rapide"
                align="right"
                widthClass="w-64"
              >
                <ul className="space-y-1 px-1.5 pb-1 pt-0.5 text-[11px] leading-relaxed text-zinc-300">
                  {[
                    ['Space / K', 'Redare / pauză'],
                    ['← / →', '±10 secunde'],
                    ['J / L', '±10 secunde (mobil)'],
                    ['↑ / ↓', 'Volum'],
                    ['M', 'Mut'],
                    ['F', 'Ecran complet'],
                    ['C', 'Mod cinema'],
                    ['S', 'Subtitrări'],
                    ['I', 'Picture-in-Picture'],
                    ['?', 'Această listă'],
                  ].map(([key, desc]) => (
                    <li key={key} className="flex items-center justify-between gap-3">
                      <span className="font-mono text-[10px] font-bold text-zinc-100">{key}</span>
                      <span className="text-right">{desc}</span>
                    </li>
                  ))}
                </ul>
              </Popover>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});
