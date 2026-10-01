/**
 * reader.ts — FAZA 24 — cititorul de metrici REALE ale platformei.
 *
 * Surse (toate READ-ONLY, zero modificări pe platforma protejată):
 *   • backend :4000/api/metrics?format=json  — RSS, HTTP, colector AI (FAZA 9)
 *   • backend :4000/api/search/status        — p95 FTS + coada pipeline (FAZA 18)
 *   • backend :4000/api/observability/metrics — contoare AI per rută (FAZA 23-b)
 *   • gateway :4040/metrics + /api/infra/status — RPS/erori/latență per regiune (FAZA 22)
 *   • /proc/<pid> al procesului backend      — CPU% real (utime+stime delta)
 *   • /proc/stat + /proc/meminfo             — context nod (2 nuclee sandbox)
 *
 * Fiecare ciclu produce câte o mostră per țintă de autoscaling și o
 * împinge în LiveTarget (re-evaluare deterministă a regulilor).
 */

import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import {
  AI_POLICIES,
  READ_INTERVAL_MS,
  READ_STALE_MS,
  REGIONS,
  SAMPLES_RETENTION,
  SOURCES,
  type RegionName,
  type TargetPolicy,
} from '../config';
import { newLiveTarget, pushSample, type LiveTarget, type Sample } from './autoscaler';

const CLK_TCK = 100; // USER_HZ standard pe Linux

interface CounterSnapshot {
  t: number;
  gatewayRequests: Record<string, number>; // region -> total
  gatewayErrors: Record<string, number>; // region -> total
  aiCalls: Record<string, number>; // engine -> total
  aiErrors: Record<string, number>; // engine -> total
  aiDurationSum: Record<string, number>; // engine -> ms total
  aiFamilyReqs: Record<string, number>; // engine -> requests total
}

export interface ReaderOverview {
  lastReadAt: number | null;
  readCycles: number;
  readErrors: number;
  backend: {
    cpuPct: number | null;
    nodeCpuPct: number | null;
    rssBytes: number | null;
    latencyP95Ms: number | null;
    ftsP50Ms: number | null;
    queueLength: number | null;
    queueInflight: number | null;
    httpTotalRequests: number | null;
    uptimeSec: number | null;
    pid: number | null;
  };
  gateway: Record<RegionName, { rps: number | null; errorRatePct: number | null; latencyMs: number | null; upstreamsHealthy: number; upstreamsTotal: number }>;
  ai: Record<string, { reqPerMin: number | null; llmLatencyMs: number | null; timeoutRatePct: number | null; callsTotal: number | null }>;
  neon: { connected: boolean | null; driver: string | null; totalItems: number | null; clusterHealthy: boolean | null };
}

async function fetchJson<T>(url: string, timeoutMs = 6000): Promise<T | null> {
  try {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), timeoutMs);
    const res = await fetch(url, { signal: ac.signal });
    clearTimeout(to);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function fetchText(url: string, timeoutMs = 6000): Promise<string | null> {
  try {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), timeoutMs);
    const res = await fetch(url, { signal: ac.signal });
    clearTimeout(to);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/** Sumă per valoare a unui label dintr-o familie Prometheus text. */
function sumByLabel(text: string, family: string, label: string): Record<string, number> {
  const out: Record<string, number> = {};
  const re = new RegExp(`^${family}\\{[^}]*${label}="([^"]+)"[^}]*\\}\\s+([0-9.eE+]+)$`, 'gm');
  for (const m of text.matchAll(re)) {
    const key = m[1];
    out[key] = (out[key] ?? 0) + Number(m[2]);
  }
  // familie fără labeluri (serie scalară)
  if (Object.keys(out).length === 0) {
    const scalar = new RegExp(`^${family}\\s+([0-9.eE+]+)$`, 'm').exec(text);
    if (scalar) out['*'] = Number(scalar[1]);
  }
  return out;
}

