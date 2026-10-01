/**
 * components/QuotaMeter.tsx — Per-plan AI quota meter.
 *
 * Every AI Cloud response carries quota: { plan, used, limit, perMinute }
 * (free 10/day · plus 100/day · pro 500/day · anonymous 5/day per IP).
 * The meter shows used/limit with a progress bar; ≥ 80% turns amber and
 * invites an upgrade (tap → Premium screen).
 *
 * Phase 6: navigation goes through the React Navigation module ref
 * (app/navigation/helpers.ts) instead of expo-router.
 */

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { navigateTo } from '../navigation/helpers';
import { colors, radii, spacing, typography } from '../utils/theme';
import type { AiCloudQuota } from '../api/ai';

export function QuotaMeter({ quota }: { quota: AiCloudQuota }): React.JSX.Element {
  const pct = quota.limit > 0 ? Math.min(100, (quota.used / quota.limit) * 100) : 0;
  const tight = pct >= 80;
  const barColor = tight ? colors.amber : colors.rose;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`AI quota ${quota.used} of ${quota.limit} used`}
      style={styles.wrap}
      onPress={() => navigateTo('Premium')}
    >
      <View style={styles.headerRow}>
        <View style={styles.planChip}>
          <Text style={styles.planText}>{quota.plan.toUpperCase()}</Text>
        </View>
        <Text style={styles.countText}>
          {quota.used}/{quota.limit} AI today
        </Text>
        {tight ? <Ionicons name="arrow-up-circle" size={14} color={colors.amber} /> : null}
      </View>
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${Math.max(pct, 3)}%` as never, backgroundColor: barColor }]} />
      </View>
      <Text style={styles.hint}>{tight ? 'Tap to raise your daily limit' : 'Resets daily · per-plan limits'}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: 8,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  planChip: {
    backgroundColor: colors.roseDark,
    borderRadius: radii.sm,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  planText: { color: '#fff', fontSize: 10, fontWeight: '800', letterSpacing: 0.5 },
  countText: { color: colors.text, fontSize: typography.tiny, fontWeight: '600', flex: 1 },
  track: { height: 5, borderRadius: 3, backgroundColor: colors.borderSoft, overflow: 'hidden' },
  fill: { height: '100%' as never, borderRadius: 3 },
  hint: { color: colors.textDim, fontSize: 10 },
});

export default QuotaMeter;
