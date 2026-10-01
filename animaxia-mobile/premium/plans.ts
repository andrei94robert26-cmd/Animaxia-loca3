/**
 * premium/plans.ts — Plan helpers mirrored from domain/premium/plans.js
 * (the server catalog fetched via GET /api/premium/plans stays the source of
 * truth — these helpers only format and rank for the Premium screen).
 */

import type { PremiumPlan } from '../api/premium';

export const PLAN_ORDER: PremiumPlan['key'][] = ['free', 'plus', 'pro'];

export const PLAN_RANK: Record<string, number> = { free: 0, plus: 1, pro: 2 };

export function planRank(plan: string | undefined | null): number {
  return PLAN_RANK[plan ?? 'free'] ?? 0;
}

export function formatPrice(plan: PremiumPlan): string {
  if (plan.price === 0) return 'Free';
  return `$${plan.price.toFixed(2)} / ${plan.period}`;
}

export function limitsLabel(plan: PremiumPlan): string {
  const l = plan.limits;
  const watchlist = l.watchlist < 0 ? 'Unlimited watchlist' : `Watchlist · ${l.watchlist}`;
  const history = l.history < 0 ? 'unlimited history' : `history ${l.history}`;
  return `${watchlist} · ${l.aiPerDay} AI/day · ${String(l.quality).toUpperCase()}`;
}

/** True when `plan` is at least `min` (e.g. gating 4K quality to pro). */
export function planAtLeast(plan: string | undefined | null, min: PremiumPlan['key']): boolean {
  return planRank(plan) >= planRank(min);
}
