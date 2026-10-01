/**
 * ai/PersonalTab.tsx — "Personal AI" half of the mobile AI hub.
 *
 * GET /api/ai/personal/home (auth) →
 *   greeting (LLm) · mood chip · daily picks (vector-ranked, with reasons) ·
 *   because-you-watched row · AI taste profile tags · quota meter ·
 *   weekly-recap expander (GET /api/ai/personal/recap on demand).
 *
 * 5-minute client cache (server caches 10 min) + stale-while-error fallback,
 * 402 → upgrade card, 401 handled by the parent sign-in gate.
 *
 * Phase 6: pure expo-router-free module — cards navigate through the React
 * Navigation module ref, and the hub screen (app/screens/AIHubScreen) mounts
 * this tab inside its Personal segment.
 */

import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, radii, spacing, typography } from '../utils/theme';
import { useApi } from '../hooks/useApi';
import { isApiError } from '../api/client';
import { cached, cachedFresh } from '../api/cache';
import * as aiApi from '../api/ai';
import { ContentCard } from '../components/content';
import { QuotaMeter } from '../components/QuotaMeter';
import { ErrorState, RowSkeleton, Skeleton, UpgradeCard } from '../components/states';
import { SectionHeader } from '../components/Screen';

function isQuotaError(err: unknown): boolean {
  return isApiError(err) && (err.upgrade || err.status === 402);
}

