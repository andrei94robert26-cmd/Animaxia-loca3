/**
 * modules/premium/stripe.js — Subscription checkout, confirmation and
 * cancellation for Animaxia Premium.
 *
 * Mount: app.use('/api/premium', plansRouter, stripeRouter) — mounted AFTER
 * plans.js (no catch-all routes here so the shared GET paths stay with plans).
 * Every route in this file requires authentication (per-route requireAuth).
 *
 * Modes:
 *   • Sandbox (default — no STRIPESECRETKEY in .env): fully simulated
 *     checkout. Sessions are `cs_sandbox_<hex>` ids held in an in-memory Map
 *     and mirrored into the subscriptions table (provider 'stripe-sandbox'),
 *     so confirmation still works after a backend restart via the DB fallback.
 *   • Live (STRIPESECRETKEY set and starting with 'sk_'): real Stripe
 *     Checkout Sessions through the REST API (global fetch — no SDK). This
 *     path is documented but untested in this environment; it is kept compact
 *     and defensive (any Stripe failure → 502 { error: 'Stripe error: …' }).
 *
 * Routes (all requireAuth):
 *   POST /checkout { plan: 'plus'|'pro' } → { ok, sessionId, url, mode }
 *   POST /confirm  { sessionId }          → { ok, user, subscription }
 *   POST /cancel                        → { ok, subscription }
 *
 * Side effects on confirm/cancel: users.plan / users.planexpiresat updates,
 * auditLog('premium.subscribe' | 'premium.cancel'), emitPlatform('plan:changed').
 * Free is never a payable plan — only plus/pro can be checked out.
 */

import crypto from 'node:crypto';
import express from 'express';
import { one, rows, num } from '../platform/sql.js';
import { requireAuth, publicUser } from '../users/auth.js';
import { PLANS, serializeSubscription } from './plans.js';
import { auditLog, clientIpOf } from '../security/security.js';
import { emitPlatform } from '../platform/events.js';
import { logger } from '../../utils/logger.js';

const PERIOD_DAYS = 30; // billing period used for planexpiresat / currentperiodend
const SANDBOX_SESSION_TTL_MS = 24 * 60 * 60 * 1000; // unconfirmed sandbox sessions are swept after 24h
const STRIPE_API = 'https://api.stripe.com/v1';

/** Live mode is active only when a well-formed secret key is configured. */
function stripeKey() {
  const key = process.env.STRIPESECRETKEY;
  return key && key.startsWith('sk_') ? key : null;
}
function isLiveMode() {
  return Boolean(stripeKey());
}

/** Sandbox checkout sessions: sessionId → { userid, plan, createdAt }. */
const sandboxSessions = new Map();

// Light housekeeping so abandoned sandbox sessions cannot accumulate forever.
const sweepTimer = setInterval(() => {
  const cutoff = Date.now() - SANDBOX_SESSION_TTL_MS;
  for (const [id, session] of sandboxSessions) {
    if (Date.parse(session.createdAt) < cutoff) sandboxSessions.delete(id);
  }
}, 60 * 60 * 1000);
if (typeof sweepTimer.unref === 'function') sweepTimer.unref();

/* ----------------------------- Stripe REST helper ---------------------------- */

/**
 * Minimal Stripe REST call (form-encoded). Throws with Stripe's error message
 * on any non-2xx so callers can map it to a 502.
 */
async function stripeRequest(method, path, body) {
  const res = await fetch(`${STRIPE_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${stripeKey()}`,
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: body ?? undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error?.message || `Stripe HTTP ${res.status}`);
  }
  return data;
}

/* ---------------------------------- router ---------------------------------- */

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const router = express.Router();

/**
 * POST /checkout — create a checkout session for a paid plan.
 * Only 'plus' and 'pro' are payable; 'free' is the default entitlement.
 */
router.post('/checkout', requireAuth, wrap(async (req, res) => {
  const planKey = req.body?.plan;
  if (planKey !== 'plus' && planKey !== 'pro') {
    return res.status(400).json({ error: "plan must be 'plus' or 'pro' — free is not a payable plan" });
  }

  /* ------------------------------- live mode ------------------------------ */
  if (isLiveMode()) {
    try {
      const origin = `${req.protocol}://${req.get('host')}`;
      const body = new URLSearchParams({
        mode: 'subscription',
        'line_items[0][price_data][currency]': 'usd',
        'line_items[0][price_data][recurring][interval]': 'month',
        'line_items[0][price_data][product_data][name]': planKey === 'pro' ? 'Animaxia Pro' : 'Animaxia Plus',
        'line_items[0][price_data][unit_amount]': String(Math.round(PLANS[planKey].price * 100)),
        'line_items[0][quantity]': '1',
        success_url: `${origin}/premium?session={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}/premium`,
        client_reference_id: String(req.user.id),
      });
      const session = await stripeRequest('POST', '/v1/checkout/sessions', body);
      // Mirror the pending session locally so /confirm can map it back to user + plan.
      await one(
        `INSERT INTO subscriptions (userid, plan, status, provider, sessionid)
         VALUES ($1, $2, 'pending', 'stripe', $3)`,
        [req.user.id, planKey, session.id],
      );
      return res.json({ ok: true, sessionId: session.id, url: session.url, mode: 'live' });
    } catch (err) {
      return res.status(502).json({ error: `Stripe error: ${err.message}` });
    }
  }

  /* ----------------------------- sandbox mode ----------------------------- */
  const sessionId = `cs_sandbox_${crypto.randomBytes(12).toString('hex')}`;
  sandboxSessions.set(sessionId, { userid: req.user.id, plan: planKey, createdAt: new Date().toISOString() });
  await one(
    `INSERT INTO subscriptions (userid, plan, status, provider, sessionid)
     VALUES ($1, $2, 'pending', 'stripe-sandbox', $3)`,
    [req.user.id, planKey, sessionId],
  );
  logger.info(`[premium] Sandbox checkout ${sessionId} → ${planKey} for user ${req.user.id}`);
  // `url` is an SPA route — the frontend reads ?session= after the redirect.
  return res.json({ ok: true, sessionId, url: `/premium?session=${sessionId}`, mode: 'sandbox' });
}));

