/**
 * components/Screen.tsx — Shared screen chrome: safe-area wrapper, optional
 * header (title + back arrow), scroll-or-plain body, bottom padding so the
 * BottomNav never covers content, and pull-to-refresh support.
 *
 * Phase 6: back navigation goes through the React Navigation module ref
 * (app/navigation/helpers.ts) instead of expo-router.
 */

import React from 'react';
import { ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { Pressable, Text } from 'react-native';
import ChevronLeft from '@expo/vector-icons/Ionicons';
import { goBackOrHome } from '../navigation/helpers';
import { colors, spacing, typography, radii } from '../utils/theme';

export interface ScreenProps {
  title?: string;
  /** Show the back arrow (default: auto — hidden on tab roots). */
  back?: boolean;
  /** Right side of the header (badge, button…). */
  headerRight?: React.ReactNode;
  /** Wrap the body in a ScrollView (default true). */
  scroll?: boolean;
  refreshControl?: React.ComponentProps<typeof ScrollView>['refreshControl'];
  contentContainerStyle?: StyleProp<ViewStyle>;
  /** Extra bottom padding when a sticky action bar is stacked (default 96). */
  bottomPadding?: number;
  children: React.ReactNode;
}

export function Screen({
  title,
  back = true,
  headerRight,
  scroll = true,
  refreshControl,
  contentContainerStyle,
  bottomPadding = 96,
  children,
}: ScreenProps): React.JSX.Element {
  const body = scroll ? (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={[styles.scrollContent, { paddingBottom: bottomPadding }, contentContainerStyle]}
      showsVerticalScrollIndicator={false}
      refreshControl={refreshControl}
    >
      {children}
    </ScrollView>
  ) : (
    <View style={[styles.plain, { paddingBottom: Math.min(bottomPadding, 24) }]}>{children}</View>
  );

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <StatusBar style="light" backgroundColor={colors.bg} />
      {title ? (
        <View style={styles.header}>
          {back ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Go back"
              style={styles.backButton}
              onPress={() => goBackOrHome()}
              hitSlop={8}
            >
              <ChevronLeft name="chevron-back" size={22} color={colors.text} />
            </Pressable>
          ) : null}
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
          {headerRight ? <View style={styles.headerRight}>{headerRight}</View> : null}
        </View>
      ) : null}
      {body}
    </SafeAreaView>
  );
}

/** Section title used across screens. */
export function SectionHeader({
  title,
  action,
}: {
  title: string;
  action?: React.ReactNode;
}): React.JSX.Element {
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {action}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: spacing.lg },
  plain: { flex: 1, paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    gap: spacing.sm,
  },
  backButton: {
    width: 34,
    height: 34,
    borderRadius: radii.pill,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { flex: 1, color: colors.text, fontSize: typography.h1, fontWeight: '700' },
  headerRight: { marginLeft: 'auto' },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.xl,
    marginBottom: spacing.md,
  },
  sectionTitle: { color: colors.text, fontSize: typography.h2, fontWeight: '700' },
});

export default Screen;
