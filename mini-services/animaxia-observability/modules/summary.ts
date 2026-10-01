/**
 * Summary API — GET /api/summary — CONTRACT FIX (consumat de tabul
 * #/admin/observability construit de agentul 23-b): 10 gauge-uri în ordine
 * fixă + pipeline + hub + player + ai + neon + redis + gateway + alerts +
 * synthetics + traces + metrics. Toate valorile vin din surse reale
 * (scrape-state, metrics store, collector, synthetics).
 */
import { RETENTION_DAYS, TRACKED_SERVICES, SCRAPE_INTERVAL_MS } from '../config.ts';
import type { TraceCollector } from './collector.ts';
import type { MetricsStore } from './metrics-store.ts';
import type { Scraper } from './scrape.ts';
import type { AlertManager } from './alerts.ts';
import type { Synthetics } from './synthetics.ts';

export interface Gauge {
  id: string;
  label: string;
  value: number;
  unit: string;
  status: 'ok' | 'warn' | 'error';
  detail: string;
}

type GStatus = Gauge['status'];

function g(
  id: string,
  label: string,
  value: number,
  unit: string,
  status: GStatus,
  detail: string,
): Gauge {
  return { id, label, value: Math.round(value * 10) / 10, unit, status, detail };
}

/** Agregă datele AI din ambele surse reale: FAZA 9 (animaxia_ai_calls_total
 *  re-expus prin scrape) și FAZA 23 (animaxia_ai_usage_* per rută, backendul
 *  23-b, job="animaxia-backend-faza23"). FAZA 9 are prioritate (contor
 *  global); suma 23-b e fallback onest când FAZA 9 e 0 (ex. după restart). */
function aiDetail(store: MetricsStore): { calls: number; errors: number; p95: number | null } {
  const faza9Calls =
    store.scrapedValue('animaxia_ai_calls_total', {}) ??
    store.scrapedValue('animaxia_ai_calls_total', { job: 'animaxia-backend' }) ??
    0;
  const faza9Errors =
    store.scrapedValue('animaxia_ai_errors_total', {}) ??
    store.scrapedValue('animaxia_ai_errors_total', { job: 'animaxia-backend' }) ??
    0;
  const faza9P95 =
    store.scrapedValue('animaxia_ai_latency_p95_ms', {}) ??
    store.scrapedValue('animaxia_ai_latency_p95_ms', { job: 'animaxia-backend' }) ??
    null;
  if (faza9Calls > 0) {
    return { calls: faza9Calls, errors: faza9Errors, p95: faza9P95 };
  }
  let calls23 = 0;
  let errors23 = 0;
  for (const s of store.scrapedSeries('animaxia_ai_usage_calls_total')) calls23 += s.value;
  for (const s of store.scrapedSeries('animaxia_ai_usage_errors_total')) errors23 += s.value;
  return { calls: calls23, errors: errors23, p95: null };
}

/** delta pe fereastră din istoricul unei familii proprii. */
function deltaOver(store: MetricsStore, metric: string, labels: Record<string, string>, windowMs: number): number | null {
  const points = store.historyFor(metric, labels, 100_000);
  if (points.length < 2) return null;
  const nowSec = Date.now() / 1000;
  const cutoff = nowSec - windowMs / 1000;
  const recent = points.filter((p) => p.tsSec >= cutoff);
  if (recent.length < 2) return null;
  const d = recent[recent.length - 1].value - recent[0].value;
  return d >= 0 ? d : null;
}

