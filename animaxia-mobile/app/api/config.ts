/**
 * api/config.ts — Single source of truth for the API base URL.
 *
 * The mobile client talks to ONE origin which exposes the entire platform
 * surface through the Animaxia Cloud gateway:
 *
 *   gateway :8080 → auth :4001 · content :4002 · ai :4003 · analytics :4004
 *                   search :4005 · premium :4006 · social :4007 ·
 *                   mobile :4008 (mobile-service BFF) · queue :4009
 *
 * The dev monolith (mini-services/animaxia-backend) serves the same routes on
 * :4000, so pointing EXPO_PUBLIC_API_URL at either works unchanged.
 *
 * Resolution order:
 *   1. EXPO_PUBLIC_API_URL (.env / EAS build env — inlined at build time)
 *   2. Android emulator default  → http://10.0.2.2:8080 (10.0.2.2 = host)
 *   3. iOS simulator default     → http://localhost:8080
 */

import { Platform } from 'react-native';

export const GATEWAY_PORT = 8080;
export const MONOLITH_PORT = 4000;

/** Per-request timeout (the gateway itself times out upstreams at 15s). */
export const REQUEST_TIMEOUT_MS = 15000;

function envUrl(): string | null {
  const raw = process.env.EXPO_PUBLIC_API_URL;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/\/+$/, '');
  return trimmed.length > 0 ? trimmed : null;
}

function defaultUrl(): string {
  // On the Android emulator 10.0.2.2 is the loopback of the host machine —
  // the gateway started with `bun run dev` is reachable there.
  if (Platform.OS === 'android') return `http://10.0.2.2:${GATEWAY_PORT}`;
  return `http://localhost:${GATEWAY_PORT}`;
}

/** Resolved API origin (no trailing slash). */
export function apiUrl(): string {
  return envUrl() ?? defaultUrl();
}

/** Human-readable target label for the connection card on the Profile screen. */
export function apiTargetLabel(): string {
  const url = envUrl();
  if (url) return url;
  return Platform.OS === 'android' ? 'gateway @ 10.0.2.2 (default)' : 'gateway @ localhost (default)';
}

/** Build an absolute URL for a relative API path. */
export function absoluteUrl(path: string): string {
  return `${apiUrl()}${path.startsWith('/') ? path : `/${path}`}`;
}
