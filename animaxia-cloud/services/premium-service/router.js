/**
 * services/premium-service/router.js — Premium route composition.
 *
 * Mirrors the monolith mount exactly (mini-services/animaxia-backend/
 * server.js):
 *
 *   app.use('/api/premium', plansRouter, stripeRouter);
 *
 * One path, both domain routers in order: plansRouter owns the shared GET
 * paths (/plans, /me, /verify) and stripeRouter adds the POST flows
 * (/checkout, /confirm, /cancel). Neither router has a catch-all, so requests
 * fall through plans → stripe exactly as in the monolith. stripeRouter routes
 * carry their own per-route requireAuth; the gateway additionally edge-gates
 * POST /api/premium/checkout with a token check.
 */

import express from 'express';
import { plansRouter } from '@animaxia/domain/premium/plans.js';
import stripeRouter from '@animaxia/domain/premium/stripe.js';

/** /api/premium — plan catalog + entitlements + Stripe checkout flows. */
export const premiumRouter = express.Router();
premiumRouter.use(plansRouter, stripeRouter);

export default premiumRouter;
