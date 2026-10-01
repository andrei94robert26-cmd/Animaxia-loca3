/**
 * screens/PremiumScreen.tsx — Plans + upgrade (route /premium).
 *
 *   GET  /api/premium/plans (public, offline-cached → PlanGrid)
 *   GET  /api/premium/me    (auth, offline-cached → current plan + usage)
 *   POST /api/premium/checkout { plan } → { sessionId, url, mode }
 *     · mode 'sandbox' (no STRIPESECRETKEY) — the session is simulated
 *       server-side; inline confirm sheet → POST /confirm { sessionId }
 *     · mode 'stripe' — real Stripe Checkout: window.open (the main process
 *       routes it to the OS browser), then "I've paid — confirm" here
 *   POST /api/premium/cancel (active subscription only, 2-step confirm)
 *
 * The screen owns the checkout state machine; PlanGrid is presentational.
 */

import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle2, Sparkles } from 'lucide-react';
import { useAuth } from '@/auth/AuthContext';
import { getPremiumMe, checkout, confirm as confirmCheckout, cancel as cancelSubscription } from '@/api/premium';
import { cacheDrop, cached } from '@/api/cache';
import { errorMessage, isApiError } from '@/api/client';
import { useApi } from '@/hooks/useApi';
import { Badge, Button, SectionHeader } from '@/components/primitives';
import { ErrorState, Skeleton } from '@/components/states';
import { PlanGrid } from '@/premium/PlanGrid';
import { planTone } from '@/premium/plans';
import { planLabel } from '@/utils/format';
import styles from './PremiumScreen.module.css';

interface PendingCheckout {
  plan: 'plus' | 'pro';
  sessionId: string;
  mode: 'sandbox' | 'stripe' | string;
}

const QUOTA_TIERS = [
  { plan: 'Free', label: '10 AI / day' },
  { plan: 'Plus', label: '100 AI / day' },
  { plan: 'Pro', label: '500 AI / day' },
];

