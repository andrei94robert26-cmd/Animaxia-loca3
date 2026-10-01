/**
 * player/VideoPlayer.tsx — expo-av video surface for the Player screen.
 *
 * Responsibilities:
 *   • native controls + poster + loop of direct sources (mp4 / m3u8 HLS)
 *   • 'view' on mount, 'play' on first start, 'complete' on finish
 *     (POST /api/analytics/views — fire-and-forget)
 *   • throttled progress reporting (player/tracking.ts → watch history)
 *   • graceful failure card with retry when the stream URL dies
 *   • Phase 6: `source` also accepts a bundled asset module
 *     ({ localAsset: number } — expo-av plays require() ids directly) so the
 *     Player screen can fall back to the offline test clip; local test
 *     playback skips the network tracking events (it is not real content).
 *
 * NOTE (expo SDK 52): expo-av's <Video> is the battle-tested component and
 * ships inside Expo Go. When you migrate to SDK 53+ swap this wrapper to
 * expo-video's <VideoView> — the props here (source/poster/onProgress) stay.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ResizeMode, Video, type AVPlaybackStatus } from 'expo-av';
import { Ionicons } from '@expo/vector-icons';
import { colors, radii, spacing, typography } from '../utils/theme';
import { createProgressTracker, trackPlayback } from './tracking';
import type { PlayerSource } from '../api/mobile';

/** A playable source: a remote stream, or a bundled asset module (offline clip). */
export type VideoSourceSpec = PlayerSource | { localAsset: number; label?: string };

function isLocalSpec(spec: VideoSourceSpec): spec is { localAsset: number; label?: string } {
  return typeof (spec as { localAsset?: number }).localAsset === 'number';
}

export interface VideoPlayerProps {
  contentId: number;
  source: VideoSourceSpec;
  poster?: string | null;
  /** Resumes playback at this percentage (0–100) when provided. */
  resumeProgressPct?: number | null;
  /** Fired when the underlying <Video> fails to load/play its source. */
  onPlaybackError?: () => void;
}

export function VideoPlayer({ contentId, source, poster, resumeProgressPct, onPlaybackError }: VideoPlayerProps): React.JSX.Element {
  const videoRef = useRef<Video>(null);
  const tracker = useRef(createProgressTracker(contentId)).current;
  const playedOnce = useRef(false);
  const resumedOnce = useRef(false);
  const [failed, setFailed] = useState(false);
  const local = isLocalSpec(source);

  // Swapping sources (remote ↔ demo ↔ bundled clip) re-arms the failure card.
  useEffect(() => {
    setFailed(false);
  }, [source]);

  // Surface load/playback failures so the screen can offer its offline fallback.
  useEffect(() => {
    if (failed) onPlaybackError?.();
  }, [failed, onPlaybackError]);

  // 'view' event — the screen is open with a resolved source.
  // (Bundled test-clip playback is local-only: no network tracking.)
  useEffect(() => {
    if (local) return undefined;
    trackPlayback(contentId, 'view');
    return () => tracker.flush();
  }, [contentId, local, tracker]);

  const onStatus = useCallback(
    (status: AVPlaybackStatus) => {
      if (!status.isLoaded) {
        if ('error' in status && status.error) setFailed(true);
        return;
      }
      if (local) return; // bundled offline clip — no tracking, no resume
      if (status.isPlaying && !playedOnce.current) {
        playedOnce.current = true;
        trackPlayback(contentId, 'play');
      }
      // Resume once the position is known (durationMillis available).
      if (!resumedOnce.current && status.durationMillis && resumeProgressPct && resumeProgressPct > 1) {
        resumedOnce.current = true;
        void videoRef.current?.setPositionAsync(Math.floor((resumeProgressPct / 100) * status.durationMillis));
      }
      if (status.durationMillis && status.positionMillis != null) {
        tracker.update((status.positionMillis / status.durationMillis) * 100);
      }
      if (status.didJustFinish) {
        tracker.update(100);
        trackPlayback(contentId, 'complete');
      }
    },
    [contentId, local, resumeProgressPct, tracker],
  );

  if (failed) {
    return (
      <View style={[styles.box, styles.failBox]}>
        <Ionicons name="warning-outline" size={26} color={colors.amber} />
        <Text style={styles.failText}>The stream could not be loaded.</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Retry stream"
          style={styles.retry}
          onPress={() => {
            setFailed(false);
            const src = isLocalSpec(source) ? source.localAsset : { uri: source.url };
            void videoRef.current
              ?.unloadAsync()
              .then(() => videoRef.current?.loadAsync(src, { shouldPlay: true }))
              .catch(() => setFailed(true));
          }}
        >
          <Text style={styles.retryText}>Retry</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.box}>
      <Video
        ref={videoRef}
        style={styles.video}
        source={isLocalSpec(source) ? source.localAsset : { uri: source.url }}
        posterSource={poster ? { uri: poster } : undefined}
        usePoster={Boolean(poster)}
        useNativeControls
        resizeMode={ResizeMode.CONTAIN}
        onPlaybackStatusUpdate={onStatus}
        onError={() => setFailed(true)}
        accessibilityLabel={`Video player for content ${contentId}`}
      />
      <View style={styles.sourceTag}>
        <Text style={styles.sourceTagText}>{source.label ?? 'Bundled clip'}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    aspectRatio: 16 / 9,
    borderRadius: radii.lg,
    overflow: 'hidden',
    backgroundColor: '#000',
  },
  video: { flex: 1 },
  sourceTag: {
    position: 'absolute',
    top: 8,
    right: 8,
    backgroundColor: 'rgba(0,0,0,0.7)',
    borderRadius: radii.sm,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  sourceTagText: { color: colors.text, fontSize: 10, fontWeight: '700' },
  failBox: { alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
  failText: { color: colors.textMuted, fontSize: typography.small },
  retry: {
    backgroundColor: colors.rose,
    borderRadius: radii.pill,
    paddingHorizontal: 18,
    paddingVertical: 8,
  },
  retryText: { color: '#fff', fontSize: typography.small, fontWeight: '700' },
});

export default VideoPlayer;
