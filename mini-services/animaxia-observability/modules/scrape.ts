/**
 * Scraper Prometheus + probe health — rulează la 10s, TOLERANT la erori/404
 * (animaxia_scrape_errors_total{job}; serviciul nu crapă niciodată din cauza
 * unei surse). Surse:
 *   - :4000/api/metrics                  (FAZA 9, Prometheus text — re-expus)
 *   - :4000/api/observability/metrics    (23-b, 404 tolerat până apare)
 *   - :4040/metrics                      (gateway, 23-b, tolerat)
 *   - probe health: backend, gateway health/status, watchdog, frontend,
 *     search status (pipeline FAZA 18), hub stats (FAZA 20)
 *   - redis :4030 prin client RESP propriu (PING + DBSIZE)
 * Familii proprii generate: vezi exposeOwnMetrics() — toate onest, fără date
 * inventate (familia lipsește sau e 0 dacă sursa nu răspunde încă).
 */
import { SCRAPE_INTERVAL_MS, SOURCES, OBSERVER_XFF } from '../config.ts';
import { MetricsStore } from './metrics-store.ts';
import { probeRedis } from './resp-client.ts';
import { histogramQuantile } from './prometheus.ts';

export interface PipelineStageStat {
  order: number;
  name: string;
  stats: Record<string, unknown>;
}

export interface ScrapeState {
  startedAt: number;
  lastTick: number | null;
  ticks: number;
  backend: {
    up: boolean;
    neonConnected: boolean;
    totalItems: number;
    uptimeSec: number;
    latencyMs: number | null;
  };
  gateway: {
    up: boolean;
    redisMode: string | null;
    regions: { name: string; healthy: boolean; latencyMs: number | null }[];
    failovers: number | null;
    cacheHits: number | null;
    cacheMisses: number | null;
    requests: number | null;
    requestsPerRegion: Record<string, number>;
  };
  redis: { up: boolean; keys: number | null; latencyMs: number | null };
  watchdog: { up: boolean };
  frontend: { up: boolean };
  realtime: { up: boolean };
  search: {
    pipelineIntegrated: boolean | null;
    pipelineStages: PipelineStageStat[];
    ftsP95Ms: number | null;
    ftsP50Ms: number | null;
    clusterEnabled: boolean | null;
    clusterHealthy: boolean | null;
    clusterNodesHealthy: number | null;
    docs: number | null;
    latencyP95Ms: number | null;
  };
  hub: { up: boolean; totalItems: number | null; raw: Record<string, unknown> | null };
  hubFeed: {
    up: boolean;
    personal: number | null;
    global: number | null;
    ai: number | null;
    combined: number | null;
  };
  /** istoric (rate windows) pentru cache hits/misses pipeline + rate-limit */
  pipelineCacheHistory: { tsMs: number; hits: number; misses: number }[];
  rateLimitHistory: { tsMs: number; limited: number }[];
  cooldownHistory: { tsMs: number; served: number; deprioritized: number }[];
}

async function fetchWithTimeout(
  url: string,
  timeoutMs = 6000,
): Promise<{ ok: boolean; status: number; text: string; error: string | null; latencyMs: number }> {
  const started = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // FAZA 23 load-budget: cererile DIRECTE către backend (:4000) poartă
    // identitatea de observer (XFF dedicat) — rateLimit.js bucket-uiește pe
    // XFF-first, deci monitorizarea nu consumă bugetul de 120/min al IP-ului
    // partajat 127.0.0.1 (fidel producției: Prometheus are IP propriu).
    const headers: Record<string, string> = { accept: '*/*' };
    if (url.includes(':4000')) headers['x-forwarded-for'] = OBSERVER_XFF;
    const res = await fetch(url, { signal: controller.signal, headers });
    const text = await res.text();
    clearTimeout(timer);
    return { ok: res.ok, status: res.status, text, error: null, latencyMs: Date.now() - started };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      text: '',
      error: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - started,
    };
  }
}

