/**
 * player/VideoPlayer.tsx — Desktop video engine (HTML5 video + hls.js).
 *
 *   • mp4/webm → native <video src>
 *   • m3u8     → hls.js (dynamic import, destroyed on unmount / source change;
 *                Safari falls back to its native HLS support)
 *   • youtube / iframe → 16:9 <iframe> embed (youtube watch URLs become
 *                youtube-nocookie embeds) with an "external player" chip
 *
 * Custom control bar (no native controls): play/pause, current/total timecode,
 * seek bar, ±10s skip, volume slider + mute, fullscreen. Keyboard (while the
 * frame is hovered or focused): Space/K play-pause, ←/→ ±10s, M mute, F
 * fullscreen.
 *
 * Analytics (only when `contentId` is set AND the source is a real remote
 * stream — the bundled offline clip and the public demo streams are exempt):
 * 'view' on mount, 'play' on first start, 'complete' on finish.
 * `onPosition` fires ~every 10s plus on pause/unmount so parents can persist
 * resume positions (PlayerScreen → watch history + playback store,
 * MiniPlayerScreen → mini-player progress IPC).
 */

import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import {
  AlertTriangle,
  Maximize,
  Minimize,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { trackView } from '../api/analytics';
import { DEMO_SOURCES, OFFLINE_TEST_VIDEO } from '../utils/offlineVideo';
import { formatTimecode } from '../utils/format';
import styles from './VideoPlayer.module.css';

/* --------------------------------- types ----------------------------------- */

export interface VideoPlayerSource {
  type: string;
  url: string;
  label: string;
}

/** Imperative controls exposed to the parent (mini-player pop-out, expand). */
export interface VideoPlayerHandle {
  pause(): void;
  getPosition(): number;
  getDuration(): number;
}

export interface VideoPlayerProps {
  source: VideoPlayerSource;
  poster?: string | null;
  autoPlay?: boolean;
  /** Resume position in seconds (seeked after metadata loads when > 5). */
  initialPosition?: number;
  /** Enables analytics tracking (view / play / complete). */
  contentId?: number;
  /** ~every 10s + on pause/unmount with the live position + duration. */
  onPosition?: (position: number, duration: number) => void;
  onEnded?: () => void;
  /** Fired when the underlying stream fails to load/play. */
  onPlaybackError?: (message: string) => void;
  className?: string;
}

/* -------------------------------- helpers ---------------------------------- */

type SourceKind = 'native' | 'hls' | 'embed';

function resolveKind(source: VideoPlayerSource): SourceKind {
  const type = String(source.type || '').toLowerCase();
  if (type === 'm3u8' || type === 'hls') return 'hls';
  if (type === 'mp4' || type === 'webm' || type === 'mkv' || type === 'mov') return 'native';
  const path = String(source.url || '').split('?')[0].toLowerCase();
  if (path.endsWith('.m3u8')) return 'hls';
  if (path.endsWith('.mp4') || path.endsWith('.webm') || path.endsWith('.mkv')) return 'native';
  return 'embed'; // youtube / iframe / anything else → embedded player
}

/** youtube.com/watch?v=ID (and friends) → privacy-enhanced embed URL. */
function youtubeEmbedUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^(www|m|music)\./, '');
    if (host !== 'youtube.com' && host !== 'youtu.be') return null;
    let id: string | null = null;
    if (host === 'youtu.be') {
      id = parsed.pathname.split('/').filter(Boolean)[0] ?? null;
    } else {
      id = parsed.searchParams.get('v');
      if (!id) {
        const parts = parsed.pathname.split('/').filter(Boolean);
        if (parts[0] === 'embed' || parts[0] === 'shorts' || parts[0] === 'live') id = parts[1] ?? null;
      }
    }
    if (!id) return null;
    return `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0`;
  } catch {
    return null;
  }
}

/** Bundled offline clip + public demo streams never count as content analytics. */
function isUntrackedUrl(url: string): boolean {
  return url === OFFLINE_TEST_VIDEO || DEMO_SOURCES.some((demo) => demo.uri === url);
}

function videoErrorMessage(video: HTMLVideoElement | null): string {
  switch (video?.error?.code) {
    case 1:
      return 'Playback was aborted.';
    case 2:
      return 'A network error interrupted the stream.';
    case 3:
      return 'The stream is corrupted or uses an unsupported codec.';
    case 4:
      return 'This source is not supported or unreachable.';
    default:
      return 'The stream could not be loaded.';
  }
}

