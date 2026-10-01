/**
 * Dashboards Grafana-compatible — 4 tablouri FAZA 23, format Grafana valid
 * (uid, title, description, panels[{id,title,type,targets[{expr}],gridPos}]),
 * datasource "animaxia-prometheus". Fiecare panel are și implementare LIVE:
 * seriile se citesc din metrics store (valoare curentă + ultimele 60 puncte).
 * NOTĂ ONESTĂ: expr-urile PromQL sunt reale (identice cu cele din
 * animaxia-ops/dashboards/faza23-*.json); datele live NU evaluează PromQL —
 * citesc direct seriile din store (documentat în README).
 */
import { HISTORY_POINTS_OUT } from '../config.ts';
import type { MetricsStore } from './metrics-store.ts';
import type { Scraper } from './scrape.ts';

export interface PanelTarget {
  expr: string;
  legendFormat?: string;
  refId: string;
}

export interface PanelLiveSeries {
  name: string;
  metric: string;
  labels: Record<string, string>;
}

export interface PanelDef {
  id: number;
  title: string;
  type: 'timeseries' | 'stat' | 'gauge';
  unit: string;
  targets: PanelTarget[];
  gridPos: { x: number; y: number; w: number; h: number };
  /** serii live explicite (metric+labels) */
  live: PanelLiveSeries[];
  /** enumeră dinamic seriile unei familii (label-ul dat devine numele) */
  liveEnumerate?: { metric: string; labelKey: string };
  description?: string;
}

export interface DashboardDef {
  uid: string;
  title: string;
  description: string;
  panels: PanelDef[];
}

const DS = 'animaxia-prometheus';

export class Dashboards {
  constructor(
    private store: MetricsStore,
    private scraper: Scraper,
  ) {}

