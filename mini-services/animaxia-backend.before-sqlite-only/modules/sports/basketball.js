import express from 'express';
import { fetchProviderJson } from '../../utils/fetcher.js';

const BASE = 'https://api.balldontlie.io';
const KEY = process.env.BALLDONTLIE_API_KEY || '';

const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

function basketball(path, params = {}) {
  if (!KEY) throw new Error('BALLDONTLIE_API_KEY missing');

  return fetchProviderJson('balldontlie', `${BASE}${path}`, {
    headers: { Authorization: KEY },
    params,
    timeoutMs: 10000,
  });
}

const router = express.Router();

router.get('/teams', wrap(async (req, res) => {
  const payload = await basketball('/nba/v1/teams');
  res.json({ data: payload.data || [] });
}));

router.get('/players', wrap(async (req, res) => {
  const search = String(req.query.search || '').trim();
  const payload = await basketball('/nba/v1/players', {
    search,
    per_page: 25,
  });
  res.json({ data: payload.data || [], meta: payload.meta || null });
}));

router.get('/games', wrap(async (req, res) => {
  const params = { per_page: 25 };

  if (req.query.date) {
    params['dates[]'] = String(req.query.date);
  }

  const payload = await basketball('/nba/v1/games', params);
  res.json({ data: payload.data || [], meta: payload.meta || null });
}));

export default router;
