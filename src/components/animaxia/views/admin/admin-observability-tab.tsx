'use client';

/**
 * admin-observability-tab.tsx — TS2b: live observability dashboard.
 * Three PUBLIC data sources combined (same endpoints the ops stack uses):
 *   • GET /api/metrics?format=json  — HTTP counters, cache, AI usage, DB pool
 *   • GET /api/platform/stability   — event-loop lag, RSS, in-flight, shed
 *   • GET /api/search/status        — the 10 FAZA-18 pipeline stages, live
 * Auto-refresh every 15 s (paused while the tab is hidden) + manual refresh
 * + an honest „ultima achiziție” timestamp. Deep-linked via #/admin/observability.
 *
 * FAZA 23 (23-c) — ADDITIVE section „FAZA 23 · Observabilitate enterprise”
 * (rendered BELOW the TS2b content on purpose: the classic live-backend view
 * stays first, the global-stack deep-dive follows). Single source of truth:
 * GET /api/summary?XTransformPort=4050 on animaxia-observability (OTel
 * collector · Prometheus · Alertmanager · 46 synthetics) — one 15 s poll,
 * its own loading skeleton / ErrorState / manual refresh, same visual
 * language (Card/CardHeader/CardContent, lucide, cn(), Skeleton, ErrorState).
 */

import { useState } from 'react';
import {
  Activity,
  BrainCircuit,
  Captions,
  Database,
  Gauge as GaugeIcon,
  GitBranch,
  Globe,
  HeartPulse,
  Layers,
  MonitorPlay,
  Network,
  Radar,
  RefreshCw,
  Search,
  ServerCog,
  ShieldCheck,
  Siren,
  Zap,
} from 'lucide-react';
import { api } from '@/lib/animaxia/api';
import { useApi } from '@/lib/animaxia/hooks';
import type { ObservabilityGauge } from '@/lib/animaxia/types';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '../../states';
import { cn } from '@/lib/utils';

/* ------------------------------- helpers ------------------------------- */