/* ---- CPU real al procesului backend (descoperit prin /proc, read-only) ---- */

interface CpuBaseline {
  pid: number;
  ticks: number;
  atMs: number;
}

let cpuBaseline: CpuBaseline | null = null;

function findBackendPid(): number | null {
  try {
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const cmdline = readFileSync(`/proc/${entry}/cmdline`, 'utf8');
        if (!cmdline.includes('server.js')) continue;
        // cwd-ul procesului de backend (evită dublurile orfane ale altor servicii)
        const cwd = readlinkSafe(`/proc/${entry}/cwd`);
        if (!cwd.includes('animaxia-backend')) continue;
        return Number(entry);
      } catch {
        /* proces dispărut între readdir și read — ignoră */
      }
    }
  } catch {
    /* /proc inaccesibil — CPU indisponibil onest */
  }
  return null;
}

function readlinkSafe(p: string): string {
  try {
    return readlinkSync(p);
  } catch {
    return '';
  }
}

/** CPU% al procesului backend relativ la UN nucleu (echivalent % din request-ul de CPU din K8s). */
function backendCpuPct(): { pct: number | null; pid: number | null } {
  const pid = findBackendPid();
  if (pid == null) {
    cpuBaseline = null;
    return { pct: null, pid: null };
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const after = stat.lastIndexOf(')');
    const fields = stat.slice(after + 2).split(' ');
    const utime = Number(fields[11]); // câmpul 14 (utime)
    const stime = Number(fields[12]); // câmpul 15 (stime)
    const ticks = utime + stime;
    const now = Date.now();
    if (cpuBaseline == null || cpuBaseline.pid !== pid) {
      cpuBaseline = { pid, ticks, atMs: now };
      return { pct: null, pid };
    }
    const dtSec = (now - cpuBaseline.atMs) / 1000;
    if (dtSec < 1) return { pct: null, pid };
    const pct = ((ticks - cpuBaseline.ticks) / CLK_TCK / dtSec) * 100;
    cpuBaseline = { pid, ticks, atMs: now };
    return { pct: Math.round(pct * 10) / 10, pid };
  } catch {
    cpuBaseline = null;
    return { pct: null, pid };
  }
}

/** CPU% al întregului nod (ambele nuclee) din /proc/stat. */
let statPrev: { idle: number; total: number } | null = null;
function nodeCpuPct(): number | null {
  try {
    const line = readFileSync('/proc/stat', 'utf8').split('\n')[0];
    const parts = line.split(/\s+/).slice(1).map(Number);
    const idle = parts[3] + (parts[4] ?? 0);
    const total = parts.reduce((a, b) => a + b, 0);
    if (statPrev == null) {
      statPrev = { idle, total };
      return null;
    }
    const dIdle = idle - statPrev.idle;
    const dTotal = total - statPrev.total;
    statPrev = { idle, total };
    if (dTotal <= 0) return null;
    return Math.round((1 - dIdle / dTotal) * 1000) / 10;
  } catch {
    return null;
  }
}

/* ---- Maparea rutelor AI pe cele 4 motoare ---- */

function engineForRoute(route: string): string | null {
  for (const p of AI_POLICIES) {
    for (const prefix of p.routes) {
      if (route === prefix || route.startsWith(prefix + '/')) return p.id;
    }
  }
  return null;
}

interface HealthShape {
  status?: string;
  uptimeSec?: number;
  db?: { driver?: string; connected?: boolean; totalItems?: number };
}
interface MetricsJsonShape {
  http?: { totalRequests?: number };
  process?: { memoryRssBytes?: number };
  collectors?: { ai?: { usage?: { latency?: { p95?: number }; totalCalls?: number; errors?: number } } };
}
interface SearchStatusShape {
  latency?: { p95Ms?: number; p50Ms?: number };
  backend?: string;
  cluster?: { healthy?: boolean };
  pipelineStages?: { order: number; name: string; stats?: Record<string, unknown> }[];
}
interface GatewayStatusShape {
  regions?: { name: string; upstreams?: { healthy?: boolean; latencyMs?: number | null; forcedDown?: boolean }[] }[];
}