export function PersonalTab(): React.JSX.Element {
  const home = useApi(
    () => cachedFresh('ai:personal:home', 5 * 60 * 1000, () => aiApi.aiPersonalHome()),
    [],
  );
  const [recapOpen, setRecapOpen] = useState(false);
  const recap = useApi(recapOpen ? () => cached('ai:personal:recap', () => aiApi.aiPersonalRecap()) : null, [recapOpen]);

  if (home.loading) {
    return (
      <View style={{ gap: spacing.xl, paddingTop: spacing.md }}>
        <Skeleton style={{ height: 20, width: '70%' }} />
        <RowSkeleton />
        <RowSkeleton />
      </View>
    );
  }
  if (home.error && isQuotaError(home.error)) {
    return <UpgradeCard message={isApiError(home.error) ? home.error.message : 'Daily AI quota reached'} />;
  }
  if (home.error) return <ErrorState message={home.error} onRetry={home.refetch} />;
  if (!home.data) return <View />;

  const d = home.data;
  return (
    <View style={{ gap: spacing.lg, paddingBottom: spacing.xl }}>
      {/* greeting + mood */}
      <View style={styles.greetingCard}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Ionicons name="sparkles" size={15} color={colors.roseSoft} />
          <View style={styles.moodChip}>
            <Text style={styles.moodText}>{d.mood}</Text>
          </View>
          {d.degraded ? (
            <View style={[styles.moodChip, styles.degradedChip]}>
              <Text style={[styles.moodText, { color: colors.amber }]}>offline mode</Text>
            </View>
          ) : null}
        </View>
        <Text style={styles.greeting}>{d.greeting}</Text>
        {d.aiProfile.tags.length > 0 ? (
          <View style={styles.tagRow}>
            {d.aiProfile.tags.slice(0, 8).map((tag, i) => (
              <View key={`${tag}-${i}`} style={styles.tag}>
                <Text style={styles.tagText}>{tag}</Text>
              </View>
            ))}
          </View>
        ) : null}
      </View>

      {d.quota ? <QuotaMeter quota={d.quota} /> : null}

      {/* daily picks */}
      <View>
        <SectionHeader title="Your daily picks" />
        {d.dailyPicks.length === 0 ? (
          <Text style={styles.hint}>Watch a few titles — the AI needs a taste to read.</Text>
        ) : (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.md }}>
            {d.dailyPicks.map((pick) => (
              <ContentCard key={pick.id} item={pick} width={126} reason={pick.reason} />
            ))}
          </ScrollView>
        )}
      </View>

      {/* because you watched */}
      {d.becauseYouWatched.length > 0 ? (
        <View>
          <SectionHeader title="Because you watched…" />
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.md }}>
            {d.becauseYouWatched.map((item) => (
              <ContentCard key={item.id} item={{ ...item, rating: null, year: null }} width={126} reason={item.because} />
            ))}
          </ScrollView>
        </View>
      ) : null}

      {/* weekly recap expander */}
      <View style={styles.recapCard}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={recapOpen ? 'Hide weekly recap' : 'Show weekly recap'}
          style={styles.recapHeader}
          onPress={() => setRecapOpen((v) => !v)}
        >
          <Ionicons name="calendar-outline" size={16} color={colors.emerald} />
          <Text style={styles.recapTitle}>Your week on Animaxia</Text>
          <Ionicons
            name={recapOpen ? 'chevron-up' : 'chevron-down'}
            size={16}
            color={colors.textDim}
          />
        </Pressable>
        {recapOpen ? (
          recap.loading ? (
            <View style={{ gap: 8, paddingVertical: spacing.md }}>
              <Skeleton style={{ height: 12, width: '80%' }} />
              <Skeleton style={{ height: 12, width: '60%' }} />
            </View>
          ) : recap.error ? (
            <ErrorState message={recap.error} onRetry={recap.refetch} compact />
          ) : recap.data ? (
            <View style={{ gap: 8 }}>
              <Text style={styles.recapText}>{recap.data.recap}</Text>
              <View style={styles.recapStatsRow}>
                <Text style={styles.recapStat}>{recap.data.stats.watched} watched</Text>
                {recap.data.stats.topGenres.slice(0, 2).map((g) => (
                  <Text key={g} style={styles.recapStatChip}>
                    {g}
                  </Text>
                ))}
              </View>
            </View>
          ) : (
            <Text style={styles.hint}>{d.recapPreview}</Text>
          )
        ) : (
          <Text style={styles.hint} numberOfLines={2}>
            {d.recapPreview}
          </Text>
        )}
      </View>

      {home.stale ? (
        <Pressable style={styles.staleRow} onPress={home.refetch}>
          <Ionicons name="cloud-offline-outline" size={13} color={colors.amber} />
          <Text style={styles.staleText}>cached — tap to refresh</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  greetingCard: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
    padding: spacing.lg,
    gap: spacing.md,
  },
  moodChip: {
    backgroundColor: colors.roseDark,
    borderRadius: radii.pill,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  moodText: { color: '#fff', fontSize: 10, fontWeight: '800', textTransform: 'capitalize' },
  degradedChip: { backgroundColor: 'rgba(251,191,36,0.15)' },
  greeting: { color: colors.text, fontSize: typography.body, lineHeight: 22, fontWeight: '600' },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  tag: {
    backgroundColor: colors.cardSoft,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radii.pill,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  tagText: { color: colors.roseSoft, fontSize: 10, fontWeight: '600' },

  hint: { color: colors.textMuted, fontSize: typography.tiny, lineHeight: 17 },

  recapCard: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
    padding: spacing.lg,
    gap: spacing.md,
  },
  recapHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  recapTitle: { flex: 1, color: colors.text, fontSize: typography.small, fontWeight: '800' },
  recapText: { color: colors.textMuted, fontSize: typography.small, lineHeight: 20 },
  recapStatsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  recapStat: { color: colors.emerald, fontSize: typography.tiny, fontWeight: '700' },
  recapStatChip: {
    color: colors.text,
    fontSize: 10,
    backgroundColor: colors.cardSoft,
    borderRadius: radii.sm,
    paddingHorizontal: 8,
    paddingVertical: 3,
    overflow: 'hidden',
  },

  staleRow: { flexDirection: 'row', alignItems: 'center', gap: 6, justifyContent: 'center' },
  staleText: { color: colors.amber, fontSize: 10 },
});

export default PersonalTab;