const POSITION_REPORT_MS = 10_000;
const SKIP_SECONDS = 10;

/* ------------------------------- component --------------------------------- */

export const VideoPlayer = forwardRef<VideoPlayerHandle, VideoPlayerProps>(function VideoPlayer(
  {
    source,
    poster,
    autoPlay = false,
    initialPosition = 0,
    contentId,
    onPosition,
    onEnded,
    onPlaybackError,
    className,
  },
  ref,
): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<{ destroy(): void } | null>(null);

  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  const [hovered, setHovered] = useState(false);

  const kind = resolveKind(source);
  const untracked = isUntrackedUrl(source.url);
  const tracked = contentId != null && !untracked;

  /* ------------------------------- prop refs ------------------------------- */

  const onPositionRef = useRef(onPosition);
  const onEndedRef = useRef(onEnded);
  const onPlaybackErrorRef = useRef(onPlaybackError);
  useEffect(() => {
    onPositionRef.current = onPosition;
    onEndedRef.current = onEnded;
    onPlaybackErrorRef.current = onPlaybackError;
  }, [onPosition, onEnded, onPlaybackError]);

  const playedOnceRef = useRef(false);
  const failedRef = useRef<string | null>(null);
  const lastEmitRef = useRef(0);
  const lastKnownRef = useRef<{ position: number; duration: number }>({ position: 0, duration: 0 });

  /* ------------------------------ failure state ----------------------------- */

  const fail = useCallback((message: string) => {
    if (failedRef.current != null) return; // surface one failure per source load
    failedRef.current = message;
    setFailed(message);
    onPlaybackErrorRef.current?.(message);
  }, []);

  // Swapping sources (remote ↔ demo ↔ bundled clip) re-arms the failure card.
  useEffect(() => {
    failedRef.current = null;
    setFailed(null);
  }, [source.url, source.type]);

  const retry = useCallback(() => {
    failedRef.current = null;
    setFailed(null);
    setRetryToken((token) => token + 1);
  }, []);

  /* ----------------------------- analytics events ---------------------------- */

  useEffect(() => {
    if (!tracked || contentId == null) return;
    void trackView(contentId, 'view');
  }, [tracked, contentId]);

  /* ------------------------------ hls.js engine ----------------------------- */

  useEffect(() => {
    if (kind !== 'hls') return undefined;
    const video = videoRef.current;
    if (!video) return undefined;

    let cancelled = false;

    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Native HLS support (Safari) — assign the URL directly.
      video.src = source.url;
      return undefined;
    }

    (async () => {
      const { default: Hls } = await import('hls.js');
      if (cancelled) return;
      if (!Hls.isSupported()) {
        fail('HLS playback is not supported in this build.');
        return;
      }
      const hls = new Hls({ enableWorker: true });
      hlsRef.current = hls;
      hls.loadSource(source.url);
      hls.attachMedia(video);
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return;
        fail(`HLS stream error — ${data.details || 'playback failed'}.`);
      });
    })();

    return () => {
      cancelled = true;
      hlsRef.current?.destroy();
      hlsRef.current = null;
    };
  }, [kind, source.url, retryToken, fail]);

  /* ------------------------- resume + re-seek handling ----------------------- */

  // Seek to `initialPosition` once metadata is known, and re-seek whenever the
  // resume position changes while mounted (mini-player expand mid-playback).
  useEffect(() => {
    if (kind === 'embed') return undefined;
    const video = videoRef.current;
    if (!video) return undefined;
    const target = Number.isFinite(initialPosition) ? initialPosition : 0;
    if (target <= 5) return undefined;

    const seek = (): void => {
      video.currentTime = target;
    };
    if (video.readyState >= 1) seek();
    else video.addEventListener('loadedmetadata', seek, { once: true });
    return () => video.removeEventListener('loadedmetadata', seek);
  }, [initialPosition, kind, source.url, retryToken]);

  /* --------------------------- volume persistence --------------------------- */

  // A remounted <video> resets volume/muted to defaults — re-apply ours.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = volume;
    video.muted = muted;
  }, [volume, muted, kind, source.url, retryToken]);

  /* ------------------------------ autoPlay nudge ----------------------------- */

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !autoPlay) return;
    video.play().catch(() => undefined); // autoplay may be blocked — ignore
  }, [autoPlay, kind, source.url, retryToken]);

  /* ---------------------------- position reporting --------------------------- */

  const emitPosition = useCallback((force: boolean) => {
    const video = videoRef.current;
    if (!video) return;
    const position = video.currentTime || 0;
    const total = Number.isFinite(video.duration) ? video.duration : 0;
    if (total <= 0) return;
    lastKnownRef.current = { position, duration: total };
    const now = Date.now();
    if (!force && now - lastEmitRef.current < POSITION_REPORT_MS) return;
    lastEmitRef.current = now;
    onPositionRef.current?.(position, total);
  }, []);

  const flushKnownRef = useRef<() => void>(() => {});
  useEffect(() => {
    flushKnownRef.current = () => {
      const { position, duration: total } = lastKnownRef.current;
      if (total > 0 && position > 0) onPositionRef.current?.(position, total);
    };
  }, []);

  // Final report on unmount (refs may already be detached — use the snapshot).
  useEffect(() => () => flushKnownRef.current(), []);

  /* ------------------------------- transport -------------------------------- */

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video || failedRef.current != null) return;
    if (video.paused) video.play().catch(() => undefined);
    else video.pause();
  }, []);

  const seekTo = useCallback((seconds: number) => {
    const video = videoRef.current;
    if (!video) return;
    const total = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    const next = Math.max(0, total > 0 ? Math.min(seconds, total) : seconds);
    video.currentTime = next;
    setCurrentTime(next);
  }, []);

  const skip = useCallback(
    (delta: number) => {
      const video = videoRef.current;
      if (!video) return;
      seekTo(video.currentTime + delta);
    },
    [seekTo],
  );

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setMuted(video.muted);
  }, []);

  const changeVolume = useCallback((next: number) => {
    const video = videoRef.current;
    const clamped = Math.max(0, Math.min(1, next));
    setVolume(clamped);
    if (video) {
      video.volume = clamped;
      if (clamped > 0 && video.muted) {
        video.muted = false;
        setMuted(false);
      }
    }
  }, []);

  const toggleFullscreen = useCallback(() => {
    const frame = containerRef.current;
    if (!frame) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    } else {
      void frame.requestFullscreen().catch(() => undefined);
    }
  }, []);

  useEffect(() => {
    const sync = (): void => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);

  /* -------------------------------- keyboard --------------------------------- */

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      const inside =
        hovered || (containerRef.current != null && target != null && containerRef.current.contains(target));
      if (!inside) return;
      // Let native widgets (seek/volume sliders) consume their own keys.
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;

      switch (event.key.toLowerCase()) {
        case ' ':
        case 'k':
          event.preventDefault();
          togglePlay();
          break;
        case 'arrowleft':
          event.preventDefault();
          skip(-SKIP_SECONDS);
          break;
        case 'arrowright':
          event.preventDefault();
          skip(SKIP_SECONDS);
          break;
        case 'm':
          toggleMute();
          break;
        case 'f':
          toggleFullscreen();
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [hovered, togglePlay, skip, toggleMute, toggleFullscreen]);

  /* ----------------------------- video handlers ------------------------------ */

  const handleLoadedMetadata = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (Number.isFinite(video.duration)) setDuration(video.duration);
  }, []);

  const handleTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    setCurrentTime(video.currentTime);
    if (!video.paused) emitPosition(false);
  }, [emitPosition]);

  const handlePlay = useCallback(() => {
    setPlaying(true);
    if (tracked && contentId != null && !playedOnceRef.current) {
      playedOnceRef.current = true;
      void trackView(contentId, 'play');
    }
  }, [tracked, contentId]);

  const handlePause = useCallback(() => {
    setPlaying(false);
    emitPosition(true);
  }, [emitPosition]);

  const handleEnded = useCallback(() => {
    setPlaying(false);
    emitPosition(true);
    if (tracked && contentId != null) void trackView(contentId, 'complete');
    onEndedRef.current?.();
  }, [tracked, contentId, emitPosition]);

  /* ----------------------------- imperative API ------------------------------ */

  useImperativeHandle(
    ref,
    () => ({
      pause: () => videoRef.current?.pause(),
      getPosition: () => videoRef.current?.currentTime ?? lastKnownRef.current.position,
      getDuration: () => {
        const total = videoRef.current?.duration;
        return Number.isFinite(total) && (total ?? 0) > 0 ? (total as number) : lastKnownRef.current.duration;
      },
    }),
    [],
  );

  /* --------------------------------- render ---------------------------------- */

  const frameClasses = [
    styles.frame,
    !playing ? styles.framePaused : '',
    failed != null ? styles.frameFailed : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  const elementKey = `${kind}:${source.url}:${retryToken}`;

  /* Embedded players (youtube / iframe) — no <video>, no custom controls. */
  if (kind === 'embed') {
    const embedUrl = youtubeEmbedUrl(source.url) ?? source.url;
    return (
      <div className={frameClasses} ref={containerRef}>
        <div className={styles.embedWrap}>
          <iframe
            className={styles.embed}
            src={embedUrl}
            title={source.label || 'Embedded player'}
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
          />
        </div>
        <div className={styles.tag}>external player</div>
      </div>
    );
  }

  return (
    <div
      className={frameClasses}
      ref={containerRef}
      tabIndex={0}
      role="region"
      aria-label={`Video player — ${source.label || 'stream'}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <video
        key={elementKey}
        ref={videoRef}
        className={styles.video}
        src={kind === 'native' ? source.url : undefined}
        poster={poster ?? undefined}
        autoPlay={autoPlay}
        playsInline
        preload="metadata"
        onLoadedMetadata={handleLoadedMetadata}
        onTimeUpdate={handleTimeUpdate}
        onPlay={handlePlay}
        onPause={handlePause}
        onEnded={handleEnded}
        onDurationChange={handleLoadedMetadata}
        onError={() => fail(videoErrorMessage(videoRef.current))}
        onClick={togglePlay}
        onDoubleClick={toggleFullscreen}
      />

      {!playing && failed == null ? (
        <button type="button" className={styles.centerPlay} onClick={togglePlay} aria-label="Play">
          <span className={styles.centerPlayCircle}>
            <Play size={26} fill="currentColor" />
          </span>
        </button>
      ) : null}

      <div className={styles.tag}>{source.label || source.type}</div>

      <div className={styles.controls}>
        <input
          className={`${styles.range} ${styles.seek}`}
          type="range"
          min={0}
          max={Math.max(duration, 0.1)}
          step={0.1}
          value={Math.min(currentTime, duration || 0)}
          onChange={(event) => seekTo(Number(event.target.value))}
          aria-label="Seek"
        />
        <div className={styles.controlsRow}>
          <button type="button" className={`${styles.ctl} ${styles.ctlPlay}`} onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'} title={playing ? 'Pause (K)' : 'Play (K)'}>
            {playing ? <Pause size={17} /> : <Play size={17} fill="currentColor" />}
          </button>
          <button type="button" className={styles.ctl} onClick={() => skip(-SKIP_SECONDS)} aria-label="Back 10 seconds" title="Back 10 seconds (←)">
            <RotateCcw size={16} />
          </button>
          <button type="button" className={styles.ctl} onClick={() => skip(SKIP_SECONDS)} aria-label="Forward 10 seconds" title="Forward 10 seconds (→)">
            <RotateCw size={16} />
          </button>
          <span className={styles.time}>
            {formatTimecode(currentTime)} / {formatTimecode(duration)}
          </span>
          <div className={styles.volumeWrap}>
            <button type="button" className={styles.ctl} onClick={toggleMute} aria-label={muted ? 'Unmute' : 'Mute'} title={muted ? 'Unmute (M)' : 'Mute (M)'}>
              {muted || volume === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}
            </button>
            <input
              className={`${styles.range} ${styles.volume}`}
              type="range"
              min={0}
              max={1}
              step={0.02}
              value={muted ? 0 : volume}
              onChange={(event) => changeVolume(Number(event.target.value))}
              aria-label="Volume"
            />
          </div>
          <button
            type="button"
            className={styles.ctl}
            onClick={toggleFullscreen}
            aria-label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            title={fullscreen ? 'Exit fullscreen (F)' : 'Fullscreen (F)'}
          >
            {fullscreen ? <Minimize size={16} /> : <Maximize size={16} />}
          </button>
        </div>
      </div>

      {failed != null ? (
        <div className={styles.fail} role="alert">
          <AlertTriangle size={24} color="var(--amber)" />
          <div className={styles.failTitle}>The stream could not be loaded</div>
          <p className={styles.failText}>{failed}</p>
          <button type="button" className="btn btn--sm" onClick={retry}>
            <RotateCw size={13} /> Retry
          </button>
        </div>
      ) : null}
    </div>
  );
});

export default VideoPlayer;
