/**
 * api/analytics.ts — /api/analytics/views client: raw view-event ingestion
 * powering trending + personal stats (public; Bearer token attaches userid;
 * 120 events/min per-IP limit — fire-and-forget, never blocks playback).
 *
 *   POST /views { contentId, event: 'view'|'play'|'complete' } → { ok }
 *   GET  /trending?window=7d&limit=10 → { data: [{ content, views, plays, score }] }
 */

import { request } from './client';

export type ViewEvent = 'view' | 'play' | 'complete';

export interface TrendingEntry {
  content: {
    id: number;
    title: string;
    type: string | null;
    thumbnail: string | null;
  };
  views: number;
  plays: number;
  score: number;
}

/** Record a playback event. Swallows errors — analytics must never break UX. */
export async function trackView(contentId: number, event: ViewEvent): Promise<void> {
  try {
    await request<{ ok: boolean }>('/api/analytics/views', {
      method: 'POST',
      body: { contentId, event },
    });
  } catch {
    /* best-effort by design */
  }
}

export function getTrending(
  window: '24h' | '7d' | '30d' = '7d',
  limit = 10,
): Promise<{ data: TrendingEntry[]; fallback: boolean }> {
  return request<{ data: TrendingEntry[]; fallback: boolean }>('/api/analytics/trending', {
    query: { window, limit },
  });
}