function formatUptime(sec: number | null | undefined): string {
  const s = Math.max(0, Math.floor(Number(sec ?? 0)));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function formatBytes(b: number | null | undefined): string {
  const v = Number(b ?? 0);
  if (!Number.isFinite(v) || v <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = v;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n >= 100 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

function fmtNum(v: unknown): string {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n.toLocaleString('ro-RO') : '0';
}

function fmtMs(v: unknown): string {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n > 0 ? `${n < 10 ? n.toFixed(1) : Math.round(n)}ms` : '0ms';
}

function fmtPct(v: unknown): string {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n)) return '0%';
  return `${n <= 1 && n > 0 ? Math.round(n * 100) : Math.round(n)}%`;
}

function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** One big gauge card: value + label + optional ratio bar. */
function GaugeCard({
  icon,
  title,
  value,
  sub,
  bar,
  tone = 'zinc',
}: {
  icon: React.ReactNode;
  title: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  bar?: { pct: number; className?: string };
  tone?: 'zinc' | 'rose' | 'emerald' | 'amber' | 'red';
}) {
  const toneText = {
    zinc: 'text-zinc-100',
    rose: 'text-rose-300',
    emerald: 'text-emerald-300',
    amber: 'text-amber-300',
    red: 'text-red-300',
  }[tone];
  return (
    <Card className="border-white/10 bg-white/[0.03]">
      <CardContent className="space-y-2 p-4">
        <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-zinc-500">
          {icon}
          {title}
        </p>
        <p className={cn('text-2xl font-black leading-tight', toneText)}>{value}</p>
        {sub ? <p className="text-xs leading-snug text-zinc-500">{sub}</p> : null}
        {bar ? (
          <div
            role="progressbar"
            aria-label={title}
            aria-valuenow={Math.round(bar.pct)}
            aria-valuemin={0}
            aria-valuemax={100}
            className="h-1.5 w-full overflow-hidden rounded-full bg-white/10"
          >
            <div
              className={cn('h-full rounded-full bg-rose-500 transition-all', bar.className)}
              style={{ width: `${Math.min(100, Math.max(0, bar.pct))}%` }}
            />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/* --------------------------- pipeline stage cards --------------------------- */

const STAGE_LABELS: Record<string, string> = {
  'anti-spam': 'Anti-spam',
  'rate-limit': 'Rate limit',
  cooldown: 'Cooldown cache',
  queue: 'Coadă de concurență',
  priority: 'Priorități',
  windowing: 'Windowing',
  dedup: 'Dedup / coalescing',
  batching: 'Batching',
  cache: 'Cache rezultate',
  'neon-fts': 'Motor Neon FTS',
};

const STAT_LABELS: Record<string, string> = {
  rejected: 'respinse',
  limited: 'limitate',
  trackedQueries: 'interogări urmărite',
  trackedClients: 'clienți urmăriți',
  servedFromCooldown: 'servite din cooldown',
  deprioritized: 'deprioritate',
  trackedKeys: 'chei urmărite',
  enqueued: 'puse în coadă',
  dispatched: 'dispatch',
  queueDepth: 'adâncime coadă',
  inflight: 'în zbor',
  maxInflight: 'max în zbor',
  deferred: 'amânate',
  executionsPerSec: 'exec/s',
  coalesced: 'coalescente',
  batches: 'batch-uri',
  batchedQueries: 'interog. batch',
  hits: 'hit',
  misses: 'miss',
  hitRate: 'rată hit',
  keys: 'chei',
  invalidations: 'invalidări',
  executions: 'execuții',
  errors: 'erori',
  p50Ms: 'p50',
  p95Ms: 'p95',
  samples: 'mostre',
  executionsByPriority: 'exec. pe prioritate',
};

function stageStatEntries(stats: Record<string, unknown> | undefined): { key: string; value: number }[] {
  if (!stats) return [];
  return Object.entries(stats)
    .filter(([, v]) => typeof v === 'number' && Number.isFinite(v as number))
    .map(([key, value]) => ({ key, value: value as number }))
    .slice(0, 6);
}

function StageCard({
  order,
  name,
  stats,
}: {
  order: number;
  name: string;
  stats?: Record<string, unknown>;
}) {
  const entries = stageStatEntries(stats);
  const hitRate = typeof stats?.hitRate === 'number' ? stats.hitRate : null;
  return (
    <Card className="border-white/10 bg-white/[0.03]">
      <CardContent className="space-y-2 p-3.5">
        <p className="flex items-center gap-2 text-xs font-bold text-zinc-200">
          <span className="grid h-5 w-5 shrink-0 place-items-center rounded-md bg-rose-500/15 text-[10px] font-black text-rose-300">
            {order}
          </span>
          {STAGE_LABELS[name] ?? name}
        </p>
        {entries.length === 0 ? (
          <p className="text-[11px] text-zinc-600">fără statistici numerice încă</p>
        ) : (
          <ul className="space-y-1">
            {entries.map(({ key, value }) => (
              <li key={key} className="flex items-baseline justify-between gap-2 text-[11px]">
                <span className="text-zinc-500">{STAT_LABELS[key] ?? key}</span>
                <span
                  className={cn(
                    'font-mono font-semibold',
                    /reject|error|limited|depriorit|deferred/i.test(key) && value > 0 ? 'text-amber-300' : 'text-zinc-200',
                    key === 'hitRate' && 'text-emerald-300',
                  )}
                >
                  {key === 'hitRate' ? fmtPct(value) : /Ms$/.test(key) ? fmtMs(value) : fmtNum(value)}
                </span>
              </li>
            ))}
          </ul>
        )}
        {hitRate != null && (
          <div
            role="progressbar"
            aria-label={`Rată hit ${STAGE_LABELS[name] ?? name}`}
            aria-valuenow={Math.round(hitRate * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
            className="h-1.5 w-full overflow-hidden rounded-full bg-white/10"
          >
            <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${Math.round(hitRate * 100)}%` }} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ------------------ FAZA 23 · observabilitate enterprise ------------------ */

/** Canonical FAZA-23 alert rule ids — fixed 10-rule platform contract (see
 *  mini-services/animaxia-observability/modules/alerts.ts). /api/summary only
 *  lists pending/firing entries, so inactive rules are derived against this
 *  canonical list (nothing invented — state comes from the live payload). */
const ALERT_RULE_IDS = [
  'animaxia-neon-down',
  'animaxia-redis-down',
  'animaxia-gateway-down',
  'animaxia-backend-down',
  'animaxia-ai-timeout',
  'animaxia-fts-latency-high',
  'animaxia-queue-high',
  'animaxia-cache-miss-high',
  'animaxia-ratelimit-abuse',
  'animaxia-cooldown-abuse',
] as const;

/** Icon per gauge id (10 gauges, fixed order in the summary contract). */
const F23_GAUGE_ICONS: Record<string, React.ReactNode> = {
  uptime: <HeartPulse className="h-3.5 w-3.5" aria-hidden />,
  backend: <ServerCog className="h-3.5 w-3.5" aria-hidden />,
  neon: <Database className="h-3.5 w-3.5" aria-hidden />,
  redis: <Zap className="h-3.5 w-3.5" aria-hidden />,
  gateway: <Globe className="h-3.5 w-3.5" aria-hidden />,
  ai_usage: <BrainCircuit className="h-3.5 w-3.5" aria-hidden />,
  search_activity: <Search className="h-3.5 w-3.5" aria-hidden />,
  hub_activity: <Network className="h-3.5 w-3.5" aria-hidden />,
  pipeline_health: <Layers className="h-3.5 w-3.5" aria-hidden />,
  synthetics: <ShieldCheck className="h-3.5 w-3.5" aria-hidden />,
};

const F23_TONE_TEXT: Record<ObservabilityGauge['status'], string> = {
  ok: 'text-emerald-300',
  warn: 'text-amber-300',
  error: 'text-red-300',
};

const F23_TONE_BAR: Record<ObservabilityGauge['status'], string> = {
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  error: 'bg-red-500',
};

/** Gauge values arrive rounded to 1 decimal — render integers cleanly. */
function fmtGaugeValue(v: number | null | undefined): string {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n)) return '—';
  return Number.isInteger(n) ? n.toLocaleString('ro-RO') : n.toFixed(1);
}

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleTimeString('ro-RO');
  } catch {
    return '—';
  }
}

/** One of the 10 live gauges from /api/summary (big value + status color). */
function F23GaugeCard({ gauge }: { gauge: ObservabilityGauge }) {
  const tone = F23_TONE_TEXT[gauge.status] ?? 'text-zinc-100';
  const bar = F23_TONE_BAR[gauge.status] ?? 'bg-zinc-500';
  return (
    <Card className="border-white/10 bg-white/[0.03]">
      <CardContent className="space-y-2 p-4">
        <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-zinc-500">
          {F23_GAUGE_ICONS[gauge.id] ?? <Activity className="h-3.5 w-3.5" aria-hidden />}
          {gauge.label}
        </p>
        <p className={cn('text-2xl font-black leading-tight', tone)}>
          {fmtGaugeValue(gauge.value)}
          {gauge.unit ? <span className="ml-1 text-sm font-bold text-zinc-500">{gauge.unit}</span> : null}
        </p>
        <p className="text-xs leading-snug text-zinc-500">{gauge.detail || '—'}</p>
        {gauge.unit === '%' ? (
          <div
            role="progressbar"
            aria-label={gauge.label}
            aria-valuenow={Math.round(gauge.value)}
            aria-valuemin={0}
            aria-valuemax={100}
            className="h-1.5 w-full overflow-hidden rounded-full bg-white/10"
          >
            <div
              className={cn('h-full rounded-full transition-all', bar)}
              style={{ width: `${Math.min(100, Math.max(0, gauge.value))}%` }}
            />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** Boolean state pill (conectat/deconectat) — matches the „integrat” badge. */
function F23BoolBadge({ ok, okText, downText }: { ok: boolean; okText: string; downText: string }) {
  return ok ? (
    <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-300">
      {okText}
    </span>
  ) : (
    <span className="rounded-full border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-red-300">
      {downText}
    </span>
  );
}

/** Key → value row used by the infra blocks (Neon/Redis/Gateway/Uptime). */
function F23KvRow({ k, v, tone }: { k: string; v: React.ReactNode; tone?: string }) {
  return (
    <li className="flex items-baseline justify-between gap-2 text-[11px]">
      <span className="shrink-0 text-zinc-500">{k}</span>
      <span className={cn('min-w-0 break-words text-right font-mono font-semibold text-zinc-200', tone)}>{v}</span>
    </li>
  );
}

/** Alert rule chip: id + state badge (+ severity/since for active rules). */
type F23AlertState = 'firing' | 'pending' | 'inactive';

function F23AlertRule({
  id,
  state,
  name,
  severity,
  since,
}: {
  id: string;
  state: F23AlertState;
  name: string | null;
  severity: string | null;
  since: string | null;
}) {
  const badge =
    state === 'firing'
      ? 'border-red-500/30 bg-red-500/10 text-red-300'
      : state === 'pending'
        ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
        : 'border-white/10 bg-white/5 text-zinc-500';
  const label = state === 'firing' ? 'firing' : state === 'pending' ? 'pending' : 'inactivă';
  return (
    <div className="space-y-1.5 rounded-xl border border-white/10 bg-white/[0.03] p-3">
      <p className="break-all font-mono text-[11px] font-semibold leading-snug text-zinc-300">{id}</p>
      {name ? <p className="text-[11px] leading-snug text-zinc-500">{name}</p> : null}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={cn('rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider', badge)}>
          {label}
        </span>
        {severity ? (
          <span
            className={cn(
              'rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider',
              severity === 'critical'
                ? 'border-red-500/30 bg-red-500/10 text-red-300'
                : 'border-amber-500/30 bg-amber-500/10 text-amber-300',
            )}
          >
            {severity}
          </span>
        ) : null}
        {since ? <span className="font-mono text-[10px] text-zinc-600">de la {fmtTime(since)}</span> : null}
      </div>
    </div>
  );
}

/**
 * FAZA 23 section — the whole enterprise observability stack (:4050) from a
 * SINGLE /api/summary poll: 10 gauges, FAZA-18 pipeline, FAZA-20 hubs,
 * FAZA-17/21 player, AI usage, Neon/Redis/Gateway/Uptime, 10 alert rules,
 * 46 synthetics and the live OTel trace collector.
 */
function Faza23ObservabilitySection() {
  const summary = useApi('admin-obs-faza23', () => api.observabilitySummary());
  const lastFetch = summary.data?.generatedAt ?? null;

  /* NEON FREE PLAN: auto-refresh 15s ELIMINAT — montare + Refresh manual
   * (colectarea metricilor pe backend e oricum la 30 min). */

  if (summary.loading && !summary.data) {
    return (
      <section aria-busy="true" aria-label="FAZA 23 — observabilitate enterprise" className="space-y-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          {Array.from({ length: 10 }).map((_, i) => (
            <Skeleton key={i} className="h-32 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-56 rounded-xl" />
        <Skeleton className="h-48 rounded-xl" />
      </section>
    );
  }

  if (summary.error && !summary.data) {
    return (
      <ErrorState
        message={`Serviciul de observabilitate :4050 nu răspunde — ${summary.error}`}
        onRetry={() => void summary.refetch()}
        compact
      />
    );
  }

  const d = summary.data;
  if (!d) return null;

  /* Alerts: pending/firing come live; inactive = canonical list − active. */
  const firingIds = new Set(d.alerts.firing.map((a) => a.id));
  const pendingIds = new Set(d.alerts.pending.map((a) => a.id));
  const activeById = new Map([...d.alerts.firing, ...d.alerts.pending].map((a) => [a.id, a]));
  const rules: { id: string; state: F23AlertState; name: string | null; severity: string | null; since: string | null }[] =
    ALERT_RULE_IDS.map((id) => {
      const state: F23AlertState = firingIds.has(id) ? 'firing' : pendingIds.has(id) ? 'pending' : 'inactive';
      const entry = activeById.get(id);
      return { id, state, name: entry?.name ?? null, severity: entry?.severity ?? null, since: entry?.since ?? null };
    });
  const inactiveCount = rules.filter((r) => r.state === 'inactive').length;

  const synRatio = d.synthetics.total > 0 ? (d.synthetics.passing / d.synthetics.total) * 100 : 0;
  const synTone = synRatio >= 95 ? 'emerald' : synRatio >= 80 ? 'amber' : 'red';
  const synToneText =
    synTone === 'emerald' ? 'text-emerald-300' : synTone === 'amber' ? 'text-amber-300' : 'text-red-300';
  const synToneBar =
    synTone === 'emerald' ? 'bg-emerald-500' : synTone === 'amber' ? 'bg-amber-500' : 'bg-red-500';

  const gatewayRegions = Object.entries(d.gateway.regions ?? {});
  const aiByRoute = [...d.ai.byRoute].sort((a, b) => b.calls - a.calls);
  const aiMaxRouteCalls = Math.max(1, ...aiByRoute.map((r) => r.calls));

  return (
    <section aria-labelledby="faza23-obs-heading" className="space-y-5 pt-2">
      {/* Section toolbar */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h3 id="faza23-obs-heading" className="flex items-center gap-2 text-base font-black text-zinc-100">
            <Radar className="h-4 w-4 text-rose-400" aria-hidden />
            FAZA 23 · Observabilitate enterprise
          </h3>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-zinc-500">
            <span>stack :4050 (OTel collector · Prometheus · Alertmanager · synthetics 46) prin gateway —</span>
            <code className="font-mono text-[11px] text-zinc-600">/api/summary?XTransformPort=4050</code>
            <span>· actualizare manuală.</span>
            {lastFetch ? (
              <span className="font-mono text-zinc-600">ultima achiziție: {fmtTime(lastFetch)}</span>
            ) : null}
            <span className="font-mono text-zinc-600">
              store: {fmtNum(d.metrics.families)} familii · {fmtNum(d.metrics.samples)} mostre · retenție{' '}
              {fmtNum(d.metrics.retentionDays)} zile
            </span>
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="border-white/15 bg-white/5 font-semibold hover:bg-white/10"
          onClick={() => void summary.refetch()}
        >
          <RefreshCw aria-hidden /> Reîmprospătează stack-ul
        </Button>
      </div>

      {/* 1 — the 10 live gauges */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {d.gauges.map((gauge) => (
          <F23GaugeCard key={gauge.id} gauge={gauge} />
        ))}
      </div>

      {/* 2 — FAZA-18 pipeline: window stats + the 10 layers */}
      <Card className="border-white/10 bg-white/[0.03]">
        <CardHeader className="pb-3">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            <Layers className="h-4 w-4 text-rose-400" aria-hidden />
            Pipeline FAZA 18 — fereastră live &amp; cele 10 straturi
          </CardTitle>
          <p className="text-xs text-zinc-500">
            re-expuse de scraperul :4050 din /api/search/status — cereri și respingeri pe 5 minute, coadă și cache.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <GaugeCard
              icon={<Activity className="h-3.5 w-3.5" aria-hidden />}
              title="Cereri pipeline (5m)"
              value={fmtNum(d.pipeline.requests5m)}
              sub="animaxia_pipeline_requests_total — delta 5 minute"
              tone="zinc"
            />
            <GaugeCard
              icon={<Siren className="h-3.5 w-3.5" aria-hidden />}
              title="Respingeri anti-spam (5m)"
              value={fmtNum(d.pipeline.rejections5m)}
              sub="stratul 1 (anti-spam) — delta 5 minute"
              tone={d.pipeline.rejections5m > 0 ? 'amber' : 'zinc'}
            />
            <GaugeCard
              icon={<GaugeIcon className="h-3.5 w-3.5" aria-hidden />}
              title="Adâncime coadă"
              value={fmtNum(d.pipeline.queueLength)}
              sub={`alertă animaxia-queue-high la > 500 (stratul 4)`}
              tone={d.pipeline.queueLength > 500 ? 'red' : d.pipeline.queueLength > 100 ? 'amber' : 'zinc'}
            />
            <GaugeCard
              icon={<Zap className="h-3.5 w-3.5" aria-hidden />}
              title="Cache hit-rate pipeline"
              value={fmtPct(d.pipeline.cacheHitRate)}
              sub="stratul 9 — alertă la miss > 80%"
              tone="emerald"
              bar={{ pct: num(d.pipeline.cacheHitRate) * 100 }}
            />
          </div>
          {d.pipeline.layers.length === 0 ? (
            <p className="text-sm text-zinc-500">
              Pipeline-ul nu raportează straturi către :4050 (backend FAZA 18+ necesar sau scraper fără date).
            </p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
              {d.pipeline.layers.map((layer) => (
                <StageCard key={`${layer.id}-${layer.name}`} order={layer.id} name={layer.name} stats={layer.stats} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 3 — FAZA-20 hubs: routes + three-source feed */}
      <Card className="border-white/10 bg-white/[0.03]">
        <CardHeader className="pb-3">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            <Network className="h-4 w-4 text-rose-400" aria-hidden />
            Huburi FAZA 20 — rute &amp; feed 3 surse
          </CardTitle>
          <p className="text-xs text-zinc-500">
            contorul animaxia_hub_requests_total pe rută + ultimele dimensiuni ale feed-ului (personal / global / AI).
          </p>
        </CardHeader>
        <CardContent className="grid gap-5 lg:grid-cols-[1.5fr_1fr]">
          <div>
            {d.hub.routes.length === 0 ? (
              <p className="text-sm text-zinc-500">— fără rute hub raportate încă.</p>
            ) : (
              <div className="max-h-64 overflow-y-auto pr-1">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-widest text-zinc-600">
                      <th scope="col" className="pb-2 pr-3 font-bold">
                        Rută
                      </th>
                      <th scope="col" className="pb-2 pr-3 text-right font-bold">
                        Cereri
                      </th>
                      <th scope="col" className="pb-2 text-right font-bold">
                        p95
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {d.hub.routes.map((r) => (
                      <tr key={r.route}>
                        <td className="py-1.5 pr-3 font-mono text-[11px] text-zinc-300">/{r.route}</td>
                        <td className="py-1.5 pr-3 text-right font-mono font-semibold text-zinc-200">
                          {fmtNum(r.requests)}
                        </td>
                        <td className="py-1.5 text-right font-mono text-zinc-400">
                          {r.p95Ms == null ? '—' : fmtMs(r.p95Ms)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <div className="space-y-2">
            <p className="text-[11px] font-bold uppercase tracking-widest text-zinc-500">Feed 3 surse (itemi)</p>
            {d.hub.feed3.sources.length === 0 ? (
              <p className="text-sm text-zinc-500">—</p>
            ) : (
              <ul className="space-y-1">
                {d.hub.feed3.sources.map((s) => (
                  <F23KvRow key={s.source} k={s.source} v={fmtNum(s.items)} />
                ))}
              </ul>
            )}
          </div>
        </CardContent>
      </Card>

      {/* 4 — FAZA-17/21 player: events + fallback chains */}
      <Card className="border-white/10 bg-white/[0.03]">
        <CardHeader className="pb-3">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            <MonitorPlay className="h-4 w-4 text-rose-400" aria-hidden />
            Player FAZA 17/21 — evenimente &amp; lanțuri de fallback
          </CardTitle>
          <p className="text-xs text-zinc-500">
            animaxia_player_* (OTLP + scrape FAZA 23) — 0 onest până sosește prima valoare reală.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <GaugeCard
              icon={<MonitorPlay className="h-3.5 w-3.5" aria-hidden />}
              title="Evenimente resume"
              value={fmtNum(d.player.resumeEvents)}
              sub="POST /api/users/me/history (FAZA 21)"
              tone="zinc"
            />
            <GaugeCard
              icon={<Captions className="h-3.5 w-3.5" aria-hidden />}
              title="Cereri subtitrări"
              value={fmtNum(d.player.subtitleRequests)}
              sub="piste WebVTT servite (FAZA 21)"
              tone="zinc"
            />
            <GaugeCard
              icon={<Siren className="h-3.5 w-3.5" aria-hidden />}
              title="Erori de redare"
              value={fmtNum(d.player.playbackErrors)}
              sub="playback errors raportate playerului"
              tone={d.player.playbackErrors > 0 ? 'amber' : 'zinc'}
            />
            <GaugeCard
              icon={<GitBranch className="h-3.5 w-3.5" aria-hidden />}
              title="Fallback-uri lanț"
              value={fmtNum(d.player.fallbacks.total)}
              sub="animaxia_player_fallback_chain_total"
              tone={d.player.fallbacks.total > 0 ? 'amber' : 'zinc'}
            />
          </div>
          <div className="space-y-2">
            <p className="text-[11px] font-bold uppercase tracking-widest text-zinc-500">Breakdown pe motiv / mod</p>
            {d.player.fallbacks.breakdown.length === 0 ? (
              <p className="text-sm text-zinc-500">— fără fallback-uri înregistrate.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {d.player.fallbacks.breakdown.map((b) => (
                  <span
                    key={b.label}
                    className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 font-mono text-[11px] text-zinc-300"
                  >
                    {b.label}: <span className="font-bold text-amber-300">{fmtNum(b.value)}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* 5 — AI usage */}
      <Card className="border-white/10 bg-white/[0.03]">
        <CardHeader className="pb-3">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            <BrainCircuit className="h-4 w-4 text-rose-400" aria-hidden />
            AI usage — apeluri, erori, latență
          </CardTitle>
          <p className="text-xs text-zinc-500">
            agregat onest FAZA 9 (animaxia_ai_calls_total) + FAZA 23 (animaxia_ai_usage_* pe rută).
          </p>
        </CardHeader>
        <CardContent className="grid gap-5 lg:grid-cols-[1fr_1.5fr]">
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-1">
            <GaugeCard
              icon={<BrainCircuit className="h-3.5 w-3.5" aria-hidden />}
              title="Apeluri AI"
              value={fmtNum(d.ai.calls)}
              sub="total istoric (toate rutele)"
              tone="zinc"
            />
            <GaugeCard
              icon={<Siren className="h-3.5 w-3.5" aria-hidden />}
              title="Erori AI"
              value={fmtNum(d.ai.errors)}
              sub="animaxia_ai_errors_total"
              tone={d.ai.errors > 0 ? 'amber' : 'zinc'}
            />
            <GaugeCard
              icon={<GaugeIcon className="h-3.5 w-3.5" aria-hidden />}
              title="Latență p95"
              value={d.ai.latencyP95 == null ? '—' : fmtMs(d.ai.latencyP95)}
              sub={d.ai.latencyP95 == null ? 'fără latency înregistrat încă' : 'alertă animaxia-ai-timeout la > 20s'}
              tone={d.ai.latencyP95 != null && d.ai.latencyP95 > 10000 ? 'amber' : 'zinc'}
            />
          </div>
          <div className="space-y-2">
            <p className="text-[11px] font-bold uppercase tracking-widest text-zinc-500">Top rute AI (calls)</p>
            {aiByRoute.length === 0 ? (
              <p className="text-sm text-zinc-500">— fără apeluri pe rute încă.</p>
            ) : (
              <ul className="max-h-64 space-y-2 overflow-y-auto pr-1">
                {aiByRoute.slice(0, 8).map((r) => (
                  <li key={r.route} className="space-y-1">
                    <div className="flex items-baseline justify-between gap-2 text-[11px]">
                      <span className="min-w-0 truncate font-mono text-zinc-400">{r.route}</span>
                      <span className="font-mono font-semibold text-zinc-200">{fmtNum(r.calls)}</span>
                    </div>
                    <div className="h-1 w-full overflow-hidden rounded-full bg-white/10">
                      <div
                        className="h-full rounded-full bg-rose-500"
                        style={{ width: `${Math.min(100, (r.calls / aiMaxRouteCalls) * 100)}%` }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </CardContent>
      </Card>

      {/* 6 — global infra: Neon · Redis · Gateway · Uptime */}
      <Card className="border-white/10 bg-white/[0.03]">
        <CardHeader className="pb-3">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            <Globe className="h-4 w-4 text-rose-400" aria-hidden />
            Infrastructură globală — Neon · Redis · Gateway · Uptime
          </CardTitle>
          <p className="text-xs text-zinc-500">
            probe reale 30s (health PING, RESP, /api/infra/health) — valori lipsă afișate onest cu „—”.
          </p>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <Card className="border-white/10 bg-white/[0.03]">
              <CardContent className="space-y-2 p-4">
                <p className="flex items-center justify-between gap-2 text-[11px] font-bold uppercase tracking-widest text-zinc-500">
                  <span className="flex items-center gap-1.5">
                    <Database className="h-3.5 w-3.5" aria-hidden /> Neon Postgres
                  </span>
                  <F23BoolBadge ok={d.neon.connected} okText="conectat" downText="deconectat" />
                </p>
                <ul className="space-y-1">
                  <F23KvRow k="latență health" v={d.neon.latencyMs == null ? '—' : fmtMs(d.neon.latencyMs)} />
                  <F23KvRow k="itemi indexați" v={fmtNum(d.neon.docs)} />
                  <F23KvRow
                    k="shards sănătoase"
                    v={`${d.neon.shardsHealthy ?? '?'}/4`}
                    tone={d.neon.shardsHealthy != null && d.neon.shardsHealthy < 4 ? 'text-amber-300' : undefined}
                  />
                </ul>
              </CardContent>
            </Card>
            <Card className="border-white/10 bg-white/[0.03]">
              <CardContent className="space-y-2 p-4">
                <p className="flex items-center justify-between gap-2 text-[11px] font-bold uppercase tracking-widest text-zinc-500">
                  <span className="flex items-center gap-1.5">
                    <Zap className="h-3.5 w-3.5" aria-hidden /> Redis global :4030
                  </span>
                  <F23BoolBadge ok={d.redis.connected} okText="up" downText="down" />
                </p>
                <ul className="space-y-1">
                  <F23KvRow
                    k="mod gateway"
                    v={d.redis.mode || '—'}
                    tone={d.redis.mode && d.redis.mode !== 'redis' && d.redis.mode !== 'resp-direct' ? 'text-amber-300' : undefined}
                  />
                  <F23KvRow k="chei (DBSIZE)" v={d.redis.keys == null ? '—' : fmtNum(d.redis.keys)} />
                </ul>
              </CardContent>
            </Card>
            <Card className="border-white/10 bg-white/[0.03]">
              <CardContent className="space-y-2 p-4">
                <p className="flex items-center justify-between gap-2 text-[11px] font-bold uppercase tracking-widest text-zinc-500">
                  <span className="flex items-center gap-1.5">
                    <Globe className="h-3.5 w-3.5" aria-hidden /> Global gateway :4040
                  </span>
                  <F23BoolBadge ok={d.gateway.up} okText="up" downText="down" />
                </p>
                <ul className="space-y-1">
                  {gatewayRegions.length === 0 ? (
                    <F23KvRow k="regiuni" v="—" />
                  ) : (
                    gatewayRegions.map(([region, info]) => (
                      <F23KvRow
                        key={region}
                        k={`${region} ${info.healthy ? '✓' : '✗'}`}
                        v={info.latencyMs == null ? '—' : fmtMs(info.latencyMs)}
                        tone={info.healthy ? 'text-emerald-300' : 'text-red-300'}
                      />
                    ))
                  )}
                  <F23KvRow
                    k="failover-uri"
                    v={fmtNum(d.gateway.failovers)}
                    tone={d.gateway.failovers > 0 ? 'text-amber-300' : undefined}
                  />
                  <F23KvRow k="cache hit-rate" v={fmtPct(d.gateway.cacheHitRate)} />
                </ul>
              </CardContent>
            </Card>
            {(() => {
              const up = d.gauges.find((g) => g.id === 'uptime');
              return (
                <Card className="border-white/10 bg-white/[0.03]">
                  <CardContent className="space-y-2 p-4">
                    <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-zinc-500">
                      <HeartPulse className="h-3.5 w-3.5" aria-hidden /> Uptime platformă
                    </p>
                    <p
                      className={cn(
                        'text-2xl font-black leading-tight',
                        up ? F23_TONE_TEXT[up.status] : 'text-zinc-100',
                      )}
                    >
                      {up ? `${fmtGaugeValue(up.value)}%` : '—'}
                    </p>
                    <p className="text-xs leading-snug text-zinc-500">{up?.detail ?? '—'}</p>
                    {up ? (
                      <div
                        role="progressbar"
                        aria-label="Uptime platformă"
                        aria-valuenow={Math.round(up.value)}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        className="h-1.5 w-full overflow-hidden rounded-full bg-white/10"
                      >
                        <div
                          className={cn('h-full rounded-full transition-all', F23_TONE_BAR[up.status])}
                          style={{ width: `${Math.min(100, Math.max(0, up.value))}%` }}
                        />
                      </div>
                    ) : null}
                  </CardContent>
                </Card>
              );
            })()}
          </div>
        </CardContent>
      </Card>

      {/* 7 — alerts: the 10 rules with live state */}
      <Card className="border-white/10 bg-white/[0.03]">
        <CardHeader className="pb-3">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            <Siren className="h-4 w-4 text-rose-400" aria-hidden />
            Alerte FAZA 23 — {fmtNum(d.alerts.firing.length)} firing · {fmtNum(d.alerts.pending.length)} pending ·{' '}
            {fmtNum(inactiveCount)} inactive
            <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-zinc-500">
              {fmtNum(d.alerts.totalRules)} reguli
            </span>
          </CardTitle>
          <p className="text-xs text-zinc-500">
            evaluare 15s pe snapshot-ul scrape-uit (inactive → pending → firing → resolved); lista canonică a regulilor
            e contractul :4050, starea e live din /api/summary.
          </p>
        </CardHeader>
        <CardContent>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            {rules.map((r) => (
              <F23AlertRule key={r.id} id={r.id} state={r.state} name={r.name} severity={r.severity} since={r.since} />
            ))}
          </div>
        </CardContent>
      </Card>

      {/* 8 — synthetics: 46 checks */}
      <Card className="border-white/10 bg-white/[0.03]">
        <CardHeader className="pb-3">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            <ShieldCheck className="h-4 w-4 text-rose-400" aria-hidden />
            Synthetics globale — {fmtNum(d.synthetics.passing)}/{fmtNum(d.synthetics.total)} checks trec
          </CardTitle>
          <p className="text-xs text-zinc-500">
            exact {fmtNum(d.synthetics.total)} check-uri GET (runner 60s staggered) · ultima rulare{' '}
            <span className="font-mono">{fmtTime(d.synthetics.lastRunAt)}</span>
          </p>
        </CardHeader>
        <CardContent className="grid gap-5 lg:grid-cols-2">
          <div className="space-y-3">
            <div>
              <p className={cn('text-3xl font-black leading-tight', synToneText)}>
                {synRatio.toFixed(1)}
                <span className="ml-1 text-sm font-bold text-zinc-500">%</span>
              </p>
              <div
                role="progressbar"
                aria-label="Rată synthetics"
                aria-valuenow={Math.round(synRatio)}
                aria-valuemin={0}
                aria-valuemax={100}
                className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/10"
              >
                <div className={cn('h-full rounded-full transition-all', synToneBar)} style={{ width: `${Math.min(100, synRatio)}%` }} />
              </div>
              <p className="mt-2 text-xs text-zinc-500">
                {fmtNum(d.synthetics.failing)} fail · prag ok ≥ 95%, warn ≥ 80%
              </p>
            </div>
            <div className="space-y-1">
              <p className="text-[11px] font-bold uppercase tracking-widest text-zinc-500">Pe regiune</p>
              {Object.entries(d.synthetics.byRegion ?? {}).length === 0 ? (
                <p className="text-sm text-zinc-500">—</p>
              ) : (
                <ul className="space-y-1">
                  {Object.entries(d.synthetics.byRegion).map(([region, r]) => (
                    <F23KvRow
                      key={region}
                      k={region}
                      v={`${fmtNum(r.passing)}/${fmtNum(r.total)}`}
                      tone={r.total > 0 && r.passing < r.total ? 'text-amber-300' : 'text-emerald-300'}
                    />
                  ))}
                </ul>
              )}
            </div>
          </div>
          <div className="space-y-2">
            <p className="text-[11px] font-bold uppercase tracking-widest text-zinc-500">Eșecuri recente</p>
            {d.synthetics.recentFailures.length === 0 ? (
              <p className="text-sm text-zinc-500">— fără eșecuri în ultima rulare.</p>
            ) : (
              <ul className="max-h-48 space-y-2 overflow-y-auto pr-1">
                {d.synthetics.recentFailures.map((f) => (
                  <li key={f.id} className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
                    <p className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="font-mono text-[11px] font-semibold text-zinc-300">{f.id}</span>
                      <span className="font-mono text-[10px] text-zinc-600">{fmtTime(f.ts)}</span>
                    </p>
                    {f.name ? <p className="mt-0.5 text-[11px] text-zinc-500">{f.name}</p> : null}
                    {f.error ? <p className="mt-1 break-words text-[11px] text-red-300">{f.error}</p> : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </CardContent>
      </Card>

      {/* 9 — live OTel traces */}
      <Card className="border-white/10 bg-white/[0.03]">
        <CardHeader className="pb-3">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            <GitBranch className="h-4 w-4 text-rose-400" aria-hidden />
            Traces OTel — collector live
          </CardTitle>
          <p className="text-xs text-zinc-500">
            {fmtNum(d.traces.active)} trace-uri active · {fmtNum(d.traces.spansPerMin)} span-uri/min · ring buffer
            LRU 5000 · include span-urile browser (animaxia-web, instrumentate în FAZA 23-c).
          </p>
        </CardHeader>
        <CardContent className="grid gap-5 lg:grid-cols-[1fr_1.5fr]">
          <div className="space-y-2">
            <p className="text-[11px] font-bold uppercase tracking-widest text-zinc-500">Servicii</p>
            {d.traces.services.length === 0 ? (
              <p className="text-sm text-zinc-500">—</p>
            ) : (
              <ul className="space-y-1">
                {d.traces.services.map((s) => (
                  <li key={s.name} className="flex flex-wrap items-baseline justify-between gap-x-3 text-[11px]">
                    <span className="font-mono font-semibold text-zinc-300">{s.name}</span>
                    <span className="text-zinc-500">
                      {fmtNum(s.spans)} span · {fmtMs(s.avgMs)} ·{' '}
                      <span className={s.errors > 0 ? 'font-semibold text-amber-300' : 'text-zinc-400'}>
                        {fmtNum(s.errors)} err ({fmtPct(s.errorRate)})
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="space-y-2">
            <p className="text-[11px] font-bold uppercase tracking-widest text-zinc-500">Trace-uri recente</p>
            {d.traces.recent.length === 0 ? (
              <p className="text-sm text-zinc-500">— collectorul nu a primit încă span-uri.</p>
            ) : (
              <ul className="max-h-80 space-y-1.5 divide-y divide-white/5 overflow-y-auto pr-1">
                {d.traces.recent.map((t) => (
                  <li key={`${t.traceId}-${t.startedAt}`} className="flex flex-wrap items-baseline gap-x-3 py-1.5 text-[11px]">
                    <span className="font-mono text-zinc-500" title={t.traceId}>
                      {t.traceId.slice(0, 8)}…
                    </span>
                    <span className="font-semibold text-zinc-300">{t.service}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-zinc-500" title={t.name}>
                      {t.name}
                    </span>
                    <span
                      className={cn(
                        'font-bold uppercase',
                        t.status === 'error' ? 'text-red-300' : 'text-emerald-300',
                      )}
                    >
                      {t.status}
                    </span>
                    <span className="font-mono font-semibold text-zinc-200">{fmtMs(t.durationMs)}</span>
                    <span className="font-mono text-[10px] text-zinc-600">{fmtTime(t.startedAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </CardContent>
      </Card>
    </section>
  );
}

/* --------------------------------- tab --------------------------------- */

export function AdminObservabilityTab() {
  const metrics = useApi('admin-obs-metrics', () => api.metricsJson());
  const stability = useApi('admin-obs-stability', () => api.platform.stability());
  const search = useApi('admin-obs-search', () => api.searchStatus());

  /* "Ultima achiziție" — derived directly from the metrics payload's
     generatedAt stamp (no state needed; it changes on every poll). */
  const lastFetch = metrics.data?.generatedAt ?? null;

  /* NEON FREE PLAN: auto-refresh 15s ELIMINAT — montare + Refresh manual
   * (colectarea metricilor pe backend e oricum la 30 min). */

  const loadingFirst = (metrics.loading || stability.loading) && !metrics.data && !stability.data;

  if (loadingFirst) {
    return (
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }

  if (metrics.error && !metrics.data && stability.error && !stability.data) {
    return <ErrorState message={metrics.error} onRetry={() => void metrics.refetch()} compact />;
  }

  const m = metrics.data;
  const st = stability.data;
  const sr = search.data;

  const http = m?.http;
  const cacheCollector = m?.collectors?.cache as { hits?: number; misses?: number; keys?: number; hitRate?: number } | undefined;
  const dbCollector = m?.collectors?.db as { connected?: boolean; pool?: { total?: number; idle?: number; waiting?: number } } | undefined;
  const ai = m?.collectors?.ai;
  const aiUsage = ai?.usage as { totalCalls?: number; errors?: number; errorRate?: number; degradedCalls?: number; callsToday?: number } | undefined;

  const rss = st?.memory.rssBytes ?? m?.process?.memoryRssBytes ?? 0;
  const rssLimit = st?.memory.rssLimitBytes ?? 0;
  const rssPct = rssLimit > 0 ? (rss / rssLimit) * 100 : 0;
  const lagP95 = st?.eventLoopLag.p95Ms ?? 0;
  const inFlight = st?.inFlight ?? 0;
  const inFlightMax = st?.inFlightMax ?? 0;
  const shedCount = st?.shed.count ?? 0;
  const stages = sr?.pipelineStages ?? [];

  const errorRatePct = http ? (http.errorRate <= 1 && http.errorRate > 0 ? http.errorRate * 100 : http.errorRate) : 0;

  return (
    <div className="space-y-5">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-xs text-zinc-500">
          <Activity className="h-3.5 w-3.5 text-rose-400" aria-hidden />
          Date publice live (/api/metrics, /api/platform/stability, /api/search/status) — actualizare manuală.
          {lastFetch ? (
            <span className="font-mono text-zinc-600">
              ultima achiziție: {new Date(lastFetch).toLocaleTimeString('ro-RO')}
            </span>
          ) : null}
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="border-white/15 bg-white/5 font-semibold hover:bg-white/10"
            onClick={() => {
              void metrics.refetch();
              void stability.refetch();
              void search.refetch();
            }}
          >
            <RefreshCw aria-hidden /> Reîmprospătează acum
          </Button>
        </div>
      </div>

      {/* Core gauges */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <GaugeCard
          icon={<HeartPulse className="h-3.5 w-3.5" aria-hidden />}
          title="Uptime proces"
          value={formatUptime(st?.uptimeSec ?? m?.uptimeSec)}
          sub={`stabilitate live · in-flight max istoric ${fmtNum(inFlightMax)}`}
          tone="emerald"
        />
        <GaugeCard
          icon={<GaugeIcon className="h-3.5 w-3.5" aria-hidden />}
          title="Event-loop lag p95"
          value={fmtMs(lagP95)}
          sub={`p50 ${fmtMs(st?.eventLoopLag.p50Ms)} · curent ${fmtMs(st?.eventLoopLag.currentMs)} · prag shed 300ms`}
          tone={lagP95 > 300 ? 'red' : lagP95 > 100 ? 'amber' : 'zinc'}
        />
        <GaugeCard
          icon={<ServerCog className="h-3.5 w-3.5" aria-hidden />}
          title="Memorie RSS"
          value={formatBytes(rss)}
          sub={`limită ${formatBytes(rssLimit)} · heap ${formatBytes(st?.memory.heapUsedBytes)} · purgări ${fmtNum(st?.memoryPurges)}`}
          bar={{ pct: rssPct, className: rssPct > 80 ? 'bg-red-500' : rssPct > 60 ? 'bg-amber-500' : 'bg-emerald-500' }}
        />
        <GaugeCard
          icon={<Zap className="h-3.5 w-3.5" aria-hidden />}
          title="Cereri în zbor / shed"
          value={`${fmtNum(inFlight)} / ${fmtNum(shedCount)}`}
          sub={`shed respinge la lag p95 > 300ms sau RSS > 90% · timeouts ${fmtNum(st?.timeouts)}`}
          tone={shedCount > 0 ? 'amber' : 'zinc'}
        />
        <GaugeCard
          icon={<Activity className="h-3.5 w-3.5" aria-hidden />}
          title="Cereri HTTP totale"
          value={fmtNum(http?.totalRequests)}
          sub={`erori 5xx: ${fmtNum(http?.serverErrors)} · rată erori ${fmtPct(errorRatePct)}`}
          tone={http && http.serverErrors > 0 ? 'amber' : 'zinc'}
        />
        <GaugeCard
          icon={<Layers className="h-3.5 w-3.5" aria-hidden />}
          title="Cache hit-rate"
          value={fmtPct(cacheCollector?.hitRate)}
          sub={`${fmtNum(cacheCollector?.hits)} hit / ${fmtNum(cacheCollector?.misses)} miss · ${fmtNum(cacheCollector?.keys)} chei`}
          tone="emerald"
          bar={{ pct: num(cacheCollector?.hitRate) * 100 }}
        />
        <GaugeCard
          icon={<BrainCircuit className="h-3.5 w-3.5" aria-hidden />}
          title="Apeluri AI"
          value={fmtNum(aiUsage?.totalCalls)}
          sub={`${fmtNum(aiUsage?.errors ?? 0)} erori · ${fmtNum(aiUsage?.degradedCalls ?? 0)} degradate · provider ${ai?.provider?.provider ?? '—'} ${ai?.provider?.available ? 'disponibil' : 'indisponibil'}`}
          tone={aiUsage && (aiUsage.errors ?? 0) > 0 ? 'amber' : 'zinc'}
        />
        <GaugeCard
          icon={<Database className="h-3.5 w-3.5" aria-hidden />}
          title="Pool bază de date"
          value={`${fmtNum(dbCollector?.pool?.total)} conex.`}
          sub={
            dbCollector?.connected
              ? `idle ${fmtNum(dbCollector?.pool?.idle)} · în așteptare ${fmtNum(dbCollector?.pool?.waiting)} · postgres conectat`
              : 'deconectat — fallback local'
          }
          tone={dbCollector?.connected ? 'emerald' : 'red'}
        />
      </div>

      {/* Search pipeline — the 10 FAZA-18 layers */}
      <Card className="border-white/10 bg-white/[0.03]">
        <CardHeader className="pb-3">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            <Search className="h-4 w-4 text-rose-400" aria-hidden />
            Pipeline de căutare — cele 10 straturi FAZA 18
            {sr ? (
              sr.pipelineIntegrated ? (
                <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-300">
                  integrat
                </span>
              ) : (
                <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-300">
                  neintegrat
                </span>
              )
            ) : null}
          </CardTitle>
          <p className="text-xs text-zinc-500">
            {fmtNum(sr?.docs)} documente indexate · latență p50 {fmtMs(sr?.latency?.p50Ms)} / p95{' '}
            {fmtMs(sr?.latency?.p95Ms)} · {fmtNum(sr?.latency?.samples)} mostre · engine {sr?.engine ?? '—'}
          </p>
        </CardHeader>
        <CardContent>
          {stages.length === 0 ? (
            <p className="text-sm text-zinc-500">Pipeline-ul nu raportează straturi (backend FAZA 18+ necesar).</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
              {stages.map((stage) => (
                <StageCard key={stage.order} order={stage.order} name={stage.name} stats={stage.stats} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* FAZA 23 (23-c) — enterprise observability section, BELOW the TS2b
          content on purpose: the classic live-backend view stays first, the
          global-stack deep-dive (10 gauges + 9 visualizations, single
          /api/summary?XTransformPort=4050 poll) follows. Self-contained: own
          15s poll (paused when hidden), own skeleton / ErrorState / refresh. */}
      <Faza23ObservabilitySection />
    </div>
  );
}
