/**
 * index.ts — FAZA 24 — animaxia-stability (port 4060).
 *
 * Planul de control al stabilității globale Animaxia:
 *   1. Autoscaling — backend (CPU/latență/coadă), gateway per regiune, 4 motoare AI
 *   2. Load balancing global — geo EU/US/ASIA + fallback + health-check-uri
 *   3. Failover automat + zero-downtime deploy (rolling + rollback automat)
 *   4. Traffic shaping — priorități + limite per regiune + mesaje oneste
 *
 * Platforma protejată (FAZA 18/20/21/23, Neon FTS, 30B, FAZA 13/17, AI 15/16)
 * este doar OBSERVATĂ (read-only) — niciodată modificată.
 *
 * Endpoint-uri:
 *   GET  /                          dashboard HTML (self-contained)
 *   GET  /health                    { ok, components }
 *   GET  /metrics                   Prometheus text (animaxia_stability_*)
 *   GET  /api/status                snapshot complet (autoscaling+lb+failover+deploy+shaping)
 *   GET  /api/metrics/overview      metricile reale observate pe platformă
 *   GET  /api/autoscaling           toate țintele
 *   GET  /api/autoscaling/:target   detaliu țintă
 *   POST /api/autoscaling/simulate  { target, samples[], startReplicas? } — evaluare pură
 *   GET  /api/lb/status             regiuni + health-check-uri + geo
 *   POST /api/lb/route              { country?|continent?|region? } → decizie rutare
 *   GET  /api/failover              stare + evenimente
 *   POST /api/failover/_simulate    { target, action: down|up } — regiuni prin API-ul REAL gateway
 *   GET  /api/deploy                versiuni + istoric rollout
 *   POST /api/deploy/rolling        { target, version, failAtStep? } — zero-downtime + rollback
 *   GET  /api/shaping               clase + limite + decizii recente
 *   POST /api/shaping/evaluate      { path, region, currentRps? } → allow|throttle|shed
 */

import http from 'node:http';
import {
  ALL_POLICIES,
  CORS_ALLOWLIST,
  FALLBACK_CHAINS,
  PORT,
  REGIONS,
  SERVICE_NAME,
  VERSION,
  type RegionName,
} from './config';
import { MetricsReader } from './modules/reader';
import { evaluateSeries, type Sample } from './modules/autoscaler';
import { GlobalLoadBalancer } from './modules/loadbalancer';
import { FailoverManager } from './modules/failover';
import { deployer } from './modules/deployer';
import { TrafficShaper } from './modules/shaping';
import { dashboardHtml } from './modules/dashboard';

const startedAt = Date.now();
const reader = new MetricsReader(ALL_POLICIES);
const failover = new FailoverManager();
const lb = new GlobalLoadBalancer(failover);
const shaper = new TrafficShaper();

reader.start();
lb.start();

/* ------------------------------------------------------------------ utils */

function json(res: http.ServerResponse, status: number, body: unknown, extra?: Record<string, string>): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...(extra ?? {}),
  });
  res.end(JSON.stringify(body));
}

function corsHeaders(req: http.IncomingMessage): Record<string, string> {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || !origin) return {};
  if ((CORS_ALLOWLIST as readonly string[]).includes(origin) || /^http:\/\/localhost:\d+$/.test(origin)) {
    return { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type' };
  }
  return {};
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 512 * 1024) throw new Error('payload_too_large');
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
}

function regionRpsNow(): Record<RegionName, number | null> {
  const out = {} as Record<RegionName, number | null>;
  for (const r of REGIONS) out[r] = reader.overview.gateway[r]?.rps ?? null;
  return out;
}

function autoscalingSnapshot() {
  return {
    targets: ALL_POLICIES.map((policy) => {
      const t = reader.targets.get(policy.id)!;
      const ov = reader.overview;
      let metricsLine = '';
      if (policy.kind === 'backend') {
        metricsLine = `CPU ${ov.backend.cpuPct ?? '—'}% · p95 ${ov.backend.latencyP95Ms ?? '—'}ms · coadă ${ov.backend.queueLength ?? '—'}`;
      } else if (policy.kind === 'gateway') {
        const r = policy.id.replace('gateway-', '') as RegionName;
        metricsLine = `RPS ${ov.gateway[r]?.rps ?? '—'} · latență ${ov.gateway[r]?.latencyMs ?? '—'}ms`;
      } else {
        metricsLine = `req/min ${ov.ai[policy.id]?.reqPerMin ?? '—'} · LLM ${ov.ai[policy.id]?.llmLatencyMs ?? '—'}ms`;
      }
      return {
        policy: {
          id: policy.id,
          kind: policy.kind,
          label: policy.label,
          minReplicas: policy.minReplicas,
          maxReplicas: policy.maxReplicas,
          scaleOut: policy.scaleOut,
          scaleIn: policy.scaleIn,
          scaleUpCooldownSec: policy.scaleUpCooldownSec,
          scaleDownStabilizationSec: policy.scaleDownStabilizationSec,
        },
        replicas: t.replicas,
        decisions: t.decisions,
        ruleStates: t.ruleStates,
        samplesKept: t.samples.length,
        lastSampleAt: t.lastSampleAt,
        metricsLine,
      };
    }),
  };
}

