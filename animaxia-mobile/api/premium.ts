/**
 * api/premium.ts — /api/premium/* client.
 *
 *   GET  /plans  (public)              → { data: [plan, plus, pro] }
 *   GET  /me     (auth)                → { plan, limits, subscription, usage }
 *   POST /checkout { plan } (auth)     → { ok, sessionId, url, mode }
 *   POST /confirm { sessionId } (auth) → { ok, user, subscription }
 *   POST /cancel (auth)                → { ok, subscription }
 *
 * Checkout modes (mirror of domain/premium/stripe.js):
 *   • 'sandbox' — url is a relative SPA route (`/premium?session=…`); the
 *     session is simulated server-side, so the app can confirm inline
 *     right away (Premium screen shows a confirm sheet).
 *   • 'stripe'  — url is an absolute Stripe Checkout URL; open it with
 *     Linking.openURL, then call confirm(sessionId) when the user returns.
 */

import { request } from './client';
import { cacheDrop } from './cache';
import type { SessionUser } from '../auth/tokenStore';
import type { PlanLimits } from './mobile';

export interface PremiumPlan {
  key: 'free' | 'plus' | 'pro' | string;
  name: string;
  price: number;
  period: string;
  currency: string;
  limits: PlanLimits;
  features: string[];
  color: string;
  highlight: boolean;
}

export interface Subscription {
  plan: string;
  status: string;
  provider: string;
  currentperiodend: string | null;
}

export interface PremiumMe {
  plan: string;
  limits: PlanLimits;
  subscription: Subscription | null;
  usage: Record<string, number>;
}

export interface CheckoutResponse {
  ok: boolean;
  sessionId: string;
  url: string;
  mode: 'sandbox' | 'stripe' | string;
}

/* --------------------------------- methods --------------------------------- */

export function getPlans(): Promise<{ data: PremiumPlan[] }> {
  return request<{ data: PremiumPlan[] }>('/api/premium/plans');
}

export function getPremiumMe(): Promise<PremiumMe> {
  return request<PremiumMe>('/api/premium/me');
}

export function checkout(plan: 'plus' | 'pro'): Promise<CheckoutResponse> {
  return request<CheckoutResponse>('/api/premium/checkout', { method: 'POST', body: { plan } });
}

/** Activates the subscription for a checkout session (ownership enforced server-side). */
export async function confirm(sessionId: string): Promise<SessionUser> {
  const res = await request<{ ok: boolean; user: SessionUser; subscription: Subscription }>(
    '/api/premium/confirm',
    { method: 'POST', body: { sessionId } },
  );
  await cacheDrop('mobile:profile');
  return res.user;
}

export async function cancel(): Promise<Subscription | null> {
  const res = await request<{ ok: boolean; subscription: Subscription | null }>('/api/premium/cancel', {
    method: 'POST',
  });
  await cacheDrop('mobile:profile');
  return res.subscription;
}