  static readonly DEFS: DashboardDef[] = [
    {
      uid: 'faza23-pipeline',
      title: 'FAZA 23 · Pipeline FAZA 18',
      description:
        'Pipeline-ul de căutare FAZA 18 — cele 10 straturi: anti-spam, rate-limit, cooldown, queue, priority, windowing, dedup, batching, cache, neon-fts. Date re-expuse din /api/search/status (scrape 10s).',
      panels: [
        {
          id: 1,
          title: 'Anti-spam hits',
          type: 'timeseries',
          unit: 'short',
          targets: [{ expr: 'animaxia_pipeline_antisam_hits_total', legendFormat: 'anti-spam respinse', refId: 'A' }],
          gridPos: { x: 0, y: 0, w: 6, h: 8 },
          live: [{ name: 'anti-spam respinse', metric: 'animaxia_pipeline_antisam_hits_total', labels: {} }],
          description: 'Strat 1 — interogări respinse (tooLong/control chars/repeat).',
        },
        {
          id: 2,
          title: 'Rate-limit hits',
          type: 'timeseries',
          unit: 'short',
          targets: [{ expr: 'animaxia_pipeline_ratelimit_hits_total', legendFormat: 'rate-limit', refId: 'A' }],
          gridPos: { x: 6, y: 0, w: 6, h: 8 },
          live: [{ name: 'rate-limit limitate', metric: 'animaxia_pipeline_ratelimit_hits_total', labels: {} }],
          description: 'Strat 2 — token bucket per client.',
        },
        {
          id: 3,
          title: 'Cooldown (served + deprioritized)',
          type: 'timeseries',
          unit: 'short',
          targets: [
            { expr: 'animaxia_pipeline_cooldown_served_total', legendFormat: 'served', refId: 'A' },
            { expr: 'animaxia_pipeline_cooldown_deprioritized_total', legendFormat: 'deprioritized', refId: 'B' },
          ],
          gridPos: { x: 12, y: 0, w: 6, h: 8 },
          live: [
            { name: 'served', metric: 'animaxia_pipeline_cooldown_served_total', labels: {} },
            { name: 'deprioritized', metric: 'animaxia_pipeline_cooldown_deprioritized_total', labels: {} },
          ],
          description: 'Strat 3 — căutări repetitive servite din cooldown.',
        },
        {
          id: 4,
          title: 'Queue length + inflight',
          type: 'timeseries',
          unit: 'short',
          targets: [
            { expr: 'animaxia_pipeline_queue_length', legendFormat: 'queueDepth', refId: 'A' },
            { expr: 'animaxia_pipeline_queue_inflight', legendFormat: 'inflight', refId: 'B' },
          ],
          gridPos: { x: 18, y: 0, w: 6, h: 8 },
          live: [
            { name: 'queueDepth', metric: 'animaxia_pipeline_queue_length', labels: {} },
            { name: 'inflight', metric: 'animaxia_pipeline_queue_inflight', labels: {} },
          ],
          description: 'Strat 4 — coada (maxConcurrency 8, alertă la >500).',
        },
        {
          id: 5,
          title: 'Windowing + batching + dedup',
          type: 'timeseries',
          unit: 'short',
          targets: [
            { expr: 'animaxia_pipeline_batching_batches_total', legendFormat: 'batches', refId: 'A' },
            { expr: 'animaxia_pipeline_dedup_coalesced_total', legendFormat: 'dedup coalesced', refId: 'B' },
          ],
          gridPos: { x: 0, y: 8, w: 6, h: 8 },
          live: [
            { name: 'batches', metric: 'animaxia_pipeline_batching_batches_total', labels: {} },
            { name: 'dedup coalesced', metric: 'animaxia_pipeline_dedup_coalesced_total', labels: {} },
          ],
          description: 'Straturi 6-8 — windowing (rate/s), dedup, batching.',
        },
        {
          id: 6,
          title: 'Cache hits / misses',
          type: 'timeseries',
          unit: 'short',
          targets: [
            { expr: 'animaxia_pipeline_cache_hits_total', legendFormat: 'hits', refId: 'A' },
            { expr: 'animaxia_pipeline_cache_misses_total', legendFormat: 'misses', refId: 'B' },
          ],
          gridPos: { x: 6, y: 8, w: 6, h: 8 },
          live: [
            { name: 'hits', metric: 'animaxia_pipeline_cache_hits_total', labels: {} },
            { name: 'misses', metric: 'animaxia_pipeline_cache_misses_total', labels: {} },
          ],
          description: 'Strat 9 — cache FTS (alertă miss rate >80% pe 10m).',
        },
        {
          id: 7,
          title: 'FTS execuții + erori',
          type: 'timeseries',
          unit: 'short',
          targets: [
            { expr: 'animaxia_pipeline_requests_total', legendFormat: 'execuții', refId: 'A' },
            { expr: 'animaxia_pipeline_rejections_total', legendFormat: 'erori', refId: 'B' },
          ],
          gridPos: { x: 12, y: 8, w: 6, h: 8 },
          live: [
            { name: 'execuții', metric: 'animaxia_pipeline_requests_total', labels: {} },
            { name: 'erori', metric: 'animaxia_pipeline_rejections_total', labels: {} },
          ],
          description: 'Strat 10 — motorul FTS real (pg_trgm).',
        },
        {
          id: 8,
          title: 'FTS latency p95 (ms)',
          type: 'timeseries',
          unit: 'ms',
          targets: [{ expr: 'animaxia_fts_latency_p95_ms', legendFormat: 'p95', refId: 'A' }],
          gridPos: { x: 18, y: 8, w: 6, h: 8 },
          live: [{ name: 'p95', metric: 'animaxia_fts_latency_p95_ms', labels: {} }],
          description: 'Alertă warning la >500ms (animaxia-fts-latency-high).',
        },
      ],
    },
    {
      uid: 'faza23-huburi',
      title: 'FAZA 23 · Huburi FAZA 20',
      description:
        'Hub-urile publice FAZA 20 (/api/hub/*): browse + facets, stats, feed 3-surse, recomandări. Latency-ul per rută = FAZA 9 histogramă (_sum/_count) re-expusă; requests = animaxia_http_requests_total{route=~"/api/hub/.*"}.',
      panels: [
        {
          id: 1,
          title: 'Browse latency (ms)',
          type: 'timeseries',
          unit: 'ms',
          targets: [{ expr: 'animaxia_hub_duration_ms{route="/api/hub/browse"}', legendFormat: '{{route}}', refId: 'A' }],
          gridPos: { x: 0, y: 0, w: 6, h: 8 },
          live: [{ name: '/api/hub/browse', metric: 'animaxia_hub_duration_ms', labels: { route: '/api/hub/browse' } }],
          description: 'Durata medie /api/hub/browse (incl. facets=1 — aceeași rută).',
        },
        {
          id: 2,
          title: 'Latency per rută hub',
          type: 'timeseries',
          unit: 'ms',
          targets: [{ expr: 'animaxia_hub_duration_ms', legendFormat: '{{route}}', refId: 'A' }],
          gridPos: { x: 6, y: 0, w: 6, h: 8 },
          live: [],
          liveEnumerate: { metric: 'animaxia_hub_duration_ms', labelKey: 'route' },
          description: 'Toate rutele FAZA 20 observate (browse/scale/feed/years…).',
        },
        {
          id: 3,
          title: 'Stats publice — itemi total',
          type: 'stat',
          unit: 'short',
          targets: [{ expr: 'animaxia_hub_total_items', legendFormat: 'totalItems', refId: 'A' }],
          gridPos: { x: 12, y: 0, w: 4, h: 8 },
          live: [{ name: 'totalItems', metric: 'animaxia_hub_total_items', labels: {} }],
          description: '/api/hub/stats totalItems (Neon real).',
        },
        {
          id: 4,
          title: 'Feed 3-surse — activitate',
          type: 'timeseries',
          unit: 'short',
          targets: [{ expr: 'animaxia_feed_activity_total', legendFormat: '{{source}}', refId: 'A' }],
          gridPos: { x: 16, y: 0, w: 8, h: 8 },
          live: [],
          liveEnumerate: { metric: 'animaxia_feed_activity_total', labelKey: 'source' },
          description: 'Cereri către feed-ul 3-surse (personal + global + AI).',
        },
        {
          id: 5,
          title: 'Cereri per rută hub',
          type: 'timeseries',
          unit: 'short',
          targets: [{ expr: 'animaxia_hub_requests_total', legendFormat: '{{route}}', refId: 'A' }],
          gridPos: { x: 0, y: 8, w: 8, h: 8 },
          live: [],
          liveEnumerate: { metric: 'animaxia_hub_requests_total', labelKey: 'route' },
        },
        {
          id: 6,
          title: 'Recomandări publice — requests',
          type: 'timeseries',
          unit: 'short',
          targets: [{ expr: 'animaxia_hub_requests_total{route="/api/hub/recommendations"}', legendFormat: 'recommendations', refId: 'A' }],
          gridPos: { x: 8, y: 8, w: 8, h: 8 },
          live: [
            { name: 'recommendations', metric: 'animaxia_hub_requests_total', labels: { route: '/api/hub/recommendations' } },
          ],
          description: '/api/hub/recommendations (split onest real+simulat FAZA 20).',
        },
        {
          id: 7,
          title: 'Hub docs (FTS)',
          type: 'stat',
          unit: 'short',
          targets: [{ expr: 'animaxia_fts_docs', legendFormat: 'docs', refId: 'A' }],
          gridPos: { x: 16, y: 8, w: 8, h: 8 },
          live: [{ name: 'docs', metric: 'animaxia_fts_docs', labels: {} }],
        },
      ],
    },
    {
      uid: 'faza23-player',
      title: 'FAZA 23 · Player FAZA 17/21',
      description:
        'Player-ul: resume events (FAZA 21), subtitrări WebVTT, erori de redare, lanțul de fallback (FAZA 17). SURSĂ ONESTĂ: animaxia_player_* sosesc prin OTLP /v1/metrics (SPA/agentul 23-b) — până la prima valoare reală familiile sunt 0 (labels {source:"pending"}).',
      panels: [
        {
          id: 1,
          title: 'Resume events',
          type: 'timeseries',
          unit: 'short',
          targets: [{ expr: 'sum(animaxia_player_resume_events_total)', legendFormat: 'resume', refId: 'A' }],
          gridPos: { x: 0, y: 0, w: 6, h: 8 },
          live: [{ name: 'resume events', metric: 'animaxia_player_resume_events_total', labels: {} }],
          description: 'Continuarea redării (watchhistory FAZA 21).',
        },
        {
          id: 2,
          title: 'Subtitrări WebVTT — requests',
          type: 'timeseries',
          unit: 'short',
          targets: [{ expr: 'sum(animaxia_player_subtitle_requests_total)', legendFormat: 'subtitles', refId: 'A' }],
          gridPos: { x: 6, y: 0, w: 6, h: 8 },
          live: [{ name: 'subtitle requests', metric: 'animaxia_player_subtitle_requests_total', labels: {} }],
          description: 'GET /api/player/subtitles/content/:id/subtitles.',
        },
        {
          id: 3,
          title: 'Playback errors',
          type: 'timeseries',
          unit: 'short',
          targets: [{ expr: 'sum(animaxia_player_playback_errors_total)', legendFormat: 'errors', refId: 'A' }],
          gridPos: { x: 12, y: 0, w: 6, h: 8 },
          live: [{ name: 'playback errors', metric: 'animaxia_player_playback_errors_total', labels: {} }],
        },
        {
          id: 4,
          title: 'Fallback chain',
          type: 'timeseries',
          unit: 'short',
          targets: [
            { expr: 'sum(animaxia_player_fallback_chain_total)', legendFormat: 'total', refId: 'A' },
            { expr: 'sum by (reason) (animaxia_player_fallback_chain_total)', legendFormat: '{{reason}}', refId: 'B' },
          ],
          gridPos: { x: 18, y: 0, w: 6, h: 8 },
          live: [{ name: 'fallback total', metric: 'animaxia_player_fallback_chain_total', labels: {} }],
          liveEnumerate: { metric: 'animaxia_player_fallback_chain_total', labelKey: 'reason' },
          description: 'Lanțul FAZA 17 (direct → mirror → transcodat → offline).',
        },
      ],
    },
    {
      uid: 'faza23-global',
      title: 'FAZA 23 · Platformă globală',
      description:
        'Sănătatea platformei: uptime per serviciu, RAM proces backend (FAZA 9), Neon, Redis global, AI usage, feed & search activity, gateway regiuni.',
      panels: [
        {
          id: 1,
          title: 'Uptime per serviciu',
          type: 'timeseries',
          unit: 'percentunit',
          targets: [{ expr: 'animaxia_up', legendFormat: '{{service}}', refId: 'A' }],
          gridPos: { x: 0, y: 0, w: 8, h: 8 },
          live: [],
          liveEnumerate: { metric: 'animaxia_up', labelKey: 'service' },
          description: '1 = sus (probe health 10s).',
        },
        {
          id: 2,
          title: 'RAM proces backend (RSS)',
          type: 'timeseries',
          unit: 'bytes',
          targets: [{ expr: 'animaxia_backend_memory_rss_bytes', legendFormat: 'rss', refId: 'A' }],
          gridPos: { x: 8, y: 0, w: 8, h: 8 },
          live: [{ name: 'rss', metric: 'animaxia_backend_memory_rss_bytes', labels: {} }],
          description: 'FAZA 9 animaxia_process_memory_rss_bytes re-expus. CPU nu are familie FAZA 9 — omis onest.',
        },
        {
          id: 3,
          title: 'Neon health',
          type: 'timeseries',
          unit: 'short',
          targets: [
            { expr: 'animaxia_neon_connected', legendFormat: 'connected', refId: 'A' },
            { expr: 'animaxia_neon_latency_ms', legendFormat: 'latencyMs', refId: 'B' },
            { expr: 'animaxia_neon_docs', legendFormat: 'docs', refId: 'C' },
          ],
          gridPos: { x: 16, y: 0, w: 8, h: 8 },
          live: [
            { name: 'connected', metric: 'animaxia_neon_connected', labels: {} },
            { name: 'latencyMs', metric: 'animaxia_neon_latency_ms', labels: {} },
            { name: 'docs', metric: 'animaxia_neon_docs', labels: {} },
          ],
          description: 'Alertă critical la deconectare (animaxia-neon-down).',
        },
        {
          id: 4,
          title: 'Redis global',
          type: 'timeseries',
          unit: 'short',
          targets: [
            { expr: 'animaxia_redis_connected', legendFormat: 'connected', refId: 'A' },
            { expr: 'animaxia_redis_keys', legendFormat: 'keys', refId: 'B' },
          ],
          gridPos: { x: 0, y: 8, w: 6, h: 8 },
          live: [
            { name: 'connected', metric: 'animaxia_redis_connected', labels: {} },
            { name: 'keys', metric: 'animaxia_redis_keys', labels: {} },
          ],
          description: 'RESP PING + DBSIZE la :4030.',
        },
        {
          id: 5,
          title: 'AI usage',
          type: 'timeseries',
          unit: 'short',
          targets: [
            { expr: 'sum by (route) (animaxia_ai_usage_calls_total)', legendFormat: '{{route}}', refId: 'A' },
            { expr: 'animaxia_ai_calls_total', legendFormat: 'total FAZA 9', refId: 'B' },
          ],
          gridPos: { x: 6, y: 8, w: 6, h: 8 },
          live: [],
          liveEnumerate: { metric: 'animaxia_ai_usage_calls_total', labelKey: 'route' },
          description: 'Apeluri AI per rută (OTLP 23-b) + totalul FAZA 9 re-expus.',
        },
        {
          id: 6,
          title: 'Feed activity',
          type: 'timeseries',
          unit: 'short',
          targets: [{ expr: 'animaxia_feed_activity_total', legendFormat: '{{source}}', refId: 'A' }],
          gridPos: { x: 12, y: 8, w: 6, h: 8 },
          live: [],
          liveEnumerate: { metric: 'animaxia_feed_activity_total', labelKey: 'source' },
        },
        {
          id: 7,
          title: 'Search activity',
          type: 'timeseries',
          unit: 'short',
          targets: [{ expr: 'animaxia_search_activity_total', legendFormat: '{{route}}', refId: 'A' }],
          gridPos: { x: 18, y: 8, w: 6, h: 8 },
          live: [{ name: 'search requests', metric: 'animaxia_search_activity_total', labels: { route: 'search' } }],
        },
      ],
    },
  ];

