/**
 * app/content/[id].tsx — Content details + AI panel.
 *
 *   GET /api/content/:id          → full row (metadata: overview, genres, …)
 *   GET /api/social/content/:id/likes → like tallies
 *   POST /api/social/content/:id/like → like / unlike (auth)
 *   POST /api/users/me/watchlist    → save / unsave (auth, plan-limited)
 *   AI panel (components/AIPanel)   → Explain this · More like this · Ask
 *
 * Invalid or non-numeric ids render a friendly error card instead of crashing.
 */

import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { colors, radii, spacing, typography, typeColor } from '../theme';
import { useAuth } from '../auth/useAuth';
import { useApi } from '../hooks/useApi';
import { cached } from '../api/cache';
import * as usersApi from '../api/users';
import * as socialApi from '../api/social';
import { Screen } from '../components/Screen';
import { BottomNav } from '../components/BottomNav';
import { AIPanel } from '../components/AIPanel';
import { Thumb } from '../components/content';
import { ErrorState, OfflineBanner, SignInCard, Skeleton } from '../components/states';

export default function ContentScreen(): React.JSX.Element {
  const params = useLocalSearchParams<{ id: string }>();
  const id = Number.parseInt(String(params.id ?? ''), 10);
  const validId = Number.isInteger(id) && id > 0;

  const { user } = useAuth();
  const content = useApi(
    validId ? () => cached(`content:${id}`, () => usersApi.getContent(id)) : null,
    [id],
  );
  const likes = useApi(
    validId ? () => cached(`likes:${id}`, () => socialApi.contentLikes(id)) : null,
    [id],
  );
  const [liked, setLiked] = useState<boolean | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const saved = useApi(
    user && validId ? () => usersApi.getWatchlist().then((r) => ({ data: r.data, stale: false })) : null,
    [user?.id, id],
  );
  const inWatchlist = useMemo(
    () => Boolean(saved.data?.some((entry) => entry.content.id === id)),
    [saved.data, id],
  );

  if (!validId) {
    return (
      <Screen title="Content">
        <ErrorState message="That content id does not exist." />
      </Screen>
    );
  }

  const toggleLike = async () => {
    if (!user) return;
    setActionError(null);
    const next = !(liked ?? Boolean(likes.data?.myVote));
    setLiked(next);
    try {
      const state = await socialApi.likeContent(id, next ? 1 : 0);
      setLiked(Boolean(state.myVote));
    } catch (err) {
      setLiked(null);
      setActionError(err instanceof Error ? err.message : 'Could not save your like');
    }
  };

  const toggleWatchlist = async () => {
    if (!user) return;
    setActionError(null);
    try {
      if (inWatchlist) await usersApi.removeFromWatchlist(id);
      else await usersApi.addToWatchlist(id);
      saved.refetch();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not update your watchlist');
    }
  };

  const c = content.data;
  const meta = c?.metadata ?? {};
  const overview = meta.overview ?? meta.synopsis ?? meta.description ?? null;
  const genres = Array.isArray(meta.genres) ? meta.genres.slice(0, 6).map(String) : [];
  const rating = typeof meta.rating === 'number' ? meta.rating : typeof meta.score === 'number' ? meta.score : null;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Screen title={c?.title ?? 'Details'}>
        <OfflineBanner visible={content.stale} />

        {content.loading ? (
          <View style={{ gap: spacing.md }}>
            <Skeleton style={{ aspectRatio: 16 / 9, borderRadius: radii.lg }} />
            <Skeleton style={{ height: 22, width: '70%' }} />
            <Skeleton style={{ height: 90, borderRadius: radii.md }} />
          </View>
        ) : content.error ? (
          <ErrorState message={content.error} onRetry={content.refetch} />
        ) : c ? (
          <View>
            {/* backdrop */}
            <Thumb uri={meta.backdrop ?? c.thumbnail} style={styles.backdrop} iconSize={40} />

            {/* title + meta chips */}
            <Text style={styles.title}>{c.title}</Text>
            <View style={styles.chipRow}>
              {c.type ? (
                <View style={[styles.chip, { backgroundColor: (typeColor[c.type] ?? colors.zinc) + '2e' }]}>
                  <Text style={[styles.chipText, { color: typeColor[c.type] ?? colors.zinc }]}>{c.type}</Text>
                </View>
              ) : null}
              {rating != null ? (
                <View style={styles.chip}>
                  <Ionicons name="star" size={11} color={colors.amber} />
                  <Text style={[styles.chipText, { color: colors.amber }]}>{rating.toFixed(1)}</Text>
                </View>
              ) : null}
              {meta.year ? (
                <View style={styles.chip}>
                  <Text style={styles.chipMuted}>{String(meta.year)}</Text>
                </View>
              ) : null}
              {meta.source ? (
                <View style={styles.chip}>
                  <Text style={styles.chipMuted}>via {String(meta.source)}</Text>
                </View>
              ) : null}
            </View>
            {genres.length > 0 ? (
              <View style={styles.chipRow}>
                {genres.map((genre) => (
                  <View key={genre} style={styles.genreChip}>
                    <Text style={styles.genreText}>{genre}</Text>
                  </View>
                ))}
              </View>
            ) : null}

            {overview ? <Text style={styles.overview}>{overview}</Text> : null}

            {/* actions */}
            <View style={styles.actionRow}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Play ${c.title}`}
                style={[styles.actionButton, styles.playAction]}
                onPress={() => router.navigate(`/player/${id}` as never)}
              >
                <Ionicons name="play" size={15} color="#fff" />
                <Text style={styles.playActionText}>Play</Text>
              </Pressable>

              {user ? (
                <>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={inWatchlist ? 'Remove from watchlist' : 'Add to watchlist'}
                    style={[styles.actionButton, styles.secondaryAction]}
                    onPress={toggleWatchlist}
                  >
                    <Ionicons
                      name={inWatchlist ? 'bookmark' : 'bookmark-outline'}
                      size={15}
                      color={inWatchlist ? colors.rose : colors.text}
                    />
                    <Text style={styles.secondaryActionText}>{inWatchlist ? 'Saved' : 'Save'}</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Like this title"
                    style={[styles.actionButton, styles.secondaryAction]}
                    onPress={toggleLike}
                  >
                    <Ionicons
                      name={(liked ?? Boolean(likes.data?.myVote)) ? 'heart' : 'heart-outline'}
                      size={15}
                      color={(liked ?? Boolean(likes.data?.myVote)) ? colors.rose : colors.text}
                    />
                    <Text style={styles.secondaryActionText}>
                      {typeof (likes.data?.likes) === 'number'
                        ? (likes.data.likes + ((liked ?? Boolean(likes.data?.myVote)) && !likes.data.myVote ? 1 : 0)).toString()
                        : 'Like'}
                    </Text>
                  </Pressable>
                </>
              ) : (
                <View style={{ flex: 1 }}>
                  <SignInCard message="Sign in to save titles, like and chat with the AI." />
                </View>
              )}
            </View>

            {actionError ? <Text style={styles.actionError}>{actionError}</Text> : null}

            {/* AI panel — Explain / More like this / Ask */}
            <AIPanel contentId={id} title={c.title} />
          </View>
        ) : null}
      </Screen>
      <BottomNav />
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { width: '100%' as never, aspectRatio: 16 / 9, borderRadius: radii.lg, backgroundColor: colors.cardSoft },
  title: { color: colors.text, fontSize: typography.title, fontWeight: '800', marginTop: spacing.lg },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: spacing.md },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radii.pill,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  chipText: { fontSize: typography.tiny, fontWeight: '800' },
  chipMuted: { color: colors.textMuted, fontSize: typography.tiny, fontWeight: '600' },
  genreChip: {
    backgroundColor: 'rgba(217,70,239,0.1)',
    borderRadius: radii.sm,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  genreText: { color: colors.fuchsia, fontSize: 10, fontWeight: '600' },
  overview: { color: colors.textMuted, fontSize: typography.small, lineHeight: 21, marginTop: spacing.md },

  actionRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg, alignItems: 'center' },
  actionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    borderRadius: radii.md,
    paddingVertical: 12,
  },
  playAction: { flex: 1, backgroundColor: colors.rose },
  playActionText: { color: '#fff', fontWeight: '800', fontSize: typography.small },
  secondaryAction: {
    flex: 1,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  secondaryActionText: { color: colors.text, fontWeight: '700', fontSize: typography.small },
  actionError: { color: colors.red, fontSize: typography.tiny, marginTop: spacing.sm },
});
