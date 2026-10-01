/**
 * api/config.ts — Single source of truth for the API base URL.
 *
 * The desktop app talks to ONE origin exposing the whole platform surface
 * through the Animaxia Cloud gateway:
 *
 *   gateway :8080 → auth :4001 · content :4002 · ai :4003 · analytics :4004
 *                   search :4005 · premium :4006 · social :4007 ·
 *                   mobile :4008 (mobile-service BFF) · queue :4009
 *
 * The dev monolith (mini-services/animaxia-backend) serves the same routes on
 * :4000, so either target works unchanged.
 *
 * Resolution order:
 *   1. Runtime override saved from the Profile → Connection card
 *      (localStorage 'animaxia.apiBaseUrl')
 *   2. VITE_API_URL (build-time, .env / CI — inlined by Vite)
 *   3. http://localhost:8080 (gateway default)
 */

export const GATEWAY_PORT = 8080;
export const MONOLITH_PORT = 4000;

/** Per-request timeout (the gateway itself times out upstreams at 15s). */
export const REQUEST_TIMEOUT_MS = 15000;

const OVERRIDE_KEY = 'animaxia.apiBaseUrl';

function normalize(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

function buildTimeUrl(): string | null {
  const raw = import.meta.env.VITE_API_URL;
  if (typeof raw !== 'string') return null;
  const trimmed = normalize(raw);
  return trimmed.length > 0 ? trimmed : null;
}

/** Resolved API origin (no trailing slash). */
export function apiUrl(): string {
  try {
    const override = window.localStorage.getItem(OVERRIDE_KEY);
    if (override && normalize(override).length > 0) return normalize(override);
  } catch {
    /* storage unavailable — fall through */
  }
  return buildTimeUrl() ?? `http://localhost:${GATEWAY_PORT}`;
}

/** Human-readable target label for the Connection card on the Profile screen. */
export function apiTargetLabel(): string {
  try {
    const override = window.localStorage.getItem(OVERRIDE_KEY);
    if (override && normalize(override).length > 0) return `${normalize(override)} (custom)`;
  } catch {
    /* ignore */
  }
  const fromEnv = buildTimeUrl();
  return fromEnv ? `${fromEnv} (build default)` : `gateway @ localhost:${GATEWAY_PORT} (default)`;
}

/** Persist/clear the runtime override (Profile → Connection card). */
export function setApiUrlOverride(url: string | null): void {
  try {
    if (url && normalize(url).length > 0) {
      window.localStorage.setItem(OVERRIDE_KEY, normalize(url));
    } else {
      window.localStorage.removeItem(OVERRIDE_KEY);
    }
  } catch {
    /* storage unavailable — the default target is used */
  }
}

/** Build an absolute URL for a relative API path. */
export function absoluteUrl(path: string): string {
  return `${apiUrl()}${path.startsWith('/') ? path : `/${path}`}`;
}