function tryJson(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export class Scraper {
  constructor(private store: MetricsStore) {}

  state: ScrapeState = {
    startedAt: Date.now(),
    lastTick: null,
    ticks: 0,
    backend: { up: false, neonConnected: false, totalItems: 0, uptimeSec: 0, latencyMs: null },
    gateway: {
      up: false,
      redisMode: null,
      regions: [],
      failovers: null,
      cacheHits: null,
      cacheMisses: null,
      requests: null,
      requestsPerRegion: {},
    },
    redis: { up: false, keys: null, latencyMs: null },
    watchdog: { up: false },
    frontend: { up: false },
    realtime: { up: false },
    search: {
      pipelineIntegrated: null,
      pipelineStages: [],
      ftsP95Ms: null,
      ftsP50Ms: null,
      clusterEnabled: null,
      clusterHealthy: null,
      clusterNodesHealthy: null,
      docs: null,
      latencyP95Ms: null,
    },
    hub: { up: false, totalItems: null, raw: null },
    hubFeed: { up: false, personal: null, global: null, ai: null, combined: null },
    pipelineCacheHistory: [],
    rateLimitHistory: [],
    cooldownHistory: [],
  };

  collectorTracesActive: number | null = null;

  private timer: ReturnType<typeof setInterval> | null = null;

  start(): void {
    // primul tick imediat (după 1s, să lase serviciul să ridice serverul HTTP)
    setTimeout(() => void this.tick(), 1000);
    this.timer = setInterval(() => void this.tick(), SCRAPE_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async scrapeJob(url: string, job: string): Promise<string | null> {
    const res = await fetchWithTimeout(url);
    if (res.ok && res.text) {
      const parsed = this.store.replaceScraped(job, res.text);
      if (parsed.series === 0) {
        this.store.scrapeError(job);
        return null;
      }
      return res.text;
    }
    this.store.scrapeError(job);
    return null;
  }

  private async probe(
    url: string,
    label: string,
  ): Promise<{ up: boolean; json: Record<string, unknown> | null; status: number; latencyMs: number }> {
    const res = await fetchWithTimeout(url);
    const up = res.status > 0 && res.status < 500; // orice răspuns HTTP = serviciul e viu
    if (!up) this.store.scrapeError(label);
    return { up, json: tryJson(res.text), status: res.status, latencyMs: res.latencyMs };
  }

  async tick(): Promise<void> {
    this.state.ticks++;
    this.state.lastTick = Date.now();
    const now = Date.now();

    // ── 1. scrape Prometheus text (FAZA 9 + sursele 23-b tolerate la 404) ─
    await this.scrapeJob(SOURCES.backendMetrics, 'animaxia-backend');
    await this.scrapeJob(SOURCES.backendObservability, 'animaxia-backend-faza23');
    await this.scrapeJob(SOURCES.gatewayMetrics, 'animaxia-global-gateway');

    // ── 2. probe backend health ───────────────────────────────────────────
    const backend = await this.probe(SOURCES.backendHealth, 'animaxia-backend-health');
    const bj = backend.json;
    const db = (bj?.db ?? {}) as { connected?: boolean; totalItems?: number };
    const totalItems =
      typeof db.totalItems === 'number'
        ? db.totalItems
        : typeof bj?.totalItems === 'number'
          ? (bj.totalItems as number)
          : 0;
    this.state.backend = {
      up: backend.up && backend.status === 200,
      neonConnected: db.connected === true,
      totalItems,
      uptimeSec: typeof bj?.uptimeSec === 'number' ? (bj.uptimeSec as number) : 0,
      latencyMs: backend.latencyMs,
    };

    // ── 3. gateway health + status ────────────────────────────────────────
    const gwHealth = await this.probe(SOURCES.gatewayHealth, 'global-gateway-health');
    const gwStatus = await this.probe(SOURCES.gatewayStatus, 'global-gateway-status');
    const gwj = gwStatus.json;
    const counters = (gwj?.counters ?? null) as Record<string, unknown> | null;
    const perRegion = (counters?.perRegion ?? null) as Record<string, number> | null;
    const regionsRaw = Array.isArray(gwj?.regions) ? (gwj!.regions as unknown[]) : [];
    const regions = regionsRaw.map((r) => {
      const ro = (r ?? {}) as {
        name?: string;
        upstreams?: { healthy?: boolean; latencyMs?: number | null }[];
      };
      const healthyUps = (ro.upstreams ?? []).filter((u) => u.healthy);
      const firstHealthy = healthyUps[0];
      return {
        name: ro.name ?? 'unknown',
        healthy: healthyUps.length > 0,
        latencyMs: firstHealthy?.latencyMs ?? null,
      };
    });
    this.state.gateway = {
      up: gwHealth.up && gwHealth.json?.ok === true,
      redisMode: typeof gwj?.redisMode === 'string' ? (gwj.redisMode as string) : null,
      regions,
      failovers: counters && typeof counters.failovers === 'number' ? counters.failovers : null,
      cacheHits: counters && typeof counters.cacheHits === 'number' ? counters.cacheHits : null,
      cacheMisses: counters && typeof counters.cacheMisses === 'number' ? counters.cacheMisses : null,
      requests: counters && typeof counters.requests === 'number' ? counters.requests : null,
      requestsPerRegion: perRegion ? { ...perRegion } : {},
    };

    // ── 4. redis global (RESP propriu) ────────────────────────────────────
    const redis = await probeRedis();
    this.state.redis = { up: redis.ok, keys: redis.keys, latencyMs: redis.latencyMs };
    if (!redis.ok) this.store.scrapeError('redis-global');

    // ── 5. watchdog / frontend / realtime ─────────────────────────────────
    const watchdog = await this.probe(SOURCES.watchdogHealth, 'animaxia-watchdog');
    this.state.watchdog = { up: watchdog.up && watchdog.json?.ok === true };
    const frontend = await this.probe(SOURCES.frontend, 'animaxia-frontend');
    this.state.frontend = { up: frontend.status === 200 };
    // realtime: root răspunde 400 — orice răspuns HTTP = UP (ECONNREFUSED = DOWN)
    const realtime = await this.probe(SOURCES.realtime, 'animaxia-realtime');
    this.state.realtime = { up: realtime.status > 0 };

    // ── 6. search status (pipeline FAZA 18) ───────────────────────────────
    const search = await this.probe(SOURCES.searchStatus, 'animaxia-search-status');
    const sj = search.json;
    const stages = Array.isArray(sj?.pipelineStages) ? (sj!.pipelineStages as PipelineStageStat[]) : [];
    const latency = (sj?.latency ?? null) as { p95Ms?: number } | null;
    const cluster = (sj?.cluster ?? null) as
      | { enabled?: boolean; healthy?: boolean; nodes?: { healthy?: boolean }[] }
      | null;
    this.state.search = {
      pipelineIntegrated: sj ? sj.pipelineIntegrated === true : null,
      pipelineStages: stages,
      ftsP95Ms: this.stageNumber(stages, 'neon-fts', 'p95Ms'),
      ftsP50Ms: this.stageNumber(stages, 'neon-fts', 'p50Ms'),
      clusterEnabled: cluster ? cluster.enabled === true : null,
      clusterHealthy: cluster ? cluster.healthy === true : null,
      clusterNodesHealthy: cluster?.nodes
        ? cluster.nodes.filter((n) => n.healthy === true).length
        : null,
      docs: typeof sj?.docs === 'number' ? (sj.docs as number) : null,
      latencyP95Ms: latency && typeof latency.p95Ms === 'number' ? latency.p95Ms : null,
    };

    // istoric cache/rate-limit/cooldown din pipeline (pentru ferestre 10m)
    const cacheHits = this.stageNumber(stages, 'cache', 'hits') ?? 0;
    const cacheMisses = this.stageNumber(stages, 'cache', 'misses') ?? 0;
    const limited = this.stageNumber(stages, 'rate-limit', 'limited') ?? 0;
    const cooldownServed = this.stageNumber(stages, 'cooldown', 'servedFromCooldown') ?? 0;
    const cooldownDepri = this.stageNumber(stages, 'cooldown', 'deprioritized') ?? 0;
    this.state.pipelineCacheHistory.push({ tsMs: now, hits: cacheHits, misses: cacheMisses });
    this.state.rateLimitHistory.push({ tsMs: now, limited });
    this.state.cooldownHistory.push({ tsMs: now, served: cooldownServed, deprioritized: cooldownDepri });
    const historyCutoff = now - 11 * 60 * 1000; // puțin peste fereastra de 10m
    this.state.pipelineCacheHistory = this.state.pipelineCacheHistory.filter((p) => p.tsMs >= historyCutoff);
    this.state.rateLimitHistory = this.state.rateLimitHistory.filter((p) => p.tsMs >= historyCutoff);
    this.state.cooldownHistory = this.state.cooldownHistory.filter((p) => p.tsMs >= historyCutoff);

    // ── 7. hub stats (FAZA 20) ────────────────────────────────────────────
    const hub = await this.probe(SOURCES.hubStats, 'animaxia-hub-stats');
    this.state.hub = {
      up: hub.up && hub.json?.ok === true,
      totalItems: typeof hub.json?.totalItems === 'number' ? (hub.json.totalItems as number) : null,
      raw: hub.json,
    };

    // ── 7b. hub feed 3-surse (personal + global + ai) ─────────────────────
    const feedUrl = SOURCES.hubStats.replace('/api/hub/stats', '/api/hub/feed');
    const feed = await this.probe(`${feedUrl}?limit=1`, 'animaxia-hub-feed');
    const fj = feed.json;
    const countItems = (v: unknown): number | null => {
      if (v && typeof v === 'object' && Array.isArray((v as { items?: unknown }).items)) {
        return (v as { items: unknown[] }).items.length;
      }
      return null;
    };
    this.state.hubFeed = {
      up: feed.up && fj?.ok === true,
      personal: countItems(fj?.personal),
      global: countItems(fj?.global),
      ai: countItems(fj?.ai),
      combined: typeof fj?.combinedCount === 'number' ? (fj.combinedCount as number) : null,
    };

    // ── 8. expune familiile proprii ───────────────────────────────────────
    this.exposeOwnMetrics();
  }

  private stageNumber(stages: PipelineStageStat[], name: string, key: string): number | null {
    const st = stages.find((s) => s.name === name);
    if (!st) return null;
    const v = st.stats?.[key];
    return typeof v === 'number' ? v : null;
  }

  /** scrie toate familiile proprii în store (chemat la fiecare tick). */
  exposeOwnMetrics(): void {
    const s = this.state;
    const svc = (name: string, up: boolean) =>
      this.store.set(
        'animaxia_up',
        { service: name },
        up ? 1 : 0,
        'gauge',
        '1 dacă serviciul platformei răspunde (probe health FAZA 23)',
      );

    svc('animaxia-backend', s.backend.up);
    svc('animaxia-frontend', s.frontend.up);
    svc('animaxia-realtime', s.realtime.up);
    svc('animaxia-watchdog', s.watchdog.up);
    svc('redis-global', s.redis.up);
    svc('global-gateway', s.gateway.up);
    svc('animaxia-observability', true); // self — suntem vii dacă scriem asta

    const upSec = (name: string, v: number | null) => {
      if (v === null) return;
      this.store.set(
        'animaxia_uptime_seconds',
        { service: name },
        Math.round(v),
        'gauge',
        'Uptime proces (secunde) raportat de serviciu',
      );
    };
    upSec('animaxia-backend', s.backend.uptimeSec || null);

    // scrape errors (per job, cumulative de la pornirea observability)
    const jobs = [
      'animaxia-backend',
      'animaxia-backend-faza23',
      'animaxia-global-gateway',
      'animaxia-backend-health',
      'global-gateway-health',
      'global-gateway-status',
      'redis-global',
      'animaxia-watchdog',
      'animaxia-frontend',
      'animaxia-realtime',
      'animaxia-search-status',
      'animaxia-hub-stats',
      'animaxia-hub-feed',
    ];
    for (const job of jobs) {
      const errors = this.store.scrapeErrorCount(job);
      this.store.setCounter(
        'animaxia_scrape_errors_total',
        { job },
        errors,
        'Erori/404 cumulate la scrape-ul sursei {job} (sursă tolerantă — serviciul nu crapă)',
      );
    }

    // OTel ingest counters
    for (const svcName of this.store.ingestServices()) {
      this.store.setCounter(
        'animaxia_otel_spans_received_total',
        { service: svcName },
        this.store.ingestCounterValue('spans', svcName),
        'Spans OTLP acceptați de /v1/traces per serviciu',
      );
      this.store.setCounter(
        'animaxia_otel_metrics_received_total',
        { service: svcName },
        this.store.ingestCounterValue('metrics', svcName),
        'Metrici OTLP acceptate de /v1/metrics per serviciu',
      );
    }

    this.store.set(
      'animaxia_otel_traces_active',
      {},
      this.collectorTracesActive ?? 0,
      'gauge',
      'Traces active în ring buffer-ul collectorului (LRU 5000)',
    );

    // Neon
    this.store.set(
      'animaxia_neon_connected',
      {},
      s.backend.neonConnected ? 1 : 0,
      'gauge',
      'Neon conectat (db.connected din /api/health)',
    );
    if (s.backend.latencyMs !== null)
      this.store.set('animaxia_neon_latency_ms', {}, s.backend.latencyMs, 'gauge', 'Latency probe /api/health (ms)');
    if (s.backend.totalItems > 0)
      this.store.set('animaxia_neon_docs', {}, s.backend.totalItems, 'gauge', 'Documente (itemi) în Neon');

    // Redis
    this.store.set('animaxia_redis_connected', {}, s.redis.up ? 1 : 0, 'gauge', 'Redis global :4030 PING ok');
    if (s.redis.keys !== null)
      this.store.set('animaxia_redis_keys', {}, s.redis.keys, 'gauge', 'Chei în Redis global (DBSIZE)');

    // Gateway
    this.store.set('animaxia_gateway_up', {}, s.gateway.up ? 1 : 0, 'gauge', 'Global gateway :4040 /api/infra/health ok');
    for (const r of s.gateway.regions) {
      this.store.set(
        'animaxia_gateway_region_healthy',
        { region: r.name },
        r.healthy ? 1 : 0,
        'gauge',
        'Regiune gateway cu cel puțin un upstream sănătos',
      );
      if (r.latencyMs !== null)
        this.store.set(
          'animaxia_gateway_region_latency_ms',
          { region: r.name },
          r.latencyMs,
          'gauge',
          'Latency upstream sănătos al regiunii (ms)',
        );
      const reqs = s.gateway.requestsPerRegion[r.name];
      if (typeof reqs === 'number')
        this.store.setCounter(
          'animaxia_gateway_requests_total',
          { region: r.name },
          reqs,
          'Cereri servite de gateway per regiune (counters.perRegion)',
        );
    }
    if (s.gateway.failovers !== null)
      this.store.setCounter('animaxia_gateway_failovers_total', {}, s.gateway.failovers, 'Failover-uri gateway (counters.failovers)');
    if (s.gateway.cacheHits !== null)
      this.store.setCounter('animaxia_gateway_cache_hits_total', {}, s.gateway.cacheHits, 'Cache hits gateway (counters.cacheHits)');

    // Pipeline FAZA 18 (re-expus din /api/search/status)
    const stage = (name: string, key: string): number | null => this.stageNumber(s.search.pipelineStages, name, key);
    const setP = (metric: string, labels: Record<string, string>, v: number | null, help: string) => {
      if (v === null) return;
      this.store.set(metric, labels, v, 'gauge', help);
    };
    setP('animaxia_pipeline_antisam_hits_total', {}, stage('anti-spam', 'rejected'), 'Pipeline FAZA 18 strat 1 anti-spam: interogări respinse (cumulat)');
    setP('animaxia_pipeline_ratelimit_hits_total', {}, stage('rate-limit', 'limited'), 'Pipeline strat 2 rate-limit: cereri limitate (cumulat)');
    setP('animaxia_pipeline_cooldown_served_total', {}, stage('cooldown', 'servedFromCooldown'), 'Pipeline strat 3 cooldown: servite din cooldown (cumulat)');
    setP('animaxia_pipeline_cooldown_deprioritized_total', {}, stage('cooldown', 'deprioritized'), 'Pipeline strat 3 cooldown: deprioritized (cumulat)');
    setP('animaxia_pipeline_queue_length', {}, stage('queue', 'queueDepth'), 'Pipeline strat 4 queue: adâncime curentă');
    setP('animaxia_pipeline_queue_inflight', {}, stage('queue', 'inflight'), 'Pipeline strat 4 queue: în execuție');
    setP('animaxia_pipeline_windowing_rate_per_sec', {}, stage('windowing', 'executionsPerSec'), 'Pipeline strat 6 windowing: execuții/s');
    setP('animaxia_pipeline_dedup_coalesced_total', {}, stage('dedup', 'coalesced'), 'Pipeline strat 7 dedup: cereri coalesced (cumulat)');
    setP('animaxia_pipeline_batching_batches_total', {}, stage('batching', 'batches'), 'Pipeline strat 8 batching: batch-uri (cumulat)');
    setP('animaxia_pipeline_cache_hits_total', {}, stage('cache', 'hits'), 'Pipeline strat 9 cache: hits (cumulat)');
    setP('animaxia_pipeline_cache_misses_total', {}, stage('cache', 'misses'), 'Pipeline strat 9 cache: misses (cumulat)');
    const hitRate = stage('cache', 'hitRate');
    if (hitRate !== null)
      this.store.set('animaxia_pipeline_cache_hit_rate', {}, hitRate, 'gauge', 'Pipeline strat 9 cache: hit rate fracționar');
    setP('animaxia_pipeline_requests_total', {}, stage('neon-fts', 'executions'), 'Pipeline strat 10 neon-fts: execuții FTS (cumulat)');
    setP('animaxia_pipeline_rejections_total', {}, stage('neon-fts', 'errors'), 'Pipeline strat 10 neon-fts: erori (cumulat)');
    setP('animaxia_fts_latency_p95_ms', {}, s.search.ftsP95Ms ?? s.search.latencyP95Ms, 'FTS p95 (ms) — pipeline neon-fts sau /api/search/status latency.p95Ms');
    setP('animaxia_fts_latency_p50_ms', {}, s.search.ftsP50Ms, 'FTS p50 (ms) — pipeline neon-fts');
    if (s.search.docs !== null)
      this.store.set('animaxia_fts_docs', {}, s.search.docs, 'gauge', 'Documente indexate FTS');

    // Hub FAZA 20 (re-expus din /api/hub/stats)
    if (s.hub.totalItems !== null)
      this.store.set('animaxia_hub_total_items', {}, s.hub.totalItems, 'gauge', 'Itemi total în hub (/api/hub/stats)');
    // rute hub din FAZA 9 (animaxia_http_requests_total{route="/api/hub/..."})
    this.exposeHubRoutes();

    // feed activity / search activity — din FAZA 9 http_requests_total
    const feedReqs = this.store.scrapedSum('animaxia_http_requests_total', { route: '/api/hub/feed' });
    this.store.setCounter(
      'animaxia_feed_activity_total',
      { source: 'hub:feed' },
      feedReqs,
      'Activitate feed (cereri /api/hub/feed, din FAZA 9 re-expus)',
    );
    const searchReqs =
      this.store.scrapedSum('animaxia_http_requests_total', { route: '/api/search/advanced' }) +
      this.store.scrapedSum('animaxia_http_requests_total', { route: '/api/search/autocomplete' });
    this.store.setCounter(
      'animaxia_search_activity_total',
      { route: 'search' },
      searchReqs,
      'Activitate căutare (cereri /api/search/*, din FAZA 9 re-expus)',
    );

    // proces backend (FAZA 9 re-expus, pentru dashboard global)
    const rss = this.store.scrapedValue('animaxia_process_memory_rss_bytes', {});
    if (rss !== null)
      this.store.set(
        'animaxia_backend_memory_rss_bytes',
        {},
        rss,
        'gauge',
        'RSS proces backend (re-expus FAZA 9 animaxia_process_memory_rss_bytes)',
      );

    // familii așteptate de la 23-b / OTLP — emise onest ca 0 doar dacă NU au
    // venit deja date reale prin /v1/metrics (nu suprascriem ingest-ul real)
    const expectedOtlp: { name: string; help: string }[] = [
      { name: 'animaxia_player_resume_events_total', help: 'Resume events player FAZA 17/21 (sursă: OTLP /v1/metrics — 0 până sosește prima valoare reală)' },
      { name: 'animaxia_player_subtitle_requests_total', help: 'Cereri subtitrări WebVTT (sursă: OTLP — 0 până sosește)' },
      { name: 'animaxia_player_playback_errors_total', help: 'Erori de redare player (sursă: OTLP — 0 până sosește)' },
      { name: 'animaxia_player_fallback_chain_total', help: 'Utilizări lanț de fallback player FAZA 17 (sursă: OTLP — 0 până sosește)' },
      { name: 'animaxia_ai_usage_calls_total', help: 'Apeluri AI per rută (sursă: OTLP/23-b — 0 până sosește)' },
      { name: 'animaxia_ai_usage_errors_total', help: 'Erori AI per rută (sursă: OTLP/23-b — 0 până sosește)' },
      { name: 'animaxia_auth_events_total', help: 'Evenimente auth (sursă: OTLP/23-b — 0 până sosește)' },
      { name: 'animaxia_ratelimit_hits_total', help: 'Rate-limit hits la perimetru (sursă: OTLP/23-b — 0 până sosește)' },
      { name: 'animaxia_antispam_hits_total', help: 'Anti-spam hits la perimetru (sursă: OTLP/23-b — 0 până sosește)' },
      { name: 'animaxia_cooldown_active', help: 'Chei cooldown active (sursă: OTLP/23-b — 0 până sosește)' },
    ];
    for (const fam of expectedOtlp) {
      const hasReal = this.store
        .ownSeries(fam.name)
        .some((srs) => Object.keys(srs.labels).length > 0 && !('source' in srs.labels));
      if (!hasReal) {
        this.store.set(fam.name, { source: 'pending' }, 0, 'counter', fam.help);
      }
    }
  }

  /** animaxia_hub_requests_total / animaxia_hub_duration_ms din FAZA 9
   *  (animaxia_http_requests_total{route="/api/hub/*"} + histogram _sum/_count). */
  private exposeHubRoutes(): void {
    const routes = new Set<string>();
    for (const s of this.store.scrapedSeries('animaxia_http_requests_total')) {
      const route = s.labels.route;
      if (route && route.startsWith('/api/hub/')) routes.add(route);
    }
    for (const route of routes) {
      const requests = this.store.scrapedSum('animaxia_http_requests_total', { route });
      this.store.setCounter(
        'animaxia_hub_requests_total',
        { route },
        requests,
        'Cereri hub FAZA 20 per rută (re-expus din FAZA 9 animaxia_http_requests_total)',
      );
      const sum = this.store.scrapedValue('animaxia_http_request_latency_ms_sum', { route });
      const count = this.store.scrapedValue('animaxia_http_request_latency_ms_count', { route });
      if (sum !== null && count !== null && count > 0) {
        this.store.set(
          'animaxia_hub_duration_ms',
          { route },
          Math.round((sum / count) * 100) / 100,
          'gauge',
          'Durata medie (ms) per rută hub = _sum/_count (FAZA 9 histogramă re-expusă)',
        );
      }
    }
  }

  /** rate pe fereastră (per minut) din istoric — pentru alerte. */
  rateOverWindow(history: { tsMs: number; value: number }[], windowMs: number): number | null {
    if (history.length < 2) return null;
    const now = Date.now();
    const recent = history.filter((h) => now - h.tsMs <= windowMs);
    if (recent.length < 2) return null;
    const first = recent[0];
    const last = recent[recent.length - 1];
    const delta = last.value - first.value;
    if (delta < 0) return null; // counter reset
    const elapsedMin = Math.max(1 / 60, (last.tsMs - first.tsMs) / 60000);
    return delta / elapsedMin;
  }

  /** cache miss rate pe fereastră (0..1) din istoricul hits/misses. */
  cacheMissRateOverWindow(windowMs: number): number | null {
    const h = this.state.pipelineCacheHistory;
    if (h.length < 2) return null;
    const now = Date.now();
    const recent = h.filter((p) => now - p.tsMs <= windowMs);
    if (recent.length < 2) return null;
    const dHits = recent[recent.length - 1].hits - recent[0].hits;
    const dMisses = recent[recent.length - 1].misses - recent[0].misses;
    const total = dHits + dMisses;
    if (total <= 0) return null;
    return dMisses / total;
  }

  /** p95 real al cererilor /api/search/* din histograma FAZA 9 (bucket-e). */
  searchLatencyP95(): number | null {
    const fam = this.store.scrapedFamily('animaxia_http_request_latency_ms_bucket');
    if (!fam) return null;
    const buckets: { le: number; count: number }[] = [];
    for (const s of fam.series.values()) {
      if (!s.labels.route || !s.labels.route.startsWith('/api/search')) continue;
      const le = s.labels.le;
      if (le === undefined) continue;
      const leNum = le === '+Inf' ? Infinity : Number(le);
      if (!Number.isFinite(leNum) && le !== '+Inf') continue;
      buckets.push({ le: leNum, count: s.value });
    }
    if (buckets.length === 0) return null;
    return histogramQuantile(buckets, 0.95);
  }
}
