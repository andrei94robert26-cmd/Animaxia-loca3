/**
 * modules/premium/plans.js — Plan catalog, entitlement limits and the
 * read-only premium endpoints (plan listing, subscription snapshot,
 * entitlement verification).
 *
 * Mount: app.use('/api/premium', plansRouter, stripeRouter) — this router is
 * mounted FIRST (before stripe.js) and therefore owns the shared GET paths.
 *
 * Routes:
 *   GET /plans   (public)   → { data: [plan objects] } — order: free, plus, pro
 *   GET /me      (requireAuth) → { plan, limits, subscription, usage }
 *   GET /verify  (requireAuth) → { plan, active, limits }
 *
 * Frozen named exports (consumed by profile.js, stripe.js, mobile.js, ai.js):
 *   plansRouter, PLANS, planLimits(plan), requirePlan(minPlan),
 *   serializeSubscription(row)
 */

import express from 'express';
import { one, num, isoOrNull } from '../platform/sql.js';
import { requireAuth } from '../users/auth.js';

/* ------------------------------ plan catalog -------------------------------- */

/** Single source of truth for pricing, entitlement limits and marketing copy. */
export const PLANS = {
  free: {
    key: 'free',
    name: 'Free',
    price: 0,
    period: 'month',
    currency: 'USD',
    limits: { watchlist: 20, history: 50, aiPerDay: 10, quality: 'sd' },
    features: [
      'Full library browsing',
      'Watchlist — up to 20 titles',
      'Watch history — last 50 entries',
      '10 AI interactions per day',
      'SD streaming quality',
    ],
    color: 'zinc',
    highlight: false,
  },
  plus: {
    key: 'plus',
    name: 'Plus',
    price: 4.99,
    period: 'month',
    currency: 'USD',
    limits: { watchlist: 200, history: 500, aiPerDay: 100, quality: 'hd' },
    features: [
      'Everything in Free',
      'Watchlist — up to 200 titles',
      'Watch history — last 500 entries',
      '100 AI interactions per day',
      'HD streaming quality',
      'Ad-free experience',
    ],
    color: 'rose',
    highlight: true,
  },
  pro: {
    key: 'pro',
    name: 'Pro',
    price: 9.99,
    period: 'month',
    currency: 'USD',
    limits: { watchlist: -1, history: -1, aiPerDay: 500, quality: '4k' },
    features: [
      'Everything in Plus',
      'Unlimited watchlist & history',
      '500 AI interactions per day',
      '4K streaming quality',
      'Ad-free experience',
      'Early access to new features',
    ],
    color: 'amber',
    highlight: false,
  },
};

/** Catalog display order (free → plus → pro). */
const PLAN_ORDER = ['free', 'plus', 'pro'];

/** Plan ranking for entitlement comparisons (higher = more entitlements). */
const PLAN_RANK = { free: 0, plus: 1, pro: 2 };

/** Limits for a plan key. Unknown/legacy keys fall back to the free tier. */
export function planLimits(plan) {
  return (PLANS[plan] || PLANS.free).limits;
}

/**
 * Middleware factory: require at least `minPlan`.
 * Rejects 401 when unauthenticated; 402 { error, upgrade, requiredPlan }
 * when the caller's plan rank is below the requirement; otherwise next().
 */
export function requirePlan(minPlan = 'free') {
  const requiredRank = PLAN_RANK[minPlan] ?? 0;
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
    }
    const currentRank = PLAN_RANK[req.user.plan] ?? 0;
    if (currentRank < requiredRank) {
      return res.status(402).json({
        error: `${(PLANS[minPlan] || { name: minPlan }).name} plan or higher required — upgrade to continue`,
        upgrade: true,
        requiredPlan: minPlan,
      });
    }
    return next();
  };
}

/** Serialize a `subscriptions` table row for API responses (null-safe). */
export function serializeSubscription(row) {
  if (!row) return null;
  return {
    id: num(row.id),
    plan: row.plan,
    status: row.status,
    provider: row.provider,
    sessionid: row.sessionid || null,
    stripecustomerid: row.stripecustomerid || null,
    stripesubscriptionid: row.stripesubscriptionid || null,
    currentperiodend: isoOrNull(row.currentperiodend),
    createdat: isoOrNull(row.createdat),
  };
}

/* ---------------------------------- router ---------------------------------- */

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export const plansRouter = express.Router();

/** GET /plans — public plan catalog (no auth required; static payload). */
plansRouter.get('/plans', (_req, res) => {
  // Deep copies so callers can never mutate the exported catalog.
  res.json({ data: PLAN_ORDER.map((key) => ({ ...PLANS[key], limits: { ...PLANS[key].limits } })) });
});

/** GET /me — current plan, limits, latest subscription row and live usage. */
plansRouter.get('/me', requireAuth, wrap(async (req, res) => {
  const subscription = await one(
    `SELECT * FROM subscriptions WHERE userid = $1 ORDER BY createdat DESC, id DESC LIMIT 1`,
    [req.user.id],
  );
  const usage = await one(
    `SELECT
       (SELECT COUNT(*)::int FROM watchlist WHERE userid = $1) AS watchlist,
       (SELECT COUNT(*)::int FROM watchhistory WHERE userid = $1) AS history`,
    [req.user.id],
  );
  res.json({
    plan: req.user.plan,
    limits: planLimits(req.user.plan),
    subscription: serializeSubscription(subscription),
    usage: { watchlist: num(usage?.watchlist), history: num(usage?.history) },
  });
}));

/** GET /verify — lightweight entitlement check: is the current plan active? */
plansRouter.get('/verify', requireAuth, wrap(async (req, res) => {
  const plan = req.user.plan || 'free';
  const expiresMs = req.user.planexpiresat ? Date.parse(req.user.planexpiresat) : NaN;
  // Free is always active; paid plans are active while the period end is in the future.
  const active = plan === 'free' || (Number.isFinite(expiresMs) && expiresMs > Date.now());
  res.json({ plan, active, limits: planLimits(plan) });
}));

export default plansRouter;
