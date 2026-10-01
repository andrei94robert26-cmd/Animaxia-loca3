/**
 * premium/PlanGrid.tsx — Plan catalogue grid (free · plus · pro).
 *
 * Fetches GET /api/premium/plans through the offline cache ('premium:plans')
 * and renders one card per plan: name, price/period, the four limits as
 * definition rows (watchlist · history · AI/day · quality), the feature list
 * and a select action. The highlighted plan (usually Plus) gets the rose
 * border; the current plan is badged and its action disabled.
 *
 * The grid is purely presentational about checkout: `onSelect` hands the
 * chosen plan key back to PremiumScreen, which runs checkout/confirm.
 * PremiumMe usage lives on the screen, not here.
 */

import React from 'react';
import { Check } from 'lucide-react';
import { getPlans } from '@/api/premium';
import type { PremiumPlan } from '@/api/premium';
import { cached } from '@/api/cache';
import { useApi } from '@/hooks/useApi';
import { Badge, Button } from '@/components/primitives';
import { ErrorState, Skeleton } from '@/components/states';
import { PLAN_ORDER, formatPrice } from './plans';
import styles from './PlanGrid.module.css';

type LimitKey = keyof PremiumPlan['limits'];

const LIMIT_ROWS: { key: LimitKey; label: string }[] = [
  { key: 'watchlist', label: 'Watchlist' },
  { key: 'history', label: 'History' },
  { key: 'aiPerDay', label: 'AI / day' },
  { key: 'quality', label: 'Quality' },
];

function limitValue(key: LimitKey, plan: PremiumPlan): string {
  const raw = plan.limits[key];
  if (key === 'quality') return String(raw).toUpperCase();
  const num = Number(raw);
  return Number.isFinite(num) && num < 0 ? 'Unlimited' : String(raw);
}

export interface PlanGridProps {
  /** Plan key the account is currently on ('free' when signed out). */
  currentPlan?: string | null;
  /** Fired for selectable (paid, not current) plans — the screen drives checkout. */
  onSelect?: (plan: 'plus' | 'pro') => void;
  /** true while a checkout/confirm is in flight — disables the actions. */
  busy?: boolean;
}

export function PlanGrid({ currentPlan = 'free', onSelect, busy = false }: PlanGridProps): React.JSX.Element {
  const plans = useApi(() => cached('premium:plans', () => getPlans()), []);

  if (plans.loading) {
    return (
      <div className={styles.grid}>
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} h={340} radius={16} />
        ))}
      </div>
    );
  }

  if (plans.error) {
    return <ErrorState message={plans.error} onRetry={plans.refetch} />;
  }

  const catalog = plans.data?.data ?? [];
  const ordered = PLAN_ORDER.map((key) => catalog.find((p) => p.key === key)).filter(
    (p): p is PremiumPlan => Boolean(p),
  );

  return (
    <div className={styles.grid}>
      {ordered.map((plan) => {
        const isCurrent = plan.key === currentPlan;
        // Only plus/pro are purchasable; cast once so onSelect stays typed.
        const selectableKey = plan.key === 'plus' || plan.key === 'pro' ? (plan.key as 'plus' | 'pro') : null;
        const selectable = selectableKey !== null && !isCurrent;
        return (
          <section
            key={plan.key}
            className={[
              styles.card,
              plan.highlight ? styles.cardHighlight : '',
              isCurrent ? styles.cardCurrent : '',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            <div className={styles.cardHead}>
              <div className={styles.name} style={plan.color ? { color: plan.color } : undefined}>
                {plan.name}
              </div>
              {isCurrent ? <Badge tone="emerald">Current</Badge> : null}
              {!isCurrent && plan.highlight ? <Badge tone="rose">Popular</Badge> : null}
            </div>

            <div className={styles.price}>{formatPrice(plan)}</div>

            <dl className={styles.limits}>
              {LIMIT_ROWS.map(({ key, label }) => (
                <div className={styles.limitRow} key={key}>
                  <dt className="dim">{label}</dt>
                  <dd className={styles.limitValue}>{limitValue(key, plan)}</dd>
                </div>
              ))}
            </dl>

            <ul className={styles.features}>
              {plan.features.map((feature) => (
                <li className={styles.feature} key={feature}>
                  <Check size={13} color={plan.highlight ? 'var(--rose-soft)' : 'var(--emerald)'} />
                  <span>{feature}</span>
                </li>
              ))}
            </ul>

            {selectable && selectableKey ? (
              <Button
                full
                variant={plan.highlight ? 'primary' : 'outline'}
                disabled={busy}
                onClick={() => onSelect?.(selectableKey)}
              >
                Get {plan.name}
              </Button>
            ) : isCurrent ? (
              <Button full disabled>
                Current plan
              </Button>
            ) : (
              <div className={styles.currentNote}>Included with every account</div>
            )}
          </section>
        );
      })}
    </div>
  );
}

export default PlanGrid;
