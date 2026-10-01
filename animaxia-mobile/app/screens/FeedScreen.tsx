/**
 * app/screens/FeedScreen.tsx — Social + AI activity feed (Phase 6 React
 * Navigation version of the Phase-5 app/feed.tsx):
 *
 *   Global    GET /api/social/feed/global  (public, cursor pagination)
 *   Personal  GET /api/social/feed/personal (auth — ranked: types, genres,
 *             watchlist ∪ history, own activity)
 *   For you   GET /api/ai/personal/feed (auth — AI Cloud re-ranked feed with
 *             an aiWhy line per item + the weekly recap card)
 *
 * The social modes render an internal FlatList (screen not scrollable); the
 * AI feed renders stacked cards and uses the screen's outer ScrollView.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, radii, spacing, typography } from '../utils/theme';
import { useAuth } from '../hooks/useAuth';
import { useApi } from '../hooks/useApi';
import { cachedFresh } from '../api/cache';
import * as socialApi from '../api/social';
import * as aiApi from '../api/ai';
import type { Activity } from '../api/social';
import { Screen } from '../components/Screen';
import { Segmented } from '../components/Segmented';
import { FeedList } from '../feed/FeedList';
import { EmptyState, ErrorState, SignInCard, Skeleton } from '../components/states';

type FeedMode = 'global' | 'personal' | 'ai';

const MODES: { value: FeedMode; label: string }[] = [
  { value: 'global', label: 'Global' },
  { value: 'personal', label: 'Personal' },
  { value: 'ai', label: 'For you · AI' },
];

export default function FeedScreen(): React.JSX.Element {
  const { user } = useAuth();
  const [mode, setMode] = useState<FeedMode>('global');

  return (
    <Screen title="Feed" back={false} scroll={mode === 'ai'}>
      <View style={styles.wrap}>
        <Segmented options={MODES} value={mode} onChange={setMode} />
        {mode === 'global' ? <GlobalFeed /> : null}
        {mode === 'personal' ? user ? <SocialFeed personal /> : <AuthGate /> : null}
        {mode === 'ai' ? user ? <AiFeed /> : <AuthGate /> : null}
      </View>
    </Screen>
  );
}

function AuthGate(): React.JSX.Element {
  return (
    <View style={{ flex: 1, justifyContent: 'center' }}>
      <SignInCard message="Sign in to see the feed ranked for your taste." />
    </View>
  );
}

/* ------------------------------ social (cursor) ----------------------------- */

function SocialFeed({ personal = false }: { personal?: boolean }): React.JSX.Element {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const fetchPage = useCallback(
    async (nextCursor: string | null, replace: boolean) => {
      if (replace) setRefreshing(true);
      else setLoadingMore(true);
      setError(null);
      try {
        const page = personal
          ? await socialApi.feedPersonal(nextCursor, 20)
          : await socialApi.feedGlobal(nextCursor, 20);
        setActivities((prev) => (replace ? page.data : [...prev, ...page.data]));
        setCursor(page.nextCursor ?? null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not load the feed');
      } finally {
        setLoading(false);
        setLoadingMore(false);
        setRefreshing(false);
      }
    },
    [personal],
  );

  useEffect(() => {
    void fetchPage(null, true);
  }, [fetchPage]);

  if (loading) {
    return (
      <View style={{ gap: spacing.md, paddingTop: spacing.md }}>
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} style={{ height: 92, borderRadius: radii.lg }} />
        ))}
      </View>
    );
  }
  if (error && activities.length === 0) return <ErrorState message={error} onRetry={() => fetchPage(null, true)} />;

  return (
    <View style={{ flex: 1, marginTop: spacing.md }}>
      <FeedList
        activities={activities}
        hasMore={cursor != null}
        loadingMore={loadingMore}
        onEndReached={() => cursor && !loadingMore && fetchPage(cursor, false)}
      />
      {activities.length === 0 && !error ? (
        <EmptyState icon="newspaper-outline" title="Nothing happening yet" message="Comments, likes and new titles land here." />
      ) : null}
    </View>
  );
}

function GlobalFeed(): React.JSX.Element {
  // Same machinery as SocialFeed but always public.
  return <SocialFeed personal={false} />;
}

/* ------------------------------- AI-ranked feed ------------------------------ */

