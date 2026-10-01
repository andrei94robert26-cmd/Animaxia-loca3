/**
 * components/states.tsx — Loading / empty / error / offline / auth states.
 *
 *   Skeleton        pulsing placeholder block
 *   RowSkeleton     a full horizontal-row placeholder
 *   GridSkeleton    a 2-column grid placeholder
 *   EmptyState      icon + title + message
 *   ErrorState      message + retry button (compact mode for inline cards)
 *   OfflineBanner   "offline — showing cached" strip (stale-while-error)
 *   SignInCard      auth-gated placeholder linking to the Login modal
 *   UpgradeCard     402 quota response → link to Premium
 *
 * Phase 6: navigation goes through the React Navigation module ref
 * (app/navigation/helpers.ts) instead of expo-router.
 */

import React, { useEffect, useRef } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { navigateTo } from '../navigation/helpers';
import { colors, radii, spacing, typography } from '../utils/theme';

/* --------------------------------- Skeleton --------------------------------- */

export function Skeleton({ style }: { style?: object | number | Array<object | number | undefined> }): React.JSX.Element {
  const pulse = useRef(new Animated.Value(0.45)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 650, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.45, duration: 650, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  return <Animated.View style={[styles.skeleton, { opacity: pulse }, style] as never} />;
}

export function RowSkeleton(): React.JSX.Element {
  return (
    <View style={styles.rowSkeletonWrap}>
      <Skeleton style={{ width: 140, height: 16, borderRadius: 6 }} />
      <View style={styles.rowSkeletonCards}>
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} style={{ width: 108, aspectRatio: 2 / 3, borderRadius: radii.md }} />
        ))}
      </View>
    </View>
  );
}

export function GridSkeleton({ count = 6 }: { count?: number }): React.JSX.Element {
  return (
    <View style={styles.gridSkeleton}>
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} style={{ flex: 1, aspectRatio: 2 / 3, borderRadius: radii.md }} />
      ))}
    </View>
  );
}

/* -------------------------------- Empty/Error ------------------------------- */

export function EmptyState({
  icon = 'leaf-outline',
  title,
  message,
}: {
  icon?: string;
  title: string;
  message?: string;
}): React.JSX.Element {
  return (
    <View style={styles.centered}>
      <Ionicons name={icon as never} size={34} color={colors.textDim} />
      <Text style={styles.emptyTitle}>{title}</Text>
      {message ? <Text style={styles.emptyMessage}>{message}</Text> : null}
    </View>
  );
}

export function ErrorState({
  message,
  onRetry,
  compact = false,
}: {
  message: string;
  onRetry?: () => void;
  compact?: boolean;
}): React.JSX.Element {
  return (
    <View style={[styles.errorCard, compact && styles.errorCardCompact]}>
      <View style={{ flex: 1, gap: 4 }}>
        <Text style={styles.errorTitle}>Something broke</Text>
        <Text style={styles.errorMessage} numberOfLines={compact ? 2 : 4}>
          {message}
        </Text>
      </View>
      {onRetry ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Retry" style={styles.retryButton} onPress={onRetry}>
          <Ionicons name="refresh" size={15} color={colors.rose} />
          <Text style={styles.retryText}>Retry</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/* --------------------------------- Offline ---------------------------------- */

export function OfflineBanner({ visible }: { visible: boolean }): React.JSX.Element | null {
  if (!visible) return null;
  return (
    <View style={styles.offlineBanner}>
      <Ionicons name="cloud-offline-outline" size={14} color={colors.amber} />
      <Text style={styles.offlineText}>Offline — showing your cached Animaxia</Text>
    </View>
  );
}

/* ---------------------------------- Auth ------------------------------------ */

export function SignInCard({ message = 'Sign in to unlock this.' }: { message?: string }): React.JSX.Element {
  return (
    <View style={styles.signInCard}>
      <Ionicons name="lock-closed-outline" size={24} color={colors.roseSoft} />
      <Text style={styles.signInMessage}>{message}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Sign in"
        style={styles.signInButton}
        onPress={() => navigateTo('Login')}
      >
        <Text style={styles.signInButtonText}>Sign in</Text>
      </Pressable>
    </View>
  );
}

export function UpgradeCard({ message }: { message: string }): React.JSX.Element {
  return (
    <View style={styles.upgradeCard}>
      <Ionicons name="flash-outline" size={20} color={colors.amber} />
      <Text style={styles.upgradeMessage}>{message}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="See premium plans"
        style={styles.upgradeButton}
        onPress={() => navigateTo('Premium')}
      >
        <Text style={styles.upgradeButtonText}>Upgrade</Text>
      </Pressable>
    </View>
  );
}

/* ---------------------------------- styles ---------------------------------- */

const styles = StyleSheet.create({
  skeleton: { backgroundColor: colors.skeleton },

  rowSkeletonWrap: { gap: spacing.md, marginTop: spacing.xl },
  rowSkeletonCards: { flexDirection: 'row', gap: spacing.md },
  gridSkeleton: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, marginTop: spacing.md },

  centered: { alignItems: 'center', gap: 8, paddingVertical: spacing.xxl },
  emptyTitle: { color: colors.text, fontSize: typography.body, fontWeight: '700' },
  emptyMessage: { color: colors.textMuted, fontSize: typography.small, textAlign: 'center' },

  errorCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.card,
    borderStyle: 'dashed',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    padding: spacing.lg,
    marginTop: spacing.md,
  },
  errorCardCompact: { padding: spacing.md },
  errorTitle: { color: colors.text, fontSize: typography.small, fontWeight: '700' },
  errorMessage: { color: colors.textMuted, fontSize: typography.tiny },
  retryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: colors.roseDark,
    borderRadius: radii.pill,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  retryText: { color: '#fff', fontSize: typography.tiny, fontWeight: '700' },

  offlineBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    backgroundColor: 'rgba(251,191,36,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(251,191,36,0.3)',
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    marginTop: spacing.sm,
  },
  offlineText: { color: colors.amber, fontSize: typography.tiny, fontWeight: '600' },

  signInCard: {
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
    padding: spacing.xxl,
    marginTop: spacing.md,
  },
  signInMessage: { color: colors.textMuted, fontSize: typography.small, textAlign: 'center' },
  signInButton: {
    backgroundColor: colors.rose,
    borderRadius: radii.pill,
    paddingHorizontal: 22,
    paddingVertical: 9,
  },
  signInButtonText: { color: '#fff', fontSize: typography.small, fontWeight: '700' },

  upgradeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: 'rgba(251,191,36,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(251,191,36,0.3)',
    borderRadius: radii.md,
    padding: spacing.md,
    marginTop: spacing.md,
  },
  upgradeMessage: { flex: 1, color: colors.text, fontSize: typography.tiny },
  upgradeButton: {
    backgroundColor: colors.amber,
    borderRadius: radii.pill,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  upgradeButtonText: { color: '#1c1200', fontSize: typography.tiny, fontWeight: '800' },
});
