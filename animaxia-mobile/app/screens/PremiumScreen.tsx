/**
 * app/screens/PremiumScreen.tsx — Plans + upgrade (Premium stack screen).
 *
 *   GET  /api/premium/plans (public catalog: free · plus $4.99 · pro $9.99)
 *   GET  /api/premium/me    (auth — current plan, subscription, usage)
 *   POST /api/premium/checkout { plan } → { sessionId, url, mode }
 *     · mode 'sandbox' (no STRIPESECRETKEY) — the session is simulated
 *       server-side; the app confirms inline: POST /confirm { sessionId }
 *     · mode 'stripe' — url is a real Stripe Checkout page: Linking.openURL,
 *       then confirm when the user returns
 *   POST /api/premium/cancel
 *
 * The current plan card shows limits + usage; upgrades highlight what changes
 * (AI/day, watchlist, quality) with the same per-plan quota the AI hub shows.
 *
 * Phase 6: straight conversion from expo-router to React Navigation — no
 * route calls lived here, only the import paths moved (../utils/theme,
 * ../hooks/useAuth).
 */

import React, { useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, radii, spacing, typography } from '../utils/theme';
import { useAuth } from '../hooks/useAuth';
import { useApi } from '../hooks/useApi';
import { cached, cachedFresh } from '../api/cache';
import * as premiumApi from '../api/premium';
import type { PremiumPlan } from '../api/premium';
import { formatPrice, limitsLabel, PLAN_ORDER } from '../premium/plans';
import { Screen } from '../components/Screen';
import { ErrorState, SignInCard, Skeleton } from '../components/states';

interface PendingCheckout {
  plan: 'plus' | 'pro';
  sessionId: string;
  mode: string;
}

