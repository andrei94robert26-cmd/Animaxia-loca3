/**
 * screens/HomeScreen.tsx — Home: hero carousel + curated rows
 * (GET /api/mobile/home — Continue watching · Trending · New · Anime · Movies).
 *
 * Offline-first: the payload is cached (stale-while-error) so the home screen
 * renders instantly and survives airplane mode with an amber banner.
 * Pull-to-refresh and a server-driven version gate (/api/mobile/config).
 *
 * Phase 6 (local notifications): on mount the repeating schedules from the
 * stored settings are (re)installed — daily picks 09:00 + weekly recap
 * Saturday 18:00 — and whenever fresh feed data arrives, every item (hero +
 * all rows) is diffed against the last-seen set to fire one "new titles"
 * notification. Both paths are best-effort: notification failures never
 * break the feed.
 */

import React, { useEffect, useMemo, useRef } from 'react';
import { RefreshControl, StyleSheet, Text, View } from 'react-native';
import Constants from 'expo-constants';
import { Ionicons } from '@expo/vector-icons';
import { colors, radii, spacing, typography } from '../utils/theme';
import { useApi } from '../hooks/useApi';
import * as mobileApi from '../api/mobile';
import {
  applyNotificationSchedules,
  checkNewContent,
  loadNotificationSettings,
  type NotificationSettings,
} from '../utils/notifications';
import { Screen } from '../components/Screen';
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

  /* Notification settings loaded once, reused by the new-content check. */
  const settingsRef = useRef<NotificationSettings | null>(null);
  const scheduleOnce = useRef(false);

  /* Install the repeating local notifications once (ref-guarded so React 18
     StrictMode double-mounts don't double-apply — applyNotificationSchedules
     cancels + reschedules, making it idempotent either way). */
  useEffect(() => {
    if (scheduleOnce.current) return;
    scheduleOnce.current = true;
    (async () => {
      try {
        const settings = await loadNotificationSettings();
        settingsRef.current = settings;
        await applyNotificationSchedules(settings);
      } catch {
        /* notifications are best-effort — never block the home screen */
      }
    })();
  }, []);

  /* New-content detection: flatten hero + every row into { id, title }[] and
     fire one local notification when unseen titles appear. */
  useEffect(() => {
    const data = home.data;
    if (!data) return;
    (async () => {
      try {
        if (!settingsRef.current) {
          settingsRef.current = await loadNotificationSettings();
        }
        const settings = settingsRef.current;
        const known = new Set<number>();
        const all: { id: number; title: string }[] = [];
        const push = (item: { id: number; title: string }): void => {
          if (known.has(item.id)) return;
          known.add(item.id);
          all.push({ id: item.id, title: item.title });
        };
        if (data.hero) push(data.hero);
        for (const row of data.rows) {
          for (const item of row.items) push(item);
        }
        await checkNewContent(all, settings.newContent);
      } catch {
        /* never crash the home screen on notification errors */
      }
    })();
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
