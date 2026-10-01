/**
 * Synthetics globale — EXACT 46 checks, rulează la 60s (staggered, max 4
 * simultan), fiecare = fetch + asserții, timeout 8s, istoric ultimele 50
 * rulări/check. CHECK-URILE SUNT DOAR CITIRE (GET) — nu modifică nimic.
 *
 * Endpoint-urile au fost validate LIVE (curl) înainte de a fi definite:
 *  - /api/search/advanced este ruta reală de căutare (/api/search simplu nu
 *    există în router — înlocuit onest, vezi README)
 *  - /api/ai/home/stats este ruta reală FAZA 15 (/api/ai/home/status nu există)
 *  - /api/hub/browse?facets=1 este calea reală de facets (nu există /api/hub/facets)
 *  - /api/hub/years înlocuiește /api/hub/dimensions (rută inexistentă)
 *  - subtitrările: /api/player/subtitles/content/:id/subtitles (mount FAZA 21)
 *  - conținut de test: id 1907 (Animaxia HLS Demo — verificat live cu surse)
 */
import {
  SYNTHETICS_AUTO,
  SYNTHETIC_CONCURRENCY,
  SYNTHETIC_HISTORY_MAX,
  SYNTHETIC_INTERVAL_SEC,
  SYNTHETIC_RUN_CONCURRENCY,
  SYNTHETIC_STAGGER_MS,
  SYNTHETIC_RUN_STAGGER_MS,
  SYNTHETIC_TIMEOUT_MS,
  OBSERVER_XFF,
} from '../config.ts';
import type { MetricsStore } from './metrics-store.ts';

export type CheckResult = 'pass' | 'fail';

export interface CheckRun {
  ts: string;
  status: CheckResult;
  durationMs: number;
  error: string | null;
}

export interface Assertion {
  type: 'status' | 'json' | 'bodyIncludes' | 'jsonType';
  /** pentru status: cod așteptat; pentru json: path */
  path?: string;
  op?: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'truthy' | 'falsy' | 'exists' | 'includes';
  value?: unknown;
  expected?: number;
  text?: string;
}

export interface CheckDef {
  id: string;
  name: string;
  category: string;
  region: 'eu' | 'us' | 'asia' | 'local';
  target: string;
  method: 'GET' | 'RESP';
  assertions: Assertion[];
  intervalSec: number;
  note?: string;
}

const GW = 'http://localhost:4040';

/** Rezolvă un path JSON de forma "a.b.0.c". */
function resolvePath(obj: unknown, path: string): { found: boolean; value: unknown } {
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined) return { found: false, value: undefined };
    if (Array.isArray(cur)) {
      const idx = Number(part);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return { found: false, value: undefined };
      cur = cur[idx];
      continue;
    }
    if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[part] ?? undefined;
      continue;
    }
    return { found: false, value: undefined };
  }
  return { found: cur !== undefined, value: cur };
}

function compare(op: Assertion['op'], actual: unknown, expected: unknown): boolean {
  switch (op) {
    case 'eq':
      return actual === expected;
    case 'ne':
      return actual !== expected;
    case 'gt':
      return typeof actual === 'number' && typeof expected === 'number' && actual > expected;
    case 'gte':
      return typeof actual === 'number' && typeof expected === 'number' && actual >= expected;
    case 'lt':
      return typeof actual === 'number' && typeof expected === 'number' && actual < expected;
    case 'lte':
      return typeof actual === 'number' && typeof expected === 'number' && actual <= expected;
    case 'truthy':
      return Boolean(actual);
    case 'falsy':
      return !actual;
    case 'exists':
      return actual !== undefined && actual !== null;
    case 'includes':
      return (
        Array.isArray(actual) &&
        actual.length > 0 &&
        (expected === undefined || actual.some((x) => JSON.stringify(x).includes(String(expected))))
      );
    default:
      return false;
  }
}