function formatPeriodEnd(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** "aiToday" → "Ai Today" — usage keys come straight from the backend map. */
function usageLabel(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export default function PremiumScreen(): React.JSX.Element {
  const { user, updateUser } = useAuth();
  const navigate = useNavigate();

  // cached() wraps PremiumMe into the { data, stale } shape useApi expects
  // (getPremiumMe alone returns a bare payload).
  const me = useApi(user ? () => cached('premium:me', () => getPremiumMe()) : null, [user?.id]);

  const [pending, setPending] = useState<PendingCheckout | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorUpgrade, setErrorUpgrade] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const currentPlan = me.data?.plan ?? user?.plan ?? 'free';
  const subscription = me.data?.subscription ?? null;
  const usageEntries = Object.entries(me.data?.usage ?? {});

  const failWith = (err: unknown): void => {
    setError(errorMessage(err));
    setErrorUpgrade(isApiError(err) && (err.status === 402 || err.upgrade));
  };

  const handleSelectPlan = (plan: 'plus' | 'pro'): void => {
    if (!user) {
      navigate('/auth?next=/premium');
      return;
    }
    void startCheckout(plan);
  };

  const startCheckout = async (plan: 'plus' | 'pro'): Promise<void> => {
    setBusy(true);
    setError(null);
    setErrorUpgrade(false);
    setNotice(null);
    try {
      const session = await checkout(plan);
      if (session.mode === 'stripe' && /^https?:\/\//i.test(session.url)) {
        // The main process routes window.open targets to the OS browser.
        window.open(session.url, '_blank', 'noopener,noreferrer');
        setPending({ plan, sessionId: session.sessionId, mode: 'stripe' });
        setNotice('Complete the payment in your browser, then confirm here.');
      } else {
        // Sandbox — the backend simulates the session; confirm inline.
        setPending({ plan, sessionId: session.sessionId, mode: 'sandbox' });
      }
    } catch (err) {
      failWith(err);
    } finally {
      setBusy(false);
    }
  };

  const confirmPending = async (): Promise<void> => {
    if (!pending || busy) return;
    setBusy(true);
    setError(null);
    setErrorUpgrade(false);
    try {
      const updated = await confirmCheckout(pending.sessionId);
      updateUser(updated);
      await cacheDrop('mobile:profile');
      setNotice(`You're on ${planLabel(updated.plan)} — enjoy the boost!`);
      setPending(null);
      me.refetch();
    } catch (err) {
      failWith(err);
    } finally {
      setBusy(false);
    }
  };

  const doCancel = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setErrorUpgrade(false);
    try {
      const sub = await cancelSubscription();
      setConfirmCancel(false);
      setNotice(
        sub
          ? `Subscription ${sub.status} — you keep ${planLabel(sub.plan)} until the period ends.`
          : 'Cancelled — you stay on the plan until the period ends.',
      );
      me.refetch();
    } catch (err) {
      failWith(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SectionHeader
        title="Animaxia Premium"
        subtitle="One subscription across web, desktop and mobile — higher AI quota, bigger watchlist, better quality."
      />

      {/* current status */}
      {!user ? (
        <div className={`card ${styles.anonNote}`}>
          <p className="dim">Sign in to manage your plan.</p>
          <Button size="sm" onClick={() => navigate('/auth?next=/premium')}>
            Sign in
          </Button>
        </div>
      ) : (
        <section className="card stack">
          <div className={styles.cardHead}>
            <div className={styles.cardTitle}>Current plan</div>
            <Badge tone={planTone(currentPlan)}>{planLabel(currentPlan)}</Badge>
          </div>
          {me.loading && !me.data ? (
            <Skeleton h={56} radius={12} />
          ) : me.error ? (
            <ErrorState message={me.error} compact onRetry={me.refetch} />
          ) : (
            <>
              {subscription ? (
                <div className="row row--wrap">
                  <Badge tone={subscription.status === 'active' ? 'emerald' : 'zinc'}>
                    {subscription.status}
                  </Badge>
                  <span className="dim">via {subscription.provider}</span>
                  {subscription.currentperiodend ? (
                    <span className="dim">
                      {subscription.status === 'active' ? 'Renews' : 'Ends'}{' '}
                      {formatPeriodEnd(subscription.currentperiodend)}
                    </span>
                  ) : null}
                </div>
              ) : (
                <p className="dim">No active subscription — the free tier is applied to your account.</p>
              )}
              {usageEntries.length > 0 ? (
                <div className="row row--wrap">
                  {usageEntries.map(([key, value]) => (
                    <span key={key} className="chip">
                      {usageLabel(key)}: <span className={styles.usageValue}>{value}</span>
                    </span>
                  ))}
                </div>
              ) : null}
            </>
          )}
        </section>
      )}

      {notice ? (
        <div className={`card ${styles.noticeCard}`} role="status">
          <CheckCircle2 size={15} color="var(--emerald)" />
          <span>{notice}</span>
        </div>
      ) : null}

      {error ? (
        errorUpgrade ? (
          <div className={`card ${styles.upgradeError}`} role="alert">
            <Sparkles size={15} color="var(--amber)" />
            <span>{error}</span>
          </div>
        ) : (
          <ErrorState message={error} compact onRetry={() => setError(null)} />
        )
      ) : null}

      {/* checkout sheet (sandbox confirm / stripe "I've paid") */}
      {pending ? (
        <section className={`card stack ${styles.pendingCard}`}>
          <div className={styles.pendingTitle}>
            {pending.mode === 'stripe'
              ? `Waiting for payment — ${planLabel(pending.plan)}`
              : `Activate ${planLabel(pending.plan)} (sandbox)`}
          </div>
          <p className="muted">
            {pending.mode === 'stripe'
              ? 'Finish the Stripe checkout in your browser, then confirm here.'
              : 'No Stripe key is configured on the server — confirm to activate this plan instantly.'}
          </p>
          <div className={`mono dim ${styles.sessionId}`} title={pending.sessionId}>
            Session {pending.sessionId}
          </div>
          <div className="row row--wrap">
            <Button loading={busy} onClick={() => void confirmPending()}>
              {pending.mode === 'stripe' ? "I've paid — confirm" : 'Confirm upgrade'}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setPending(null)}>
              Dismiss
            </Button>
          </div>
        </section>
      ) : null}

      {/* catalogue */}
      <PlanGrid currentPlan={currentPlan} busy={busy} onSelect={handleSelectPlan} />

      {/* quota comparison */}
      <section className={`card stack ${styles.quotaCard}`}>
        <div className={styles.cardTitle}>Daily AI quota per plan</div>
        <div className={styles.quotaGrid}>
          {QUOTA_TIERS.map((tier) => (
            <div key={tier.plan} className={styles.quotaTile}>
              <span className={styles.quotaValue}>{tier.label}</span>
              <span className="dim">{tier.plan}</span>
            </div>
          ))}
        </div>
      </section>

      {/* cancel (two-step) */}
      {user && subscription?.status === 'active' ? (
        confirmCancel ? (
          <section className={`card stack ${styles.cancelCard}`}>
            <div className={styles.cardTitle}>Cancel subscription?</div>
            <p className="dim">
              You keep {planLabel(currentPlan)} until the end of the paid period, then drop to Free.
            </p>
            <div className="row row--wrap">
              <Button variant="danger" size="sm" loading={busy} onClick={() => void doCancel()}>
                Yes, cancel
              </Button>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmCancel(false)}>
                Keep my plan
              </Button>
            </div>
          </section>
        ) : (
          <Button variant="danger" onClick={() => setConfirmCancel(true)}>
            Cancel subscription
          </Button>
        )
      ) : null}
    </>
  );
}