  list() {
    return {
      dashboards: Dashboards.DEFS.map((d) => ({
        uid: d.uid,
        title: d.title,
        description: d.description,
        panelCount: d.panels.length,
      })),
    };
  }

  grafanaJson(uid: string): Record<string, unknown> | null {
    const def = Dashboards.DEFS.find((d) => d.uid === uid);
    if (!def) return null;
    return {
      uid: def.uid,
      title: def.title,
      description: def.description,
      tags: ['animaxia', 'faza23', 'observability'],
      timezone: 'browser',
      schemaVersion: 39,
      version: 1,
      editable: true,
      refresh: '30s',
      time: { from: 'now-30m', to: 'now' },
      panels: def.panels.map((p) => ({
        id: p.id,
        title: p.title,
        type: p.type,
        description: p.description ?? '',
        datasource: { type: 'prometheus', uid: DS },
        gridPos: p.gridPos,
        fieldConfig: { defaults: { unit: p.unit }, overrides: [] },
        options: { legend: { displayMode: 'list', placement: 'bottom' } },
        targets: p.targets.map((t) => ({
          datasource: { type: 'prometheus', uid: DS },
          expr: t.expr,
          legendFormat: t.legendFormat ?? '{{instance}}',
          refId: t.refId,
        })),
      })),
    };
  }

