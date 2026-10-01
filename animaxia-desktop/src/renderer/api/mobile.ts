/**
 * api/mobile.ts — /api/mobile/* client (the mobile-service BFF payloads).
 *
 *   GET /home        (public; auth adds Continue-watching) → { hero, rows, config }
 *   GET /player/:id  (public)   → { content, mode, allowedTypes, sources, primary, nextUp }
 *   GET /profile     (auth)     → { user, plan, limits, watchlistCount, recentHistory }
 *   GET /config      (public)   → { versions, features, endpoints }
 *
 * Compact item shape from the BFF: { id, title, type, thumbnail, rating, year }.
 * Home + player responses are wrapped in the offline cache (stale-while-error),
 * config uses a 10-minute cache-first window.
 */

import { request } from './client';
import { cached, cachedFresh } from './cache';
import type { SessionUser } from '../auth/tokenStore';

/* ---------------------------------- types ---------------------------------- */

export interface MobileItem {
  id: number;
  title: string;
  type: string;
  thumbnail: string | null;
  rating: number | null;
  year: string | number | null;
  overview?: string | null;
  backdrop?: string | null;
}

export interface MobileHome {
  hero: MobileItem | null;
  rows: { key: string; title: string; items: MobileItem[] }[];
  config: { minVersion: string; latestVersion: string };
}

export type PlayerSourceType = 'mp4' | 'm3u8' | 'youtube' | 'iframe' | string;

export interface PlayerSource {
  type: PlayerSourceType;
  url: string;
  label: string;
}

export interface MobilePlayer {
  content: MobileItem & { overview: string | null };
  mode: string;
  allowedTypes: PlayerSourceType[];
  sources: PlayerSource[];
  primary: PlayerSource | null;
  nextUp: MobileItem | null;
}

export interface PlanLimits {
  watchlist: number;
  history: number;
  aiPerDay: number;
  quality: string;
}

export interface MobileProfile {
  user: SessionUser;
  plan: string;
  limits: PlanLimits;
  watchlistCount: number;
  recentHistory: {
    content: MobileItem;
    watchedat: string | null;
    progress: number;
  }[];
}

export interface MobileConfig {
  versions: { min: string; latest: string };
  features: Record<string, boolean>;
  endpoints: Record<string, string>;
}

/* --------------------------------- methods --------------------------------- */

export function getHome(): Promise<MobileHome> {
  return request<MobileHome>('/api/mobile/home');
}

/** Offline-cached home screen (serves the last payload when the network fails). */
export function getHomeCached(): Promise<{ data: MobileHome; stale: boolean; fetchedAt: number }> {
  return cached('mobile:home', () => getHome());
}

export function getPlayer(id: number | string): Promise<MobilePlayer> {
  return request<MobilePlayer>(`/api/mobile/player/${id}`);
}

/** Offline-cached player payloads — handy on flaky connections. */
export function getPlayerCached(
  id: number | string,
): Promise<{ data: MobilePlayer; stale: boolean; fetchedAt: number }> {
  return cached(`mobile:player:${id}`, () => getPlayer(id));
}

export function getProfile(): Promise<MobileProfile> {
  return request<MobileProfile>('/api/mobile/profile');
}

export function getProfileCached(): Promise<{ data: MobileProfile; stale: boolean; fetchedAt: number }> {
  return cached('mobile:profile', () => getProfile());
}

export function getConfigCached(): Promise<{ data: MobileConfig; stale: boolean; fetchedAt: number }> {
  return cachedFresh('mobile:config', 10 * 60 * 1000, () =>
    request<MobileConfig>('/api/mobile/config'),
  );
}
