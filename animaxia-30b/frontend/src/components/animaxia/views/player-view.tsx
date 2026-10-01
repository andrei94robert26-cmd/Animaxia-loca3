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
 *
 * FAZA 19 (task 19-2) — the mp4/HLS branches of the main surface render the
 * custom <VideoStage> (control bar, subtitles, speed, quality, cinema mode).
 * VideoStage owns hls.js + the decoder lifecycle internally and delegates
 * load errors to the SAME FAZA 17 chain via onError; the 12s watchdog keeps
 * working through its onLoadedData/onCanPlay/onLoadProgress props. Playback
 * progress is saved for real via POST /api/playerhub/progress (throttled to
 * ~10s, unified with the watch history) and resumed via initialTime. Embeds
 * (YouTube/Vimeo/Rumble/iframe) keep their native embeds — untouched.
 *
 * FAZA 19 (task 19-3a) — resume banner («Continuă de unde ai rămas»), extra
 * progress saves (pause / unmount / minimize) and the «Minimizează» button
 * that parks the mp4/HLS stage in the global PlayerDock mini-player.
 *
 * FAZA 19 (task 19-3b) — playlist mode: «Coadă de redare» panel next to the
 * player (lg: 2 columns) fed by the REAL /api/playerhub/playlists; auto-play
 * next with a 5s countdown overlay when the active queue has a next item and
 * autoplayNext is on; otherwise the «Ce urmează?» recommendations overlay at
 * the end of playback (real aiPersonalPlayer data, no queue → C, queue → A
 * has priority). All additions are strictly additive.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeft,
  ExternalLink,
  Film,
  Globe,
  Loader2,
  Minimize2,
  MonitorPlay,
  Pickaxe,
  Play,
  RefreshCw,
  RectangleHorizontal,
  Sparkles,
  Star,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/animaxia/api';
import { platform, type AiPersonalPlayerResponse } from '@/lib/animaxia/platform';
import { usePlayerSettings } from '@/lib/animaxia/player-settings';
import { useApi } from '@/lib/animaxia/hooks';
import { navigate, type AppRoute } from '@/lib/animaxia/router';
import type { PlayerExternalResponse, PlayerResponse, PlayerSource } from '@/lib/animaxia/types';
import { useAuth } from '@/components/animaxia/auth-provider';
import { VideoStage, type VideoStageHandle } from '@/components/animaxia/player/player-controls';
import { usePlayerDock } from '@/components/animaxia/player/player-dock';
import {
  AddToPlaylistCard,
  NextUpCountdownOverlay,
  PlaylistQueue,
  usePlaylistContext,
  type QueueItem,
} from '@/components/animaxia/player/playlist-queue';
import { EndgameRecommendationsOverlay } from '@/components/animaxia/player/endgame-recommendations';
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

/** mm:ss or h:mm:ss — used by the FAZA 19 resume banner. */
function fmtClock(sec: number): string {
  const n = Number.isFinite(sec) && sec > 0 ? Math.floor(sec) : 0;
  const s = n % 60;
  const m = Math.floor(n / 60) % 60;
  const h = Math.floor(n / 3600);
  const p = (v: number) => String(v).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
}

/* ------------------- FAZA 14 — external URL playback (rule 4) ------------------- */

/**
 * Standalone player surface for a resolved external source — used on the
 * branches without a library player (invalid id / load error), so external
 * playback works even when the title itself cannot be loaded.
 */
