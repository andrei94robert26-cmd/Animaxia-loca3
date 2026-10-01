/**
 * components/Segmented.tsx — Pill segmented control (iOS-style) used for view
 * switches (Feed: Social | AI, AI hub: Personal | Assistant, AI panel modes).
 */

import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';
import { colors, radii, spacing, typography } from '../theme';

export interface SegmentOption<K extends string> {
  value: K;
  label: string;
  icon?: string;
}

export function Segmented<K extends string>({
  options,
  value,
  onChange,
}: {
  options: SegmentOption<K>[];
  value: K;
  onChange: (value: K) => void;
}): React.JSX.Element {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.trackScroll}
      contentContainerStyle={styles.track}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            style={[styles.option, active && styles.optionActive]}
            onPress={() => onChange(option.value)}
          >
            <Text style={[styles.optionLabel, active && styles.optionLabelActive]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  trackScroll: { flexGrow: 0 },
  track: {
    flexDirection: 'row',
    backgroundColor: colors.card,
    borderRadius: radii.pill,
    padding: 4,
    gap: 4,
  },
  option: {
    paddingHorizontal: spacing.lg,
    height: 36,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  optionActive: { backgroundColor: colors.rose },
  optionLabel: { color: colors.textMuted, fontSize: typography.small, fontWeight: '600' },
  optionLabelActive: { color: '#fff', fontWeight: '700' },
});

export default Segmented;
