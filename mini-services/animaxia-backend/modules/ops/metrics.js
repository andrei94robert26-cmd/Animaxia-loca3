/**
 * modules/ops/metrics.js — FAZA 9 (Ops & Observability) unified metrics
 * registry for the Animaxia monolith.
 *
 * Design: pure in-memory counters / latency histograms / gauges + a pull-based
 * collector mechanism. The express middleware observes requests without
 * altering them (finish-hook); collectors read live state from existing
 * modules (db / cache / provider breakers / llm-core / vector-service) at
 * scrape time, so no hot path is touched.
 *
 * Exposed endpoints (wired in server.js):
 *   GET /api/metrics              — Prometheus text format (version=0.0.4)
 *   GET /api/metrics?format=json  — structured snapshot (dashboards, synthetics)
 *
 * Metric contract (canonical doc: animaxia-ops/metrics/METRICS.md):
 *   animaxia_http_requests_total{method,route,status}            counter
 *   animaxia_http_request_latency_ms_{bucket|sum|count}{method,route} histogram (ms)
 *   animaxia_http_server_errors_total{method,route}              counter (5xx)
 *   animaxia_quota_responses_total{route}                        counter (402 on /api/ai*)
 *   animaxia_db_connected / animaxia_db_pool_{total,idle,waiting} gauges
 *   animaxia_cache_{hits,misses}_total / animaxia_cache_hit_ratio gauges
 *   animaxia_provider_circuit_state{provider}                    gauge (0 closed/1 half/2 open)
 *   animaxia_ai_{calls,errors,degraded}_total                    gauges from llm-core ring
 *   animaxia_ai_tokens_total{direction}                          gauge
 *   animaxia_ai_latency_{p50,p95}_ms                             gauges
 *   animaxia_vector_backend_info{backend}                        gauge (=1 active backend)
 *   animaxia_uptime_seconds / animaxia_process_memory_rss_bytes  gauges
 *
 * FAZA 13 (sharding — Task 13-5, 'shards' collector namespace, additive — the
 * FAZA 9 unlabeled animaxia_db_pool_* lines above remain for existing
 * dashboards; the shard-labeled gauges are emitted ALONGSIDE them):
 *   animaxia_db_shard_pool_{total,idle,waiting}{shard,branch,mode} gauges
 *   animaxia_db_shard_connected{shard,branch} / _healthy{shard,branch} gauges
 *   animaxia_db_shard_queries_total{shard} / _errors_total{shard}  counters
 *   animaxia_search_cluster_enabled / _queries_total / _errors_total /
 *     _coalesced_total / _nodes_healthy / _nodes_total / _latency_p50_ms /
 *     _latency_p95_ms                                              gauge/counter set
 *   animaxia_search_cluster_node_{healthy,docs,latency_ms}{shard}   per-node gauges
 *   animaxia_vector_cluster_enabled / _queries_total / _errors_total /
 *     _upserts_total / _nodes_healthy / _nodes_total / _latency_p50_ms /
 *     _latency_p95_ms                                              gauge/counter set
 *   animaxia_vector_cluster_node_{healthy,docs,latency_ms}{shard}   per-node gauges
 *
 * Route labels are normalized (numeric segments → :id, max 4 segments) to keep
 * label cardinality bounded. Zero dependencies. Additive observability only.
 */

const BUCKETS_MS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
const MAX_ROUTE_SEGMENTS = 4;