/* ------------------------------------------------------- prometheus text */

function prometheus(): string {
  const lines: string[] = [];
  const fam = (name: string, type: string, help: string) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
  };

  fam('animaxia_stability_up', 'gauge', 'Sanătatea planului de control FAZA 24 (1 = activ).');
  lines.push(`animaxia_stability_up 1`);

  fam('animaxia_stability_replicas', 'gauge', 'Replicile curente per țintă de autoscaling.');
  fam('animaxia_stability_target_min', 'gauge', 'Replicile minime per țintă.');
  fam('animaxia_stability_target_max', 'gauge', 'Replicile maxime per țintă.');
  for (const policy of ALL_POLICIES) {
    const t = reader.targets.get(policy.id)!;
    lines.push(
      `animaxia_stability_replicas{target="${policy.id}"} ${t.replicas}`,
      `animaxia_stability_target_min{target="${policy.id}"} ${policy.minReplicas}`,
      `animaxia_stability_target_max{target="${policy.id}"} ${policy.maxReplicas}`,
    );
  }

  fam('animaxia_stability_scale_decisions_total', 'counter', 'Decizii de scalare per țintă și direcție.');
  for (const policy of ALL_POLICIES) {
    const t = reader.targets.get(policy.id)!;
    const out = t.decisions.filter((d) => d.direction === 'out').length;
    const inn = t.decisions.filter((d) => d.direction === 'in').length;
    lines.push(
      `animaxia_stability_scale_decisions_total{target="${policy.id}",direction="out"} ${out}`,
      `animaxia_stability_scale_decisions_total{target="${policy.id}",direction="in"} ${inn}`,
    );
  }

  fam('animaxia_stability_lb_region_healthy', 'gauge', 'Sănătatea regiunilor de load balancing.');
  for (const r of REGIONS) {
    lines.push(`animaxia_stability_lb_region_healthy{region="${r}"} ${lb.regionHealthy(r).healthy ? 1 : 0}`);
  }
  fam('animaxia_stability_lb_reroutes_total', 'counter', 'Redirecționări către regiuni de fallback.');
  lines.push(`animaxia_stability_lb_reroutes_total ${lb.reroutesTotal}`);

  fam('animaxia_stability_health_check', 'gauge', 'Health-check-uri globale (1 = up).');
  for (const [name, st] of lb.health) {
    lines.push(`animaxia_stability_health_check{service="${name}"} ${st.up ? 1 : 0}`);
  }

  fam('animaxia_stability_failover_events_total', 'counter', 'Evenimente de failover înregistrate.');
  lines.push(`animaxia_stability_failover_events_total ${failover.events.length}`);

  fam('animaxia_stability_deploy_rollouts_total', 'counter', 'Rollout-uri de deploy per rezultat.');
  lines.push(
    `animaxia_stability_deploy_rollouts_total{result="success"} ${deployer.status().rolloutsTotal.success}`,
    `animaxia_stability_deploy_rollouts_total{result="rolled-back"} ${deployer.status().rolloutsTotal['rolled-back']}`,
  );

  fam('animaxia_stability_shaping_evaluations_total', 'counter', 'Decizii de traffic shaping per acțiune.');
  lines.push(
    `animaxia_stability_shaping_evaluations_total{action="allow"} ${shaper.counters.allow}`,
    `animaxia_stability_shaping_evaluations_total{action="throttle"} ${shaper.counters.throttle}`,
    `animaxia_stability_shaping_evaluations_total{action="shed"} ${shaper.counters.shed}`,
  );

  fam('animaxia_stability_uptime_seconds', 'gauge', 'Uptime-ul planului de control.');
  lines.push(`animaxia_stability_uptime_seconds ${Math.round((Date.now() - startedAt) / 1000)}`);

  return lines.join('\n') + '\n';
}

/* ---------------------------------------------------------------- server */

