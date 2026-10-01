/**
 * modules/sports/f1.js — /api/sports/f1 router backed by the Ergast F1 API
 * (via the jolpi.ca mirror). Current-season driver standings and race schedule.
 */

import express from 'express';
import { fetchProviderJson } from '../../utils/fetcher.js';

const BASE = process.env.ERGASTBASEURL || 'https://api.jolpi.ca/ergast/f1';
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const router = express.Router();

router.get(
  '/standings',
  wrap(async (req, res) => {
    const payload = await fetchProviderJson('ergast', `${BASE}/current/driverStandings.json`, {
      timeoutMs: 10000,
    });
    const list = payload?.MRData?.StandingsTable?.StandingsLists?.[0]?.DriverStandings || [];
    res.json({
      data: list.map((row) => ({
        position: Number(row.positionText) || row.position,
        driver: `${row.Driver?.givenName || ''} ${row.Driver?.familyName || ''}`.trim(),
        team: row.Constructors?.[0]?.name || '',
        points: Number(row.points) || 0,
        wins: Number(row.wins) || 0,
      })),
    });
  }),
);

router.get(
  '/schedule',
  wrap(async (req, res) => {
    const payload = await fetchProviderJson('ergast', `${BASE}/current.json`, { timeoutMs: 10000 });
    const races = payload?.MRData?.RaceTable?.Races || [];
    res.json({
      data: races.map((race) => ({
        round: Number(race.round) || null,
        race: race.raceName,
        date: race.date || '',
        time: race.time || '',
        circuit: race.Circuit?.circuitName || '',
        locality: race.Circuit?.Location?.locality || '',
        country: race.Circuit?.Location?.country || '',
      })),
    });
  }),
);

export default router;
