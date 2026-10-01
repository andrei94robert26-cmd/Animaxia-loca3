/**
 * app/index.tsx — Home screen: hero carousel + curated rows
 * (GET /api/mobile/home — Continue watching · Trending · New · Anime · Movies).
 *
 * Offline-first: the payload is cached (stale-while-error) so the home screen
 * renders instantly and survives airplane mode with an amber banner.
 * Pull-to-refresh, a server-driven version gate (/api/mobile/config) and the
 * 5-tab bottom nav.
 */

import React, { useMemo } from 'react';
import { RefreshControl, StyleSheet, Text, View } from 'react-native';
import Constants from 'expo-constants';
import { Ionicons } from '@expo/vector-icons';
import { colors, radii, spacing, typography } from '../theme';
import { useApi } from '../hooks/useApi';
import * as mobileApi from '../api/mobile';
import { Screen } from '../components/Screen';
import { BottomNav } from '../components/BottomNav';
import { ContentRow, HeroCarousel } from '../components/content';
import { EmptyState, ErrorState, OfflineBanner, RowSkeleton } from '../components/states';

/** "1.2.0" → [1, 2, 0] for a light semver compare. */
function versionParts(v: string | undefined): number[] {
  return String(v || '0')
    .split('.')
    .map((part) => parseInt(part, 10) || 0);
}

export default function HomeScreen(): React.JSX.Element {
  const home = useApi(mobileApi.getHomeCached, []);
  const config = useApi(mobileApi.getConfigCached, []);

  const refreshing = home.refreshing;
  const heroItems = useMemo(() => {
    const h = home.data;
    if (!h) return [];
    const trending = h.rows.find((row) => row.key === 'trending')?.items ?? [];
    const heroCandidates = h.hero ? [h.hero, ...trending.filter((t) => t.id !== h.hero?.id)] : trending;
    return heroCandidates.slice(0, 5);
  }, [home.data]);

  const outdated =
    config.data && Constants.expoConfig?.version
      ? (() => {
          const app = versionParts(Constants.expoConfig.version);
          const min = versionParts(config.data.versions.min);
          return app[0] < min[0] || (app[0] === min[0] && (app[1] < min[1] || (app[1] === min[1] && app[2] < min[2])));
        })()
      : false;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Screen
        title="Animaxia"
        back={false}
        scroll
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={home.refetch} tintColor={colors.rose} />
        }
      >
        <OfflineBanner visible={home.stale} />

        {outdated ? (
          <View style={styles.updateBanner}>
            <Ionicons name="download-outline" size={14} color={colors.amber} />
            <Text style={styles.updateText}>
              Animaxia v{config.data?.versions.latest} is out — your build (v{Constants.expoConfig?.version}) is below
              the supported v{config.data?.versions.min}.
            </Text>
          </View>
        ) : null}

        {home.loading ? (
          <View style={{ gap: spacing.sm }}>
            <RowSkeleton />
            <RowSkeleton />
            <RowSkeleton />
          </View>
        ) : home.error ? (
          <ErrorState message={home.error} onRetry={home.refetch} />
        ) : home.data ? (
          <View>
            <HeroCarousel items={heroItems} />
            {home.data.rows.map((row) => (
              <ContentRow key={row.key} title={row.title} items={row.items} />
            ))}
            {home.data.rows.length === 0 && (
              <EmptyState title="Nothing here yet" message="The library is empty — seed it from the web console." />
            )}
          </View>
        ) : null}
      </Screen>
      <BottomNav />
    </View>
  );
}

const styles = StyleSheet.create({
  updateBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(251,191,36,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(251,191,36,0.3)',
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    marginTop: spacing.sm,
  },
  updateText: { flex: 1, color: colors.amber, fontSize: typography.tiny, lineHeight: 15 },
});