export class MetricsReader {
  targets = new Map<string, LiveTarget>();
  overview: ReaderOverview = {
    lastReadAt: null,
    readCycles: 0,
    readErrors: 0,
    backend: {
      cpuPct: null,
      nodeCpuPct: null,
      rssBytes: null,
      latencyP95Ms: null,
      ftsP50Ms: null,
      queueLength: null,
      queueInflight: null,
      httpTotalRequests: null,
      uptimeSec: null,
      pid: null,
    },
    gateway: {
      eu: { rps: null, errorRatePct: null, latencyMs: null, upstreamsHealthy: 0, upstreamsTotal: 0 },
      us: { rps: null, errorRatePct: null, latencyMs: null, upstreamsHealthy: 0, upstreamsTotal: 0 },
      asia: { rps: null, errorRatePct: null, latencyMs: null, upstreamsHealthy: 0, upstreamsTotal: 0 },
    },
    ai: Object.fromEntries(AI_POLICIES.map((p) => [p.id, { reqPerMin: null, llmLatencyMs: null, timeoutRatePct: null, callsTotal: null }])),
    neon: { connected: null, driver: null, totalItems: null, clusterHealthy: null },
  };

  private prev: CounterSnapshot | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(policies: TargetPolicy[]) {
    for (const policy of policies) {
      this.targets.set(policy.id, newLiveTarget(policy));
    }
  }