const server = http.createServer((req, res) => {
  void handle(req, res).catch((e) => {
    if (!res.headersSent) json(res, 500, { ok: false, error: (e as Error).message });
    else res.destroy();
  });
});

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const cors = corsHeaders(req);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { ...cors, allow: 'GET,POST,OPTIONS' });
    res.end();
    return;
  }

  /* ---- dashboard + health + metrics ---- */
  if (path === '/' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...cors });
    res.end(dashboardHtml());
    return;
  }

  if (path === '/health') {
    return json(res, 200, {
      ok: true,
      service: SERVICE_NAME,
      version: VERSION,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      components: {
        reader: reader.overview.readCycles > 0,
        autoscaler: true,
        loadbalancer: lb.health.size > 0,
        failover: true,
        deployer: true,
        shaping: true,
      },
      readCycles: reader.overview.readCycles,
      targets: ALL_POLICIES.length,
    }, cors);
  }

  if (path === '/metrics' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', ...cors });
    res.end(prometheus());
    return;
  }

  /* ---- snapshot complet ---- */
  if (path === '/api/status') {
    /* NEON FREE PLAN: refresh on-demand — cineva chiar citește datele; dacă
     *  sunt >60s vechi, declanșăm citiri proaspete (throttle intern). */
    reader.refreshIfStale();
    lb.checkAllIfStale();
    return json(res, 200, {
      ok: true,
      service: SERVICE_NAME,
      version: VERSION,
      generatedAt: new Date().toISOString(),
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      autoscaling: autoscalingSnapshot(),
      metrics: reader.overview,
      lb: lb.status(),
      failover: failover.state(),
      deploy: deployer.status(),
      shaping: shaper.status(regionRpsNow()),
    }, cors);
  }

  if (path === '/api/metrics/overview') {
    return json(res, 200, { ok: true, overview: reader.overview }, cors);
  }

  /* ---- autoscaling ---- */
  if (path === '/api/autoscaling') {
    return json(res, 200, { ok: true, ...autoscalingSnapshot() }, cors);
  }

  if (path === '/api/autoscaling/simulate' && req.method === 'POST') {
    const body = await readBody(req);
    const targetId = String(body.target ?? '');
    const policy = ALL_POLICIES.find((p) => p.id === targetId);
    if (!policy) {
      return json(res, 400, { ok: false, error: 'țintă necunoscută', targets: ALL_POLICIES.map((p) => p.id) }, cors);
    }
    const raw = Array.isArray(body.samples) ? body.samples : [];
    const samples: Sample[] = [];
    for (const s of raw) {
      if (typeof s !== 'object' || s == null) continue;
      const o = s as Record<string, unknown>;
      const numOrNull = (v: unknown): number | null =>
        typeof v === 'number' && Number.isFinite(v) ? v : null;
      samples.push({
        t: numOrNull(o.t) ?? 0,
        cpuPct: numOrNull(o.cpuPct),
        ramBytes: numOrNull(o.ramBytes),
        latencyP95Ms: numOrNull(o.latencyP95Ms),
        queueLength: numOrNull(o.queueLength),
        rps: numOrNull(o.rps),
        errorRatePct: numOrNull(o.errorRatePct),
        reqPerMin: numOrNull(o.reqPerMin),
        llmLatencyMs: numOrNull(o.llmLatencyMs),
        timeoutRatePct: numOrNull(o.timeoutRatePct),
      });
    }
    const startReplicas = typeof body.startReplicas === 'number' ? body.startReplicas : undefined;
    const result = evaluateSeries(policy, samples, startReplicas);
    return json(res, 200, { ok: true, target: targetId, samples: samples.length, ...result }, cors);
  }

  const targetMatch = path.match(/^\/api\/autoscaling\/([a-z0-9-]+)$/);
  if (targetMatch && req.method === 'GET') {
    const policy = ALL_POLICIES.find((p) => p.id === targetMatch[1]);
    if (!policy) return json(res, 404, { ok: false, error: 'țintă necunoscută' }, cors);
    const all = autoscalingSnapshot().targets;
    return json(res, 200, { ok: true, target: all.find((t) => t.policy.id === policy.id) }, cors);
  }

  /* ---- load balancing ---- */
  if (path === '/api/lb/status') {
    return json(res, 200, { ok: true, ...lb.status(), fallbackChains: FALLBACK_CHAINS }, cors);
  }

  if (path === '/api/lb/route' && req.method === 'POST') {
    const body = await readBody(req);
    const decision = lb.route({
      country: typeof body.country === 'string' ? body.country : undefined,
      continent: typeof body.continent === 'string' ? body.continent : undefined,
      region: typeof body.region === 'string' ? body.region : undefined,
    });
    return json(res, decision.ok ? 200 : 409, { ...decision }, cors);
  }

  /* ---- failover ---- */
  if (path === '/api/failover') {
    return json(res, 200, { ok: true, ...failover.state() }, cors);
  }

  if (path === '/api/failover/_simulate' && req.method === 'POST') {
    const body = await readBody(req);
    const target = String(body.target ?? '');
    const action = body.action === 'down' ? 'down' : 'up';
    const regionMatch = target.match(/^region-(eu|us|asia)$/);
    if (regionMatch) {
      const result = await failover.setRegion(regionMatch[1] as RegionName, action === 'down');
      return json(res, result.ok ? 200 : 502, { ok: result.ok, target, action, detail: result.detail }, cors);
    }
    const result = failover.simulate(target as never, action === 'down');
    if (!result.ok) return json(res, 400, { ok: false, error: result.detail }, cors);
    return json(res, 200, { ok: true, target, action, detail: result.detail }, cors);
  }

  /* ---- deploy ---- */
  if (path === '/api/deploy') {
    return json(res, 200, { ok: true, ...deployer.status() }, cors);
  }

  if (path === '/api/deploy/rolling' && req.method === 'POST') {
    const body = await readBody(req);
    const target = String(body.target ?? '');
    const version = String(body.version ?? '');
    const failAtStep = typeof body.failAtStep === 'number' ? body.failAtStep : undefined;
    const policy = ALL_POLICIES.find((p) => p.id === target);
    if (!policy) {
      return json(res, 400, { ok: false, error: 'țintă necunoscută', available: ALL_POLICIES.map((p) => p.id) }, cors);
    }
    const replicas = typeof body.replicas === 'number' ? body.replicas : reader.targets.get(target)?.replicas ?? policy.minReplicas;
    const result = await deployer.start(target, version, replicas, failAtStep);
    if (!result.ok) return json(res, 409, { ok: false, error: result.error }, cors);
    return json(res, 202, { ok: true, rolloutId: result.rolloutId, target, version, replicas, note: 'zero-downtime: surge + health gate real înainte de trafic, rollback automat la eșec' }, cors);
  }

  /* ---- traffic shaping ---- */
  if (path === '/api/shaping') {
    return json(res, 200, { ok: true, ...shaper.status(regionRpsNow()) }, cors);
  }

  if (path === '/api/shaping/evaluate' && req.method === 'POST') {
    const body = await readBody(req);
    const pathToCheck = String(body.path ?? '/');
    const region = String(body.region ?? 'eu') as RegionName;
    if (!(REGIONS as readonly string[]).includes(region)) {
      return json(res, 400, { ok: false, error: 'regiune invalidă (eu|us|asia)' }, cors);
    }
    const currentRps =
      typeof body.currentRps === 'number' && Number.isFinite(body.currentRps)
        ? body.currentRps
        : regionRpsNow()[region] ?? 0;
    const evaluation = shaper.evaluate(pathToCheck, region, currentRps);
    return json(res, 200, { ok: true, httpStatus: evaluation.action === 'allow' ? 200 : evaluation.action === 'throttle' ? 200 : 429, ...evaluation }, cors);
  }

  /* ---- info ---- */
  if (path === '/api/info') {
    return json(res, 200, {
      ok: true,
      service: SERVICE_NAME,
      version: VERSION,
      faza: '24 — Stabilitate Globală',
      endpoints: [
        'GET /', 'GET /health', 'GET /metrics', 'GET /api/status', 'GET /api/metrics/overview',
        'GET /api/autoscaling', 'GET /api/autoscaling/:target', 'POST /api/autoscaling/simulate',
        'GET /api/lb/status', 'POST /api/lb/route', 'GET /api/failover', 'POST /api/failover/_simulate',
        'GET /api/deploy', 'POST /api/deploy/rolling', 'GET /api/shaping', 'POST /api/shaping/evaluate',
      ],
      protected: 'FAZA 18/20/21/23 + Neon FTS + 30B + FAZA 13/17 + AI 15/16 — doar observate, zero modificări',
    }, cors);
  }

  json(res, 404, { ok: false, error: 'not_found', hint: 'GET /api/info pentru harta endpoint-urilor' }, cors);
}

server.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] ${SERVICE_NAME} v${VERSION} (FAZA 24) ascultă pe :${PORT} — autoscaling + LB global + failover + zero-downtime + shaping`);
});