export function buildSummary(
  store: MetricsStore,
  scraper: Scraper,
  collector: TraceCollector,
  alerts: AlertManager,
  synthetics: Synthetics,
): Record<string, unknown> {
  const s = scraper.state;

  // ── gauge 1: uptime platformă ───────────────────────────────────────────
  const servicesUp = TRACKED_SERVICES.filter(
    (name) => (store.get('animaxia_up', { service: name }) ?? 0) === 1,
  ).length;
  const uptimePct = (servicesUp / TRACKED_SERVICES.length) * 100;
  const uptimeStatus: GStatus = uptimePct >= 99 ? 'ok' : uptimePct >= 95 ? 'warn' : 'error';
  const uptimeGauge = g(
    'uptime',
    'Uptime platformă',
    uptimePct,
    '%',
    uptimeStatus,
    `${servicesUp}/${TRACKED_SERVICES.length} servicii sus (probe ${SCRAPE_INTERVAL_MS / 1000}s)`,
  );

  // ── gauge 2: backend ────────────────────────────────────────────────────
  const backendLatency = s.backend.latencyMs ?? 0;
  const backendValue = s.backend.up ? (s.backend.neonConnected ? 100 : 70) : 0;
  const backendStatus: GStatus = !s.backend.up ? 'error' : s.backend.neonConnected ? 'ok' : 'warn';
  const backendGauge = g(
    'backend',
    'Backend :4000',
    backendValue,
    '%',
    backendStatus,
    s.backend.up
      ? `up, /api/health ${backendLatency}ms, Neon ${s.backend.neonConnected ? 'conectat' : 'DECONECTAT'}, uptime ${Math.round(s.backend.uptimeSec / 60)}min`
      : 'nu răspunde la /api/health',
  );

  // ── gauge 3: neon ───────────────────────────────────────────────────────
  const neonValue = s.backend.neonConnected ? 100 : 0;
  const neonStatus: GStatus = s.backend.neonConnected ? 'ok' : 'error';
  const neonGauge = g(
    'neon',
    'Neon Postgres',
    neonValue,
    '%',
    neonStatus,
    `${s.backend.neonConnected ? 'conectat' : 'deconectat'} — ${s.backend.totalItems} itemi, health ${backendLatency}ms, cluster ${s.search.clusterNodesHealthy ?? '?'}/4 shards sănătoase`,
  );

  // ── gauge 4: redis ──────────────────────────────────────────────────────
  const redisValue = s.redis.up ? 100 : 0;
  const redisStatus: GStatus = s.redis.up ? 'ok' : 'error';
  const redisGauge = g(
    'redis',
    'Redis global :4030',
    redisValue,
    '%',
    redisStatus,
    s.redis.up
      ? `PING ok ${s.redis.latencyMs ?? '?'}ms, ${s.redis.keys ?? '?'} chei, gateway mode=${s.gateway.redisMode ?? '?'}`
      : 'PING eșuat (sau gateway degradat la in-memory)',
  );

  // ── gauge 5: gateway ────────────────────────────────────────────────────
  const healthyRegions = s.gateway.regions.filter((r) => r.healthy).length;
  const gatewayValue = s.gateway.up ? (healthyRegions / Math.max(1, s.gateway.regions.length)) * 100 : 0;
  const gatewayStatus: GStatus = !s.gateway.up ? 'error' : healthyRegions === s.gateway.regions.length ? 'ok' : 'warn';
  const gatewayGauge = g(
    'gateway',
    'Global gateway :4040',
    gatewayValue,
    '%',
    gatewayStatus,
    s.gateway.up
      ? `${healthyRegions}/${s.gateway.regions.length} regiuni sănătoase (eu/us/asia), ${s.gateway.requests ?? 0} cereri, ${s.gateway.failovers ?? 0} failover-uri`
      : '/api/infra/health nu răspunde ok',
  );

  // ── gauge 6: ai usage ───────────────────────────────────────────────────
  const ai = aiDetail(store);
  let aiValue = 100;
  let aiStatus: GStatus = 'ok';
  let aiDetailText = `${ai.calls} apeluri AI (FAZA 9 + FAZA 23)`;
  if (ai.p95 !== null && ai.p95 > 0) {
    if (ai.p95 > 20000) {
      aiValue = 30;
      aiStatus = 'error';
      aiDetailText += `, p95 ${ai.p95}ms > 20s (animaxia-ai-timeout)`;
    } else if (ai.p95 > 10000) {
      aiValue = 60;
      aiStatus = 'warn';
      aiDetailText += `, p95 ${ai.p95}ms`;
    } else {
      aiValue = 100;
      aiDetailText += `, p95 ${ai.p95}ms`;
    }
  } else {
    aiDetailText += ', fără latency înregistrat';
  }
  const aiGauge = g('ai_usage', 'AI usage', aiValue, '%', aiStatus, aiDetailText);

  // ── gauge 7: search activity ────────────────────────────────────────────
  const search5m =
    deltaOver(store, 'animaxia_search_activity_total', { route: 'search' }, 5 * 60 * 1000) ?? 0;
  const searchValue = Math.min(100, search5m);
  const searchStatus: GStatus = 'ok';
  const searchGauge = g(
    'search_activity',
    'Activitate căutare',
    searchValue,
    'req/5m',
    searchStatus,
    `${search5m} cereri /api/search/* în ultimele 5m (FAZA 9 re-expus)`,
  );

  // ── gauge 8: hub activity ───────────────────────────────────────────────
  const hubRoutes = store.ownSeries('animaxia_hub_requests_total');
  let hub5m = 0;
  for (const r of hubRoutes) {
    hub5m += deltaOver(store, 'animaxia_hub_requests_total', r.labels, 5 * 60 * 1000) ?? 0;
  }
  const hubValue = Math.min(100, hub5m);
  const hubGauge = g(
    'hub_activity',
    'Activitate huburi',
    hubValue,
    'req/5m',
    'ok',
    `${hub5m} cereri /api/hub/* în ultimele 5m pe ${hubRoutes.length} rute (FAZA 20)`,
  );

  // ── gauge 9: pipeline health ────────────────────────────────────────────
  const queueLength = s.search.pipelineStages.find((x) => x.name === 'queue')?.stats?.queueDepth;
  const ftsP95 = s.search.ftsP95Ms ?? s.search.latencyP95Ms;
  const cacheMissRate = scraper.cacheMissRateOverWindow(10 * 60 * 1000);
  let pipelineValue = 100;
  let pipelineStatus: GStatus = 'ok';
  const pipelineIssues: string[] = [];
  if (s.search.pipelineIntegrated !== true) {
    pipelineValue = 0;
    pipelineStatus = 'error';
    pipelineIssues.push('pipelineIntegrated !== true');
  } else {
    if (typeof queueLength === 'number' && queueLength > 500) {
      pipelineValue -= 60;
      pipelineStatus = 'error';
      pipelineIssues.push(`queue ${queueLength} > 500`);
    } else if (typeof queueLength === 'number' && queueLength > 100) {
      pipelineValue -= 30;
      pipelineStatus = pipelineStatus === 'ok' ? 'warn' : pipelineStatus;
      pipelineIssues.push(`queue ${queueLength}`);
    }
    if (ftsP95 !== null && ftsP95 > 500) {
      pipelineValue -= 30;
      pipelineStatus = 'warn';
      pipelineIssues.push(`FTS p95 ${ftsP95}ms > 500ms`);
    }
    if (cacheMissRate !== null && cacheMissRate > 0.8) {
      pipelineValue -= 20;
      pipelineStatus = pipelineStatus === 'ok' ? 'warn' : pipelineStatus;
      pipelineIssues.push(`cache miss ${(cacheMissRate * 100).toFixed(0)}% > 80%`);
    }
  }
  const pipelineGauge = g(
    'pipeline_health',
    'Sănătate pipeline FAZA 18',
    Math.max(0, pipelineValue),
    '%',
    pipelineStatus,
    pipelineIssues.length > 0
      ? pipelineIssues.join(', ')
      : `10 straturi integrate, queue ${queueLength ?? 0}, FTS p95 ${ftsP95 ?? 0}ms`,
  );

  // ── gauge 10: synthetics ────────────────────────────────────────────────
  const synView = synthetics.view();
  const synRatio = synView.total > 0 ? (synView.passing / synView.total) * 100 : 0;
  const synStatus: GStatus = synRatio >= 95 ? 'ok' : synRatio >= 80 ? 'warn' : 'error';
  const synGauge = g(
    'synthetics',
    'Synthetics globale',
    synRatio,
    '%',
    synStatus,
    `${synView.passing}/${synView.total} checks trec (${synView.failing} fail), ultima rulare ${synView.lastRunAt ?? 'încă nu'}`,
  );

  // ── pipeline detail ─────────────────────────────────────────────────────
  const layers = s.search.pipelineStages.map((st) => ({
    id: st.order,
    name: st.name,
    stats: st.stats ?? {},
  }));
  const requests5m =
    deltaOver(store, 'animaxia_pipeline_requests_total', {}, 5 * 60 * 1000) ?? 0;
  const rejections5m =
    deltaOver(store, 'animaxia_pipeline_antisam_hits_total', {}, 5 * 60 * 1000) ?? 0;
  const cacheHitRateStat = s.search.pipelineStages.find((x) => x.name === 'cache')?.stats?.hitRate;
  const cacheHitRate = typeof cacheHitRateStat === 'number' ? cacheHitRateStat : 0;

  // ── hub detail ──────────────────────────────────────────────────────────
  const hubRouteStats = store.ownSeries('animaxia_hub_requests_total').map((r) => ({
    route: r.labels.route ?? 'unknown',
    requests: r.value,
    p95Ms: store.get('animaxia_hub_duration_ms', r.labels) ?? null,
  }));
  const feed3 = {
    sources: [
      { source: 'personal', items: s.hubFeed.personal ?? 0 },
      { source: 'global', items: s.hubFeed.global ?? 0 },
      { source: 'ai', items: s.hubFeed.ai ?? 0 },
    ],
  };
  const hubStatsRaw = (s.hub.raw ?? {}) as Record<string, unknown>;
  const hubStatsClean: Record<string, unknown> = {};
  for (const k of ['ok', 'source', 'totalItems', 'metadataCompleteness']) {
    if (k in hubStatsRaw) hubStatsClean[k] = hubStatsRaw[k];
  }
  if (hubStatsRaw.countsByType) hubStatsClean.countsByType = hubStatsRaw.countsByType;

  // ── player detail (OTLP — 0 onest până sosește prima valoare reală) ─────
  const playerMetric = (name: string): number => {
    let sum = 0;
    // serii proprii (OTLP /v1/metrics), fără placeholder-ul {source:"pending"}
    for (const srs of store.ownSeries(name)) {
      if (srs.labels.source === 'pending') continue;
      sum += srs.value;
    }
    // serii scrape-uite de la backendul FAZA 23 (23-b, label job)
    for (const srs of store.scrapedSeries(name)) sum += srs.value;
    return sum;
  };
  const fallbackBreakdown = store
    .ownSeries('animaxia_player_fallback_chain_total')
    .filter((x) => x.labels.reason !== undefined)
    .map((x) => ({ label: x.labels.reason, value: x.value }));
  // fallback-urile 23-b sunt etichetate {mode=…} — agregate onest separat
  const faza23Fallback = new Map<string, number>();
  for (const x of store.scrapedSeries('animaxia_player_fallback_chain_total')) {
    const key = x.labels.mode ?? 'unknown';
    faza23Fallback.set(key, (faza23Fallback.get(key) ?? 0) + x.value);
  }
  for (const [label, value] of faza23Fallback) {
    if (value > 0) fallbackBreakdown.push({ label: `faza23:${label}`, value });
  }

  // ── ai detail ───────────────────────────────────────────────────────────
  const aiByRoute = new Map<string, number>();
  for (const x of store.ownSeries('animaxia_ai_usage_calls_total')) {
    if (x.labels.route !== undefined && x.labels.source !== 'pending') {
      aiByRoute.set(x.labels.route, (aiByRoute.get(x.labels.route) ?? 0) + x.value);
    }
  }
  for (const x of store.scrapedSeries('animaxia_ai_usage_calls_total')) {
    if (x.labels.route === undefined) continue;
    aiByRoute.set(x.labels.route, (aiByRoute.get(x.labels.route) ?? 0) + x.value);
  }

  // ── gateway detail ──────────────────────────────────────────────────────
  const gatewayRegions: Record<string, { healthy: boolean; latencyMs: number | null }> = {};
  for (const r of s.gateway.regions) gatewayRegions[r.name] = { healthy: r.healthy, latencyMs: r.latencyMs };
  const gwCacheTotal = (s.gateway.cacheHits ?? 0) + (s.gateway.cacheMisses ?? 0);
  const gwCacheHitRate = gwCacheTotal > 0 ? (s.gateway.cacheHits ?? 0) / gwCacheTotal : 0;

  // ── alerts detail ───────────────────────────────────────────────────────
  const firing = alerts.firing().map((r) => ({ id: r.id, name: r.name, severity: r.severity, since: r.since }));
  const pending = alerts.pending().map((r) => ({ id: r.id, name: r.name, severity: r.severity, since: r.since }));

  // ── traces detail ───────────────────────────────────────────────────────
  const traceStats = collector.stats();
  const recentTraces = collector.recentTraces(8).map((t) => ({
    traceId: t.traceId,
    service: t.service,
    name: t.rootName,
    durationMs: t.durationMs,
    status: t.error ? 'error' : 'ok',
    startedAt: new Date(t.startedAt).toISOString(),
  }));

  return {
    ok: true,
    service: 'animaxia-observability',
    generatedAt: new Date().toISOString(),
    gauges: [
      uptimeGauge,
      backendGauge,
      neonGauge,
      redisGauge,
      gatewayGauge,
      aiGauge,
      searchGauge,
      hubGauge,
      pipelineGauge,
      synGauge,
    ],
    pipeline: {
      layers,
      requests5m,
      rejections5m,
      queueLength: typeof queueLength === 'number' ? queueLength : 0,
      cacheHitRate,
    },
    hub: {
      routes: hubRouteStats,
      feed3,
      stats: hubStatsClean,
    },
    player: {
      resumeEvents: playerMetric('animaxia_player_resume_events_total'),
      subtitleRequests: playerMetric('animaxia_player_subtitle_requests_total'),
      playbackErrors: playerMetric('animaxia_player_playback_errors_total'),
      fallbacks: {
        total: playerMetric('animaxia_player_fallback_chain_total'),
        breakdown: fallbackBreakdown,
      },
    },
    ai: {
      calls: ai.calls,
      errors: ai.errors,
      latencyP95: ai.p95,
      byRoute: [...aiByRoute.entries()].map(([route, calls]) => ({ route, calls })),
    },
    neon: {
      connected: s.backend.neonConnected,
      latencyMs: s.backend.latencyMs,
      docs: s.backend.totalItems,
      shardsHealthy: s.search.clusterNodesHealthy,
    },
    redis: {
      connected: s.redis.up,
      mode: s.gateway.redisMode ?? (s.redis.up ? 'resp-direct' : 'down'),
      keys: s.redis.keys,
    },
    gateway: {
      up: s.gateway.up,
      regions: gatewayRegions,
      failovers: s.gateway.failovers ?? 0,
      cacheHitRate: gwCacheHitRate,
    },
    alerts: {
      firing,
      pending,
      totalRules: 10,
    },
    synthetics: {
      total: synView.total,
      passing: synView.passing,
      failing: synView.failing,
      lastRunAt: synView.lastRunAt,
      byRegion: synView.byRegion,
      recentFailures: synthetics.recentFailures(10),
    },
    traces: {
      active: traceStats.tracesActive,
      spansPerMin: traceStats.spansPerMin,
      services: traceStats.services,
      recent: recentTraces,
    },
    metrics: {
      families: store.familyCount(),
      samples: store.sampleCount(),
      retentionDays: RETENTION_DAYS,
    },
  };
}

/* FAZA 23: reload marker after UTF-8 mid-write recovery */