  start(): void {
    /* NEON FREE PLAN: primul tick la 1s după boot (populează dashboard-urile),
     *  apoi background la 30 MIN. Prospețimea reală o asigură refreshIfStale()
     *  — apelat on-demand de /api/status (când cineva chiar citește datele). */
    setTimeout(() => void this.tick(), 1000);
    this.timer = setInterval(() => void this.tick(), READ_INTERVAL_MS);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** NEON FREE PLAN: refresh on-demand — dacă ultima citire e mai veche de
   *  READ_STALE_MS, declanșează un tick nou (folosit de /api/status: cineva
   *  chiar se uită la dashboard). Throttle: maxim o citire la 60s. */
  refreshIfStale(): void {
    const last = this.overview.lastReadAt ?? 0;
    if (Date.now() - last > READ_STALE_MS) {
      void this.tick();
    }
  }

  private async tick(): Promise<void> {
    const nowSec = Math.floor(Date.now() / 1000);
    const [health, metricsJson, searchStatus, obsText, gwMetricsText, gwStatus] = await Promise.all([
      fetchJson<HealthShape>(SOURCES.backendHealth),
      fetchJson<MetricsJsonShape>(SOURCES.backendMetricsJson),
      fetchJson<SearchStatusShape>(SOURCES.searchStatus),
      fetchText(SOURCES.observabilityMetrics),
      fetchText(SOURCES.gatewayMetrics),
      fetchJson<GatewayStatusShape>(SOURCES.gatewayStatus),
    ]);

    this.overview.readCycles++;
    const failed = [health, metricsJson, searchStatus, obsText, gwMetricsText, gwStatus].filter((x) => x == null).length;
    if (failed > 0) this.overview.readErrors++;

    /* ---- backend ---- */
    const { pct: cpuPct, pid } = backendCpuPct();
    const node = nodeCpuPct();
    const rss = metricsJson?.process?.memoryRssBytes ?? null;
    const ftsP95 = searchStatus?.latency?.p95Ms ?? null;
    const ftsP50 = searchStatus?.latency?.p50Ms ?? null;
    const queueStage = searchStatus?.pipelineStages?.find((s) => s.name === 'queue');
    const queueDepth = queueStage ? Number((queueStage.stats as { queueDepth?: number })?.queueDepth ?? 0) : null;
    const queueInflight = queueStage ? Number((queueStage.stats as { inflight?: number })?.inflight ?? 0) : null;

    this.overview.backend = {
      cpuPct,
      nodeCpuPct: node,
      rssBytes: rss,
      latencyP95Ms: ftsP95,
      ftsP50Ms: ftsP50,
      queueLength: queueDepth,
      queueInflight,
      httpTotalRequests: metricsJson?.http?.totalRequests ?? null,
      uptimeSec: health?.uptimeSec ?? null,
      pid,
    };
    this.overview.neon = {
      connected: health?.db?.connected ?? null,
      driver: health?.db?.driver ?? null,
      totalItems: health?.db?.totalItems ?? null,
      clusterHealthy: searchStatus?.cluster?.healthy ?? null,
    };

    const backendTarget = this.targets.get('backend');
    if (backendTarget && (cpuPct != null || ftsP95 != null || queueDepth != null)) {
      pushSample(
        backendTarget,
        { t: nowSec, cpuPct, ramBytes: rss, latencyP95Ms: ftsP95, queueLength: queueDepth },
        SAMPLES_RETENTION,
      );
    }

    /* ---- gateway per regiune ---- */
    const gwRequests = obsTextAndGw(gwMetricsText);
    const snapshot: CounterSnapshot = {
      t: nowSec,
      gatewayRequests: gwRequests.requests,
      gatewayErrors: gwRequests.errors,
      aiCalls: {},
      aiErrors: {},
      aiDurationSum: {},
      aiFamilyReqs: {},
    };

    if (obsText) {
      const calls = sumByLabel(obsText, 'animaxia_ai_usage_calls_total', 'route');
      const errors = sumByLabel(obsText, 'animaxia_ai_usage_errors_total', 'route');
      const famDur = sumByLabel(obsText, 'animaxia_family_duration_ms_sum', 'route');
      const famReq = sumByLabel(obsText, 'animaxia_family_requests_total', 'route');
      for (const [route, n] of Object.entries(calls)) {
        const engine = engineForRoute(route);
        if (!engine) continue;
        snapshot.aiCalls[engine] = (snapshot.aiCalls[engine] ?? 0) + n;
        snapshot.aiErrors[engine] = (snapshot.aiErrors[engine] ?? 0) + (errors[route] ?? 0);
        snapshot.aiDurationSum[engine] = (snapshot.aiDurationSum[engine] ?? 0) + (famDur[route] ?? 0);
        snapshot.aiFamilyReqs[engine] = (snapshot.aiFamilyReqs[engine] ?? 0) + (famReq[route] ?? 0);
      }
    }

    const prev = this.prev;
    for (const region of REGIONS) {
      const statusRegion = gwStatus?.regions?.find((r) => r.name === region);
      const ups = statusRegion?.upstreams ?? [];
      const healthyUps = ups.filter((u) => u.healthy && !u.forcedDown);
      const latencies = healthyUps.map((u) => u.latencyMs).filter((v): v is number => typeof v === 'number');
      const latencyMs = latencies.length ? Math.round(Math.min(...latencies)) : null;

      let rps: number | null = null;
      let errPct: number | null = null;
      if (prev && snapshot.gatewayRequests[region] != null && prev.gatewayRequests[region] != null) {
        const dt = snapshot.t - prev.t;
        if (dt > 0) rps = (snapshot.gatewayRequests[region]! - prev.gatewayRequests[region]!) / dt;
      }
      if (
        prev &&
        snapshot.gatewayErrors[region] != null &&
        prev.gatewayErrors[region] != null &&
        snapshot.gatewayRequests[region] != null &&
        prev.gatewayRequests[region] != null
      ) {
        const dErr = snapshot.gatewayErrors[region]! - prev.gatewayErrors[region]!;
        const dReq = snapshot.gatewayRequests[region]! - prev.gatewayRequests[region]!;
        errPct = dReq > 0 ? Math.round((dErr / dReq) * 1000) / 10 : 0;
      }

      this.overview.gateway[region] = {
        rps: rps != null ? Math.round(rps * 100) / 100 : null,
        errorRatePct: errPct,
        latencyMs,
        upstreamsHealthy: healthyUps.length,
        upstreamsTotal: ups.length,
      };

      const target = this.targets.get(`gateway-${region}`);
      if (target && (rps != null || latencyMs != null)) {
        pushSample(target, { t: nowSec, rps, latencyP95Ms: latencyMs, errorRatePct: errPct ?? 0 }, SAMPLES_RETENTION);
      }
    }

    /* ---- motoare AI ---- */
    const aiLatencyP95 = metricsJson?.collectors?.ai?.usage?.latency?.p95 ?? null;
    for (const p of AI_POLICIES) {
      let reqPerMin: number | null = null;
      let timeoutPct: number | null = null;
      let llmLatencyMs: number | null = null;
      if (prev && snapshot.aiCalls[p.id] != null && prev.aiCalls[p.id] != null) {
        const dtMin = (snapshot.t - prev.t) / 60;
        const dCalls = snapshot.aiCalls[p.id]! - prev.aiCalls[p.id]!;
        if (dtMin > 0) reqPerMin = dCalls / dtMin;
        const dErr = (snapshot.aiErrors[p.id] ?? 0) - (prev.aiErrors[p.id] ?? 0);
        timeoutPct = dCalls > 0 ? Math.round((dErr / dCalls) * 1000) / 10 : 0;
        const dDur = (snapshot.aiDurationSum[p.id] ?? 0) - (prev.aiDurationSum[p.id] ?? 0);
        const dReq = (snapshot.aiFamilyReqs[p.id] ?? 0) - (prev.aiFamilyReqs[p.id] ?? 0);
        // latență medie REALĂ per rută (p95 per-engine vine din OTel în producție)
        if (dReq > 0) llmLatencyMs = Math.round(dDur / dReq);
      }
      if (aiLatencyP95 && aiLatencyP95 > 0 && llmLatencyMs == null) llmLatencyMs = aiLatencyP95;

      this.overview.ai[p.id] = {
        reqPerMin: reqPerMin != null ? Math.round(reqPerMin * 10) / 10 : null,
        llmLatencyMs,
        timeoutRatePct: timeoutPct,
        callsTotal: snapshot.aiCalls[p.id] ?? null,
      };

      const target = this.targets.get(p.id);
      if (target && (reqPerMin != null || llmLatencyMs != null)) {
        pushSample(
          target,
          { t: nowSec, reqPerMin, llmLatencyMs, timeoutRatePct: timeoutPct ?? 0 },
          SAMPLES_RETENTION,
        );
      }
    }

    this.prev = snapshot;
    this.overview.lastReadAt = Date.now();
  }
}

/** Parsează textul /metrics al gateway-ului: cereri + erori per regiune. */
function obsTextAndGw(gwText: string | null): { requests: Record<string, number>; errors: Record<string, number> } {
  const requests: Record<string, number> = {};
  const errors: Record<string, number> = {};
  if (!gwText) return { requests, errors };
  for (const m of gwText.matchAll(/^animaxia_gateway_requests_total\{[^}]*region="([^"]+)"[^}]*\}\s+([0-9.eE+]+)$/gm)) {
    requests[m[1]] = (requests[m[1]] ?? 0) + Number(m[2]);
  }
  for (const m of gwText.matchAll(/^animaxia_gateway_upstream_errors_total\{[^}]*region="([^"]+)"[^}]*\}\s+([0-9.eE+]+)$/gm)) {
    errors[m[1]] = (errors[m[1]] ?? 0) + Number(m[2]);
  }
  // fără serii per-regiune pentru erori → onest: nicio eroare observată
  return { requests, errors };
}