export class Synthetics {
  private history = new Map<string, CheckRun[]>();
  private lastRunAt: string | null = null;
  private running = false;
  /** rularea în curs (dacă există) — _run așteaptă finalizarea ei */
  private inFlight: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private store: MetricsStore) {}

  /** CELE 46 — construite din target-uri validate live. */
  static readonly CHECKS: CheckDef[] = [
    // ── homepage ×3 ────────────────────────────────────────────────────────
    { id: 'homepage-eu', name: 'Homepage eu', category: 'homepage', region: 'eu', target: 'http://localhost:3000/', method: 'GET', intervalSec: 60, assertions: [{ type: 'status', expected: 200 }, { type: 'bodyIncludes', text: '<' }] },
    { id: 'homepage-us', name: 'Homepage us', category: 'homepage', region: 'us', target: 'http://localhost:3000/', method: 'GET', intervalSec: 60, assertions: [{ type: 'status', expected: 200 }] },
    { id: 'homepage-asia', name: 'Homepage asia', category: 'homepage', region: 'asia', target: 'http://localhost:3000/', method: 'GET', intervalSec: 60, assertions: [{ type: 'status', expected: 200 }] },

    // ── search ×4 (ruta reală: /api/search/advanced) ──────────────────────
    { id: 'search-eu', name: 'Căutare eu (q=big)', category: 'search', region: 'eu', target: `${GW}/api/search/advanced?q=big&region=eu`, method: 'GET', intervalSec: 60, note: '/api/search simplu nu există în router — ruta reală FAZA 18 e /api/search/advanced', assertions: [{ type: 'status', expected: 200 }, { type: 'json', path: 'total', op: 'gte', value: 1 }] },
    { id: 'search-us', name: 'Căutare us (q=big)', category: 'search', region: 'us', target: `${GW}/api/search/advanced?q=big&region=us`, method: 'GET', intervalSec: 60, assertions: [{ type: 'status', expected: 200 }, { type: 'json', path: 'total', op: 'gte', value: 1 }] },
    { id: 'search-asia', name: 'Căutare asia (q=big)', category: 'search', region: 'asia', target: `${GW}/api/search/advanced?q=big&region=asia`, method: 'GET', intervalSec: 60, assertions: [{ type: 'status', expected: 200 }, { type: 'json', path: 'total', op: 'gte', value: 1 }] },
    { id: 'search-autocomplete-eu', name: 'Autocomplete eu (q=ka)', category: 'search', region: 'eu', target: `${GW}/api/search/autocomplete?q=ka&region=eu`, method: 'GET', intervalSec: 60, assertions: [{ type: 'status', expected: 200 }, { type: 'json', path: 'suggestions', op: 'includes' }] },

    // ── pipeline FAZA 18 ×3 (eu, asia + bonus us) ─────────────────────────
    { id: 'pipeline-status-eu', name: 'Pipeline integrat eu (10 straturi)', category: 'pipeline', region: 'eu', target: `${GW}/api/search/status?region=eu`, method: 'GET', intervalSec: 60, assertions: [{ type: 'status', expected: 200 }, { type: 'json', path: 'pipelineIntegrated', op: 'eq', value: true }, { type: 'json', path: 'pipelineStages', op: 'includes' }] },
    { id: 'pipeline-status-asia', name: 'Pipeline integrat asia', category: 'pipeline', region: 'asia', target: `${GW}/api/search/status?region=asia`, method: 'GET', intervalSec: 60, assertions: [{ type: 'status', expected: 200 }, { type: 'json', path: 'pipelineIntegrated', op: 'eq', value: true }] },
    { id: 'pipeline-status-us', name: 'Pipeline integrat us', category: 'pipeline', region: 'us', target: `${GW}/api/search/status?region=us`, method: 'GET', intervalSec: 60, note: 'al 3-lea check liber (43→46)', assertions: [{ type: 'status', expected: 200 }, { type: 'json', path: 'pipelineIntegrated', op: 'eq', value: true }] },

    // ── huburi FAZA 20 ×7 ─────────────────────────────────────────────────
    { id: 'hub-browse-eu', name: 'Hub browse eu', category: 'huburi', region: 'eu', target: `${GW}/api/hub/browse?limit=5&region=eu`, method: 'GET', intervalSec: 60, assertions: [{ type: 'status', expected: 200 }, { type: 'json', path: 'ok', op: 'eq', value: true }, { type: 'json', path: 'data', op: 'includes' }] },
    { id: 'hub-browse-us', name: 'Hub browse us', category: 'huburi', region: 'us', target: `${GW}/api/hub/browse?limit=5&region=us`, method: 'GET', intervalSec: 60, assertions: [{ type: 'status', expected: 200 }, { type: 'json', path: 'ok', op: 'eq', value: true }] },
    { id: 'hub-browse-asia', name: 'Hub browse asia', category: 'huburi', region: 'asia', target: `${GW}/api/hub/browse?limit=5&region=asia`, method: 'GET', intervalSec: 60, assertions: [{ type: 'status', expected: 200 }, { type: 'json', path: 'ok', op: 'eq', value: true }] },
    { id: 'hub-facets-us', name: 'Hub facets us (browse?facets=1)', category: 'huburi', region: 'us', target: `${GW}/api/hub/browse?limit=1&facets=1&region=us`, method: 'GET', intervalSec: 60, note: '/api/hub/facets nu există — facets se obțin din /api/hub/browse?facets=1 (rută reală FAZA 20)', assertions: [{ type: 'status', expected: 200 }, { type: 'json', path: 'facets', op: 'exists' }] },
    { id: 'hub-stats-us', name: 'Hub stats us', category: 'huburi', region: 'us', target: `${GW}/api/hub/stats?region=us`, method: 'GET', intervalSec: 60, assertions: [{ type: 'status', expected: 200 }, { type: 'json', path: 'ok', op: 'eq', value: true }, { type: 'json', path: 'totalItems', op: 'gt', value: 0 }] },
    { id: 'hub-scale-asia', name: 'Hub scale asia (real vs capacitate proiectată AR10M)', category: 'huburi', region: 'asia', target: `${GW}/api/hub/scale?region=asia`, method: 'GET', intervalSec: 60, note: 'al 2-lea check liber', assertions: [{ type: 'status', expected: 200 }, { type: 'json', path: 'ok', op: 'eq', value: true }] },
    { id: 'hub-years-asia', name: 'Hub years asia (dimensiune anii)', category: 'huburi', region: 'asia', target: `${GW}/api/hub/years?region=asia`, method: 'GET', intervalSec: 60, note: '/api/hub/dimensions nu există — înlocuit onest cu /api/hub/years (rută reală FAZA 20)', assertions: [{ type: 'status', expected: 200 }, { type: 'json', path: 'data', op: 'includes' }] },

    // ── feed 3-surse ×1 ───────────────────────────────────────────────────
    { id: 'feed-asia', name: 'Feed 3-surse asia', category: 'feed', region: 'asia', target: `${GW}/api/hub/feed?region=asia`, method: 'GET', intervalSec: 60, assertions: [{ type: 'status', expected: 200 }, { type: 'json', path: 'ok', op: 'eq', value: true }, { type: 'json', path: 'global.items', op: 'exists' }] },

    // ── recomandări publice ×1 ────────────────────────────────────────────
    { id: 'recommendations-eu', name: 'Recomandări publice eu', category: 'recommendations', region: 'eu', target: `${GW}/api/hub/recommendations?region=eu`, method: 'GET', intervalSec: 60, assertions: [{ type: 'status', expected: 200 }, { type: 'json', path: 'ok', op: 'eq', value: true }, { type: 'json', path: 'real.items', op: 'exists' }] },

    // ── history FAZA 21 ×2 (gating 401 fără token) ────────────────────────
    { id: 'history-gating-eu', name: 'Istoric gating 401 eu', category: 'history', region: 'eu', target: `${GW}/api/users/me/history?region=eu`, method: 'GET', intervalSec: 60, assertions: [{ type: 'status', expected: 401 }] },
    { id: 'history-gating-us', name: 'Istoric gating 401 us', category: 'history', region: 'us', target: `${GW}/api/users/me/history?region=us`, method: 'GET', intervalSec: 60, assertions: [{ type: 'status', expected: 401 }] },

    // ── playlists FAZA 21 ×2 ──────────────────────────────────────────────
    { id: 'playlists-gating-eu', name: 'Playlist-uri gating 401 eu', category: 'playlists', region: 'eu', target: `${GW}/api/playlists?region=eu`, method: 'GET', intervalSec: 60, assertions: [{ type: 'status', expected: 401 }] },
    { id: 'playlists-gating-asia', name: 'Playlist-uri gating 401 asia', category: 'playlists', region: 'asia', target: `${GW}/api/playlists?region=asia`, method: 'GET', intervalSec: 60, assertions: [{ type: 'status', expected: 401 }] },

    // ── stats FAZA 21 ×2 ──────────────────────────────────────────────────
    { id: 'user-stats-gating-eu', name: 'Stats personale gating 401 eu', category: 'stats', region: 'eu', target: `${GW}/api/users/me/stats?region=eu`, method: 'GET', intervalSec: 60, assertions: [{ type: 'status', expected: 401 }] },
    { id: 'user-stats-gating-us', name: 'Stats personale gating 401 us', category: 'stats', region: 'us', target: `${GW}/api/users/me/stats?region=us`, method: 'GET', intervalSec: 60, assertions: [{ type: 'status', expected: 401 }] },

    // ── player FAZA 17 ×3 (id 1907 verificat live) ────────────────────────
    { id: 'player-eu', name: 'Player cu surse eu (id 1907)', category: 'player', region: 'eu', target: `${GW}/api/content/1907/player?region=eu`, method: 'GET', intervalSec: 60, assertions: [{ type: 'status', expected: 200 }, { type: 'json', path: 'content.metadata.player.sources', op: 'includes' }] },
    { id: 'player-us', name: 'Player cu surse us (id 1907)', category: 'player', region: 'us', target: `${GW}/api/content/1907/player?region=us`, method: 'GET', intervalSec: 60, assertions: [{ type: 'status', expected: 200 }, { type: 'json', path: 'content.metadata.player.sources', op: 'includes' }] },
    { id: 'player-asia', name: 'Player cu surse asia (id 1907)', category: 'player', region: 'asia', target: `${GW}/api/content/1907/player?region=asia`, method: 'GET', intervalSec: 60, assertions: [{ type: 'status', expected: 200 }, { type: 'json', path: 'content.metadata.player.sources', op: 'includes' }] },

    // ── subtitrări WebVTT ×1 (rută reală FAZA 21) ─────────────────────────
    { id: 'subtitles-eu', name: 'Subtitrări WebVTT eu (id 1907)', category: 'subtitles', region: 'eu', target: `${GW}/api/player/subtitles/content/1907/subtitles?region=eu`, method: 'GET', intervalSec: 60, note: 'ruta reală e /api/player/subtitles/content/:id/subtitles (mount /api/player/subtitles + router FAZA 21)', assertions: [{ type: 'status', expected: 200 }, { type: 'json', path: 'ok', op: 'eq', value: true }, { type: 'json', path: 'data', op: 'exists' }] },

    // ── AI Hub FAZA 16 ×2 ─────────────────────────────────────────────────
    { id: 'ai-hub-eu', name: 'AI Hub status eu', category: 'ai-hub', region: 'eu', target: `${GW}/api/ai/hub/status?region=eu`, method: 'GET', intervalSec: 60, assertions: [{ type: 'status', expected: 200 }, { type: 'json', path: 'ais', op: 'includes' }] },
    { id: 'ai-hub-us', name: 'AI Hub status us', category: 'ai-hub', region: 'us', target: `${GW}/api/ai/hub/status?region=us`, method: 'GET', intervalSec: 60, assertions: [{ type: 'status', expected: 200 }, { type: 'json', path: 'ais', op: 'includes' }] },

    // ── AI Home FAZA 15 ×2 (ruta reală: /api/ai/home/stats) ───────────────
    { id: 'ai-home-eu', name: 'AI Home stats eu', category: 'ai-home', region: 'eu', target: `${GW}/api/ai/home/stats?region=eu`, method: 'GET', intervalSec: 60, note: '/api/ai/home/status nu există — rutele reale FAZA 15: feed/taxonomy/stats/metadata/browse/trailers', assertions: [{ type: 'status', expected: 200 }, { type: 'json', path: 'ai', op: 'eq', value: true }] },
    { id: 'ai-home-asia', name: 'AI Home stats asia', category: 'ai-home', region: 'asia', target: `${GW}/api/ai/home/stats?region=asia`, method: 'GET', intervalSec: 60, assertions: [{ type: 'status', expected: 200 }, { type: 'json', path: 'ai', op: 'eq', value: true }] },

    // ── AR10M arhitectura reală ×3 (fost „30B logic" simulat — eliminat) ──
    { id: 'ar10m-stats-eu', name: 'AR10M stats eu (capacitate proiectată 10M)', category: 'ar10m', region: 'eu', target: `${GW}/api/ar10m/stats?region=eu`, method: 'GET', intervalSec: 60, assertions: [{ type: 'status', expected: 200 }, { type: 'json', path: 'capacity.designed', op: 'eq', value: 10000000 }] },
    { id: 'ar10m-stats-us', name: 'AR10M stats us', category: 'ar10m', region: 'us', target: `${GW}/api/ar10m/stats?region=us`, method: 'GET', intervalSec: 60, assertions: [{ type: 'status', expected: 200 }, { type: 'json', path: 'capacity.designed', op: 'eq', value: 10000000 }] },
    { id: 'ar10m-stats-asia', name: 'AR10M stats asia', category: 'ar10m', region: 'asia', target: `${GW}/api/ar10m/stats?region=asia`, method: 'GET', intervalSec: 60, assertions: [{ type: 'status', expected: 200 }, { type: 'json', path: 'capacity.designed', op: 'eq', value: 10000000 }] },

    // ── sharding FAZA 13 ×3 ───────────────────────────────────────────────
    { id: 'sharding-eu', name: 'Sharding cluster eu', category: 'sharding', region: 'eu', target: `${GW}/api/shards?region=eu`, method: 'GET', intervalSec: 60, assertions: [{ type: 'status', expected: 200 }, { type: 'json', path: 'searchCluster.enabled', op: 'eq', value: true }, { type: 'json', path: 'searchCluster.nodes.0.healthy', op: 'eq', value: true }] },
    { id: 'sharding-us', name: 'Sharding cluster us', category: 'sharding', region: 'us', target: `${GW}/api/shards?region=us`, method: 'GET', intervalSec: 60, assertions: [{ type: 'status', expected: 200 }, { type: 'json', path: 'searchCluster.enabled', op: 'eq', value: true }] },
    { id: 'sharding-asia', name: 'Sharding cluster asia', category: 'sharding', region: 'asia', target: `${GW}/api/shards?region=asia`, method: 'GET', intervalSec: 60, assertions: [{ type: 'status', expected: 200 }, { type: 'json', path: 'searchCluster.enabled', op: 'eq', value: true }] },

    // ── uptime interne ×7 ─────────────────────────────────────────────────
    { id: 'uptime-backend', name: 'Backend :4000 UP', category: 'uptime', region: 'local', target: 'http://localhost:4000/api/health', method: 'GET', intervalSec: 60, assertions: [{ type: 'status', expected: 200 }, { type: 'json', path: 'status', op: 'eq', value: 'ok' }] },
    { id: 'uptime-redis', name: 'Redis :4030 PING', category: 'uptime', region: 'local', target: 'resp://localhost:4030', method: 'RESP', intervalSec: 60, note: 'PING via client RESP propriu (node:net)', assertions: [{ type: 'bodyIncludes', text: '+PONG' }] },
    { id: 'uptime-gateway', name: 'Gateway :4040 UP', category: 'uptime', region: 'local', target: 'http://localhost:4040/api/infra/health', method: 'GET', intervalSec: 60, assertions: [{ type: 'status', expected: 200 }, { type: 'json', path: 'ok', op: 'eq', value: true }] },
    { id: 'uptime-realtime', name: 'Realtime :4010 UP', category: 'uptime', region: 'local', target: 'http://localhost:4010/', method: 'GET', intervalSec: 60, note: 'root răspunde 400 — orice răspuns HTTP = UP (ECONNREFUSED = DOWN)', assertions: [{ type: 'json', path: '__status__', op: 'gt', value: 0 }] },
    { id: 'uptime-watchdog', name: 'Watchdog :4020 UP', category: 'uptime', region: 'local', target: 'http://localhost:4020/health', method: 'GET', intervalSec: 60, assertions: [{ type: 'status', expected: 200 }, { type: 'json', path: 'ok', op: 'eq', value: true }] },
    { id: 'uptime-frontend', name: 'Frontend :3000 UP', category: 'uptime', region: 'local', target: 'http://localhost:3000/', method: 'GET', intervalSec: 60, assertions: [{ type: 'status', expected: 200 }] },
    { id: 'uptime-collector', name: 'Observability self :4050 UP', category: 'uptime', region: 'local', target: 'http://localhost:4050/health', method: 'GET', intervalSec: 60, assertions: [{ type: 'status', expected: 200 }, { type: 'json', path: 'ok', op: 'eq', value: true }] },
  ];

  start(): void {
    /* NEON FREE PLAN (scale-to-zero): loop-ul automat de synthetics este
     * DEFAULT OPRIT — cele 46 de check-uri generau trafic fals continuu
     * (căutări FTS reale, hub browse, AI status → interogări Neon la fiecare
     * 2 min, 24/7) care ținea compute-ul treaz fără niciun utilizator real.
     * Rulează on-demand: POST /api/synthetics/_run (sau SYNTHETICS_AUTO=1
     * pentru behaviorul vechi, explicit). */
    if (!SYNTHETICS_AUTO) {
      console.log('[synthetics] auto-run OPRIT (NEON FREE PLAN) — on-demand via POST /api/synthetics/_run');
      return;
    }
    // prima rulare completă după 5s (după ce serviciul e sus)
    setTimeout(() => void this.runAll(SYNTHETIC_CONCURRENCY), 5_000);
    this.timer = setInterval(() => {
      void this.runAll(SYNTHETIC_CONCURRENCY);
    }, SYNTHETIC_INTERVAL_SEC * 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** rulează un singur check și înregistrează rezultatul. */
  async runCheck(def: CheckDef): Promise<CheckRun> {
    const started = Date.now();
    let status: CheckResult = 'pass';
    let error: string | null = null;
    let bodyText = '';
    let statusCode = 0;
    let json: unknown = null;

    try {
      if (def.method === 'RESP') {
        const { probeRedis } = await import('./resp-client.ts');
        const probe = await probeRedis();
        statusCode = probe.ok ? 200 : 0;
        bodyText = probe.ok ? '+PONG' : probe.error ?? 'redis probe failed';
        json = { __status__: statusCode, pong: probe.ok, keys: probe.keys };
        if (!probe.ok) {
          status = 'fail';
          error = probe.error ?? 'redis probe failed';
        }
      } else {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), SYNTHETIC_TIMEOUT_MS);
        // FAZA 23 load-budget: check-urile DIRECTE către :4000 poartă identitatea
        // de observer (bucket XFF separat); cele prin gateway (:4040) exercită
        // intenționat perimetrul real, ca un utilizator — asta e rolul lor.
        const init: RequestInit = { signal: controller.signal };
        if (def.target.includes(':4000')) {
          init.headers = { 'x-forwarded-for': OBSERVER_XFF };
        }
        const res = await fetch(def.target, init);
        clearTimeout(timer);
        statusCode = res.status;
        bodyText = await res.text();
        try {
          json = JSON.parse(bodyText);
        } catch {
          json = {};
        }
        // expune status-ul HTTP ca path special pentru asserții
        if (json && typeof json === 'object' && !Array.isArray(json)) {
          (json as Record<string, unknown>).__status__ = res.status;
        } else {
          json = { __status__: res.status, __value__: json };
        }
      }

      if (status === 'pass') {
        for (const a of def.assertions) {
          if (a.type === 'status') {
            if (statusCode !== (a.expected ?? 200)) {
              status = 'fail';
              error = `status ${statusCode} != ${a.expected}`;
              break;
            }
          } else if (a.type === 'bodyIncludes') {
            if (!bodyText.includes(a.text ?? '')) {
              status = 'fail';
              error = `body nu conține "${a.text}"`;
              break;
            }
          } else if (a.type === 'json') {
            const { found, value } = resolvePath(json, a.path ?? '');
            if (!found) {
              status = 'fail';
              error = `path lipsă: ${a.path}`;
              break;
            }
            if (!compare(a.op, value, a.value)) {
              status = 'fail';
              error = `${a.path}=${JSON.stringify(value)} nu satisface ${a.op} ${JSON.stringify(a.value)}`;
              break;
            }
          }
        }
      }
    } catch (err) {
      status = 'fail';
      error = err instanceof Error ? err.message : String(err);
    }

    const run: CheckRun = {
      ts: new Date().toISOString(),
      status,
      durationMs: Date.now() - started,
      error,
    };
    this.record(def, run);
    return run;
  }

  private record(def: CheckDef, run: CheckRun): void {
    let hist = this.history.get(def.id);
    if (!hist) {
      hist = [];
      this.history.set(def.id, hist);
    }
    hist.push(run);
    if (hist.length > SYNTHETIC_HISTORY_MAX) hist.splice(0, hist.length - SYNTHETIC_HISTORY_MAX);

    // metrici
    this.store.inc(
      'animaxia_synthetic_checks_total',
      { check: def.id, region: def.region, result: run.status },
      1,
      'Rulări synthetics per check/regiune/rezultat (FAZA 23)',
    );
    this.store.set(
      'animaxia_synthetic_duration_ms',
      { check: def.id },
      run.durationMs,
      'gauge',
      'Durata ultimei rulări a check-ului (ms)',
    );
  }

  /** rulează toate cele 46 (staggered, limită concurență).
   *  staggerMs = pacing între porniri (default 1100ms — distribuie cele 46
   *  pe fereastra de 60s ca să rămână SUB propriul rate-limit al platformei:
   *  backend-ul FAZA 9/18 aplică 120 req/min/IP — good citizen, onest). */
  async runAll(
    concurrency: number,
    staggerMs = SYNTHETIC_STAGGER_MS,
  ): Promise<{
    total: number;
    passing: number;
    failing: number;
    durationMs: number;
  }> {
    if (this.running && this.inFlight) {
      // o rulare programată e deja în desfășurare — _run așteaptă finalizarea
      await this.inFlight;
      return this.summaryCounts();
    }
    this.running = true;
    const started = Date.now();
    const task = (async () => {
      try {
        const defs = Synthetics.CHECKS;
        const queue = [...defs];
        const workers: Promise<void>[] = [];
        // stagger ABSOLUT: check-ul N pornește la runStart + N×staggerMs
        // (delay relativ la pornirea rulării, nu la momentul dequeue —
        // evită compoundarea întârzierilor când execuția întârzie).
        let stagger = 0;
        const runStart = Date.now();
        for (let i = 0; i < concurrency; i++) {
          workers.push(
            (async () => {
              while (queue.length > 0) {
                const def = queue.shift();
                if (!def) break;
                const startAt = runStart + stagger;
                stagger += staggerMs;
                const sleepFor = Math.max(0, startAt - Date.now());
                await new Promise((r) => setTimeout(r, sleepFor));
                await this.runCheck(def);
              }
            })(),
          );
        }
        await Promise.all(workers);
        this.lastRunAt = new Date().toISOString();

        const counts = this.summaryCounts();
        this.store.set(
          'animaxia_synthetic_pass_ratio',
          {},
          counts.total > 0 ? counts.passing / counts.total : 0,
          'gauge',
          'Rata de trecere a celor 46 synthetics (ultimele rezultate)',
        );
      } finally {
        this.running = false;
        this.inFlight = null;
      }
    })();
    this.inFlight = task;
    await task;
    const counts = this.summaryCounts();
    return { ...counts, durationMs: Date.now() - started };
  }

  private summaryCounts(): { total: number; passing: number; failing: number; durationMs: 0 } {
    let passing = 0;
    let failing = 0;
    for (const def of Synthetics.CHECKS) {
      const hist = this.history.get(def.id);
      const last = hist?.[hist.length - 1];
      if (!last) continue;
      if (last.status === 'pass') passing++;
      else failing++;
    }
    return { total: Synthetics.CHECKS.length, passing, failing, durationMs: 0 };
  }

  /** GET /api/synthetics. */
  view() {
    const counts = this.summaryCounts();
    const byRegion: Record<string, { passing: number; total: number }> = {
      eu: { passing: 0, total: 0 },
      us: { passing: 0, total: 0 },
      asia: { passing: 0, total: 0 },
      local: { passing: 0, total: 0 },
    };
    const checks = Synthetics.CHECKS.map((def) => {
      const hist = this.history.get(def.id) ?? [];
      const last = hist[hist.length - 1];
      const passing = last?.status === 'pass';
      if (last) {
        byRegion[def.region].total++;
        if (passing) byRegion[def.region].passing++;
      }
      const failures24h = hist.filter(
        (h) => h.status === 'fail' && Date.now() - Date.parse(h.ts) < 24 * 3600 * 1000,
      ).length;
      return {
        id: def.id,
        name: def.name,
        category: def.category,
        region: def.region,
        target: def.target,
        method: def.method,
        assertions: def.assertions,
        intervalSec: def.intervalSec,
        note: def.note,
        lastStatus: last?.status ?? 'never',
        lastDurationMs: last?.durationMs ?? null,
        lastError: last?.error ?? null,
        lastRunAt: last?.ts ?? null,
        passing,
        runs: hist.length,
        failures24h,
      };
    });
    return {
      total: counts.total,
      passing: counts.passing,
      failing: counts.failing,
      lastRunAt: this.lastRunAt,
      byRegion,
      checks,
    };
  }

  historyFor(id: string): { id: string; history: CheckRun[] } | null {
    if (!Synthetics.CHECKS.some((c) => c.id === id)) return null;
    return { id, history: [...(this.history.get(id) ?? [])].reverse() };
  }

  recentFailures(n: number): { id: string; name: string; error: string | null; ts: string }[] {
    const out: { id: string; name: string; error: string | null; ts: string }[] = [];
    for (const def of Synthetics.CHECKS) {
      const last = (this.history.get(def.id) ?? []).slice(-1)[0];
      if (last && last.status === 'fail') {
        out.push({ id: def.id, name: def.name, error: last.error, ts: last.ts });
      }
    }
    return out.slice(0, n);
  }

  async runNow(): Promise<{ total: number; passing: number; failing: number; durationMs: number }> {
    // pacing mai alert decât rularea programată, dar sub rate-limit-ul platformei
    return this.runAll(SYNTHETIC_RUN_CONCURRENCY, SYNTHETIC_RUN_STAGGER_MS);
  }
}