  /** Date LIVE pentru /api/dashboards/:uid/data. */
  liveData(uid: string): { uid: string; panels: unknown[] } | null {
    const def = Dashboards.DEFS.find((d) => d.uid === uid);
    if (!def) return null;
    return {
      uid,
      panels: def.panels.map((p) => {
        const series: { name: string; labels: Record<string, string>; points: [number, number][] }[] = [];
        for (const s of p.live) {
          const value = this.store.get(s.metric, s.labels);
          const points = this.store
            .historyFor(s.metric, s.labels, HISTORY_POINTS_OUT)
            .map((pt) => [pt.tsSec, pt.value] as [number, number]);
          if (value === null && points.length === 0) continue;
          series.push({ name: s.name, labels: s.labels, points });
        }
        if (p.liveEnumerate) {
          const { metric, labelKey } = p.liveEnumerate;
          for (const s of this.store.ownSeries(metric)) {
            if (s.labels[labelKey] === undefined) continue;
            const points = this.store
              .historyFor(metric, s.labels, HISTORY_POINTS_OUT)
              .map((pt) => [pt.tsSec, pt.value] as [number, number]);
            series.push({ name: s.labels[labelKey], labels: s.labels, points });
          }
        }
        return { id: p.id, title: p.title, unit: p.unit, series };
      }),
    };
  }
}