/**
 * POST /confirm — activate the subscription for a checkout session.
 * Ownership is enforced: a session belonging to another account → 403.
 */
router.post('/confirm', requireAuth, wrap(async (req, res) => {
  const sessionId = req.body?.sessionId;
  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'Missing sessionId' });
  }

  // Session lookup: in-memory sandbox store first, then the subscriptions
  // table — the fallback covers live sessions and sandbox sessions created
  // before a backend restart.
  const memorySession = sandboxSessions.get(sessionId) || null;
  let sub = await one(
    `SELECT * FROM subscriptions WHERE sessionid = $1 ORDER BY createdat DESC, id DESC LIMIT 1`,
    [sessionId],
  );
  if (!memorySession && !sub) {
    return res.status(404).json({ error: 'Checkout session not found' });
  }

  const sessionUserid = num(memorySession?.userid ?? sub?.userid, -1);
  const targetPlan = String(memorySession?.plan ?? sub?.plan ?? '');
  if (sessionUserid !== req.user.id) {
    return res.status(403).json({ error: 'This checkout session belongs to a different account' });
  }
  if (!PLANS[targetPlan] || targetPlan === 'free') {
    return res.status(400).json({ error: 'Checkout session has an invalid plan' });
  }

  // Live mode: the session must exist at Stripe and be fully paid.
  if (isLiveMode() && !sessionId.startsWith('cs_sandbox_')) {
    try {
      const stripeSession = await stripeRequest('GET', `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`);
      if (stripeSession?.payment_status !== 'paid') {
        return res.status(402).json({ error: 'Payment not completed yet', upgrade: true });
      }
      // Defense in depth: Stripe's own client_reference_id must match too.
      if (String(stripeSession.client_reference_id || '') !== String(req.user.id)) {
        return res.status(403).json({ error: 'This checkout session belongs to a different account' });
      }
    } catch (err) {
      return res.status(502).json({ error: `Stripe error: ${err.message}` });
    }
  }

  // Activate the plan and stamp a fresh 30-day period.
  const userRow = await one(
    `UPDATE users SET plan = $2, planexpiresat = datetime('now','+' || $3) WHERE id = $1 RETURNING *`,
    [req.user.id, targetPlan, `${PERIOD_DAYS} days`],
  );
  if (!userRow) {
    return res.status(404).json({ error: 'Account no longer exists' });
  }

  if (sub) {
    sub = await one(
      `UPDATE subscriptions
       SET status = 'active', currentperiodend = datetime('now','+' || $2)
       WHERE id = $1 RETURNING *`,
      [Number(sub.id), `${PERIOD_DAYS} days`],
    );
  } else {
    // Memory-only session whose mirror row vanished — recreate it as active.
    sub = await one(
      `INSERT INTO subscriptions (userid, plan, status, provider, sessionid, currentperiodend)
       VALUES ($1, $2, 'active', $3, $4, datetime('now','+' || $5)) RETURNING *`,
      [req.user.id, targetPlan, sessionId.startsWith('cs_sandbox_') ? 'stripe-sandbox' : 'stripe', sessionId, `${PERIOD_DAYS} days`],
    );
  }

  sandboxSessions.delete(sessionId); // consumed — later confirms fall through to the row above
  await auditLog({ userid: req.user.id, action: 'premium.subscribe', ip: clientIpOf(req), meta: { plan: targetPlan, sessionId } });
  emitPlatform('plan:changed', { userid: req.user.id, plan: targetPlan });
  logger.info(`[premium] user ${req.user.id} subscribed to ${targetPlan} (${sessionId})`);
  return res.json({ ok: true, user: publicUser(userRow), subscription: serializeSubscription(sub) });
}));

/** POST /cancel — return to the free plan and cancel the active subscription. */
router.post('/cancel', requireAuth, wrap(async (req, res) => {
  let sub = await one(
    `SELECT * FROM subscriptions WHERE userid = $1 AND status = 'active' ORDER BY createdat DESC, id DESC LIMIT 1`,
    [req.user.id],
  );

  // Live mode: best-effort remote cancel (local state is authoritative either way).
  if (isLiveMode() && sub?.stripesubscriptionid) {
    try {
      await stripeRequest('POST', `/v1/subscriptions/${encodeURIComponent(sub.stripesubscriptionid)}/cancel`, new URLSearchParams());
    } catch (err) {
      logger.warn(`[premium] Stripe cancel failed (continuing locally): ${err.message}`);
    }
  }

  if (sub) {
    sub = await one(`UPDATE subscriptions SET status = 'canceled' WHERE id = $1 RETURNING *`, [Number(sub.id)]);
  }
  await rows(`UPDATE users SET plan = 'free', planexpiresat = NULL WHERE id = $1`, [req.user.id]);

  await auditLog({ userid: req.user.id, action: 'premium.cancel', ip: clientIpOf(req), meta: {} });
  emitPlatform('plan:changed', { userid: req.user.id, plan: 'free' });
  logger.info(`[premium] user ${req.user.id} canceled subscription → free`);
  return res.json({ ok: true, subscription: serializeSubscription(sub) });
}));

export default router;
