/**
 * screens/PlayerScreen.tsx — Full player page (desktop port of the mobile
 * FAZA 6 Player + Phase-6 offline fallbacks).
 *
 *   GET /api/mobile/player/:id (cached)  → content · mode · sources · primary · nextUp
 *   GET /api/ai/personal/player (auth)   → companion strip (before-you-watch,
 *                                          predicted rating, match, more-like-this)
 *   window.animaxia.playback             → cross-window resume position
 *   window.animaxia.miniPlayer           → pop-out always-on-top player
 *
 *   • mp4/m3u8 sources play in the custom VideoPlayer (analytics + progress
 *     tracking inside); youtube/iframe sources render as chips that open in
 *     the OS browser via window.open.
 *   • Resume: max(?resume= from the mini-player expand, stored playback
 *     position); re-seeks live when the resume param changes while mounted.
 *   • Offline fallbacks: stale payload with no playable source → bundled test
 *     clip (untracked, no contentId); remote source failure → amber card with
 *     the same bundled clip; online with nothing playable → public demo
 *     streams join the source picker (labelled "(demo)").
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { CloudOff, ExternalLink, PictureInPicture2, Play, SkipForward, Sparkles, VideoOff } from 'lucide-react';
import * as mobile from '../api/mobile';
import type { PlayerSource } from '../api/mobile';
import * as ai from '../api/ai';
import { cached } from '../api/cache';
import { useAuth } from '../auth/AuthContext';
import { useApi } from '../hooks/useApi';
import { VideoPlayer } from '../player/VideoPlayer';
import type { VideoPlayerHandle, VideoPlayerSource } from '../player/VideoPlayer';
import { createProgressReporter } from '../player/tracking';
import type { ProgressReporter } from '../player/tracking';
import { DEMO_SOURCES, OFFLINE_TEST_LABEL, OFFLINE_TEST_VIDEO } from '../utils/offlineVideo';
import { formatTimecode } from '../utils/format';
import { ContentCard } from '../components/content';
import { Button } from '../components/primitives';
import { ErrorState, Skeleton } from '../components/states';
import styles from './PlayerScreen.module.css';

const NATIVE_TYPES = new Set(['mp4', 'm3u8']);

export default function PlayerScreen(): React.JSX.Element {
  const navigate = useNavigate();
  const { id: idParam } = useParams();
  const idKey = idParam ?? '';
  const numericId = Number(idKey);
  const validId = Number.isInteger(numericId) && numericId > 0;

  const [searchParams] = useSearchParams();
  const resumeParam = Number(searchParams.get('resume')) || 0;

  const { user } = useAuth();
  const payload = useApi(validId ? () => mobile.getPlayerCached(idKey) : null, [idKey]);
  const companion = useApi(
    user && validId ? () => cached(`ai:companion:${idKey}`, () => ai.aiPersonalPlayer(numericId)) : null,
    [user?.id, idKey],
  );

  /* --------------------------- resume bookkeeping ---------------------------- */

  const [playbackRecord, setPlaybackRecord] = useState<PlaybackRecord | null>(null);
  useEffect(() => {
    if (!validId || typeof window === 'undefined' || !window.animaxia) {
      setPlaybackRecord(null);
      return undefined;
    }
    let cancelled = false;
    const bridge = window.animaxia;
    bridge.playback
      .get(idKey)
      .then((record) => {
        if (!cancelled) setPlaybackRecord(record);
      })
      .catch(() => {
        if (!cancelled) setPlaybackRecord(null);
      });
    return () => {
      cancelled = true;
    };
  }, [idKey, validId]);

  const resumePosition = Math.max(resumeParam, playbackRecord?.position ?? 0);

  /* ------------------------------ source model ------------------------------- */

  const data = payload.data;
  const nativeSources = useMemo<PlayerSource[]>(
    () => (data?.sources ?? []).filter((source) => NATIVE_TYPES.has(source.type)),
    [data],
  );
  const externalSources = useMemo<PlayerSource[]>(
    () => (data?.sources ?? []).filter((source) => !NATIVE_TYPES.has(source.type)),
    [data],
  );

  const [activeUrl, setActiveUrl] = useState<string | null>(null);
  const [localMode, setLocalMode] = useState(false);
  const [playbackFailed, setPlaybackFailed] = useState(false);
  const [miniOpen, setMiniOpen] = useState(false);

  /* Route param changes (/player/5 → /player/6 via nextUp) reuse this
     component instance — reset per-title playback state so the new title's
     own primary source wins instead of the previous title's pick. */
  useEffect(() => {
    setActiveUrl(null);
    setLocalMode(false);
    setPlaybackFailed(false);
    setMiniOpen(false);
  }, [idKey]);

  const demoSources = useMemo<PlayerSource[]>(
    () => DEMO_SOURCES.map((demo) => ({ type: 'mp4', url: demo.uri, label: demo.label })),
    [],
  );
  const demoAvailable = Boolean(data) && !payload.stale && (nativeSources.length === 0 || playbackFailed);
  const pickableSources = useMemo<PlayerSource[]>(
    () => (demoAvailable ? [...nativeSources, ...demoSources] : nativeSources),
    [demoAvailable, nativeSources, demoSources],
  );

  const initialSource =
    data?.primary && NATIVE_TYPES.has(data.primary.type) ? data.primary : nativeSources[0] ?? null;
  const remoteActive: PlayerSource | null = activeUrl
    ? nativeSources.find((source) => source.url === activeUrl) ??
      demoSources.find((source) => source.url === activeUrl) ??
      null
    : initialSource;

  const localSource = useMemo<VideoPlayerSource>(
    () => ({ type: 'mp4', url: OFFLINE_TEST_VIDEO, label: OFFLINE_TEST_LABEL }),
    [],
  );
  const active: VideoPlayerSource | null = localMode ? localSource : remoteActive;

  const pickSource = useCallback((url: string) => {
    setPlaybackFailed(false);
    setLocalMode(false);
    setActiveUrl(url);
  }, []);

  const playLocalClip = useCallback(() => {
    setPlaybackFailed(false);
    setLocalMode(true);
  }, []);

  const handlePlaybackError = useCallback(() => setPlaybackFailed(true), []);

  /* --------------------------- progress reporting ---------------------------- */

  const reporterRef = useRef<ProgressReporter | null>(null);
  useEffect(() => {
    if (!validId) return;
    reporterRef.current = createProgressReporter(numericId);
  }, [validId, numericId]);

  const lastKnownRef = useRef<{ position: number; duration: number }>({ position: 0, duration: 0 });
  const localModeRef = useRef(false);
  useEffect(() => {
    localModeRef.current = localMode;
  }, [localMode]);

  const handlePosition = useCallback(
    (position: number, duration: number) => {
      lastKnownRef.current = { position, duration };
      if (!localModeRef.current) reporterRef.current?.tick(position, duration);
    },
    [],
  );

  const handleEnded = useCallback(() => {
    const { position, duration } = lastKnownRef.current;
    if (!localModeRef.current) reporterRef.current?.flush(position, duration);
  }, []);

  // Final save when leaving the screen mid-playback.
  useEffect(
    () => () => {
      const { position, duration } = lastKnownRef.current;
      if (!localModeRef.current && duration > 0 && position > 0) {
        reporterRef.current?.flush(position, duration);
      }
    },
    [],
  );

  /* ------------------------------ mini-player -------------------------------- */

  const playerRef = useRef<VideoPlayerHandle>(null);
  const miniSource = !localMode ? remoteActive : null;

  const popOutMini = useCallback(() => {
    if (!data || !miniSource) return;
    playerRef.current?.pause();
    const position = playerRef.current?.getPosition() ?? lastKnownRef.current.position;
    const duration = playerRef.current?.getDuration() ?? lastKnownRef.current.duration;
    try {
      window.animaxia?.miniPlayer.open({
        contentId: numericId,
        title: data.content.title,
        thumbnail: data.content.thumbnail,
        source: miniSource,
        position: Math.max(0, Math.floor(position)),
        duration: Math.max(0, Math.floor(duration)),
      });
      setMiniOpen(true);
    } catch {
      /* mini-player unavailable (plain-browser dev) — ignore */
    }
  }, [data, miniSource, numericId]);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.animaxia) return undefined;
    try {
      return window.animaxia.miniPlayer.onClosed(() => setMiniOpen(false));
    } catch {
      return undefined;
    }
  }, []);

  /* --------------------------------- render ---------------------------------- */

  if (!validId) {
    return <ErrorState message="That player id does not exist." />;
  }

  if (payload.loading) {
    return (
      <div className="stack" style={{ gap: 14 }}>
        <Skeleton h={420} radius={16} />
        <Skeleton w="55%" h={16} />
        <Skeleton h={80} radius={12} />
      </div>
    );
  }

  if (payload.error) {
    return <ErrorState message={payload.error} onRetry={payload.refetch} />;
  }

  if (!data) return <></>;

  const companionData = companion.data;
  const nextUp = data.nextUp ?? companionData?.nextUp ?? null;
  const showResumeChip = !resumeParam && (playbackRecord?.position ?? 0) > 30 && !localMode;

  return (
    <div>
      {active ? (
        <VideoPlayer
          ref={playerRef}
          source={active}
          poster={data.content.thumbnail}
          autoPlay={resumeParam > 5}
          initialPosition={localMode ? 0 : resumePosition}
          contentId={localMode ? undefined : numericId}
          onPosition={handlePosition}
          onEnded={handleEnded}
          onPlaybackError={handlePlaybackError}
        />
      ) : payload.stale ? (
        /* Offline + no playable cached source → the bundled clip always plays. */
        <div className={styles.noStream}>
          <CloudOff size={26} color="var(--amber)" />
          <div className={styles.noStreamTitle}>Offline — cached sources unavailable</div>
          <p className={styles.noStreamText}>
            This cached title has no direct stream, but the bundled test clip plays without a network.
          </p>
          <Button onClick={playLocalClip}>
            <Play size={13} /> Play bundled test clip
          </Button>
        </div>
      ) : (
        <div className={styles.noStream}>
          <VideoOff size={26} color="var(--text-dim)" />
          <div className={styles.noStreamTitle}>No native stream for this title</div>
          <p className={styles.noStreamText}>
            {data.mode === 'trailer'
              ? 'Only an official trailer is available — open it below.'
              : data.allowedTypes.length > 0
                ? `Allowed types: ${data.allowedTypes.join(', ')} — none playable in-app.`
                : 'This title has no sources attached yet.'}
          </p>
        </div>
      )}

      {/* Remote source failed to load → offer the bundled offline test clip. */}
      {active && playbackFailed && !localMode ? (
        <div className={styles.offlineCard}>
          <CloudOff size={16} color="var(--amber)" />
          <span className={styles.offlineCardText}>Offline — cached sources unavailable</span>
          <Button size="sm" onClick={playLocalClip}>
            <Play size={12} /> Play bundled test clip
          </Button>
        </div>
      ) : null}

      {/* resume + pop-out toolbar */}
      <div className={styles.toolbar}>
        {showResumeChip ? (
          <span className="chip chip--on" title={`Resuming from ${formatTimecode(playbackRecord?.position ?? 0)}`}>
            Resume from {formatTimecode(playbackRecord?.position ?? 0)}
          </span>
        ) : null}
        <span className={styles.toolbarSpacer} />
        {miniOpen ? (
          <span className="badge badge--rose">
            <span className={styles.miniNote}>
              <PictureInPicture2 size={11} /> Playing in the mini-player
            </span>
          </span>
        ) : miniSource ? (
          <Button variant="ghost" size="sm" onClick={popOutMini}>
            <PictureInPicture2 size={13} /> Pop out mini-player
          </Button>
        ) : null}
      </div>

      {/* sources (demo streams join the picker while online + unplayable) */}
      {pickableSources.length > 0 ? (
        <div>
          <div className={styles.sectionLabel}>{demoAvailable ? 'Sources · fallbacks' : 'Sources'}</div>
          <div className={styles.sourceRow}>
            {pickableSources.map((source) => {
              const isActive = !localMode && remoteActive?.url === source.url;
              return (
                <button
                  key={source.url}
                  type="button"
                  className={`chip${isActive ? ' chip--on' : ''}`}
                  onClick={() => pickSource(source.url)}
                  aria-pressed={isActive}
                  aria-label={`Switch to ${source.label}`}
                >
                  {source.label}
                </button>
              );
            })}
            {localMode ? <span className="badge badge--amber">{OFFLINE_TEST_LABEL}</span> : null}
          </div>
        </div>
      ) : null}

      {/* external embeds open in the OS browser */}
      {externalSources.length > 0 ? (
        <div>
          <div className={styles.sectionLabel}>External</div>
          {externalSources.map((source) => (
            <button
              key={source.url}
              type="button"
              className={styles.externalRow}
              onClick={() => {
                window.open(source.url, '_blank', 'noopener,noreferrer');
              }}
              aria-label={`Open ${source.label} in browser`}
            >
              <ExternalLink size={14} color="var(--rose-soft)" />
              {source.label}
            </button>
          ))}
        </div>
      ) : null}

      {data.content.overview ? <p className={styles.overview}>{data.content.overview}</p> : null}

      {/* AI companion (signed-in, best-effort — hidden on error) */}
      {user && companionData ? (
        <section className={styles.companion} aria-label="Animaxia AI companion">
          <div className={styles.companionHeader}>
            <Sparkles size={13} color="var(--rose-soft)" />
            <span className={styles.companionTitle}>Before you watch</span>
            {companionData.predictedRating != null ? (
              <span className="badge badge--rose">you: {companionData.predictedRating.toFixed(1)}/10</span>
            ) : null}
            {companionData.matchScore != null ? (
              <span className="badge badge--emerald">{Math.round(companionData.matchScore * 100)}% match</span>
            ) : null}
          </div>
          <p className={styles.companionText}>{companionData.beforeYouWatch}</p>
          {companionData.moreLikeThis.length > 0 ? (
            <div className={styles.companionRow}>
              {companionData.moreLikeThis.slice(0, 6).map((item) => (
                <ContentCard
                  key={`${item.id}-${item.title}`}
                  width={118}
                  item={{
                    id: item.id,
                    title: item.title,
                    type: item.type,
                    thumbnail: item.thumbnail,
                    rating: null,
                    year: null,
                  }}
                  reason={item.genres.length > 0 ? item.genres.slice(0, 2).join(' · ') : undefined}
                  onOpen={(id) => navigate(`/content/${id}`)}
                />
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {/* next up — chains to the next trending title (stack replace) */}
      {nextUp ? (
        <button
          type="button"
          className={styles.nextUp}
          onClick={() => navigate(`/player/${nextUp.id}`, { replace: true })}
          aria-label={`Play next: ${nextUp.title}`}
        >
          {nextUp.thumbnail ? (
            <img className={styles.nextUpThumb} src={nextUp.thumbnail} alt="" />
          ) : (
            <span className={styles.nextUpThumb} aria-hidden />
          )}
          <span style={{ minWidth: 0, flex: 1 }}>
            <span className={styles.nextUpLabel}>NEXT UP</span>
            <span className={styles.nextUpTitle}>{nextUp.title}</span>
          </span>
          <SkipForward size={18} color="var(--rose)" />
        </button>
      ) : null}
    </div>
  );
}
