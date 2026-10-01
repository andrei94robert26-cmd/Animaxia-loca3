/**
 * domain/providers/tvmaze.js — /api/tv/schedule router backed by TVmaze (today's TV schedule).
 * Registered BEFORE the TMDB tv router so /api/tv/schedule does not clash with
 * TMDB's /api/tv/:id route.
 */

import express from 'express';
import { fetchProviderJson } from '@animaxia/common/fetcher.js';

const BASE = process.env.TVMAZEBASEURL || 'https://api.tvmaze.com';
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function stripSummary(html) {
  if (!html) return '';
  return String(html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const router = express.Router();

router.get(
  '/schedule',
  wrap(async (req, res) => {
    const payload = await fetchProviderJson('tvmaze', `${BASE}/schedule`, { timeoutMs: 10000 });
    const episodes = (Array.isArray(payload) ? payload : []).filter((e) => e?.show?.image).slice(0, 30);
    res.json({
      data: episodes.map((e) => ({
        id: e.id,
        title: e.name || `Episode ${e.number ?? '?'}`,
        show: e.show?.name || 'Unknown show',
        airtime: e.airtime || '',
        season: e.season ?? null,
        number: e.number ?? null,
        network: e.show?.network?.name || e.show?.webChannel?.name || null,
        image: e.show?.image?.original || null,
        summary: stripSummary(e.summary),
        url: e.show?.url || '',
      })),
    });
  }),
);

export default router;