/** Prometheus label-value escaping (backslash, quote, newline). */
function esc(v) {
  return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** Sorted, rendered label block: {k1="v1",k2="v2"} or '' when empty. */
function labelStr(labels = {}) {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  return `{${keys.map((k) => `${k}="${esc(labels[k])}"`).join(',')}}`;
}

/** Label block with one extra label appended (histogram buckets). */
function labelStrWith(labels, extraKey, extraValue) {
  const keys = Object.keys(labels).sort();
  const parts = keys.map((k) => `${k}="${esc(labels[k])}"`);
  parts.push(`${extraKey}="${esc(extraValue)}"`);
  return `{${parts.join(',')}}`;
}

/** Per-series histogram accumulator. */
function emptyHist() {
  return { count: 0, sum: 0, buckets: new Array(BUCKETS_MS.length + 1).fill(0) };
}

/** Numeric path segments → :id, cap segment count (label cardinality guard). */
export function normalizeRoute(url = '') {
  const path = String(url).split('?')[0].split('#')[0];
  const segs = path.split('/').filter(Boolean).slice(0, MAX_ROUTE_SEGMENTS);
  const norm = segs.map((s) => (/^\d+$/.test(s) ? ':id' : s));
  return norm.length === 0 ? '/' : `/${norm.join('/')}`;
}

class MetricsRegistry {
  constructor() {
    this.counters = new Map(); // name -> Map<labelKey, {labels, value}>
    this.gauges = new Map(); // name -> Map<labelKey, {labels, value}>
    this.hists = new Map(); // name -> Map<labelKey, {labels, ...emptyHist}>
    this.collectors = new Map(); // ns -> () => object|Promise<object>
    this.startedAt = Date.now();
  }

  /* ------------------------------------------------------------ primitives - */

  inc(name, labels = {}, value = 1) {
    if (!this.counters.has(name)) this.counters.set(name, new Map());
    const key = labelStr(labels);
    const slot = this.counters.get(name).get(key) || { labels, value: 0 };
    slot.value += value;
    this.counters.get(name).set(key, slot);
  }

  gauge(name, labels = {}, value = 0) {
    if (!this.gauges.has(name)) this.gauges.set(name, new Map());
    this.gauges.get(name).set(labelStr(labels), { labels, value });
  }

  /** Observe a latency in milliseconds into a bounded histogram. */
  observe(name, labels = {}, ms = 0) {
    if (!this.hists.has(name)) this.hists.set(name, new Map());
    const key = labelStr(labels);
    const h = this.hists.get(name).get(key) || { labels, ...emptyHist() };
    h.count += 1;
    h.sum += ms;
    let placed = false;
    for (let i = 0; i < BUCKETS_MS.length; i += 1) {
      if (ms <= BUCKETS_MS[i]) {
        h.buckets[i] += 1;
        placed = true;
        break;
      }
    }
    if (!placed) h.buckets[BUCKETS_MS.length] += 1; // +Inf bucket
    this.hists.get(name).set(key, h);
  }

  /** Register a pull collector: () => plain object (sync or async). */
  attachPull(ns, fn) {
    this.collectors.set(ns, fn);
  }

  /* ------------------------------------------------------------ middleware - */

  /**
   * Express middleware — counts every request once it finishes. Placed with
   * the other global middleware so it observes responses from every mounted
   * router, including later 404s and error responses. Observability failures
   * are swallowed: metrics must never break a response.
   */
  middleware() {
    return (req, res, next) => {
      const started = process.hrtime.bigint();
      res.on('finish', () => {
        try {
          const ms = Number(process.hrtime.bigint() - started) / 1e6;
          const route = normalizeRoute(req.originalUrl || req.url);
          const method = req.method;
          const status = String(res.statusCode);
          this.inc('animaxia_http_requests_total', { method, route, status });
          this.observe('animaxia_http_request_latency_ms', { method, route }, ms);
          if (res.statusCode >= 500) {
            this.inc('animaxia_http_server_errors_total', { method, route });
          }
          if (res.statusCode === 402 && route.startsWith('/api/ai')) {
            this.inc('animaxia_quota_responses_total', { route });
          }
        } catch {
          /* never break the response path */
        }
      });
      next();
    };
  }

  /* ------------------------------------------------------------- collectors - */

  async collect() {
    const out = {};
    for (const [ns, fn] of this.collectors) {
      try {
        out[ns] = await fn();
      } catch {
        out[ns] = { error: 'collector_failed' };
      }
    }
    return out;
  }

  /* -------------------------------------------------------------- snapshots - */

  /** Structured snapshot for ?format=json consumers (dashboards / synthetics). */
  async snapshot() {
    const routes = {};
    const reqMap = this.counters.get('animaxia_http_requests_total');
    const latMap = this.hists.get('animaxia_http_request_latency_ms');
    if (reqMap) {
      for (const { labels, value } of reqMap.values()) {
        const rk = labels.route;
        routes[rk] = routes[rk] || { requests: 0, errors5xx: 0 };
        routes[rk].requests += value;
        if (Number(labels.status) >= 500) routes[rk].errors5xx += value;
      }
    }
    if (latMap) {
      for (const { labels, count, sum } of latMap.values()) {
        const rk = labels.route;
        routes[rk] = routes[rk] || { requests: 0, errors5xx: 0 };
        routes[rk].avgMs = count > 0 ? Math.round(sum / count) : 0;
      }
    }
    const totalReqs = Object.values(routes).reduce((a, r) => a + r.requests, 0);
    const totalErrs = Object.values(routes).reduce((a, r) => a + r.errors5xx, 0);

    const counters = {};
    for (const [name, slots] of this.counters) {
      counters[name] = [...slots.values()].map(({ labels, value }) => ({ labels, value }));
    }

    return {
      service: 'animaxia-backend',
      uptimeSec: Math.floor(process.uptime()),
      generatedAt: new Date().toISOString(),
      http: {
        totalRequests: totalReqs,
        serverErrors: totalErrs,
        errorRate: totalReqs > 0 ? Number((totalErrs / totalReqs).toFixed(4)) : 0,
        routes,
      },
      counters,
      collectors: await this.collect(),
      process: { memoryRssBytes: process.memoryUsage().rss },
    };
  }

  /* -------------------------------------------------------- prometheus text - */

  /** Render the registry + standard collectors as Prometheus text format. */
  async renderPrometheus() {
    const lines = [];
    const emit = (line) => lines.push(line);

    for (const [name, slots] of this.counters) {
      emit(`# TYPE ${name} counter`);
      for (const { labels, value } of slots.values()) emit(`${name}${labelStr(labels)} ${value}`);
    }
    for (const [name, slots] of this.gauges) {
      emit(`# TYPE ${name} gauge`);
      for (const { labels, value } of slots.values()) emit(`${name}${labelStr(labels)} ${value}`);
    }
    for (const [name, slots] of this.hists) {
      emit(`# TYPE ${name} histogram`);
      for (const h of slots.values()) {
        let cum = 0;
        for (let i = 0; i < BUCKETS_MS.length; i += 1) {
          cum += h.buckets[i];
          emit(`${name}_bucket${labelStrWith(h.labels, 'le', BUCKETS_MS[i])} ${cum}`);
        }
        emit(`${name}_bucket${labelStrWith(h.labels, 'le', '+Inf')} ${h.count}`);
        emit(`${name}_sum${labelStr(h.labels)} ${Math.round(h.sum * 100) / 100}`);
        emit(`${name}_count${labelStr(h.labels)} ${h.count}`);
      }
    }

    /* standard pull collectors → gauges (namespaces fixed by the FAZA 9 contract) */
    const c = await this.collect();
    if (c.db && !c.db.error) {
      emit('# TYPE animaxia_db_connected gauge');
      emit(`animaxia_db_connected ${c.db.connected ? 1 : 0}`);
      emit('# TYPE animaxia_db_pool_total gauge');
      emit(`animaxia_db_pool_total ${c.db.pool?.total ?? 0}`);
      emit('# TYPE animaxia_db_pool_idle gauge');
      emit(`animaxia_db_pool_idle ${c.db.pool?.idle ?? 0}`);
      emit('# TYPE animaxia_db_pool_waiting gauge');
      emit(`animaxia_db_pool_waiting ${c.db.pool?.waiting ?? 0}`);
      emit('# TYPE animaxia_db_driver_info gauge');
      emit(`animaxia_db_driver_info{driver="${esc(c.db.driver)}"} 1`);
    }
    if (c.cache && !c.cache.error) {
      emit('# TYPE animaxia_cache_hits_total counter');
      emit(`animaxia_cache_hits_total ${c.cache.hits ?? 0}`);
      emit('# TYPE animaxia_cache_misses_total counter');
      emit(`animaxia_cache_misses_total ${c.cache.misses ?? 0}`);
      emit('# TYPE animaxia_cache_keys gauge');
      emit(`animaxia_cache_keys ${c.cache.keys ?? 0}`);
      emit('# TYPE animaxia_cache_hit_ratio gauge');
      emit(`animaxia_cache_hit_ratio ${c.cache.hitRate ?? 0}`);
    }
    if (Array.isArray(c.providers)) {
      emit('# TYPE animaxia_provider_circuit_state gauge');
      const stateNum = { closed: 0, 'half-open': 1, open: 2 };
      for (const p of c.providers) {
        emit(`animaxia_provider_circuit_state{provider="${esc(p.name)}"} ${stateNum[p.state] ?? 0}`);
      }
    }
    if (c.ai && !c.ai.error) {
      const u = c.ai.usage || {};
      emit('# TYPE animaxia_ai_calls_total gauge');
      emit(`animaxia_ai_calls_total ${u.totalCalls ?? 0}`);
      emit('# TYPE animaxia_ai_calls_today gauge');
      emit(`animaxia_ai_calls_today ${u.callsToday ?? 0}`);
      emit('# TYPE animaxia_ai_errors_total gauge');
      emit(`animaxia_ai_errors_total ${u.errors ?? 0}`);
      emit('# TYPE animaxia_ai_degraded_total gauge');
      emit(`animaxia_ai_degraded_total ${u.degradedCalls ?? 0}`);
      emit('# TYPE animaxia_ai_tokens_total gauge');
      emit(`animaxia_ai_tokens_total{direction="prompt"} ${u.tokens?.prompt ?? 0}`);
      emit(`animaxia_ai_tokens_total{direction="completion"} ${u.tokens?.completion ?? 0}`);
      emit('# TYPE animaxia_ai_latency_p50_ms gauge');
      emit(`animaxia_ai_latency_p50_ms ${u.latency?.p50 ?? 0}`);
      emit('# TYPE animaxia_ai_latency_p95_ms gauge');
      emit(`animaxia_ai_latency_p95_ms ${u.latency?.p95 ?? 0}`);
      if (u.byProvider && typeof u.byProvider === 'object') {
        emit('# TYPE animaxia_ai_calls_by_provider gauge');
        for (const [prov, n] of Object.entries(u.byProvider)) {
          emit(`animaxia_ai_calls_by_provider{provider="${esc(prov)}"} ${n}`);
        }
      }
    }
    if (c.vector && !c.vector.error) {
      emit('# TYPE animaxia_vector_backend_info gauge');
      emit(`animaxia_vector_backend_info{backend="${esc(c.vector.backend ?? 'unknown')}"} 1`);
      if (c.vector.counts && typeof c.vector.counts.content === 'number') {
        emit('# TYPE animaxia_vector_documents gauge');
        emit(`animaxia_vector_documents{kind="content"} ${c.vector.counts.content}`);
      }
    }

    /* FAZA 13 (sharding — Task 13-5): per-shard DB pools + search/vector
     * cluster gauges. Emitted only when the 'shards' collector answered;
     * each sub-part (pools/search/searchHealth/vector/vectorHealth) can
     * individually degrade to {error:'collector_failed'} without breaking
     * the rest of the scrape. */
    if (c.shards && !c.shards.error) {
      const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
      const pools = Array.isArray(c.shards.pools) && !c.shards.pools.error ? c.shards.pools : [];
      if (pools.length > 0) {
        emit('# TYPE animaxia_db_shard_pool_total gauge');
        emit('# TYPE animaxia_db_shard_pool_idle gauge');
        emit('# TYPE animaxia_db_shard_pool_waiting gauge');
        emit('# TYPE animaxia_db_shard_connected gauge');
        emit('# TYPE animaxia_db_shard_healthy gauge');
        for (const p of pools) {
          const lb = `shard="${esc(p.shardid)}",branch="${esc(p.branch)}"`;
          emit(`animaxia_db_shard_pool_total{${lb},mode="${esc(p.mode)}"} ${num(p.pool?.total)}`);
          emit(`animaxia_db_shard_pool_idle{${lb},mode="${esc(p.mode)}"} ${num(p.pool?.idle)}`);
          emit(`animaxia_db_shard_pool_waiting{${lb},mode="${esc(p.mode)}"} ${num(p.pool?.waiting)}`);
          emit(`animaxia_db_shard_connected{${lb}} ${p.connected === true ? 1 : 0}`);
          // main-mode registry entries do not track a separate 'healthy' flag
          // (db.js listShardPools) — they mirror the main pool connection.
          const healthy = p.healthy === undefined ? (p.connected === true ? 1 : 0) : p.healthy === true ? 1 : 0;
          emit(`animaxia_db_shard_healthy{${lb}} ${healthy}`);
        }
        emit('# TYPE animaxia_db_shard_queries_total counter');
        emit('# TYPE animaxia_db_shard_errors_total counter');
        for (const p of pools) {
          emit(`animaxia_db_shard_queries_total{shard="${esc(p.shardid)}"} ${num(p.stats?.queries)}`);
          emit(`animaxia_db_shard_errors_total{shard="${esc(p.shardid)}"} ${num(p.stats?.errors)}`);
        }
      }

      /* search cluster — ops counters/latency + per-node health (docs/latency) */
      if (c.shards.search && !c.shards.search.error) {
        const s = c.shards.search;
        emit('# TYPE animaxia_search_cluster_enabled gauge');
        emit(`animaxia_search_cluster_enabled ${s.enabled === true ? 1 : 0}`);
        emit('# TYPE animaxia_search_cluster_queries_total counter');
        emit(`animaxia_search_cluster_queries_total ${num(s.queries)}`);
        emit('# TYPE animaxia_search_cluster_errors_total counter');
        emit(`animaxia_search_cluster_errors_total ${num(s.errors)}`);
        emit('# TYPE animaxia_search_cluster_coalesced_total counter');
        emit(`animaxia_search_cluster_coalesced_total ${num(s.coalesced)}`);
        emit('# TYPE animaxia_search_cluster_nodes_healthy gauge');
        emit(`animaxia_search_cluster_nodes_healthy ${num(s.nodesHealthy)}`);
        emit('# TYPE animaxia_search_cluster_nodes_total gauge');
        emit(`animaxia_search_cluster_nodes_total ${num(s.nodesTotal)}`);
        emit('# TYPE animaxia_search_cluster_latency_p50_ms gauge');
        emit(`animaxia_search_cluster_latency_p50_ms ${num(s.latencyP50Ms)}`);
        emit('# TYPE animaxia_search_cluster_latency_p95_ms gauge');
        emit(`animaxia_search_cluster_latency_p95_ms ${num(s.latencyP95Ms)}`);
      }
      const searchNodes =
        c.shards.searchHealth && !c.shards.searchHealth.error && Array.isArray(c.shards.searchHealth.nodes)
          ? c.shards.searchHealth.nodes
          : [];
      if (searchNodes.length > 0) {
        emit('# TYPE animaxia_search_cluster_node_healthy gauge');
        emit('# TYPE animaxia_search_cluster_node_docs gauge');
        emit('# TYPE animaxia_search_cluster_node_latency_ms gauge');
        for (const n of searchNodes) {
          emit(`animaxia_search_cluster_node_healthy{shard="${esc(n.shardid)}"} ${n.healthy === true ? 1 : 0}`);
          emit(`animaxia_search_cluster_node_docs{shard="${esc(n.shardid)}"} ${num(n.docs)}`);
          emit(`animaxia_search_cluster_node_latency_ms{shard="${esc(n.shardid)}"} ${num(n.latencyMs)}`);
        }
      }

      /* vector cluster — same set (queries/errors/upserts) + per-node gauges */
      if (c.shards.vector && !c.shards.vector.error) {
        const v = c.shards.vector;
        emit('# TYPE animaxia_vector_cluster_enabled gauge');
        emit(`animaxia_vector_cluster_enabled ${v.enabled === true ? 1 : 0}`);
        emit('# TYPE animaxia_vector_cluster_queries_total counter');
        emit(`animaxia_vector_cluster_queries_total ${num(v.queries)}`);
        emit('# TYPE animaxia_vector_cluster_errors_total counter');
        emit(`animaxia_vector_cluster_errors_total ${num(v.errors)}`);
        emit('# TYPE animaxia_vector_cluster_upserts_total counter');
        emit(`animaxia_vector_cluster_upserts_total ${num(v.upserts)}`);
        emit('# TYPE animaxia_vector_cluster_nodes_healthy gauge');
        emit(`animaxia_vector_cluster_nodes_healthy ${num(v.nodesHealthy)}`);
        emit('# TYPE animaxia_vector_cluster_nodes_total gauge');
        emit(`animaxia_vector_cluster_nodes_total ${num(v.nodesTotal)}`);
        emit('# TYPE animaxia_vector_cluster_latency_p50_ms gauge');
        emit(`animaxia_vector_cluster_latency_p50_ms ${num(v.latencyP50Ms)}`);
        emit('# TYPE animaxia_vector_cluster_latency_p95_ms gauge');
        emit(`animaxia_vector_cluster_latency_p95_ms ${num(v.latencyP95Ms)}`);
      }
      const vectorNodes =
        c.shards.vectorHealth && !c.shards.vectorHealth.error && Array.isArray(c.shards.vectorHealth.nodes)
          ? c.shards.vectorHealth.nodes
          : [];
      if (vectorNodes.length > 0) {
        emit('# TYPE animaxia_vector_cluster_node_healthy gauge');
        emit('# TYPE animaxia_vector_cluster_node_docs gauge');
        emit('# TYPE animaxia_vector_cluster_node_latency_ms gauge');
        for (const n of vectorNodes) {
          emit(`animaxia_vector_cluster_node_healthy{shard="${esc(n.shardid)}"} ${n.healthy === true ? 1 : 0}`);
          emit(`animaxia_vector_cluster_node_docs{shard="${esc(n.shardid)}"} ${num(n.docs)}`);
          emit(`animaxia_vector_cluster_node_latency_ms{shard="${esc(n.shardid)}"} ${num(n.latencyMs)}`);
        }
      }
    }

    emit('# TYPE animaxia_uptime_seconds gauge');
    emit(`animaxia_uptime_seconds ${Math.floor(process.uptime())}`);
    emit('# TYPE animaxia_process_memory_rss_bytes gauge');
    emit(`animaxia_process_memory_rss_bytes ${process.memoryUsage().rss}`);

    return `${lines.join('\n')}\n`;
  }

  /** Test/ops helper — wipe the in-memory series (collectors stay attached). */
  reset() {
    this.counters.clear();
    this.gauges.clear();
    this.hists.clear();
    this.startedAt = Date.now();
  }
}

export const metrics = new MetricsRegistry();

/**
 * Wire the standard FAZA 9 pull collectors from dependencies the server already
 * imports (db / cache / provider breakers / llm-core / vector-service).
 * Called once from server.js — keeps the wiring to a single line.
 */
export function registerStandardCollectors(deps) {
  metrics.attachPull('db', () => ({ ...deps.driverInfo(), pool: deps.poolStats() }));
  metrics.attachPull('cache', () => deps.cacheStats());
  metrics.attachPull('providers', () => deps.breakerStats());
  metrics.attachPull('ai', () => ({ provider: deps.llmProviderStatus(), usage: deps.llmUsageStats() }));
  metrics.attachPull('vector', () => deps.vectorStatus().catch(() => ({ backend: 'unavailable' })));
  return metrics;
}

/**
 * Wire the FAZA 13 (sharding — Task 13-5) pull collector: the 'shards'
 * namespace feeding animaxia_db_shard_* / animaxia_search_cluster_* /
 * animaxia_vector_cluster_* series. Called once from server.js right after
 * registerStandardCollectors — additive, the FAZA 9 namespaces are untouched.
 *
 * Each sub-call is individually try/caught: a failing cluster/pool registry
 * degrades to { error: 'collector_failed' } for that part only, so a broken
 * cluster never breaks the whole scrape (renderPrometheus skips errored parts).
 */
export function registerShardingCollectors(deps) {
  metrics.attachPull('shards', async () => {
    const part = async (fn) => {
      try {
        return await fn();
      } catch {
        return { error: 'collector_failed' };
      }
    };
    return {
      pools: await part(() => Promise.resolve(deps.listShardPools())),
      search: await part(() => Promise.resolve(deps.searchClusterOpsSnapshot())),
      searchHealth: await part(() => deps.searchClusterHealth()),
      vector: await part(() => Promise.resolve(deps.vectorClusterOpsSnapshot())),
      vectorHealth: await part(() => deps.vectorClusterHealth()),
    };
  });
  return metrics;
}

export default metrics;
