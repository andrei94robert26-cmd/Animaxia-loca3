/**
 * domain/providers/football.js — /api/sports/football router backed by football-data.org v4.
 * Curated competitions, league standings, and fixtures (free-tier friendly).
 */

import express from 'express';
import { fetchProviderJson, ProviderError } from '@animaxia/common/fetcher.js';
import { logger } from '@animaxia/common/logger.js';

const BASE = process.env.FOOTBALLDATABASE_URL || 'https://api.football-data.org/v4';
const TOKEN = process.env.FOOTBALLDATAAPI_KEY || '';
const CURATED_CODES = ['PL', 'PD', 'SA', 'BL1', 'FL1', 'CL', 'WC'];
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const STATIC_COMPETITIONS = [
  { id: 2021, code: 'PL', name: 'Premier League', area: 'England' },
  { id: 2014, code: 'PD', name: 'Primera Division', area: 'Spain' },
  { id: 2019, code: 'SA', name: 'Serie A', area: 'Italy' },
  { id: 2002, code: 'BL1', name: 'Bundesliga', area: 'Germany' },
  { id: 2015, code: 'FL1', name: 'Ligue 1', area: 'France' },
  { id: 2001, code: 'CL', name: 'UEFA Champions League', area: 'Europe' },
  { id: 2000, code: 'WC', name: 'FIFA World Cup', area: 'World' },
];

function football(path, params = {}) {
  return fetchProviderJson('football-data', `${BASE}${path}`, {
    headers: { 'X-Auth-Token': TOKEN },
    params,
    timeoutMs: 10000,
  });
}

const router = express.Router();

router.get(
  '/competitions',
  wrap(async (req, res) => {
    try {
      const payload = await football('/competitions');
      const competitions = (payload.competitions || [])
        .filter((c) => CURATED_CODES.includes(c.code))
        .map((c) => ({ id: c.id, code: c.code, name: c.name, area: c.area?.name || '' }));
      if (competitions.length > 0) return res.json({ data: competitions });
      return res.json({ data: STATIC_COMPETITIONS });
    } catch (err) {
      logger.warn(`[football] /competitions upstream failed (${err.message}) — using static list`);
      return res.json({ data: STATIC_COMPETITIONS });
    }
  }),
);

router.get(
  '/standings',
  wrap(async (req, res) => {
    const code = String(req.query.competition || 'PL').toUpperCase();
    let payload;
    try {
      payload = await football(`/competitions/${code}/standings`);
    } catch (err) {
      if (err instanceof ProviderError && (err.status === 403 || err.status === 400)) {
        return res.status(403).json({ error: 'Competition not available on the current football-data plan' });
      }
      if (err instanceof ProviderError && err.status === 404) {
        return res.status(404).json({ error: `Competition ${code} not found` });
      }
      throw err;
    }
    const table = (payload.standings?.[0]?.table || []).map((r) => ({
      rank: r.position,
      team: r.team?.name || '',
      teamCrest: r.team?.crest || null,
      played: r.playedGames ?? 0,
      won: r.won ?? 0,
      draw: r.draw ?? 0,
      lost: r.lost ?? 0,
      goalsFor: r.goalsFor ?? 0,
      goalsAgainst: r.goalsAgainst ?? 0,
      goalDifference: r.goalDifference ?? 0,
      points: r.points ?? 0,
    }));
    res.json({ data: { competition: code, table } });
  }),
);

router.get(
  '/matches',
  wrap(async (req, res) => {
    const code = String(req.query.competition || 'PL').toUpperCase();
    const status = String(req.query.status || 'SCHEDULED').toUpperCase();
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));
    let payload;
    try {
      payload = await football(`/competitions/${code}/matches`, { status });
    } catch (err) {
      if (err instanceof ProviderError && (err.status === 403 || err.status === 400)) {
        return res.status(403).json({ error: 'Competition not available on the current football-data plan' });
      }
      if (err instanceof ProviderError && err.status === 404) {
        return res.status(404).json({ error: `Competition ${code} not found` });
      }
      throw err;
    }
    const matches = (payload.matches || []).slice(0, limit).map((m) => ({
      id: m.id,
      utcDate: m.utcDate,
      status: m.status,
      matchday: m.matchday ?? null,
      home: m.homeTeam?.name || '',
      away: m.awayTeam?.name || '',
      homeCrest: m.homeTeam?.crest || null,
      awayCrest: m.awayTeam?.crest || null,
      score: {
        home: m.score?.fullTime?.home ?? m.score?.regularTime?.home ?? null,
        away: m.score?.fullTime?.away ?? m.score?.regularTime?.away ?? null,
      },
    }));
    res.json({ data: matches });
  }),
);

export default router;
