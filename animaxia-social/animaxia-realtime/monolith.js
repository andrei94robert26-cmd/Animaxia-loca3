/**
 * monolith.js — HTTP bridge to the backend (:4000) for party persistence.
 *
 * The realtime service is a relay: Neon ownership stays with the monolith.
 * All calls forward the user's access token (same JWT the socket
 * authenticated with) so authorization is enforced by the backend, not here.
 * Every call is fail-soft: null on any error (rooms keep working in
 * degraded, unpersisted mode — GET /api/social/party/:id stays the source
 * of truth for late joiners).
 */

import { config } from './env.js';

const TIMEOUT_MS = 4000;

async function call(method, path, { token, body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${config.monolithUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* non-JSON */
    }
    return { status: res.status, ok: res.ok, json };
  } catch {
    return { status: 0, ok: false, json: null };
  } finally {
    clearTimeout(timer);
  }
}

/** GET /api/social/party/:id — party detail (public): members, state, host. */
export const partyDetail = (partyId) => call('GET', `/api/social/party/${Number(partyId)}`);

/** POST /api/social/party/:id/join — idempotent membership upsert. */
export const partyJoin = (partyId, token) =>
  call('POST', `/api/social/party/${Number(partyId)}/join`, { token, body: {} });

/** POST /api/social/party/:id/messages — persist a chat message. */
export const partyMessage = (partyId, token, body) =>
  call('POST', `/api/social/party/${Number(partyId)}/messages`, { token, body: { body } });

/** GET /api/health — used by /api/health here for upstream status. */
export const monolithHealth = () => call('GET', '/api/health');
