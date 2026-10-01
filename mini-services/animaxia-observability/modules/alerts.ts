/**
 * Alertmanager local — EXACT 10 reguli, evaluare la 15s.
 * Stări: inactive → pending (condiție adevărată, pornește `for`) → firing
 * (condiția a ținut cât `for`) → resolved (condiția falsă ≥ 60s).
 * Log notificări in-memory (ultimele 200): {ts, alert, from→to, severity}.
 * Fiecare regulă: description RO + referință runbook.
 */
import { ALERT_EVAL_MS, ALERT_LOG_MAX, ALERT_RESOLVE_AFTER_MS } from '../config.ts';
import type { MetricsStore } from './metrics-store.ts';
import type { Scraper } from './scrape.ts';

export type AlertSeverity = 'critical' | 'warning';
export type AlertState = 'inactive' | 'pending' | 'firing' | 'resolved';

/** Snapshot dat evaluării unei reguli — construit din scrape-state + store,
 *  SAU din body-ul sintetic al POST /api/alerts/_simulate/:id. */
export interface AlertSnapshot {
  neonConnected?: number | boolean | null;
  redisUp?: boolean | null;
  gatewayRedisMode?: string | null;
  gatewayUp?: boolean | null;
  backendUp?: boolean | null;
  aiLatencyP95Ms?: number | null;
  ftsP95Ms?: number | null;
  queueLength?: number | null;
  cacheMissRate?: number | null; // 0..1 pe fereastră 10m
  rateLimitPerMin?: number | null;
  cooldownPerMin?: number | null; // served + deprioritized
}

export interface AlertRule {
  id: string;
  name: string;
  severity: AlertSeverity;
  forSec: number;
  description: string;
  runbook: string;
  /** Prometheus expr real (folosit și în animaxia-ops/alerts/faza23-alerts.yaml). */
  expr: string;
  condition: (s: AlertSnapshot) => boolean;
  observed: (s: AlertSnapshot) => Record<string, unknown>;
}

interface RuleRuntime {
  state: AlertState;
  /** ms când condiția a devenit adevărată (pending start) */
  trueSince: number | null;
  /** ms când a intrat în firing */
  firingSince: number | null;
  /** ms când condiția a devenit falsă (resolved countdown) */
  falseSince: number | null;
  lastEvaluatedAt: number | null;
  lastObserved: Record<string, unknown>;
}

