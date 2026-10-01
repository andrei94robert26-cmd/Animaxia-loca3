/**
 * api/users.ts — /api/users/me/* client (profile, watchlist, history,
 * preferences, avatar). Every route requires authentication.
 *
 *   GET    /me                        → { user, stats }
 *   PATCH  /me { username?, avatar?, preferences? } → { user }
 *   POST   /me/avatar { image: dataURL }            → { user }
 *   GET    /me/watchlist               → { data: [{ content, addedat }] }
 *   POST   /me/watchlist { contentId } → { ok, added }        (plan-limited)
 *   DELETE /me/watchlist/:contentId    → { ok, removed }
 *   GET    /me/history?limit=          → { data: [{ content, watchedat, progress }] }
 *   POST   /me/history { contentId, progress } → { ok }       (rolling window)
 *   GET    /me/preferences             → { preferences }
 *   PUT    /me/preferences { types?, genres?, franchises? } → { preferences }
 *
 * Watchlist mutations drop the `mobile:profile` offline-cache entry so the
 * Profile screen re-syncs on next visit.
 */

import { request } from './client';
import { cacheDrop } from './cache';
import type { SessionUser } from '../auth/tokenStore';
import type { MobileItem } from './mobile';

/* ---------------------------------- types ---------------------------------- */

export interface DbContent extends MobileItem {
  externalid: string | null;
  metadata: {
    overview?: string;
    synopsis?: string;
    description?: string;
    rating?: number;
    score?: number;
    year?: string | number;
    genres?: string[];
    backdrop?: string;
    source?: string;
    player?: { sources?: { url?: string; src?: string; type?: string; label?: string }[] };
    sources?: { url?: string; src?: string; type?: string; label?: string }[];
    [key: string]: unknown;
  };
  createdat: string | null;
}

export interface WatchlistEntry {
  content: DbContent;
  addedat: string | null;
}

export interface HistoryEntry {
  content: DbContent;
  watchedat: string | null;
  progress: number;
}

export interface Preferences {
  types?: string[];
  genres?: string[];
  franchises?: string[];
}

export interface MeStats {
  watchlist: number;
  history: number;
  comments: number;
}

/* ------------------------------- profile core ------------------------------ */

export function getMe(): Promise<{ user: SessionUser; stats: MeStats }> {
  return request<{ user: SessionUser; stats: MeStats }>('/api/users/me');
}

export function updateMe(patch: {
  username?: string;
  avatar?: string;
  preferences?: Preferences;
}): Promise<SessionUser> {
  return request<{ user: SessionUser }>('/api/users/me', { method: 'PATCH', body: patch }).then((r) => r.user);
}

/** Upload a picked avatar image (base64 data-URL, ≤ 512KB decoded). */
export function uploadAvatar(dataUrl: string): Promise<SessionUser> {
  return request<{ user: SessionUser }>('/api/users/me/avatar', {
    method: 'POST',
    body: { image: dataUrl },
  }).then((r) => r.user);
}

/* --------------------------------- watchlist -------------------------------- */

export function getWatchlist(): Promise<{ data: WatchlistEntry[] }> {
  return request<{ data: WatchlistEntry[] }>('/api/users/me/watchlist');
}

/** Add to watchlist (403 when the plan limit is hit — body has { error }). */
export async function addToWatchlist(contentId: number): Promise<boolean> {
  const res = await request<{ ok: boolean; added: boolean }>('/api/users/me/watchlist', {
    method: 'POST',
    body: { contentId },
  });
  await cacheDrop('mobile:profile');
  return res.added;
}

export async function removeFromWatchlist(contentId: number): Promise<boolean> {
  const res = await request<{ ok: boolean; removed: boolean }>(
    `/api/users/me/watchlist/${contentId}`,
    { method: 'DELETE' },
  );
  await cacheDrop('mobile:profile');
  return res.removed;
}

/* ---------------------------------- history -------------------------------- */

export function getHistory(limit = 50): Promise<{ data: HistoryEntry[] }> {
  return request<{ data: HistoryEntry[] }>('/api/users/me/history', { query: { limit } });
}

/** Fire-and-forget progress save (0–100, throttled by the player). */
export function saveProgress(contentId: number, progress: number): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>('/api/users/me/history', {
    method: 'POST',
    body: { contentId, progress },
  });
}

/* -------------------------------- preferences ------------------------------- */

export function getPreferences(): Promise<{ preferences: Preferences }> {
  return request<{ preferences: Preferences }>('/api/users/me/preferences');
}

export function putPreferences(prefs: Preferences): Promise<{ preferences: Preferences }> {
  return request<{ preferences: Preferences }>('/api/users/me/preferences', {
    method: 'PUT',
    body: prefs,
  });
}

/* --------------------------------- content --------------------------------- */

/** Full content row (metadata included) — GET /api/content/:id (public). */
export function getContent(id: number | string): Promise<DbContent> {
  return request<DbContent>(`/api/content/${id}`);
}
