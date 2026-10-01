/**
 * app/watchlist.tsx — Saved titles (/api/users/me/watchlist).
 *
 * Rows with thumbnail, title, type + a remove action (optimistic via the
 * useWatchlist hook). Plan limits are enforced server-side (free 20 ·
 * plus 200 · pro unlimited) — a failed add surfaces the server message on
 * the content screen; this screen shows the current list + a link to the
 * Premium screen.
 */

import React from 'react';
import { Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { colors, radii, spacing, typography, typeColor } from '../theme';
import { useAuth } from '../auth/useAuth';
import { useWatchlist } from '../watchlist/useWatchlist';
import { Screen } from '../components/Screen';
import { BottomNav } from '../components/BottomNav';
import { Thumb } from '../components/content';
import { EmptyState, ErrorState, SignInCard, Skeleton } from '../components/states';

export default function WatchlistScreen(): React.JSX.Element {
  const { user } = useAuth();
  const wl = useWatchlist(user != null);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Screen
        title="Watchlist"
        back={false}
        scroll
        refreshControl={<RefreshControl refreshing={wl.refreshing} onRefresh={wl.load} tintColor={colors.rose} />}
      >
        <View style={styles.wrap}>
          {!user ? (
            <View style={{ flex: 1, justifyContent: 'center' }}>
              <SignInCard message="Sign in to keep your watchlist across devices — web and mobile share it." />
            </View>
          ) : wl.loading ? (
            <View style={{ gap: spacing.md, marginTop: spacing.md }}>
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} style={{ height: 78, borderRadius: radii.lg }} />
              ))}
            </View>
          ) : wl.error ? (
            <ErrorState message={wl.error} onRetry={wl.load} />
          ) : wl.entries.length === 0 ? (
            <EmptyState
              icon="bookmark-outline"
              title="Nothing saved yet"
              message="Tap Save on any title — your list syncs with the web console."
            />
          ) : (
            <View style={{ gap: spacing.md, marginTop: spacing.md, paddingBottom: spacing.xxl }}>
              <Text style={styles.countText}>
                {wl.entries.length} saved · more with{' '}
                <Text style={styles.upgradeInline} onPress={() => router.navigate('/premium' as never)}>
                  Plus / Pro
                </Text>
              </Text>
              {wl.entries.map((entry) => (
                <View key={entry.content.id} style={styles.row}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Open ${entry.content.title}`}
                    style={styles.rowPress}
                    onPress={() => router.navigate(`/content/${entry.content.id}` as never)}
                  >
                    <Thumb uri={entry.content.thumbnail} style={styles.thumb} iconSize={16} />
                    <View style={{ flex: 1, gap: 4 }}>
                      <Text style={styles.rowTitle} numberOfLines={1}>
                        {entry.content.title || '…'}
                      </Text>
                      {entry.content.type ? (
                        <Text style={[styles.rowType, { color: typeColor[entry.content.type] ?? colors.zinc }]}>
                          {entry.content.type}
                        </Text>
                      ) : null}
                    </View>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${entry.content.title} from watchlist`}
                    style={styles.removeButton}
                    onPress={() => void wl.toggle(entry.content.id)}
                  >
                    <Ionicons name="trash-outline" size={16} color={colors.red} />
                  </Pressable>
                </View>
              ))}
            </View>
          )}
        </View>
      </Screen>
      <BottomNav />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: 110 },
  countText: { color: colors.textMuted, fontSize: typography.tiny },
  upgradeInline: { color: colors.rose, fontWeight: '700' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radii.lg,
    padding: spacing.md,
    gap: spacing.md,
  },
  rowPress: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, flex: 1 },
  thumb: { width: 64, height: 84, borderRadius: radii.sm },
  rowTitle: { color: colors.text, fontSize: typography.small, fontWeight: '700' },
  rowType: { fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  removeButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(248,113,113,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
