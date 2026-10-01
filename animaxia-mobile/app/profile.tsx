/**
 * app/profile.tsx — Account hub (GET /api/mobile/profile — the mobile BFF
 * card: user · plan · limits · watchlistCount · recentHistory).
 *
 *   • avatar picker → POST /api/users/me/avatar (base64 data-URL ≤ 512KB)
 *   • plan card with live limits (planLimits) + upgrade link
 *   • watchlist count → /watchlist
 *   • continue-watching history rows → /player/:id
 *   • taste preferences editor (types / genres) → PUT /api/users/me/preferences
 *   • connection target (gateway/monolith) + logout
 */

import React, { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { colors, radii, spacing, typography, planColor } from '../theme';
import { useAuth } from '../auth/useAuth';
import { useApi } from '../hooks/useApi';
import { apiTargetLabel } from '../api/config';
import * as mobileApi from '../api/mobile';
import * as usersApi from '../api/users';
import { Screen } from '../components/Screen';
import { BottomNav } from '../components/BottomNav';
import { Thumb } from '../components/content';
import { ErrorState, OfflineBanner, SignInCard, Skeleton } from '../components/states';

const TYPE_SUGGESTIONS = ['anime', 'movie', 'tv', 'sports', 'news'];
const GENRE_SUGGESTIONS = ['Action', 'Comedy', 'Drama', 'Fantasy', 'Sci-Fi', 'Slice of Life', 'Thriller'];

export default function ProfileScreen(): React.JSX.Element {
  const { user, initializing, logout, updateUser } = useAuth();
  const profile = useApi(user ? mobileApi.getProfileCached : null, [user?.id]);
  const [busy, setBusy] = useState(false);
  const [prefDraft, setPrefDraft] = useState<{ types?: string[]; genres?: string[] } | null>(null);

  if (!user && !initializing) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <Screen title="Profile" back={false}>
          <SignInCard message="Sign in to sync your watchlist, history, plan and AI taste across Animaxia." />
        </Screen>
        <BottomNav />
      </View>
    );
  }

  const pickAvatar = async () => {
    setBusy(true);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.7,
        base64: true,
      });
      const asset = result.assets?.[0];
      if (!result.canceled && asset?.base64) {
        const dataUrl = `data:image/jpeg;base64,${asset.base64}`;
        const updated = await usersApi.uploadAvatar(dataUrl);
        updateUser(updated);
        profile.refetch();
      }
    } catch (err) {
      Alert.alert('Avatar', err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  };

  const prefs = prefDraft ?? {
    types: (user?.preferences?.types as string[] | undefined) ?? [],
    genres: (user?.preferences?.genres as string[] | undefined) ?? [],
  };

  const togglePref = (key: 'types' | 'genres', value: string) => {
    setPrefDraft({
      ...prefs,
      [key]: prefs[key]?.includes(value) ? prefs[key]?.filter((v) => v !== value) : [...(prefs[key] ?? []), value],
    });
  };

  const savePrefs = async () => {
    if (!prefDraft) return;
    setBusy(true);
    try {
      await usersApi.putPreferences(prefDraft);
      const me = await usersApi.getMe();
      updateUser(me.user);
      setPrefDraft(null);
      profile.refetch();
    } catch (err) {
      Alert.alert('Preferences', err instanceof Error ? err.message : 'Could not save preferences');
    } finally {
      setBusy(false);
    }
  };

  const plan = profile.data?.plan ?? user?.plan ?? 'free';
  const limits = profile.data?.limits ?? { watchlist: 20, history: 50, aiPerDay: 10, quality: 'sd' };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Screen title="Profile" back={false}>
        <OfflineBanner visible={profile.stale} />

        {/* identity card */}
        <View style={styles.identityCard}>
          <Pressable accessibilityRole="button" accessibilityLabel="Change avatar" onPress={pickAvatar} disabled={busy}>
            {user?.avatar ? (
              <Thumb uri={user.avatar} style={styles.avatar} iconSize={20} />
            ) : (
              <View style={[styles.avatar, styles.avatarFallback]}>
                <Text style={styles.avatarLetter}>{(user?.username ?? '?').slice(0, 1).toUpperCase()}</Text>
              </View>
            )}
            <View style={styles.avatarEdit}>
              <Ionicons name="camera" size={11} color="#fff" />
            </View>
          </Pressable>
          <View style={{ flex: 1, gap: 3 }}>
            <Text style={styles.username}>{user?.username ?? '…'}</Text>
            <Text style={styles.email} numberOfLines={1}>
              {user?.email ?? ''}
            </Text>
            {user?.role === 'admin' ? (
              <View style={styles.adminChip}>
                <Text style={styles.adminText}>ADMIN</Text>
              </View>
            ) : null}
          </View>
        </View>

        {/* plan card */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open premium plans"
          style={styles.planCard}
          onPress={() => router.navigate('/premium' as never)}
        >
          <View style={styles.planTop}>
            <View style={[styles.planChip, { backgroundColor: (planColor[plan] ?? colors.zinc) + '26' }]}>
              <Text style={[styles.planChipText, { color: planColor[plan] ?? colors.zinc }]}>{plan.toUpperCase()}</Text>
            </View>
            <Text style={styles.planLimitText}>
              {limits.watchlist < 0 ? '∞ watchlist' : `${limits.watchlist} watchlist`} · {limits.aiPerDay} AI/day ·{' '}
              {String(limits.quality).toUpperCase()}
            </Text>
            <Ionicons name="chevron-forward" size={15} color={colors.textDim} />
          </View>
          <Text style={styles.planHint}>
            {plan === 'free' ? 'Tap to see Plus & Pro — more AI, more storage, better quality.' : 'Manage your subscription'}
          </Text>
        </Pressable>

        {/* stats row */}
        <View style={styles.statsRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open watchlist"
            style={styles.statCard}
            onPress={() => router.navigate('/watchlist' as never)}
          >
            <Text style={styles.statValue}>{profile.data?.watchlistCount ?? '—'}</Text>
            <Text style={styles.statLabel}>Watchlist</Text>
          </Pressable>
          <View style={[styles.statCard, styles.statCardDisabled]}>
            <Text style={styles.statValue}>{profile.data?.recentHistory.length ?? 0}</Text>
            <Text style={styles.statLabel}>Recent</Text>
          </View>
          <View style={[styles.statCard, styles.statCardDisabled]}>
            <Text style={styles.statValue}>{user?.plan?.toUpperCase() ?? '—'}</Text>
            <Text style={styles.statLabel}>Plan</Text>
          </View>
        </View>

        {/* continue watching */}
        {profile.data && profile.data.recentHistory.length > 0 ? (
          <View style={{ gap: spacing.md, marginTop: spacing.xl }}>
            <Text style={styles.sectionTitle}>Continue watching</Text>
            {profile.data.recentHistory.slice(0, 5).map((entry) => (
              <Pressable
                key={entry.content.id}
                accessibilityRole="button"
                accessibilityLabel={`Resume ${entry.content.title}`}
                style={styles.historyRow}
                onPress={() => router.navigate(`/player/${entry.content.id}` as never)}
              >
                <Thumb uri={entry.content.thumbnail} style={styles.historyThumb} iconSize={14} />
                <View style={{ flex: 1, gap: 4 }}>
                  <Text style={styles.historyTitle} numberOfLines={1}>
                    {entry.content.title}
                  </Text>
                  <View style={styles.progressTrack}>
                    <View style={[styles.progressFill, { width: `${Math.max(4, Math.min(100, entry.progress))}%` as never }]} />
                  </View>
                </View>
                <Text style={styles.progressText}>{Math.round(entry.progress)}%</Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        {/* preferences */}
        <View style={{ gap: spacing.md, marginTop: spacing.xl }}>
          <Text style={styles.sectionTitle}>Your taste — feeds the AI</Text>
          {(['types', 'genres'] as const).map((key) => {
            const suggestions = key === 'types' ? TYPE_SUGGESTIONS : GENRE_SUGGESTIONS;
            const selected = prefs[key] ?? [];
            return (
              <View key={key} style={styles.prefCard}>
                <Text style={styles.prefTitle}>{key === 'types' ? 'Content types' : 'Genres'}</Text>
                <View style={styles.prefChipRow}>
                  {suggestions.map((value) => {
                    const on = selected.includes(value);
                    return (
                      <Pressable
                        key={value}
                        accessibilityRole="button"
                        accessibilityLabel={`${on ? 'Remove' : 'Add'} ${value}`}
                        style={[styles.prefChip, on && styles.prefChipOn]}
                        onPress={() => togglePref(key, value)}
                      >
                        <Text style={[styles.prefChipText, on && styles.prefChipTextOn]}>{value}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            );
          })}
          {prefDraft ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Save preferences"
              style={[styles.saveButton, busy && styles.saveButtonDisabled]}
              disabled={busy}
              onPress={savePrefs}
            >
              <Text style={styles.saveButtonText}>{busy ? 'Saving…' : 'Save preferences'}</Text>
            </Pressable>
          ) : null}
        </View>

        {/* connection + logout */}
        <View style={styles.footerCard}>
          <View style={styles.connectionRow}>
            <Ionicons name="server-outline" size={12} color={colors.textDim} />
            <Text style={styles.connectionText}>API: {apiTargetLabel()}</Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Log out"
            style={styles.logoutButton}
            onPress={() => void logout()}
          >
            <Ionicons name="log-out-outline" size={15} color={colors.red} />
            <Text style={styles.logoutText}>Log out</Text>
          </Pressable>
        </View>
      </Screen>
      <BottomNav />
    </View>
  );
}

const styles = StyleSheet.create({
  identityCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
    padding: spacing.lg,
  },
  avatar: { width: 64, height: 64, borderRadius: 32 },
  avatarFallback: { backgroundColor: colors.roseDark, alignItems: 'center', justifyContent: 'center' },
  avatarLetter: { color: '#fff', fontSize: typography.h1, fontWeight: '900' },
  avatarEdit: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.rose,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: colors.bg,
  },
  username: { color: colors.text, fontSize: typography.h2, fontWeight: '800' },
  email: { color: colors.textMuted, fontSize: typography.tiny },
  adminChip: {
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(251,191,36,0.15)',
    borderRadius: radii.sm,
    paddingHorizontal: 7,
    paddingVertical: 2,
    marginTop: 4,
  },
  adminText: { color: colors.amber, fontSize: 9, fontWeight: '800' },

  planCard: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
    padding: spacing.lg,
    gap: 8,
    marginTop: spacing.md,
  },
  planTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  planChip: { borderRadius: radii.sm, paddingHorizontal: 9, paddingVertical: 4 },
  planChipText: { fontSize: typography.tiny, fontWeight: '900', letterSpacing: 0.5 },
  planLimitText: { flex: 1, color: colors.textMuted, fontSize: typography.tiny, fontWeight: '600' },
  planHint: { color: colors.textDim, fontSize: 10 },

  statsRow: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.md },
  statCard: {
    flex: 1,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    alignItems: 'center',
    paddingVertical: spacing.md,
    gap: 3,
  },
  statCardDisabled: { opacity: 0.85 },
  statValue: { color: colors.text, fontSize: typography.h2, fontWeight: '900' },
  statLabel: { color: colors.textDim, fontSize: 10, fontWeight: '700' },

  sectionTitle: { color: colors.text, fontSize: typography.body, fontWeight: '800' },
  historyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radii.md,
    padding: spacing.md,
  },
  historyThumb: { width: 78, height: 50, borderRadius: radii.sm },
  historyTitle: { color: colors.text, fontSize: typography.tiny, fontWeight: '700' },
  progressTrack: { height: 4, borderRadius: 2, backgroundColor: colors.borderSoft, overflow: 'hidden' },
  progressFill: { height: '100%' as never, backgroundColor: colors.rose },
  progressText: { color: colors.textDim, fontSize: 10, fontWeight: '700' },

  prefCard: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.sm,
  },
  prefTitle: { color: colors.textMuted, fontSize: typography.tiny, fontWeight: '700' },
  prefChipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  prefChip: {
    backgroundColor: colors.cardSoft,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.pill,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  prefChipOn: { backgroundColor: colors.rose, borderColor: colors.rose },
  prefChipText: { color: colors.textMuted, fontSize: typography.tiny, fontWeight: '600' },
  prefChipTextOn: { color: '#fff', fontWeight: '800' },
  saveButton: {
    backgroundColor: colors.rose,
    borderRadius: radii.md,
    alignItems: 'center',
    paddingVertical: 12,
  },
  saveButtonDisabled: { opacity: 0.5 },
  saveButtonText: { color: '#fff', fontSize: typography.small, fontWeight: '800' },

  footerCard: { marginTop: spacing.xxl, gap: spacing.md, paddingBottom: spacing.sm },
  connectionRow: { flexDirection: 'row', alignItems: 'center', gap: 6, justifyContent: 'center' },
  connectionText: { color: colors.textDim, fontSize: 10 },
  logoutButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    backgroundColor: 'rgba(248,113,113,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(248,113,113,0.25)',
    borderRadius: radii.md,
    paddingVertical: 12,
  },
  logoutText: { color: colors.red, fontSize: typography.small, fontWeight: '700' },
});