function ExternalSourceSurface({ source, title }: { source: PlayerSource; title: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  /* HLS via hls.js — same dynamic-import pattern as the main surface. */
  useEffect(() => {
    const url = source.url;
    const el = videoRef.current;
    if (source.type !== 'm3u8' || !url || !el) return undefined;
    let hls: { destroy: () => void } | null = null;
    let cancelled = false;
    (async () => {
      try {
        const mod = await import('hls.js');
        const Hls = mod.default;
        if (cancelled) return;
        if (Hls.isSupported()) {
          const instance = new Hls({ enableWorker: true });
          instance.loadSource(url);
          instance.attachMedia(el);
          hls = instance;
        } else if (el.canPlayType('application/vnd.apple.mpegurl')) {
          el.src = url;
        }
      } catch {
        /* hls.js failed to init — the <video> element surfaces its own error */
      }
    })();
    return () => {
      cancelled = true;
      hls?.destroy();
    };
  }, [source.type, source.url]);

  return (
    <div className="aspect-video w-full overflow-hidden rounded-2xl border border-white/10 bg-black">
      {source.type === 'mp4' && (
        <video
          key={`ext-mp4-${source.url}`}
          controls
          autoPlay
          playsInline
          className="h-full w-full"
          src={source.url}
        />
      )}
      {source.type === 'm3u8' && (
        <video
          key={`ext-m3u8-${source.url}`}
          ref={videoRef}
          controls
          autoPlay
          playsInline
          className="h-full w-full"
        />
      )}
      {source.type === 'youtube' && (
        <iframe
          key={`ext-youtube-${source.url}`}
          src={`${source.url}${source.url.includes('?') ? '&' : '?'}autoplay=1&rel=0`}
          title={title}
          className="h-full w-full"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
        />
      )}
      {(source.type === 'vimeo' || source.type === 'rumble') && (
        <iframe
          key={`ext-${source.type}-${source.url}`}
          src={`${source.url}${source.url.includes('?') ? '&' : '?'}autoplay=1`}
          title={title}
          className="h-full w-full"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
        />
      )}
      {source.type === 'iframe' && (
        <iframe
          key={`ext-iframe-${source.url}`}
          src={source.url}
          title={title}
          className="h-full w-full"
          sandbox="allow-scripts; allow-same-origin; allow-presentation; allow-popups; allow-forms"
          allowFullScreen
          referrerPolicy="no-referrer"
        />
      )}
    </div>
  );
}

/**
 * «Redare URL extern» — form card for the external resolver. ALWAYS visible in
 * every player branch: the resolver is DB-free (rule 4), so playback never
 * depends on how many real contents exist.
 */
function ExternalUrlCard({
  url,
  onUrlChange,
  onSubmit,
  resolving,
  error,
  resolved,
}: {
  url: string;
  onUrlChange: (value: string) => void;
  onSubmit: (event: React.FormEvent) => void;
  resolving: boolean;
  error: string | null;
  resolved: PlayerExternalResponse | null;
}) {
  return (
    <Card className="border-white/10 bg-white/[0.03]">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Globe className="h-4 w-4 text-rose-400" aria-hidden />
          Redare URL extern (independentă de bibliotecă)
        </CardTitle>
        <CardDescription>
          Rezolvare universală prin /api/player/external — YouTube, Vimeo, Rumble, MP4, HLS m3u8 sau orice embed
          iframe JS. Fără interogări de bază de date: funcționează indiferent de câte conținuturi reale există.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <form className="flex flex-col gap-3 sm:flex-row" onSubmit={onSubmit}>
          <div className="flex-1">
            <label htmlFor="player-external-url" className="sr-only">
              URL extern de redat
            </label>
            <Input
              id="player-external-url"
              value={url}
              onChange={(e) => onUrlChange(e.target.value)}
              placeholder="https://example.com/pagina-sau-stream"
              inputMode="url"
              className="border-white/10 bg-black/40"
            />
          </div>
          <Button
            type="submit"
            disabled={resolving || !url.trim()}
            className="bg-rose-600 font-bold hover:bg-rose-500"
          >
            {resolving ? <Loader2 className="animate-spin" aria-hidden /> : <Play aria-hidden />}
            Redă
          </Button>
        </form>
        {error ? (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-200"
          >
            <ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            {error}
          </p>
        ) : null}
        {resolved ? (
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-zinc-500">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 font-semibold text-emerald-300">
              {resolved.label}
            </span>
            <span className="font-mono text-zinc-400">{resolved.type}</span>
            <span>rezolvare fără bază de date — funcționează indiferent de câte conținuturi reale există</span>
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function PlayerModeBadge({ mode }: { mode: PlayerResponse['mode'] }) {
  if (mode === 'direct') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-[11px] font-semibold text-emerald-300">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden />
        Direct stream
      </span>
    );
  }
  if (mode === 'trailer') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-[11px] font-semibold text-amber-300">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-400" aria-hidden />
        YouTube trailer
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] font-semibold text-zinc-400">
      <span className="h-1.5 w-1.5 rounded-full bg-zinc-500" aria-hidden />
      No source
    </span>
  );
}

export function PlayerView({ route }: { route: AppRoute }) {
  const { user } = useAuth();
  /* FAZA 19 (19-3a) — global persistent mini-player (minimize → dock). */
  const { minimizeToDock } = usePlayerDock();
  const id = Number(route.params[0]);
  const validId = Number.isInteger(id) && id > 0;
  /* FAZA 19 (19-3b) — playlist queue context (REAL /api/playerhub/playlists). */
  const playlistCtx = usePlaylistContext(validId ? id : null);
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

  /* FAZA 14 — external URL playback (rule 4): the resolved source plays in
     the main player surface as the «Extern» chip; on branches without a
     library player (bad id / error) it plays in the standalone surface. */
  const [externalUrl, setExternalUrl] = useState('');
  const [externalResolving, setExternalResolving] = useState(false);
  const [externalError, setExternalError] = useState<string | null>(null);
  const [externalSource, setExternalSource] = useState<PlayerSource | null>(null);
  const [externalInfo, setExternalInfo] = useState<PlayerExternalResponse | null>(null);
  const [usingExternal, setUsingExternal] = useState(false);

  /* FAZA 19 (19-2) — persistent player settings + real progress/resume.
     VideoStage owns the <video> element now; this ref is its imperative API
     (getCurrentTime/getDuration) used for the final progress save on end.
     FAZA 19 (19-3a): the saved position is offered through an explicit
     resume banner («Continuă de unde ai rămas») instead of a silent seek —
     resumeChoice drives the banner, stageNonce forces a clean remount when
     the user picks «Continuă redarea» / «Începe de la început». */
  const { settings: playerSettings, update: updatePlayerSettings } = usePlayerSettings();
  const [resumeOffer, setResumeOffer] = useState<number | null>(null);
  const [resumeChoice, setResumeChoice] = useState<'none' | 'pending' | 'resume' | 'start'>('none');
  const [stageNonce, setStageNonce] = useState(0);
  const stageRef = useRef<VideoStageHandle>(null);
  const lastSavedRef = useRef(-1);
  const playedOnceRef = useRef(false);
  const stageTimeRef = useRef(0);

  const sourcesRef = useRef<PlayerSource[]>([]);
  const sourceIndexRef = useRef(0);
  const loadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastAdvanceRef = useRef<{ key: string; at: number } | null>(null);

  /* FAZA 19 (19-3b) — endgame overlays: (A) auto-play next countdown over the
     active playlist queue and (C) the «Ce urmează?» recommendations overlay
     (shown only WITHOUT an active queue — the queue has priority). */
  const [nextCountdown, setNextCountdown] = useState<QueueItem | null>(null);
  const [endgameOpen, setEndgameOpen] = useState(false);

  /* Only trust data matching the requested id — useApi keeps the previous
     record alive while the key changes (stale data across titles). */
  const current = player.data && player.data.content.id === id ? player.data : null;
  const sources = current?.sources ?? [];
  const exhausted = failedState != null && failedState.contentId === id && sources.length > 0;
  /* FAZA 14 — while the «Extern» chip is selected, the resolved external
     source takes over the main surface (bypasses the end-of-chain card). */
  const externalActive = usingExternal && externalSource != null;
  const activeSource: PlayerSource | null = externalActive
    ? externalSource
    : exhausted
      ? null
      : sources[sourceIndex] ?? current?.primary ?? null;

  /* FAZA 19 — the main mp4/HLS surface renders <VideoStage>, which manages
     hls.js and the decoder release internally (same FAZA 17 discipline); its
     load errors arrive through the onError prop below. */

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
     ever renders, so no stale index/failure can flash. The resolved external
     source survives (it is library-independent); only the selection resets so
     the new title's own sources play first. */
  useEffect(() => {
    sourceIndexRef.current = 0;
    setSourceIndex(0);
    setFailedState(null);
    setUsingExternal(false);
  }, [id]);

  /* FAZA 19 (19-3b) — endgame overlays reset on title change. */
  useEffect(() => {
    setNextCountdown(null);
    setEndgameOpen(false);
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

  /* FAZA 17 — the hls.js setup + decoder release for the main surface moved
     INTO <VideoStage> (task 19-2): fatal errors still advance the chain via
     its onError prop and the element is released on every source
     change/unmount with the same discipline. */

  /* FAZA 17 — 12s load watchdog: if a video source produces no loadeddata /
     canplay within the window, advance to the next source. */
  useEffect(() => {
    const t = activeSource?.type;
    if (!activeSource?.url || exhausted) return undefined;
    if (externalActive) return undefined; // external sources are user-resolved — no chain advance
    if (t !== 'mp4' && t !== 'm3u8') return undefined;
    clearLoadTimer();
    loadTimerRef.current = setTimeout(() => {
      loadTimerRef.current = null;
      advanceSource('timeout sursă');
    }, 12_000);
    return clearLoadTimer;
  }, [activeSource?.type, activeSource?.url, sourceIndex, reloadNonce, stageNonce, exhausted, externalActive, advanceSource, clearLoadTimer]);

  /* ------------------- FAZA 19 — progress save + resume ------------------- */

  /** Progress pings run for signed-in users with saveProgress on (the setting
   *  persists in localStorage through usePlayerSettings). */
  const progressEnabled = playerSettings.saveProgress && user != null;

  /* Fetch the saved resume point once per title (auth; 404/anonymous → none).
     FAZA 19 (19-3a): positions > 15s and ≤ 1h are offered as an explicit
     resume banner (> 1h is treated as "watched" — no offer); the banner is
     skipped entirely if playback already started (autoplay race). */
  useEffect(() => {
    setResumeOffer(null);
    setResumeChoice('none');
    playedOnceRef.current = false;
    stageTimeRef.current = 0;
    lastSavedRef.current = -1;
    if (!progressEnabled || !validId) return undefined;
    let cancelled = false;
    api
      .playerHubProgress(id)
      .then((res) => {
        if (cancelled) return;
        if (res.progress > 15 && res.progress <= 3600 && !playedOnceRef.current) {
          setResumeOffer(res.progress);
          setResumeChoice('pending');
        }
      })
      .catch(() => {
        /* no saved progress (or signed out mid-flight) — start from 0 */
      });
    return () => {
      cancelled = true;
    };
  }, [id, progressEnabled, validId]);

  /* Every source hop/retry/resume-choice remount restarts the throttle
     bookkeeping. */
  useEffect(() => {
    lastSavedRef.current = -1;
  }, [sourceIndex, reloadNonce, stageNonce]);

  /** Throttled progress ping (≥10s of new playback) — fire-and-forget POST
   *  /api/playerhub/progress, the SAME watchhistory the profile page reads.
 *  The latest position is also mirrored into stageTimeRef for the unmount
 *  save (FAZA 19 19-3a). */
  const handleStageTimeUpdate = useCallback(
    (t: number, duration: number) => {
      stageTimeRef.current = t;
      if (!progressEnabled) return;
      const sec = Math.floor(t);
      if (sec < 5 || sec - lastSavedRef.current < 10) return;
      lastSavedRef.current = sec;
      api
        .playerHubSaveProgress(id, sec, duration > 0 ? Math.floor(duration) : undefined)
        .catch(() => {});
    },
    [id, progressEnabled],
  );

  /** FAZA 19 (19-3a) — immediate save on pause: the user is deliberately
   *  leaving the surface, so the exact stopping point goes to watchhistory. */
  const handleStagePaused = useCallback(() => {
    if (!progressEnabled) return;
    const t = stageRef.current?.getCurrentTime() ?? stageTimeRef.current;
    const sec = Math.floor(t);
    if (sec < 5) return;
    lastSavedRef.current = sec;
    api.playerHubSaveProgress(id, sec).catch(() => {});
  }, [id, progressEnabled]);

  /** FAZA 19 (19-3a) — first play dismisses a pending resume offer (the user
   *  chose to watch from the start by hitting play directly). */
  const handleStagePlay = useCallback(() => {
    playedOnceRef.current = true;
    setResumeChoice((c) => (c === 'pending' ? 'start' : c));
  }, []);

  /** FAZA 19 (19-3a) — final save on unmount/navigation: the last known
   *  position (kept current by handleStageTimeUpdate) is POSTed
   *  fire-and-forget so the resume banner can offer it on the next visit. */
  useEffect(() => {
    return () => {
      const t = stageTimeRef.current;
      if (progressEnabled && t >= 5) {
        api.playerHubSaveProgress(id, Math.floor(t)).catch(() => {});
      }
    };
  }, [id, progressEnabled]);

  /** Final save when playback ends — records the completed position. */
  const handleStageEnded = useCallback(() => {
    if (!progressEnabled) return;
    const t = stageRef.current?.getCurrentTime() ?? 0;
    const d = stageRef.current?.getDuration() ?? 0;
    api
      .playerHubSaveProgress(id, Math.floor(t || d), d > 0 ? Math.floor(d) : undefined)
      .catch(() => {});
  }, [id, progressEnabled]);

  /* ------------------- FAZA 19 (19-3b) — endgame (A vs C) ------------------- */

  /** End-of-playback decision (mp4/m3u8 — onEnded fires only there):
   *  active queue with a next item → auto-play countdown (A) when the
   *  autoplayNext setting is on; NO queue (or last item in queue) → the
   * «Ce urmează?» recommendations overlay (C). The queue always wins. */
  const queueNext = playlistCtx.next;
  const handleStageEndgame = useCallback(() => {
    setEndgameOpen(false);
    if (queueNext) {
      if (playerSettings.autoplayNext) setNextCountdown(queueNext);
      return;
    }
    setEndgameOpen(true);
  }, [queueNext, playerSettings.autoplayNext]);

  /** The playlist panel rendered next to the player (queue when the title is
   *  in one, otherwise the discrete «Adaugă la playlist» card / login ask). */
  const queuePanel = validId ? (
    playlistCtx.queues.length > 0 ? (
      <PlaylistQueue ctx={playlistCtx} />
    ) : (
      <AddToPlaylistCard ctx={playlistCtx} />
    )
  ) : null;

  /* ---------------------- FAZA 19 — cinema mode ---------------------- */

  /** Cinema = wider player (max-w-7xl) + a fixed dim overlay under the player
   *  zone; the preference persists in the player settings. It applies while a
   *  source is active (any type) so the toggle button always has an effect. */
  const hasSurface = activeSource != null;
  const cinemaActive = playerSettings.cinemaMode && hasSurface;
  const toggleCinemaMode = () => updatePlayerSettings({ cinemaMode: !playerSettings.cinemaMode });

  /* FAZA 19 (19-3a) — the custom <VideoStage> surface is active (mp4/HLS,
   *  library or resolved-external): only it can be minimized to the dock and
   *  only it honors the resume banner (embeds expose no currentTime). */
  const stageSurface =
    activeSource != null && (activeSource.type === 'mp4' || activeSource.type === 'm3u8');
  const resumeBannerVisible = resumeOffer != null && resumeChoice === 'pending' && stageSurface;

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
      toast.success('Stream attached');
      setMineUrl('');
      await player.refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Mining failed');
    } finally {
      setMining(false);
    }
  }

  /* ------------------ FAZA 14 — external URL resolution (rule 4) ------------------ */

  /** Resolve ANY external URL via /api/player/external — zero DB queries, so
   *  it works no matter how many real contents exist. The resolved embed
   *  plays in the main surface («Extern» chip) or the standalone surface. */
  const resolveExternalUrl = async (raw: string) => {
    const url = raw.trim();
    if (!url || externalResolving) return;
    setExternalResolving(true);
    setExternalError(null);
    try {
      const res = await api.playerExternal(url);
      setExternalInfo(res);
      setExternalSource({ type: res.type, url: res.embedUrl, label: res.label });
      setUsingExternal(true);
      setFailedState(null);
      toast.success(`Sursă externă rezolvată: ${res.label}`);
    } catch (err) {
      setExternalError(err instanceof Error ? err.message : 'URL-ul extern nu a putut fi rezolvat.');
    } finally {
      setExternalResolving(false);
    }
  };

  const resolveExternalSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void resolveExternalUrl(externalUrl);
  };

  /* Rendered in EVERY branch — the external card never depends on the title
     being playable (or even existing). */
  const externalCard = (
    <ExternalUrlCard
      url={externalUrl}
      onUrlChange={setExternalUrl}
      onSubmit={resolveExternalSubmit}
      resolving={externalResolving}
      error={externalError}
      resolved={externalInfo}
    />
  );
  /* Standalone surface — only for branches without a library player. */
  const externalStandalone = externalSource ? (
    <ExternalSourceSurface source={externalSource} title={externalInfo?.label ?? 'Sursă externă'} />
  ) : null;

  if (!validId) {
    return (
      <Container className="space-y-5 py-20">
        <EmptyState
          title="Title not found"
          message="The player URL is missing a valid title id."
          action={
            <Button className="bg-rose-600 font-bold hover:bg-rose-500" onClick={() => navigate('/home')}>
              Back to home
            </Button>
          }
        />
        {externalCard}
        {externalStandalone}
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
          {externalCard}
        </div>
      </Container>
    );
  }

  if (player.error && !current) {
    if (isNotFound(player.error)) {
      return (
        <Container className="space-y-5 py-20">
          <EmptyState
            title="Title not found"
            message={player.error}
            action={
              <Button className="bg-rose-600 font-bold hover:bg-rose-500" onClick={() => navigate('/home')}>
                Back to home
              </Button>
            }
          />
          {externalCard}
          {externalStandalone}
        </Container>
      );
    }
    return (
      <Container className="space-y-5 py-20">
        <ErrorState message={player.error} onRetry={player.refetch} />
        {externalCard}
        {externalStandalone}
      </Container>
    );
  }

  const data = current;
  if (!data) return null;

  const content = data.content;
  const md = content.metadata || {};
  const overview =
    [md.overview, md.synopsis, md.description].find((v) => typeof v === 'string' && v.trim() !== '') ||
    'No synopsis available for this title.';
  const thumb = content.thumbnail || (typeof md.backdrop === 'string' ? md.backdrop : null);
  const noSource = data.mode === 'none' || !data.primary;

  /* FAZA 17 — "open the stream externally" suggestion: the original page
     URL from metadata when available, else the last source in the chain. */
  const externalHref =
    (typeof md.url === 'string' && /^https?:\/\//.test(md.url) ? md.url : null) ??
    (typeof md.mined?.url === 'string' && /^https?:\/\//.test(md.mined.url) ? md.mined.url : null) ??
    (sources.length > 0 ? sources[sources.length - 1].url : null);

  /* FAZA 19 (19-3a) — «Minimizează»: park the mp4/HLS stage in the global
     dock. The current position is saved for real (watchhistory) and the dock
     replays the SAME source from that point once the user navigates away.
     Embeds cannot survive cross-page, so the button only exists while the
     custom VideoStage surface is active. */
  const handleMinimizeToDock = () => {
    const t = stageRef.current?.getCurrentTime() ?? stageTimeRef.current;
    if (progressEnabled && validId && t >= 5) {
      api.playerHubSaveProgress(id, Math.floor(t)).catch(() => {});
    }
    minimizeToDock({
      contentId: validId ? id : null,
      title: content.title,
      thumbnail: thumb,
      source: activeSource
        ? { type: activeSource.type, url: activeSource.url, label: activeSource.label }
        : null,
      startedAt: Math.max(0, Math.floor(t)),
      open: true,
    });
  };

  return (
    <Container className="py-6 sm:py-8">
      {/* FAZA 19 — cinema mode dim overlay: a fixed portal above the page but
          UNDER the player zone (overlay z-40, player zone z-50). Clicking the
          dimmed area exits cinema mode. */}
      {cinemaActive && typeof document !== 'undefined'
        ? createPortal(
            <div
              className="fixed inset-0 z-40 bg-black/70"
              aria-hidden
              onClick={toggleCinemaMode}
            />,
            document.body,
          )
        : null}
      <div
        className={cn(
          'mx-auto w-full space-y-5',
          cinemaActive || queuePanel ? 'max-w-7xl' : 'max-w-5xl',
        )}
      >
        {/* FAZA 19 (19-3b) — player + playlist panel: stacked on mobile, two
            columns (player | coadă) from lg up. The cinema zone below is
            UNCHANGED inside the first grid cell. */}
        <div
          className={cn(
            'grid items-start gap-5',
            queuePanel ? 'lg:grid-cols-[minmax(0,1fr)_340px]' : '',
          )}
        >
        {/* FAZA 19 — the cinema zone (top bar + surface + source chips) stays
            above the dim overlay while the rest of the page is dimmed. */}
        <div className={cn('space-y-5', cinemaActive && 'relative z-50')}>
        {/* Top bar */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button
            variant="outline"
            className="border-white/15 bg-white/5 font-semibold hover:bg-white/10"
            onClick={() => navigate(`/content/${id}`)}
          >
            <ArrowLeft aria-hidden /> Back to details
          </Button>
          <div className="flex items-center gap-2">
            {/* FAZA 19 (19-3a) — minimize to the global persistent mini-player
                dock (mp4/HLS only — embeds cannot survive cross-page). */}
            {stageSurface ? (
              <Button
                variant="outline"
                size="sm"
                title="Minimizează — lasă redarea în mini-player și navighează liber"
                onClick={handleMinimizeToDock}
                className="h-8 gap-1.5 border-white/15 bg-white/5 px-3 font-semibold hover:bg-white/10"
              >
                <Minimize2 className="h-4 w-4" aria-hidden />
                Minimizează
              </Button>
            ) : null}
            {/* FAZA 19 — cinema mode toggle (persists in the player settings). */}
            {hasSurface ? (
              <Button
                variant="outline"
                size="sm"
                aria-pressed={cinemaActive}
                title="Mod cinema (C) — player lărgit, restul paginii estompat"
                onClick={toggleCinemaMode}
                className={cn(
                  'h-8 gap-1.5 border-white/15 bg-white/5 px-3 font-semibold hover:bg-white/10',
                  cinemaActive && 'border-rose-500/60 bg-rose-600 text-white hover:bg-rose-500',
                )}
              >
                {cinemaActive ? (
                  <MonitorPlay className="h-4 w-4" aria-hidden />
                ) : (
                  <RectangleHorizontal className="h-4 w-4" aria-hidden />
                )}
                Cinema
              </Button>
            ) : null}
            <PlayerModeBadge mode={data.mode} />
          </div>
        </div>

        {/* FAZA 19 (19-3a) — resume banner: the saved watch position (> 15s,
            ≤ 1h) is offered as an explicit choice; it hides automatically
            after the first play. */}
        {resumeBannerVisible ? (
          <div
            role="status"
            aria-label="Continuă de unde ai rămas"
            className="flex flex-wrap items-center gap-3 rounded-2xl border border-rose-500/30 bg-rose-500/[0.08] p-3 sm:p-4"
          >
            {thumb ? (
              <img
                src={thumb}
                alt={content.title}
                className="hidden h-14 w-24 shrink-0 rounded-lg border border-white/10 object-cover sm:block"
                loading="lazy"
              />
            ) : null}
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold text-white">Continuă de unde ai rămas</p>
              <p className="text-xs leading-relaxed text-zinc-400">
                Ai oprit la{' '}
                <span className="font-mono font-semibold text-rose-300">{fmtClock(resumeOffer)}</span>{' '}
                — relua de acolo sau începe de la început.
              </p>
            </div>
            <div className="flex w-full gap-2 sm:w-auto">
              <Button
                size="sm"
                className="flex-1 bg-rose-600 font-bold hover:bg-rose-500 sm:flex-none"
                onClick={() => {
                  setResumeChoice('resume');
                  setStageNonce((n) => n + 1);
                }}
              >
                <Play className="h-4 w-4" aria-hidden /> Continuă redarea
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="flex-1 border-white/15 bg-white/5 font-semibold hover:bg-white/10 sm:flex-none"
                onClick={() => {
                  setResumeChoice('start');
                  setStageNonce((n) => n + 1);
                }}
              >
                Începe de la început
              </Button>
            </div>
          </div>
        ) : null}

        {/* Player surface — FAZA 14: the resolved «Extern» source takes over
            the same surface when selected, even with no library sources. */}
        {noSource && !externalActive ? (
          <div className="space-y-4">
            <EmptyState
              title="No stream sources available"
              message={
                data.note ||
                'This title has no playable sources yet. Mine a stream below and it will be attached instantly.'
              }
              icon={<MonitorPlay className="h-6 w-6" aria-hidden />}
            />
            <Card className="border-white/10 bg-white/[0.03]">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Pickaxe className="h-4 w-4 text-rose-400" aria-hidden />
                  Mine a stream
                </CardTitle>
                <CardDescription>
                  Point the miner at a page or direct media URL — it extracts mp4, m3u8, iframe and YouTube sources
                  and attaches them to this title.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form className="flex flex-col gap-3 sm:flex-row" onSubmit={handleMine}>
                  <div className="flex-1">
                    <label htmlFor="player-mine-url" className="sr-only">
                      Stream or page URL
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
                    Mine &amp; attach
                  </Button>
                </form>
              </CardContent>
            </Card>
          </div>
        ) : exhausted && !externalActive ? (
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
                    Deschide sursa extern
                  </a>
                )}
              </div>
            </CardContent>
          </Card>
        ) : activeSource && (activeSource.type === 'mp4' || activeSource.type === 'm3u8') ? (
          /* FAZA 19 (19-2) — custom control bar stage for mp4/HLS: subtitles,
              speed, quality, cinema, shortcuts. Errors delegate to the SAME
              FAZA 17 chain; the 12s watchdog stays wired through the props.
              FAZA 19 (19-3b): the stage is wrapped in a relative div so the
              endgame overlays (countdown A / «Ce urmează?» C) sit on top of it. */
          <div className="relative">
            <VideoStage
              key={`stage-${id}-${activeSource.type}-${sourceIndex}-${activeSource.url}-${reloadNonce}-r${stageNonce}`}
              ref={stageRef}
              className="overflow-hidden rounded-2xl border border-white/10"
              src={activeSource.url}
              type={activeSource.type}
              contentId={validId ? id : null}
              autoPlay={resumeChoice !== 'pending'}
              initialTime={resumeChoice === 'resume' ? resumeOffer ?? undefined : undefined}
              onPlay={() => {
                trackPlay();
                handleStagePlay();
              }}
              onPause={handleStagePaused}
              onEnded={() => {
                trackComplete();
                handleStageEnded();
                handleStageEndgame();
              }}
              onError={(reason) => advanceSource(reason)}
              onLoadedData={clearLoadTimer}
              onCanPlay={clearLoadTimer}
              onLoadProgress={clearLoadTimer}
              onTimeUpdate={handleStageTimeUpdate}
            />
            {/* FAZA 19 (19-3b) — (A) auto-play next countdown (coada activă). */}

            {nextCountdown ? (
              <NextUpCountdownOverlay
                next={nextCountdown}
                onPlayNow={() => navigate(`/player/${nextCountdown.contentId}`)}
                onCancel={() => setNextCountdown(null)}
              />
            ) : null}
            {/* FAZA 19 (19-3b) — (C) «Ce urmează?» — recomandări (fără coadă). */}

            {endgameOpen ? (
              <EndgameRecommendationsOverlay
                contentId={id}
                onReplay={() => {
                  setEndgameOpen(false);
                  setResumeChoice('start');
                  setStageNonce((n) => n + 1);
                }}
                onClose={() => setEndgameOpen(false)}
              />
            ) : null}
          </div>
        ) : (
          <div className="aspect-video w-full overflow-hidden rounded-2xl border border-white/10 bg-black">
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
            {/* FAZA 14 — explicit vimeo + rumble embeds (the source url is
                already the normalized embed URL from the backend). */}
            {(activeSource?.type === 'vimeo' || activeSource?.type === 'rumble') && (
              <iframe
                key={activeSource.url}
                src={`${activeSource.url}${activeSource.url.includes('?') ? '&' : '?'}autoplay=1`}
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
                title="Embedded player"
                className="h-full w-full"
                sandbox="allow-scripts; allow-same-origin; allow-presentation; allow-popups; allow-forms"
                allowFullScreen
                referrerPolicy="no-referrer"
              />
            )}
          </div>
        )}

        {/* Source switcher — FAZA 14: the resolved external source appears as
            an extra «Extern» chip that selects and plays in the same surface. */}
        {(data.sources.length > 1 || externalSource != null) && (
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Stream sources">
            {data.sources.map((s, i) => {
              const isActive = !usingExternal && activeSource?.url === s.url && activeSource?.type === s.type;
              return (
                <button
                  key={`${s.type}-${i}-${s.url}`}
                  type="button"
                  onClick={() => {
                    selectSource(i);
                    setUsingExternal(false);
                  }}
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
            {externalSource != null && (
              <button
                type="button"
                onClick={() => {
                  setUsingExternal(true);
                  setFailedState(null);
                }}
                aria-pressed={usingExternal}
                title={externalInfo ? `${externalInfo.label} — ${externalInfo.url}` : externalSource.url}
                className={cn(
                  'rounded-full border px-3 py-1.5 text-xs font-semibold transition',
                  usingExternal
                    ? 'border-rose-500/60 bg-rose-600 text-white shadow-lg shadow-rose-900/30'
                    : 'border-white/10 bg-white/[0.04] text-zinc-300 hover:border-white/25 hover:bg-white/10',
                )}
              >
                Extern · {externalSource.type}
              </button>
            )}
          </div>
        )}
        </div>{/* /FAZA 19 cinema zone (top bar + surface + chips) */}

          {/* FAZA 19 (19-3b) — coada de redare / cardul „Adaugă la playlist”. */}
          {queuePanel ? (
            <aside aria-label="Playlist" className={cn(cinemaActive && 'relative z-50')}>
              {queuePanel}
            </aside>
          ) : null}
        </div>{/* /FAZA 19 (19-3b) player + queue grid */}

        {/* Policy line */}
        <p className="flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
          <span>Allowed by policy:</span>
          {data.allowedTypes.map((t) => (
            <span
              key={t}
              className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 font-mono text-[10px] text-zinc-400"
            >
              {t}
            </span>
          ))}
        </p>

        {/* FAZA 14 — external URL playback (rule 4): always visible, never
            depends on the title or the size of the real library. */}
        {externalCard}

        {/* Info card */}
        <Card className="border-white/10 bg-white/[0.03] p-4 sm:p-5">
          <div className="flex flex-wrap items-start gap-4">
            {thumb ? (
              <img
                src={thumb}
                alt={`${content.title} thumbnail`}
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
              View details
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
      <Card className="border-white/10 bg-white/[0.03]" aria-busy="true" aria-label="Loading AI companion">
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
  /* FAZA 19 — dedupe moreLikeThis by id: the recommendations source can
     return the same title multiple times, which broke React list keys. */
  const moreLikeThis = data.moreLikeThis.filter(
    (item, i, arr) => arr.findIndex((x) => x.id === item.id) === i,
  );

  return (
    <Card className="border-fuchsia-500/20 bg-gradient-to-br from-fuchsia-500/[0.06] via-white/[0.03] to-white/[0.02]">
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2.5 text-sm font-bold uppercase tracking-widest text-zinc-400">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-rose-500/30 to-fuchsia-500/30">
            <Sparkles className="h-4 w-4 text-fuchsia-300" aria-hidden />
          </span>
          AI companion
          {data.predictedRating != null && (
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-0.5 text-[11px] font-bold normal-case tracking-normal text-amber-300">
              <Star className="h-3 w-3 fill-amber-300" aria-hidden /> predicted {data.predictedRating}/10
            </span>
          )}
          {data.matchScore != null && (
            <span className="inline-flex items-center gap-1 rounded-full border border-rose-500/30 bg-rose-500/10 px-2.5 py-0.5 text-[11px] font-bold normal-case tracking-normal text-rose-300">
              {Math.round(data.matchScore * 100)}% match
            </span>
          )}
          {data.degraded && (
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider text-amber-300">
              offline mode
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-widest text-zinc-500">Before you watch</p>
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

        {moreLikeThis.length > 0 && (
          <div className="space-y-2">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">More like this</p>
            <div className="custom-scrollbar flex gap-2.5 overflow-x-auto pb-1">
              {moreLikeThis.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => navigate(`/content/${item.id}`)}
                  aria-label={`Open ${item.title}`}
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
            aria-label={`Play next: ${nextUp.title}`}
            className="flex w-full items-center gap-3 rounded-xl border border-rose-500/25 bg-rose-500/[0.08] p-2.5 text-left transition hover:border-rose-500/50 hover:bg-rose-500/[0.14] focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60"
          >
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-rose-600 text-white">
              <Play className="h-4 w-4 fill-white" aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[10px] font-semibold uppercase tracking-widest text-rose-300">Next up</span>
              <span className="block truncate text-sm font-semibold text-zinc-100">{nextUp.title}</span>
            </span>
          </button>
        )}
      </CardContent>
    </Card>
  );
}