export interface AlertLogEntry {
  ts: string;
  alert: string;
  from: AlertState;
  to: AlertState;
  severity: AlertSeverity;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export const ALERT_RULES: AlertRule[] = [
  {
    id: 'animaxia-neon-down',
    name: 'Neon deconectat',
    severity: 'critical',
    forSec: 60,
    description:
      'Baza Neon nu mai răspunde: animaxia_neon_connected==0 sau /api/health raportează db.connected fals. Platforma nu poate servi conținut real.',
    runbook: 'animaxia-ops/runbooks/neon-recovery.md',
    expr: 'animaxia_neon_connected == 0',
    condition: (s) => {
      const v = typeof s.neonConnected === 'boolean' ? (s.neonConnected ? 1 : 0) : num(s.neonConnected);
      return v === 0;
    },
    observed: (s) => ({ neonConnected: s.neonConnected ?? null }),
  },
  {
    id: 'animaxia-redis-down',
    name: 'Redis global :4030 nu răspunde',
    severity: 'critical',
    forSec: 60,
    description:
      'PING pe redis-global a eșuat SAU gateway-ul a degradat la modul in-memory (redisMode !== "redis") — straturile de perimetru distribuite (FAZA 22) nu mai sunt partajate.',
    runbook: 'animaxia-ops/runbooks/redis-global-recovery.md',
    expr: 'animaxia_redis_connected == 0 or animaxia_gateway_redis_mode{mode!="redis"} == 1',
    condition: (s) =>
      s.redisUp === false || (s.gatewayRedisMode !== null && s.gatewayRedisMode !== undefined && s.gatewayRedisMode !== 'redis'),
    observed: (s) => ({ redisUp: s.redisUp ?? null, gatewayRedisMode: s.gatewayRedisMode ?? null }),
  },
  {
    id: 'animaxia-gateway-down',
    name: 'Global gateway :4040 down',
    severity: 'critical',
    forSec: 60,
    description:
      'Global gateway nu răspunde ok la /api/infra/health — rutarea multi-regiune eu/us/asia și cache-ul de perimetru sunt indisponibile.',
    runbook: 'animaxia-ops/runbooks/gateway-recovery.md',
    expr: 'animaxia_gateway_up == 0',
    condition: (s) => s.gatewayUp === false,
    observed: (s) => ({ gatewayUp: s.gatewayUp ?? null }),
  },
  {
    id: 'animaxia-backend-down',
    name: 'Backend :4000 down',
    severity: 'critical',
    forSec: 60,
    description:
      'Backend-ul Express nu răspunde la /api/health — întreaga platformă API (hub, search, player, AI) este afectată.',
    runbook: 'animaxia-ops/runbooks/backend-recovery.md',
    expr: 'animaxia_up{service="animaxia-backend"} == 0',
    condition: (s) => s.backendUp === false,
    observed: (s) => ({ backendUp: s.backendUp ?? null }),
  },
  {
    id: 'animaxia-ai-timeout',
    name: 'AI latency p95 > 20s',
    severity: 'warning',
    forSec: 120,
    description:
      'Latency p95 al apelurilor AI (animaxia_ai_latency_p95_ms FAZA 9) a depășit 20.000ms — rutele AI (FAZA 15/16) sunt aproape de timeout.',
    runbook: 'animaxia-ops/runbooks/ai-latency.md',
    expr: 'animaxia_ai_latency_p95_ms > 20000',
    condition: (s) => {
      const v = num(s.aiLatencyP95Ms);
      return v !== null && v > 20000;
    },
    observed: (s) => ({ aiLatencyP95Ms: s.aiLatencyP95Ms ?? null }),
  },
  {
    id: 'animaxia-fts-latency-high',
    name: 'FTS p95 > 500ms',
    severity: 'warning',
    forSec: 300,
    description:
      'Latency p95 al motorului FTS (pipeline strat 10 neon-fts / /api/search/status latency.p95Ms) a depășit 500ms — experiența de căutare FAZA 18 se degradează.',
    runbook: 'animaxia-ops/runbooks/fts-latency.md',
    expr: 'animaxia_fts_latency_p95_ms > 500',
    condition: (s) => {
      const v = num(s.ftsP95Ms);
      return v !== null && v > 500;
    },
    observed: (s) => ({ ftsP95Ms: s.ftsP95Ms ?? null }),
  },
  {
    id: 'animaxia-queue-high',
    name: 'Pipeline queue > 500',
    severity: 'critical',
    forSec: 120,
    description:
      'Adâncimea cozii pipeline FAZA 18 (strat 4) a depășit 500 — căutările se acumulează mai repede decât pot fi executate (maxConcurrency saturat).',
    runbook: 'animaxia-ops/runbooks/pipeline-queue.md',
    expr: 'animaxia_pipeline_queue_length > 500',
    condition: (s) => {
      const v = num(s.queueLength);
      return v !== null && v > 500;
    },
    observed: (s) => ({ queueLength: s.queueLength ?? null }),
  },
  {
    id: 'animaxia-cache-miss-high',
    name: 'Cache miss rate > 80%',
    severity: 'warning',
    forSec: 600,
    description:
      'Rata de miss a cache-ului pipeline (strat 9) pe fereastra de 10 minute a depășit 80% — traffic-ul ocolește cache-ul (invalidări masive sau chei nenimerite).',
    runbook: 'animaxia-ops/runbooks/cache-miss.md',
    expr: 'rate(animaxia_pipeline_cache_misses_total[10m]) / (rate(animaxia_pipeline_cache_misses_total[10m]) + rate(animaxia_pipeline_cache_hits_total[10m])) > 0.8',
    condition: (s) => {
      const v = num(s.cacheMissRate);
      return v !== null && v > 0.8;
    },
    observed: (s) => ({ cacheMissRate: s.cacheMissRate ?? null }),
  },
  {
    id: 'animaxia-ratelimit-abuse',
    name: 'Rate-limit rejections > 50/min',
    severity: 'warning',
    forSec: 300,
    description:
      'Rata respingerilor rate-limit (pipeline strat 2, per minut) a depășit 50 — posibil abuz sau bot flood asupra căutării.',
    runbook: 'animaxia-ops/runbooks/ratelimit-abuse.md',
    expr: 'rate(animaxia_pipeline_ratelimit_hits_total[5m]) * 60 > 50',
    condition: (s) => {
      const v = num(s.rateLimitPerMin);
      return v !== null && v > 50;
    },
    observed: (s) => ({ rateLimitPerMin: s.rateLimitPerMin ?? null }),
  },
  {
    id: 'animaxia-cooldown-abuse',
    name: 'Cooldown served+deprioritized > 60/min',
    severity: 'warning',
    forSec: 300,
    description:
      'Rata cererilor servite din cooldown + deprioritized (pipeline strat 3, per minut) a depășit 60 — utilizatori/boți care re-interoghează agresiv aceleași chei.',
    runbook: 'animaxia-ops/runbooks/cooldown-abuse.md',
    expr: '(rate(animaxia_pipeline_cooldown_served_total[5m]) + rate(animaxia_pipeline_cooldown_deprioritized_total[5m])) * 60 > 60',
    condition: (s) => {
      const v = num(s.cooldownPerMin);
      return v !== null && v > 60;
    },
    observed: (s) => ({ cooldownPerMin: s.cooldownPerMin ?? null }),
  },
];

export class AlertManager {
  private runtime = new Map<string, RuleRuntime>();
  private log: AlertLogEntry[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private store: MetricsStore,
    private scraper: Scraper,
  ) {
    for (const rule of ALERT_RULES) {
      this.runtime.set(rule.id, {
        state: 'inactive',
        trueSince: null,
        firingSince: null,
        falseSince: null,
        lastEvaluatedAt: null,
        lastObserved: {},
      });
    }
  }

