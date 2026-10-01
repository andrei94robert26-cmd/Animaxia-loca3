/**
 * app/player/[id].tsx — Native player.
 *
 *   GET /api/mobile/player/:id (BFF payload: content · mode · sources ·
 *       primary · nextUp) + optional GET /api/users/me/history for resume.
 *
 *   • expo-av plays direct mp4/HLS sources; youtube/iframe sources open in
 *     the browser via Linking (they are embeds, not streams)
 *   • analytics tracking lives in player/VideoPlayer.tsx (view / play /
 *     complete + throttled progress → watch history)
 *   • signed-in users get the personal AI companion strip
 *     (GET /api/ai/personal/player: before-you-watch note, predicted rating,
 *     match score, more-like-this chips) — hidden on error, never blocks
 *   • nextUp card chains to the next trending title
 */

import React, { useMemo, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { colors, radii, spacing, typography } from '../theme';
import { useAuth } from '../auth/useAuth';
import { useApi } from '../hooks/useApi';
import { cached } from '../api/cache';
import * as mobileApi from '../api/mobile';
import * as usersApi from '../api/users';
import * as aiApi from '../api/ai';
import type { PlayerSource } from '../api/mobile';
import { Screen } from '../components/Screen';
import { VideoPlayer } from '../player/VideoPlayer';
import { Thumb } from '../components/content';
import { ErrorState, OfflineBanner, Skeleton } from '../components/states';

const NATIVE_TYPES = new Set(['mp4', 'm3u8']);

export default function PlayerScreen(): React.JSX.Element {
  const params = useLocalSearchParams<{ id: string }>();
  const id = Number.parseInt(String(params.id ?? ''), 10);
  const validId = Number.isInteger(id) && id > 0;

  const { user } = useAuth();
  const payload = useApi(
    validId ? () => mobileApi.getPlayerCached(id) : null,
    [id],
  );
  const history = useApi(
    user && validId ? () => usersApi.getHistory(50).then((r) => ({ data: r.data, stale: false })) : null,
    [user?.id, id],
  );
  const companion = useApi(
    user && validId ? () => cached(`ai:companion:${id}`, () => aiApi.aiPersonalPlayer(id)) : null,
    [user?.id, id],
  );

  const data = payload.data;
  const nativeSources = useMemo(
    () => (data?.sources ?? []).filter((s) => NATIVE_TYPES.has(s.type)),
    [data],
  );
  const externalSources = useMemo(
    () => (data?.sources ?? []).filter((s) => !NATIVE_TYPES.has(s.type)),
    [data],
  );
  const initialSource =
    data?.primary && NATIVE_TYPES.has(data.primary.type) ? data.primary : nativeSources[0] ?? null;
  const [activeUrl, setActiveUrl] = useState<string | null>(null);
  const active: PlayerSource | null = useMemo(() => {
    if (activeUrl) return nativeSources.find((s) => s.url === activeUrl) ?? null;
    return initialSource;
  }, [activeUrl, initialSource, nativeSources]);

  const resumePct = useMemo(() => {
    const entry = history.data?.find((h) => h.content.id === id);
    return entry && entry.progress > 1 && entry.progress < 97 ? entry.progress : null;
  }, [history.data, id]);

  if (!validId) {
    return (
      <Screen title="Player">
        <ErrorState message="That player id does not exist." />
      </Screen>
    );
  }

  return (
    <Screen title={data?.content.title ?? 'Player'}>
      <OfflineBanner visible={payload.stale} />

      {payload.loading ? (
        <View style={{ gap: spacing.md }}>
          <Skeleton style={{ aspectRatio: 16 / 9, borderRadius: radii.lg }} />
          <Skeleton style={{ height: 16, width: '55%' }} />
          <Skeleton style={{ height: 70, borderRadius: radii.md }} />
        </View>
      ) : payload.error ? (
        <ErrorState message={payload.error} onRetry={payload.refetch} />
      ) : data ? (
        <View style={{ gap: spacing.lg }}>
          {active ? (
            <VideoPlayer
              contentId={id}
              source={active}
              poster={data.content.thumbnail}
              resumeProgressPct={resumePct}
            />
          ) : (
            <View style={styles.noStream}>
              <Ionicons name="videocam-off-outline" size={26} color={colors.textDim} />
              <Text style={styles.noStreamTitle}>No native stream for this title</Text>
              {data.mode === 'trailer' ? (
                <Text style={styles.noStreamText}>Only an official trailer is available — open it below.</Text>
              ) : (
                <Text style={styles.noStreamText}>
                  {data.allowedTypes.length > 0
                    ? `Allowed types: ${data.allowedTypes.join(', ')} — none playable in-app.`
                    : 'This title has no sources attached yet.'}
                </Text>
              )}
            </View>
          )}

          {resumePct != null ? (
            <View style={styles.resumeRow}>
              <Ionicons name="play-forward-outline" size={13} color={colors.emerald} />
              <Text style={styles.resumeText}>Resuming at {Math.round(resumePct)}%</Text>
            </View>
          ) : null}

          {/* sources */}
          {nativeSources.length > 1 ? (
            <View style={{ gap: 8 }}>
              <Text style={styles.sourceTitle}>Sources</Text>
              <View style={styles.sourceRow}>
                {nativeSources.map((source) => {
                  const isActive = active?.url === source.url;
                  return (
                    <Pressable
                      key={source.url}
                      accessibilityRole="button"
                      accessibilityLabel={`Switch to ${source.label}`}
                      style={[styles.sourceChip, isActive && styles.sourceChipActive]}
                      onPress={() => setActiveUrl(source.url)}
                    >
                      <Text style={[styles.sourceChipText, isActive && styles.sourceChipTextActive]}>
                        {source.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          ) : null}
          {externalSources.length > 0 ? (
            <View style={{ gap: 8 }}>
              <Text style={styles.sourceTitle}>External</Text>
              {externalSources.map((source) => (
                <Pressable
                  key={source.url}
                  accessibilityRole="button"
                  accessibilityLabel={`Open ${source.label} in browser`}
                  style={styles.externalRow}
                  onPress={() => void Linking.openURL(source.url).catch(() => undefined)}
                >
                  <Ionicons name="open-outline" size={14} color={colors.roseSoft} />
                  <Text style={styles.externalText}>{source.label}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}

          {/* overview */}
          {data.content.overview ? (
            <Text style={styles.overview} numberOfLines={5}>
              {data.content.overview}
            </Text>
          ) : null}

          {/* AI companion (signed-in, best-effort) */}
          {user && companion.data ? (
            <View style={styles.companionCard}>
              <View style={styles.companionHeader}>
                <Ionicons name="sparkles" size={13} color={colors.roseSoft} />
                <Text style={styles.companionTitle}>Before you watch</Text>
                {companion.data.predictedRating != null ? (
                  <View style={styles.predictedChip}>
                    <Text style={styles.predictedText}>you: {companion.data.predictedRating.toFixed(1)}/10</Text>
                  </View>
                ) : null}
                {companion.data.matchScore != null ? (
                  <View style={[styles.predictedChip, { backgroundColor: 'rgba(52,211,153,0.12)' }]}>
                    <Text style={[styles.predictedText, { color: colors.emerald }]}>
                      {Math.round(companion.data.matchScore * 100)}% match
                    </Text>
                  </View>
                ) : null}
              </View>
              <Text style={styles.companionText}>{companion.data.beforeYouWatch}</Text>
              {companion.data.moreLikeThis.length > 0 ? (
                <View style={styles.companionChips}>
                  {companion.data.moreLikeThis.slice(0, 4).map((item) => (
                    <Pressable
                      key={item.id}
                      accessibilityRole="button"
                      accessibilityLabel={`Open ${item.title}`}
                      style={styles.companionChip}
                      onPress={() => router.navigate(`/content/${item.id}` as never)}
                    >
                      <Text style={styles.companionChipText} numberOfLines={1}>
                        {item.title}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              ) : null}
            </View>
          ) : null}

          {/* next up */}
          {data.nextUp ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Play next: ${data.nextUp.title}`}
              style={styles.nextUpCard}
              onPress={() => router.replace(`/player/${data.nextUp!.id}` as never)}
            >
              <Thumb uri={data.nextUp.thumbnail} style={styles.nextUpThumb} iconSize={14} />
              <View style={{ flex: 1, gap: 3 }}>
                <Text style={styles.nextUpLabel}>NEXT UP</Text>
                <Text style={styles.nextUpTitle} numberOfLines={1}>
                  {data.nextUp.title}
                </Text>
              </View>
              <Ionicons name="play-skip-forward" size={18} color={colors.rose} />
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  noStream: {
    aspectRatio: 16 / 9,
    borderRadius: radii.lg,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    padding: spacing.lg,
  },
  noStreamTitle: { color: colors.text, fontSize: typography.small, fontWeight: '700' },
  noStreamText: { color: colors.textMuted, fontSize: typography.tiny, textAlign: 'center' },

  resumeRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  resumeText: { color: colors.emerald, fontSize: typography.tiny, fontWeight: '700' },

  sourceTitle: {
    color: colors.textDim,
    fontSize: 10,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  sourceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  sourceChip: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.pill,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  sourceChipActive: { backgroundColor: colors.rose, borderColor: colors.rose },
  sourceChipText: { color: colors.textMuted, fontSize: typography.tiny, fontWeight: '700' },
  sourceChipTextActive: { color: '#fff' },

  externalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
  },
  externalText: { color: colors.text, fontSize: typography.tiny, fontWeight: '600' },

  overview: { color: colors.textMuted, fontSize: typography.small, lineHeight: 20 },

  companionCard: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
    padding: spacing.lg,
    gap: spacing.md,
  },
  companionHeader: { flexDirection: 'row', alignItems: 'center', gap: 7, flexWrap: 'wrap' },
  companionTitle: { color: colors.text, fontSize: typography.tiny, fontWeight: '800', flex: 1 },
  predictedChip: {
    backgroundColor: 'rgba(244,63,94,0.12)',
    borderRadius: radii.sm,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  predictedText: { color: colors.roseSoft, fontSize: 10, fontWeight: '800' },
  companionText: { color: colors.textMuted, fontSize: typography.tiny, lineHeight: 17 },
  companionChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  companionChip: {
    backgroundColor: colors.cardSoft,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radii.pill,
    paddingHorizontal: 10,
    paddingVertical: 5,
    maxWidth: 150,
  },
  companionChipText: { color: colors.text, fontSize: 10 },

  nextUpCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
    padding: spacing.md,
  },
  nextUpThumb: { width: 86, height: 52, borderRadius: radii.sm },
  nextUpLabel: { color: colors.textDim, fontSize: 9, fontWeight: '800', letterSpacing: 0.8 },
  nextUpTitle: { color: colors.text, fontSize: typography.small, fontWeight: '700' },
});
