/**
 * premium/plans.ts — Plan helpers mirrored from domain/premium/plans.js.
 *
 * The server catalogue fetched via GET /api/premium/plans stays the source of
 * truth — these helpers only rank plans and format them for the Premium
 * screen's badges, the PlanGrid and plan-gated features.
 */

import type { PremiumPlan } from '@/api/premium';
import type { BadgeTone } from '@/components/primitives';

/** Display order used by the PlanGrid (free → plus → pro). */
export const PLAN_ORDER: PremiumPlan['key'][] = ['free', 'plus', 'pro'];

const PLAN_RANK: Record<string, number> = { free: 0, plus: 1, pro: 2 };

/** 0 for free/unknown, 1 for plus, 2 for pro. */
export function planRank(plan: string | null | undefined): number {
  return PLAN_RANK[plan ?? 'free'] ?? 0;
}

/** Badge tone per plan — Free zinc · Plus rose · Pro amber. */
export function planTone(plan: string | null | undefined): BadgeTone {
  if (plan === 'plus') return 'rose';
  if (plan === 'pro') return 'amber';
  return 'zinc';
}

/** True when `plan` is at least `min` (e.g. gating 4K quality to pro). */
export function planAtLeast(plan: string | null | undefined, min: PremiumPlan['key']): boolean {
  return planRank(plan) >= planRank(min);
}

/** "Free" or "$4.99 / month" — the PlanGrid price line. */
export function formatPrice(plan: PremiumPlan): string {
  if (plan.price === 0) return 'Free';
  const currency = plan.currency === 'EUR' ? '€' : '$';
  return `${currency}${plan.price.toFixed(2)} / ${plan.period}`;
}