  start(): void {
    // prima evaluare după 12s (după primul scrape tick)
    setTimeout(() => void this.evaluateAll(), 12_000);
    this.timer = setInterval(() => void this.evaluateAll(), ALERT_EVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** snapshot REAL din scrape-state + metrics store. */
  buildSnapshot(): AlertSnapshot {
    const s = this.scraper.state;
    const rlHistory = s.rateLimitHistory.map((h) => ({ tsMs: h.tsMs, value: h.limited }));
    const cdHistory = s.cooldownHistory.map((h) => ({
      tsMs: h.tsMs,
      value: h.served + h.deprioritized,
    }));
    const aiP95 =
      this.store.scrapedValue('animaxia_ai_latency_p95_ms', {}) ??
      this.store.scrapedValue('animaxia_ai_latency_p95_ms', { job: 'animaxia-backend' });
    return {
      neonConnected: s.backend.neonConnected ? 1 : 0,
      redisUp: s.redis.up,
      gatewayRedisMode: s.gateway.redisMode,
      gatewayUp: s.gateway.up,
      backendUp: s.backend.up,
      aiLatencyP95Ms: aiP95,
      ftsP95Ms: s.search.ftsP95Ms ?? s.search.latencyP95Ms,
      queueLength: this.stageValue('queue', 'queueDepth'),
      cacheMissRate: this.scraper.cacheMissRateOverWindow(10 * 60 * 1000),
      rateLimitPerMin: this.scraper.rateOverWindow(rlHistory, 5 * 60 * 1000),
      cooldownPerMin: this.scraper.rateOverWindow(cdHistory, 5 * 60 * 1000),
    };
  }

  private stageValue(stage: string, key: string): number | null {
    const st = this.scraper.state.search.pipelineStages.find((x) => x.name === stage);
    if (!st) return null;
    const v = st.stats?.[key];
    return typeof v === 'number' ? v : null;
  }

  /** evaluează O regulă pe un snapshot și întoarce starea rezultată (pur). */
  static evaluateOne(rule: AlertRule, rt: RuleRuntime, snap: AlertSnapshot, now: number): {
    state: AlertState;
    runtime: RuleRuntime;
    transition: { from: AlertState; to: AlertState } | null;
  } {
    const next: RuleRuntime = { ...rt, lastEvaluatedAt: now, lastObserved: rule.observed(snap) };
    const cond = rule.condition(snap);
    let transition: { from: AlertState; to: AlertState } | null = null;

    if (cond) {
      next.falseSince = null;
      if (rt.trueSince === null) next.trueSince = now;
      if (next.state === 'inactive' || next.state === 'resolved') {
        next.state = 'pending';
        transition = { from: rt.state, to: 'pending' };
      } else if (next.state === 'pending' && now - (next.trueSince ?? now) >= rule.forSec * 1000) {
        next.state = 'firing';
        next.firingSince = now;
        transition = { from: 'pending', to: 'firing' };
      }
    } else {
      next.trueSince = null;
      if (next.state === 'firing' || next.state === 'pending') {
        if (rt.falseSince === null) next.falseSince = now;
        if (next.falseSince !== null && now - next.falseSince >= ALERT_RESOLVE_AFTER_MS) {
          transition = { from: next.state, to: 'resolved' };
          next.state = 'resolved';
          next.firingSince = null;
        }
        // altfel rămâne în aceeași stare (firing/pending) până la 60s false
      } else if (next.state === 'resolved') {
        // condiția falsă de mai mult — după un ciclu complet revenim la inactive
        if (rt.falseSince !== null && now - rt.falseSince >= ALERT_RESOLVE_AFTER_MS * 2) {
          next.state = 'inactive';
          transition = { from: 'resolved', to: 'inactive' };
        }
      }
    }
    return { state: next.state, runtime: next, transition };
  }

  async evaluateAll(): Promise<void> {
    const snap = this.buildSnapshot();
    const now = Date.now();
    for (const rule of ALERT_RULES) {
      const rt = this.runtime.get(rule.id);
      if (!rt) continue;
      const { runtime, transition } = AlertManager.evaluateOne(rule, rt, snap, now);
      this.runtime.set(rule.id, runtime);
      if (transition && transition.from !== transition.to) {
        this.pushLog({ ts: new Date(now).toISOString(), alert: rule.id, from: transition.from, to: transition.to, severity: rule.severity });
      }
    }
    this.exposeMetrics();
  }

  private pushLog(entry: AlertLogEntry): void {
    this.log.push(entry);
    if (this.log.length > ALERT_LOG_MAX) this.log.splice(0, this.log.length - ALERT_LOG_MAX);
  }

  private exposeMetrics(): void {
    for (const rule of ALERT_RULES) {
      const rt = this.runtime.get(rule.id);
      if (!rt) continue;
      this.store.set(
        'animaxia_alerts_firing',
        { alert: rule.id },
        rt.state === 'firing' ? 1 : 0,
        'gauge',
        '1 dacă alerta e în starea firing (FAZA 23 alertmanager local)',
      );
      this.store.set(
        'animaxia_alerts_pending',
        { alert: rule.id },
        rt.state === 'pending' ? 1 : 0,
        'gauge',
        '1 dacă alerta e în starea pending (cronometrul `for` rulează)',
      );
    }
  }

  // ── API ─────────────────────────────────────────────────────────────────

  rulesView() {
    const now = Date.now();
    return ALERT_RULES.map((rule) => {
      const rt = this.runtime.get(rule.id)!;
      return {
        id: rule.id,
        name: rule.name,
        severity: rule.severity,
        state: rt.state,
        condition: rule.expr,
        forSec: rule.forSec,
        since: rt.trueSince ? new Date(rt.trueSince).toISOString() : null,
        firingSince: rt.firingSince ? new Date(rt.firingSince).toISOString() : null,
        lastEvaluatedAt: rt.lastEvaluatedAt ? new Date(rt.lastEvaluatedAt).toISOString() : null,
        observed: rt.lastObserved,
        description: rule.description,
        runbook: rule.runbook,
      };
    });
  }

  firing() {
    return this.rulesView().filter((r) => r.state === 'firing');
  }

  pending() {
    return this.rulesView().filter((r) => r.state === 'pending');
  }

  logView(): AlertLogEntry[] {
    return [...this.log].reverse(); // cel mai recent primul
  }

  /** GET /alertmanager/api/v2/alerts — compatibil Alertmanager. */
  alertmanagerV2() {
    const active = this.rulesView().filter((r) => r.state === 'firing' || r.state === 'pending');
    return active.map((r) => ({
      labels: {
        alertname: r.id,
        severity: r.severity,
        service: 'animaxia-observability',
      },
      annotations: {
        summary: r.name,
        description: r.description,
        runbook_url: `https://ops.animaxia.local/${r.runbook.replace(/^animaxia-ops\//, '')}`,
      },
      startsAt: r.since ?? r.lastEvaluatedAt ?? new Date().toISOString(),
      endsAt: null,
      generatorURL: `http://localhost:4050/api/alerts`,
      status: { state: r.state === 'firing' ? 'active' : 'pending', inhibitedBy: [], silencedBy: [] },
    }));
  }

  /** POST /api/alerts/_simulate/:id — DOAR QA: evaluează regula cu snapshot-ul
   *  sintetic din body FĂRĂ a altera starea reală. */
  simulate(ruleId: string, body: unknown): {
    ok: boolean;
    rule?: string;
    snapshot?: AlertSnapshot;
    simulatedState?: AlertState;
    wouldFire?: boolean;
    currentRealState?: AlertState;
    note?: string;
    error?: string;
  } {
    const rule = ALERT_RULES.find((r) => r.id === ruleId);
    if (!rule) return { ok: false, error: `unknown alert id: ${ruleId}` };
    const snap = (body && typeof body === 'object' ? body : {}) as AlertSnapshot;
    const rt = this.runtime.get(rule.id)!;
    const now = Date.now();
    // simulăm DOUĂ cicluri: (1) condiția devine adevărată → pending,
    // (2) `for` scurs → firing (dacă regula ține). Pornim din inactive.
    const t0 = now - rule.forSec * 1000 - 2000; // condiția e adevărată de peste `for`
    let simulated: RuleRuntime = {
      state: 'inactive',
      trueSince: null,
      firingSince: null,
      falseSince: null,
      lastEvaluatedAt: null,
      lastObserved: {},
    };
    simulated = AlertManager.evaluateOne(rule, simulated, snap, t0).runtime;
    const second = AlertManager.evaluateOne(rule, simulated, snap, now);
    simulated = second.runtime;
    return {
      ok: true,
      rule: rule.id,
      snapshot: snap,
      simulatedState: simulated.state,
      wouldFire: simulated.state === 'firing',
      currentRealState: rt.state,
      note: 'Simulare QA pură (2 cicluri: pending → for scurs → firing); starea reală a alertei NU este modificată (vezi README).',
    };
  }
}