function AiFeed(): React.JSX.Element {
  const feed = useApi(
    () => cachedFresh('ai:personal:feed', 3 * 60 * 1000, () => aiApi.aiPersonalFeed(15)),
    [],
  );

  if (feed.loading) {
    return (
      <View style={{ gap: spacing.md, paddingTop: spacing.md }}>
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} style={{ height: 84, borderRadius: radii.lg }} />
        ))}
      </View>
    );
  }
  if (feed.error) return <ErrorState message={feed.error} onRetry={feed.refetch} />;
  if (!feed.data) return <View />;

  return (
    <View style={{ flex: 1, marginTop: spacing.md, gap: spacing.md }}>
      {feed.data.recap ? (
        <View style={styles.recapCard}>
          <View style={styles.recapHeader}>
            <Ionicons name="calendar-outline" size={13} color={colors.emerald} />
            <Text style={styles.recapWeek}>Week {feed.data.recap.week}</Text>
          </View>
          <Text style={styles.recapText}>{feed.data.recap.recap}</Text>
          <View style={styles.recapStats}>
            <Text style={styles.recapStat}>{feed.data.recap.stats.watched} watched</Text>
            {feed.data.recap.stats.topGenres.slice(0, 3).map((g) => (
              <Text key={g} style={styles.recapGenre}>
                {g}
              </Text>
            ))}
          </View>
        </View>
      ) : null}

      {feed.data.data.length === 0 ? (
        <EmptyState icon="sparkles-outline" title="The AI needs more signal" message="Watch and like a few titles first." />
      ) : (
        <View style={{ gap: spacing.md, paddingBottom: spacing.xxl }}>
          {feed.data.data.map((item, index) => (
            <View key={`${item.contentid ?? item.content}-${index}`} style={styles.aiCard}>
              <View style={styles.aiTopRow}>
                <Ionicons
                  name={item.type === 'comment' ? 'chatbubble-ellipses-outline' : 'add-circle-outline'}
                  size={14}
                  color={colors.roseSoft}
                />
                <Text style={styles.aiWho} numberOfLines={1}>
                  {item.user ?? 'Someone'}
                  <Text style={styles.aiVerb}> {item.type === 'comment' ? 'commented' : 'added'}</Text>
                  {item.content ? <Text style={styles.aiContent}> {item.content}</Text> : null}
                </Text>
              </View>
              {item.preview ? (
                <Text style={styles.aiPreview} numberOfLines={2}>
                  {item.preview}
                </Text>
              ) : null}
              {item.aiWhy ? (
                <View style={styles.aiWhyRow}>
                  <Ionicons name="sparkles" size={10} color={colors.fuchsia} />
                  <Text style={styles.aiWhy} numberOfLines={2}>
                    {item.aiWhy}
                  </Text>
                </View>
              ) : null}
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, paddingTop: spacing.sm, paddingBottom: 110 },

  recapCard: {
    backgroundColor: 'rgba(52,211,153,0.07)',
    borderWidth: 1,
    borderColor: 'rgba(52,211,153,0.25)',
    borderRadius: radii.lg,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  recapHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  recapWeek: { color: colors.emerald, fontSize: typography.tiny, fontWeight: '800' },
  recapText: { color: colors.textMuted, fontSize: typography.tiny, lineHeight: 17 },
  recapStats: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  recapStat: { color: colors.emerald, fontSize: 10, fontWeight: '700' },
  recapGenre: {
    color: colors.text,
    fontSize: 10,
    backgroundColor: colors.cardSoft,
    borderRadius: radii.sm,
    paddingHorizontal: 8,
    paddingVertical: 3,
    overflow: 'hidden',
  },

  aiCard: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radii.lg,
    padding: spacing.md,
    gap: spacing.sm,
  },
  aiTopRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  aiWho: { flex: 1, color: colors.text, fontSize: typography.tiny, fontWeight: '700' },
  aiVerb: { color: colors.textMuted, fontWeight: '500' },
  aiContent: { color: colors.roseSoft, fontWeight: '600' },
  aiPreview: { color: colors.textMuted, fontSize: typography.tiny, lineHeight: 16 },
  aiWhyRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  aiWhy: { flex: 1, color: colors.fuchsia, fontSize: 10, fontStyle: 'italic' },
});