export default function PremiumScreen(): React.JSX.Element {
  const { user, updateUser } = useAuth();
  const plans = useApi(() => cachedFresh('premium:plans', 10 * 60 * 1000, () => premiumApi.getPlans()), []);
  // cached() wraps PremiumMe into { data, stale } for useApi (getPremiumMe
  // alone returns a bare payload — the Phase-5 screen fed it to useApi as-is,
  // so me.data was always undefined and the plan fell back to the auth user).
  const me = useApi(user ? () => cached('premium:me', () => premiumApi.getPremiumMe()) : null, [user?.id]);
  const [pending, setPending] = useState<PendingCheckout | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const currentPlan = me.data?.plan ?? user?.plan ?? 'free';

  const startCheckout = async (plan: 'plus' | 'pro') => {
    if (!user) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const session = await premiumApi.checkout(plan);
      if (session.mode === 'stripe' && session.url.startsWith('http')) {
        void Linking.openURL(session.url).catch(() => undefined);
        setPending({ plan, sessionId: session.sessionId, mode: session.mode });
        setNotice('Complete the payment in your browser, then tap “I’ve paid”.');
      } else {
        // Sandbox — the backend simulates the session; confirm inline.
        setPending({ plan, sessionId: session.sessionId, mode: session.mode });
        setNotice(`Sandbox checkout ready for ${plan.toUpperCase()} — activate below (Stripe key not configured).`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Checkout failed');
    } finally {
      setBusy(false);
    }
  };

  const confirmCheckout = async () => {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await premiumApi.confirm(pending.sessionId);
      updateUser(updated);
      setNotice(`You're on ${updated.plan.toUpperCase()} — enjoy the boost!`);
      setPending(null);
      me.refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Confirmation failed');
    } finally {
      setBusy(false);
    }
  };

  const cancelSubscription = async () => {
    setBusy(true);
    setError(null);
    try {
      const sub = await premiumApi.cancel();
      setNotice(sub ? `Subscription ${sub.status}.` : 'Cancelled — you stay on the plan until the period ends.');
      me.refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Cancel failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title="Animaxia Premium">
      {!user ? (
        <SignInCard message="Sign in to upgrade — your plan unlocks AI quota, watchlist size and stream quality." />
      ) : null}

      <Text style={styles.blurb}>
        One subscription across web and mobile. Plans raise your daily AI quota (10 → 100 → 500), watchlist size and
        stream quality.
      </Text>

      {notice ? (
        <View style={styles.noticeCard}>
          <Ionicons name="checkmark-circle-outline" size={14} color={colors.emerald} />
          <Text style={styles.noticeText}>{notice}</Text>
        </View>
      ) : null}
      {error ? <ErrorState message={error} compact onRetry={() => setError(null)} /> : null}

      {pending ? (
        <View style={styles.pendingCard}>
          <Text style={styles.pendingTitle}>
            {pending.mode === 'stripe' ? 'Waiting for payment' : `Activate ${pending.plan.toUpperCase()} (sandbox)`}
          </Text>
          <Text style={styles.pendingText}>
            {pending.mode === 'stripe'
              ? 'Finish the Stripe checkout in your browser, then confirm here.'
              : 'No Stripe key is configured — confirm to activate the sandbox subscription instantly.'}
          </Text>
          <View style={{ flexDirection: 'row', gap: spacing.sm }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Confirm subscription"
              style={[styles.confirmButton, busy && styles.disabled]}
              disabled={busy}
              onPress={() => void confirmCheckout()}
            >
              <Text style={styles.confirmText}>{pending.mode === 'stripe' ? "I've paid" : 'Activate'}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Cancel checkout"
              style={styles.abortButton}
              onPress={() => setPending(null)}
            >
              <Text style={styles.abortText}>Dismiss</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {plans.loading ? (
        <View style={{ gap: spacing.md }}>
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} style={{ height: 190, borderRadius: radii.lg }} />
          ))}
        </View>
      ) : plans.error ? (
        <ErrorState message={plans.error} onRetry={plans.refetch} />
      ) : plans.data ? (
        <View style={{ gap: spacing.lg, marginTop: spacing.md }}>
          {PLAN_ORDER.map((key) => {
            const plan = plans.data?.data.find((p) => p.key === key) as PremiumPlan | undefined;
            if (!plan) return null;
            const isCurrent = plan.key === currentPlan;
            return (
              <View
                key={plan.key}
                style={[styles.planCard, isCurrent && styles.planCardCurrent, plan.highlight && styles.planCardHighlight]}
              >
                <View style={styles.planHeader}>
                  <Text style={[styles.planName, plan.highlight && styles.planNameHighlight]}>{plan.name}</Text>
                  {isCurrent ? (
                    <View style={styles.currentBadge}>
                      <Text style={styles.currentBadgeText}>CURRENT</Text>
                    </View>
                  ) : null}
                </View>
                <Text style={styles.planPrice}>{formatPrice(plan)}</Text>
                <Text style={styles.planLimits}>{limitsLabel(plan)}</Text>
                <View style={{ gap: 7 }}>
                  {plan.features.map((feature) => (
                    <View key={feature} style={styles.featureRow}>
                      <Ionicons name="checkmark" size={12} color={plan.highlight ? colors.rose : colors.emerald} />
                      <Text style={styles.featureText}>{feature}</Text>
                    </View>
                  ))}
                </View>
                {user && !isCurrent && plan.key !== 'free' ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Upgrade to ${plan.name}`}
                    style={[styles.upgradeButton, plan.highlight && styles.upgradeButtonHighlight, busy && styles.disabled]}
                    disabled={busy}
                    onPress={() => void startCheckout(plan.key as 'plus' | 'pro')}
                  >
                    <Text style={styles.upgradeText}>Get {plan.name}</Text>
                  </Pressable>
                ) : null}
              </View>
            );
          })}

          {user && currentPlan !== 'free' && !pending ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Cancel subscription"
              style={styles.cancelButton}
              disabled={busy}
              onPress={() => void cancelSubscription()}
            >
              <Text style={styles.cancelText}>Cancel subscription</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  blurb: { color: colors.textMuted, fontSize: typography.small, lineHeight: 20, marginBottom: spacing.md },
  noticeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(52,211,153,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(52,211,153,0.3)',
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    marginBottom: spacing.md,
  },
  noticeText: { flex: 1, color: colors.emerald, fontSize: typography.tiny, fontWeight: '600' },

  pendingCard: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.rose,
    borderRadius: radii.lg,
    padding: spacing.lg,
    gap: spacing.md,
    marginBottom: spacing.md,
  },
  pendingTitle: { color: colors.text, fontSize: typography.body, fontWeight: '800' },
  pendingText: { color: colors.textMuted, fontSize: typography.tiny, lineHeight: 16 },
  confirmButton: {
    backgroundColor: colors.rose,
    borderRadius: radii.md,
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  confirmText: { color: '#fff', fontSize: typography.small, fontWeight: '800' },
  abortButton: {
    backgroundColor: colors.cardSoft,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  abortText: { color: colors.textMuted, fontSize: typography.small, fontWeight: '700' },

  planCard: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  planCardCurrent: { borderColor: colors.emerald, borderWidth: 1.5 },
  planCardHighlight: { borderColor: 'rgba(244,63,94,0.55)', borderWidth: 1.5 },
  planHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  planName: { color: colors.text, fontSize: typography.h2, fontWeight: '900', flex: 1 },
  planNameHighlight: { color: colors.roseSoft },
  currentBadge: {
    backgroundColor: 'rgba(52,211,153,0.15)',
    borderRadius: radii.sm,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  currentBadgeText: { color: colors.emerald, fontSize: 9, fontWeight: '800', letterSpacing: 0.5 },
  planPrice: { color: colors.text, fontSize: typography.title, fontWeight: '800' },
  planLimits: { color: colors.textDim, fontSize: 10, marginBottom: 4 },
  featureRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  featureText: { color: colors.textMuted, fontSize: typography.tiny, flex: 1 },
  upgradeButton: {
    backgroundColor: colors.cardSoft,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    alignItems: 'center',
    paddingVertical: 12,
    marginTop: 6,
  },
  upgradeButtonHighlight: { backgroundColor: colors.rose, borderColor: colors.rose },
  upgradeText: { color: colors.text, fontSize: typography.small, fontWeight: '800' },
  disabled: { opacity: 0.5 },

  cancelButton: { alignItems: 'center', paddingVertical: spacing.md },
  cancelText: { color: colors.textDim, fontSize: typography.tiny, textDecorationLine: 'underline' },
});
