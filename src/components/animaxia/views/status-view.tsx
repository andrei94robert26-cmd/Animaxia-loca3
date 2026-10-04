'use client';

/**
 * status-view.tsx — FAZA 29 (Animaxia 2.0) — reconstituirea view-ului de stare
 * pierdut la restaurarea snapshot-ului FAZA 24. Stare LIVE, reală, a întregii
 * platforme: sonda trei surse independente în paralel —
 *
 *   1. Backend   :4000  /api/health        (SQLite, cache, provideri, versiune)
 *   2. Edge      :8181  /api/edge/status   (6 upstream-uri + Redis PING + TLS)
 *   3. Gateway   :4040  /api/infra/status  (3 regiuni, straturi perimetru)
 *
 * Rută: #/status (meniul „Cont” → Stare Platformă). View 100% aditiv — nu
 * atinge nicio componentă protejată; doar CITEȘTE endpoint-urile publice.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  CircleDot,
  Database,
  Gauge,
  Globe,
  HeartPulse,
  RefreshCw,
  Server,
  ShieldCheck,
  XCircle,
  Zap,
} from 'lucide-react';
import { api } from '@/lib/animaxia/api';
import { useApi } from '@/lib/animaxia/hooks';
import type { HealthResponse } from '@/lib/animaxia/types';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/* ------------------------------ probe helpers ----------------------------- */

/** GET pe un serviciu intern prin gateway (cale relativă + XTransformPort). */
async function svcFetch<T>(port: number, path: string): Promise<T> {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${path}${sep}XTransformPort=${port}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

interface EdgeUpstream {
  canonical: string;
  address: string;
  port: number;
  healthy: boolean;
  lastError: string | null;
  latencyMs: number;
}

interface EdgeStatus {
  ok: boolean;
  service: string;
  uptimeSec: number;
  listeners: {
    https?: { port: number; alpn?: string[]; tls?: string; hsts?: string };
    http?: { port: number; note?: string };
    redirect?: { port: number; code: number };
  };
  upstreams: Record<string, EdgeUpstream>;
  redisGlobal: { ok: boolean; latencyMs: number } | null;
}

interface EdgePublicStatus {
  ok: boolean;
  upstream?: {
    status?: number;
    healthy?: boolean;
    service?: string;
  };
  latencyMs?: number;
}

interface GwUpstream {
  url: string;
  healthy: boolean;
  latencyMs: number;
  forcedDown?: boolean;
}

interface GwRegion {
  name: string;
  label: string;
  upstreams: GwUpstream[];
}

interface GwStatus {
  ok: boolean;
  service: string;
  uptimeSec: number;
  redisMode: string;
  regions: GwRegion[];
  layers?: {
    limits?: Record<string, { limit: number; windowSec: number }>;
    cacheTtlSec?: Record<string, number>;
  };
  cache?: { hits: number; misses: number; hitRate: number };
  counters?: { requests?: number; rateLimited?: number; failovers?: number };
}

interface StabilityIncident {
  id: string;
  key: string;
  service: string;
  severity: 'critical' | 'warning' | 'info';
  message: string;
  active: boolean;
  intentionalDemo: boolean;
  createdAt: string;
  lastSeenAt: string;
}

interface StabilityStatus {
  ok: boolean;
  service: string;
  port: number;
  uptimeSec: number;
  completedCycles: number;
  score: number;
  state: 'stable' | 'degraded' | 'critical';
  incidents: {
    active: number;
    critical: number;
    warning: number;
    info: number;
  };
  failovers: {
    active: number;
    regions: Array<{
      region: string;
      label: string;
      healthy: number;
      total: number;
      available: boolean;
      failoverActive: boolean;
      intentionalDemo: boolean;
    }>;
  };
  recoveries: {
    total: number;
  };
}

interface ObservabilityAlert {
  id: string;
  key: string;
  severity: 'critical' | 'warning' | 'info';
  service: string;
  message: string;
  active: boolean;
  createdAt: string;
  lastSeenAt: string;
}

interface ObservabilityAlertsResponse {
  count: number;
  alerts: ObservabilityAlert[];
}

interface ObservabilityProbe {
  healthy: boolean;
  status: number | null;
  latencyMs: number | null;
  consecutiveFailures: number;
  totalChecks: number;
  totalFailures: number;
}

interface ObservabilitySummary {
  ok: boolean;
  service: string;
  port: number;
  uptimeSec: number;
  completedCycles: number;
  intervalMs: number;
  probes: Record<string, ObservabilityProbe>;
  alerts: {
    active: number;
    critical: number;
    warning: number;
    info: number;
  };
  events: {
    total: number;
  };
  timestamp: string;
}

interface WatchdogServiceStatus {
  service: string;
  url: string;
  healthy: boolean;
  status: number | null;
  latencyMs: number | null;
  consecutiveFailures: number;
  lastCheck: number | null;
  lastSuccess: number | null;
  lastFailure: number | null;
  lastError: string | null;
  lastRestart: number | null;
  restartCount: number;
  restarting: boolean;
}

interface WatchdogStatus {
  ok: boolean;
  service: string;
  port: number;
  uptimeSec: number;
  completedCycles: number;
  policy: {
    intervalMs: number;
    timeoutMs: number;
    failureThreshold: number;
    restartCooldownMs: number;
  };
  services: Record<string, WatchdogServiceStatus>;
  timestamp: string;
}

/* FAZA 30: stare publică a tracker-ului SLO (animaxia-ops/slo-100x.sh). */
interface SloStatus {
  phase: string;
  slo: { target: number; windowSec: number; intervalSec: number };
  availability: number;
  errorBudget: { used: number; status: 'ok' | 'at-risk' | 'breached' | 'warming' };
  samples: { window: number; failed: number; total: number };
  soakStartedAt: string;
  updatedAt: string;
}

/* --------------------------------- format --------------------------------- */

const SERVICE_NAMES: Record<string, string> = {
  BACKEND: 'Backend API',
  GATEWAY: 'Gateway Global',
  OBSERVABILITY: 'Observabilitate',
  STABILITY: 'Stabilitate',
  REALTIME: 'Realtime (socket.io)',
  FRONTEND: 'Frontend Web',
};

function fmtUptime(sec?: number): string {
  if (sec == null) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h >= 24) {
    const d = Math.floor(h / 24);
    return `${d}z ${h % 24}h`;
  }
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function StatusPill({ up, label }: { up: boolean; label?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider',
        up
          ? 'border-emerald-500/30 bg-emerald-500/15 text-emerald-300'
          : 'border-rose-500/30 bg-rose-500/15 text-rose-300',
      )}
    >
      {up ? <CheckCircle2 className="h-3 w-3" aria-hidden /> : <XCircle className="h-3 w-3" aria-hidden />}
      {label ?? (up ? 'Operațional' : 'Indisponibil')}
    </span>
  );
}

function DetailCard({
  icon,
  title,
  children,
  className,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('rounded-2xl border border-white/10 bg-white/[0.02] p-5', className)}>
      <div className="mb-3 flex items-center gap-2 text-zinc-300">
        {icon}
        <h3 className="text-sm font-bold uppercase tracking-wider">{title}</h3>
      </div>
      {children}
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-white/5 py-1.5 last:border-0">
      <span className="text-xs text-zinc-500">{label}</span>
      <span className={cn('text-right text-xs font-semibold text-zinc-200', mono && 'font-mono text-[11px]')}>
        {value}
      </span>
    </div>
  );
}

/* ---------------------------------- view ---------------------------------- */

/* NEON FREE PLAN: sondă auto la 5 MIN (fost 30s), doar tab vizibil —
 * /api/health e cache piggyback pe backend, deci nu accesează inutil SQLite, dar
 * restul sondelor (accel etc.) rulează doar cu utilizator activ pe pagină.
 * Butonul Refresh manual forțează actualizarea instant. */
const REFRESH_MS = 5 * 60 * 1000;

export function StatusView() {
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [seenBackend, setSeenBackend] = useState<unknown>(null);
  const [seenEdge, setSeenEdge] = useState<unknown>(null);
  const [seenGateway, setSeenGateway] = useState<unknown>(null);

  const backend = useApi('status-backend', () => api.health());
  const edge = useApi('status-edge', () => svcFetch<EdgeStatus>(8181, '/api/edge/status'));
  const edgePublic = useApi('status-edge-public', async () => {
    const res = await fetch('/api/edge-status', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as EdgePublicStatus;
  });
  const gateway = useApi('status-gateway', () => svcFetch<GwStatus>(4040, '/api/infra/status'));
  const watchdog = useApi(
    'status-watchdog',
    () => svcFetch<WatchdogStatus>(4020, '/api/watchdog/status'),
  );
  const observability = useApi(
    'status-observability',
    () => svcFetch<ObservabilitySummary>(4050, '/api/summary'),
  );
  const observabilityAlerts = useApi(
    'status-observability-alerts',
    () =>
      svcFetch<ObservabilityAlertsResponse>(
        4050,
        '/api/alerts',
      ),
  );
  const stability = useApi(
    'status-stability',
    () =>
      svcFetch<StabilityStatus>(
        4060,
        '/api/stability/status',
      ),
  );
  /* FAZA 29-P: strat accelerare căutare (cache SQLite + LRU + warming). */
  const accel = useApi('status-accel', () => api.searchAccelStatus());
  /* FAZA 30: SLO 99.9% + soak (fișier public scris de tracker-ul ops). */
  const [slo, setSlo] = useState<SloStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch('/slo-status.json', { cache: 'no-store' });
        if (res.ok) {
          const data = (await res.json()) as SloStatus;
          if (!cancelled) setSlo(data);
        } else if (!cancelled) {
          setSlo(null); // tracker-ul nu a scris încă (instanță publică fără ops) — cardul se ascunde
        }
      } catch {
        if (!cancelled) setSlo(null);
      }
    };
    void load();
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 5 * 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const refetchBackend = backend.refetch;
  const refetchEdgePublic = edgePublic.refetch;
  const refetchGateway = gateway.refetch;
  const refetchWatchdog = watchdog.refetch;
  const refetchObservability = observability.refetch;
  const refetchObservabilityAlerts = observabilityAlerts.refetch;
  const refetchStability = stability.refetch;
  const refetchAccel = accel.refetch;

  /* Pattern React „adjust state during render”: marcaj temporal la fiecare
     set nou de date de la sonde (fără setState în efect — regula lint). */
  if (
    (backend.data || edge.data || gateway.data) &&
    (backend.data !== seenBackend || edge.data !== seenEdge || gateway.data !== seenGateway)
  ) {
    setSeenBackend(backend.data);
    setSeenEdge(edge.data);
    setSeenGateway(gateway.data);
    setUpdatedAt(new Date());
  }

  /* Auto-refresh la 5 min — doar tab vizibil (sonde pasive, sub rate-limits). */
  const refreshAll = useCallback(() => {
    void refetchBackend();
    void refetchEdgePublic();
    void refetchGateway();
    void refetchWatchdog();
    void refetchObservability();
    void refetchObservabilityAlerts();
    void refetchStability();
    void refetchAccel();
  }, [
    refetchBackend,
    refetchEdgePublic,
    refetchGateway,
    refetchWatchdog,
    refetchObservability,
    refetchObservabilityAlerts,
    refetchStability,
    refetchAccel,
  ]);

  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') refreshAll();
    }, REFRESH_MS);
    return () => window.clearInterval(id);
  }, [refreshAll]);

  /* Verdict global bazat pe sondele reale: backend, edge si gateway regional. */
  const verdict = useMemo(() => {
    const dbOk = backend.data?.db?.connected === true;
    const edgeOk =
      edgePublic.data?.ok === true &&
      edgePublic.data?.upstream?.healthy === true;

    const gatewayRegions = gateway.data?.regions ?? [];
    const gatewayOk =
      gateway.data?.ok === true &&
      gatewayRegions.length > 0 &&
      gatewayRegions.every((region) =>
        region.upstreams.some(
          (upstream) => upstream.healthy && !upstream.forcedDown,
        ),
      );

    if (dbOk && edgeOk && gatewayOk) return 'ok' as const;
    if (dbOk || edgeOk || gatewayOk) return 'partial' as const;

    const finishedLoading =
      !backend.loading &&
      !edgePublic.loading &&
      !gateway.loading;

    return finishedLoading ? 'down' as const : 'unknown' as const;
  }, [
    backend.data,
    backend.loading,
    edgePublic.data,
    edgePublic.loading,
    gateway.data,
    gateway.loading,
  ]);

  const upstreams = useMemo(
    () =>
      edge.data
        ? Object.entries(edge.data.upstreams).sort(([a], [b]) => a.localeCompare(b))
        : [],
    [edge.data],
  );

  const loading = backend.loading && edgePublic.loading && gateway.loading;
  const anyError = backend.error && edgePublic.error && gateway.error;

  return (
    <section className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6">
      {/* Header */}
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="mb-1 flex items-center gap-2 text-rose-400">
            <HeartPulse className="h-4 w-4" aria-hidden />
            <span className="text-[11px] font-bold uppercase tracking-[0.2em]">Sonde live · reale</span>
          </div>
          <h1 className="text-2xl font-black tracking-tight text-white sm:text-3xl">Stare Platformă</h1>
          <p className="mt-1 max-w-xl text-sm text-zinc-400">
            Toate serviciile Animaxia, sondate în timp real: backend, gateway global pe 3 regiuni,
            edge public, Redis, SQLite și providerii externi.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {updatedAt ? (
            <span className="hidden text-[11px] text-zinc-500 sm:block" aria-live="polite">
              Actualizat: {updatedAt.toLocaleTimeString('ro-RO')}
            </span>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            onClick={() => refreshAll()}
            disabled={loading}
            className="border-white/15 bg-white/5 hover:bg-white/10"
          >
            <RefreshCw className={cn('mr-2 h-3.5 w-3.5', loading && 'animate-spin')} aria-hidden />
            Reîmprospătează
          </Button>
        </div>
      </div>

      {/* Verdict global */}
      {loading ? (
        <Skeleton className="mb-6 h-24 w-full rounded-2xl" />
      ) : (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className={cn(
            'mb-6 flex flex-wrap items-center gap-4 rounded-2xl border p-5',
            verdict === 'ok' && 'border-emerald-500/25 bg-emerald-500/[0.06]',
            verdict === 'partial' && 'border-amber-500/25 bg-amber-500/[0.06]',
            verdict === 'down' && 'border-rose-500/25 bg-rose-500/[0.06]',
            verdict === 'unknown' && 'border-white/10 bg-white/[0.02]',
          )}
          role="status"
          aria-live="polite"
        >
          {verdict === 'ok' ? (
            <CheckCircle2 className="h-9 w-9 shrink-0 text-emerald-400" aria-hidden />
          ) : verdict === 'partial' ? (
            <AlertTriangle className="h-9 w-9 shrink-0 text-amber-400" aria-hidden />
          ) : (
            <XCircle className="h-9 w-9 shrink-0 text-rose-400" aria-hidden />
          )}
          <div className="min-w-0 flex-1">
            <p className="text-lg font-black text-white">
              {verdict === 'ok'
                ? 'Toate sistemele operaționale'
                : verdict === 'partial'
                  ? 'Funcționare parțială'
                  : verdict === 'down'
                    ? 'Platformă indisponibilă'
                    : 'Stare necunoscută'}
            </p>
            <p className="text-sm text-zinc-400">
              {verdict === 'ok'
                ? `Toate serviciile răspund, Redis PING OK, SQLite conectat (${backend.data?.db?.totalItems ?? '—'} titluri în bibliotecă).`
                : 'Unele sonde nu răspund — detaliile sunt mai jos. Verificăm continuu la fiecare 30 de secunde.'}
            </p>
          </div>
          {edge.data ? (
            <div className="rounded-xl border border-white/10 bg-black/30 px-4 py-2 text-center">
              <div className="text-lg font-black text-white">{fmtUptime(edge.data.uptimeSec)}</div>
              <div className="text-[10px] uppercase tracking-wider text-zinc-500">Uptime edge</div>
            </div>
          ) : null}
        </motion.div>
      )}

      {anyError ? (
        <div role="alert" className="mb-6 rounded-2xl border border-rose-500/20 bg-rose-500/5 p-4 text-sm text-zinc-300">
          <p className="font-semibold text-rose-300">Sonde inaccesibile</p>
          <p className="mt-1 text-zinc-400">
            Backend: {backend.error ?? 'ok'} · Edge: {edgePublic.error ?? 'ok'} · Gateway: {gateway.error ?? 'ok'}
          </p>
        </div>
      ) : null}

      {/* Grid servicii (edge upstream-uri + redis + edge self) */}
      <h2 className="mb-3 flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-zinc-400">
        <Server className="h-4 w-4" aria-hidden /> Servicii
      </h2>
      <div className="mb-8 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {edge.loading && !edge.data
          ? Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-2xl" />)
          : upstreams.map(([key, u], i) => (
              <motion.div
                key={key}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25, delay: Math.min(i * 0.03, 0.3) }}
                className="rounded-2xl border border-white/10 bg-white/[0.02] p-4"
              >
                <div className="mb-2 flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold text-zinc-100">
                      {SERVICE_NAMES[key] ?? key}
                    </p>
                    <p className="font-mono text-[10px] text-zinc-500">:{u.port}</p>
                  </div>
                  <StatusPill up={u.healthy} />
                </div>
                <div className="flex items-center justify-between text-[11px] text-zinc-500">
                  <span className="inline-flex items-center gap-1">
                    <Gauge className="h-3 w-3" aria-hidden />
                    {u.latencyMs >= 0 ? `${u.latencyMs} ms` : '—'}
                  </span>
                  <span className="font-mono">{u.canonical}</span>
                </div>
                {u.lastError ? (
                  <p className="mt-2 truncate text-[10px] text-rose-300/80" title={u.lastError}>
                    {u.lastError}
                  </p>
                ) : null}
              </motion.div>
            ))}
        {edge.data ? (
          <>
            <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
              <div className="mb-2 flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-bold text-zinc-100">Redis Global</p>
                  <p className="font-mono text-[10px] text-zinc-500">:4030 · RESP PING</p>
                </div>
                <StatusPill up={Boolean(edge.data.redisGlobal?.ok)} />
              </div>
              <div className="flex items-center gap-1 text-[11px] text-zinc-500">
                <Gauge className="h-3 w-3" aria-hidden />
                {edge.data.redisGlobal ? `${edge.data.redisGlobal.latencyMs} ms` : '—'}
              </div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
              <div className="mb-2 flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-bold text-zinc-100">Edge Public</p>
                  <p className="font-mono text-[10px] text-zinc-500">:8181 · :8443 · :8080</p>
                </div>
                <StatusPill up={edge.data.ok} />
              </div>
              <div className="flex items-center gap-1 text-[11px] text-zinc-500">
                <ShieldCheck className="h-3 w-3" aria-hidden />
                TLS 1.2–1.3 · h2 · HSTS · 308
              </div>
            </div>
          </>
        ) : null}
      </div>

      {/* Detalii infrastructură */}
      <h2 className="mb-3 flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-zinc-400">
        <Activity className="h-4 w-4" aria-hidden /> Detalii infrastructură
      </h2>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {/* Bază de date SQLite */}
        <DetailCard icon={<Database className="h-4 w-4 text-rose-400" aria-hidden />} title="Bază de date SQLite">
          {backend.loading && !backend.data ? (
            <div className="space-y-2">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          ) : backend.data ? (
            <>
              <Row
                label="Driver"
                value={
                  <span className={backend.data.db.driver === 'postgres' ? 'text-emerald-300' : 'text-amber-300'}>
                    {backend.data.db.driver}
                  </span>
                }
              />
              <Row label="Conectat" value={backend.data.db.connected ? 'Da' : 'Nu'} />
              <Row label="Titluri în bibliotecă" value={backend.data.db.totalItems.toLocaleString('ro-RO')} />
              <div className="mt-2 flex flex-wrap gap-1.5">
                {Object.entries(backend.data.db.countsByType).map(([type, count]) => (
                  <span
                    key={type}
                    className="rounded-full border border-white/10 bg-white/[0.03] px-2 py-0.5 text-[10px] font-semibold text-zinc-400"
                  >
                    {type}: {count}
                  </span>
                ))}
              </div>
            </>
          ) : (
            <p className="text-xs text-zinc-500">Sondă indisponibilă: {backend.error}</p>
          )}
        </DetailCard>

        {/* Backend */}
        <DetailCard icon={<CircleDot className="h-4 w-4 text-amber-400" aria-hidden />} title="Backend API">
          {backend.data ? (
            <>
              <Row label="Versiune" value={backend.data.version} mono />
              <Row label="Uptime" value={fmtUptime(backend.data.uptimeSec)} />
              <Row
                label="Cache hit-rate"
                value={
                  <span className="inline-flex items-center gap-2">
                    <span className="h-1.5 w-16 overflow-hidden rounded-full bg-white/10">
                      <span
                        className="block h-full rounded-full bg-rose-400"
                        style={{ width: `${Math.round((backend.data.cache.hitRate ?? 0) * 100)}%` }}
                      />
                    </span>
                    {Math.round((backend.data.cache.hitRate ?? 0) * 100)}%
                  </span>
                }
              />
              <Row label="Cereri limitate (fereastră)" value={backend.data.rateLimit.totalLimited} />
              <div className="mt-2 flex flex-wrap gap-1.5">
                {backend.data.providers.map((p) => (
                  <span
                    key={p.name}
                    className={cn(
                      'rounded-full border px-2 py-0.5 text-[10px] font-semibold',
                      p.state === 'closed'
                        ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300'
                        : 'border-amber-500/25 bg-amber-500/10 text-amber-300',
                    )}
                    title={`Circuit breaker: ${p.state}${p.failures ? ` · eșecuri: ${p.failures}` : ''}`}
                  >
                    {p.name}:{' '}
                    {p.state === 'closed'
                      ? 'sănătos'
                      : p.name === 'jikan'
                        ? 'degradat · timeout upstream'
                        : `degradat · ${p.state}`}
                  </span>
                ))}
              </div>
            </>
          ) : (
            <p className="text-xs text-zinc-500">Sondă indisponibilă.</p>
          )}
        </DetailCard>

        {/* Gateway regiuni */}
        <DetailCard icon={<Globe className="h-4 w-4 text-teal-400" aria-hidden />} title="Gateway global · 3 regiuni">
          {gateway.loading && !gateway.data ? (
            <div className="space-y-2">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          ) : gateway.data ? (
            <>
              {gateway.data.regions.map((r) => {
                const healthy = r.upstreams.filter((u) => u.healthy && !u.forcedDown).length;
                const total = r.upstreams.length;
                return (
                  <Row
                    key={r.name}
                    label={
                      r.name === 'us'
                        ? `${r.label} · failover demo`
                        : r.label
                    }
                    value={
                      <span className={healthy === total ? 'text-emerald-300' : 'text-amber-300'}>
                        {healthy}/{total} upstream-uri
                      </span>
                    }
                  />
                );
              })}
              <Row label="Cache gateway" value={`${Math.round((gateway.data.cache?.hitRate ?? 0) * 100)}%`} />
              <Row label="Cereri (total)" value={(gateway.data.counters?.requests ?? 0).toLocaleString('ro-RO')} />
              <Row label="Failovers" value={gateway.data.counters?.failovers ?? 0} />
            </>
          ) : (
            <p className="text-xs text-zinc-500">Sondă indisponibilă: {gateway.error}</p>
          )}
        </DetailCard>

        {/* FAZA 29-P — Accelerare căutare (strat aditiv peste motorul protejat) */}
        {accel.data ? (
          <DetailCard icon={<Zap className="h-4 w-4 text-yellow-400" aria-hidden />} title="Accelerare căutare · FAZA 29-P">
            <Row
              label="Stare SQLite local"
              value={
                <span className={accel.data.keepalive.avgPingMs != null && accel.data.keepalive.avgPingMs < 300 ? 'text-emerald-300' : 'text-amber-300'}>
                  {accel.data.keepalive.avgPingMs != null ? `${accel.data.keepalive.avgPingMs} ms mediu` : '—'}
                </span>
              }
            />
            <Row
              label="Cache accel (LRU 10 min)"
              value={
                <span className="inline-flex items-center gap-2">
                  <span className="h-1.5 w-16 overflow-hidden rounded-full bg-white/10">
                    <span
                      className="block h-full rounded-full bg-yellow-400"
                      style={{ width: `${Math.round(accel.data.cache.hitRate * 100)}%` }}
                    />
                  </span>
                  {Math.round(accel.data.cache.hitRate * 100)}% ({accel.data.cache.keys} chei)
                </span>
              }
            />
            <Row
              label="Warming top interogări"
              value={`${accel.data.warming.warmed} reîncălzite · ${accel.data.warming.errors} erori`}
            />
            <Row
              label="Prefetch hover"
              value={`${accel.data.prefetch.accepted} acceptate · ${accel.data.prefetch.alreadyWarm} deja calde`}
            />
            <Row label="Interogări populare urmărite" value={accel.data.popular.tracked} />
            <p className="mt-2 text-[10px] leading-relaxed text-zinc-500">
              Strat 100% aditiv peste pipeline-ul FAZA 18: optimizează accesul la SQLite local, servește
              interogările repetate din cache și reîncălzește top interogări la 30s — motorul FTS
              rămâne neatins.
            </p>
          </DetailCard>
        ) : null}

        {/* FAZA 30 — SLO 99.9% + soak (tracker real animaxia-ops/slo-100x.sh) */}
        {slo ? (
          <DetailCard icon={<Gauge className="h-4 w-4 text-cyan-400" aria-hidden />} title="SLO 99.9% · soak FAZA 30">
            <Row
              label="Disponibilitate (24h rolling)"
              value={
                <span className={slo.availability >= 0.999 ? 'text-emerald-300' : slo.availability >= 0.99 ? 'text-amber-300' : 'text-rose-300'}>
                  {(slo.availability * 100).toFixed(3)}%
                </span>
              }
            />
            <Row
              label="Buget de eroare consumat"
              value={
                <span className="inline-flex items-center gap-2">
                  <span className="h-1.5 w-16 overflow-hidden rounded-full bg-white/10">
                    <span
                      className={cn(
                        'block h-full rounded-full',
                        slo.errorBudget.status === 'breached' ? 'bg-rose-400' : slo.errorBudget.status === 'at-risk' ? 'bg-amber-400' : 'bg-cyan-400',
                      )}
                      style={{ width: `${Math.round(slo.errorBudget.used * 100)}%` }}
                    />
                  </span>
                  {(slo.errorBudget.used * 100).toFixed(1)}% · {slo.errorBudget.status}
                </span>
              }
            />
            <Row
              label="Probe sonde (fereastră)"
              value={`${slo.samples.window} probe · ${slo.samples.failed} eșuate`}
            />
            <Row label="Soak pornit" value={new Date(slo.soakStartedAt).toLocaleString('ro-RO')} />
            <p className="mt-2 text-[10px] leading-relaxed text-zinc-500">
              Tracker FAZA 30 sondează lanțul public la 30s și calculează disponibilitatea rolling 24h
              față de ținta SLO 99.9% (buget de eroare: max 1,44 min/zi).
            </p>
          </DetailCard>
        ) : null}

        {/* Perimetru gateway */}
        {gateway.data?.layers?.limits ? (
          <DetailCard icon={<ShieldCheck className="h-4 w-4 text-emerald-400" aria-hidden />} title="Perimetru · rate limits">
            {Object.entries(gateway.data.layers.limits).map(([cls, l]) => (
              <Row key={cls} label={cls} value={`${l.limit}/min`} />
            ))}
            <Row
              label="Cache TTL"
              value={Object.entries(gateway.data.layers.cacheTtlSec ?? {})
                .map(([k, v]) => `${k} ${v}s`)
                .join(' · ')}
            />
          </DetailCard>
        ) : null}

        {/* Edge listeners */}
        {edge.data ? (
          <DetailCard icon={<Globe className="h-4 w-4 text-fuchsia-400" aria-hidden />} title="Edge public · TLS">
            <Row label="HTTPS :8443" value={`${edge.data.listeners.https?.tls ?? 'TLS'} · ALPN ${(edge.data.listeners.https?.alpn ?? []).join(', ')}`} />
            <Row label="HSTS" value={edge.data.listeners.https?.hsts ? 'activ (1 an, preload)' : '—'} />
            <Row label="HTTP mirror :8181" value="fără HSTS (RFC 6797)" />
            <Row label="Redirect :8080" value={`${edge.data.listeners.redirect?.code ?? 308} permanent`} />
            <Row label="Redis PING" value={edge.data.redisGlobal?.ok ? `${edge.data.redisGlobal.latencyMs} ms` : 'indisponibil'} />
          </DetailCard>
        ) : null}

        {/* Dashboard alerte si incidente */}
        <DetailCard
          icon={
            <AlertTriangle
              className="h-4 w-4 text-amber-400"
              aria-hidden
            />
          }
          title="Alerte & Incidente"
        >
          {observabilityAlerts.loading &&
          !observabilityAlerts.data ? (
            <div className="space-y-2">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          ) : observabilityAlerts.data ? (
            <>
              <Row
                label="Alerte active"
                value={observabilityAlerts.data.count}
              />

              {stability.data ? (
                <>
                  <Row
                    label="Critice"
                    value={stability.data.incidents.critical}
                  />
                  <Row
                    label="Warning"
                    value={stability.data.incidents.warning}
                  />
                  <Row
                    label="Info"
                    value={stability.data.incidents.info}
                  />
                </>
              ) : null}

              <div className="mt-3 space-y-2">
                {observabilityAlerts.data.alerts.length === 0 ? (
                  <p className="text-xs text-emerald-300">
                    Nu există alerte active.
                  </p>
                ) : (
                  observabilityAlerts.data.alerts.map(
                    (alert) => (
                      <div
                        key={alert.id}
                        className={cn(
                          'rounded-xl border px-3 py-2',
                          alert.severity === 'critical'
                            ? 'border-rose-500/25 bg-rose-500/10'
                            : alert.severity === 'warning'
                              ? 'border-amber-500/25 bg-amber-500/10'
                              : 'border-sky-500/25 bg-sky-500/10',
                        )}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-bold text-zinc-100">
                            {alert.service}
                          </span>
                          <span className="text-[10px] font-bold uppercase text-zinc-400">
                            {alert.severity}
                          </span>
                        </div>

                        <p className="mt-1 text-[11px] leading-relaxed text-zinc-300">
                          {alert.message}
                        </p>
                      </div>
                    ),
                  )
                )}
              </div>
            </>
          ) : (
            <p className="text-xs text-zinc-500">
              Alertele nu sunt disponibile:{' '}
              {observabilityAlerts.error}
            </p>
          )}
        </DetailCard>

        {/* Watchdog real :4020 */}
        <DetailCard
          icon={<Activity className="h-4 w-4 text-lime-400" aria-hidden />}
          title="Supraveghere continuă"
        >
          {watchdog.loading && !watchdog.data ? (
            <div className="space-y-2">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          ) : watchdog.data ? (
            <>
              <Row
                label="Watchdog :4020"
                value={
                  <StatusPill
                    up={watchdog.data.ok}
                    label={watchdog.data.ok ? 'Operațional' : 'Degradat'}
                  />
                }
              />
              <Row
                label="Uptime"
                value={fmtUptime(watchdog.data.uptimeSec)}
              />
              <Row
                label="Cicluri finalizate"
                value={watchdog.data.completedCycles.toLocaleString('ro-RO')}
              />
              <Row
                label="Servicii monitorizate"
                value={Object.keys(watchdog.data.services).length}
              />
              <Row
                label="Restarturi totale"
                value={Object.values(watchdog.data.services).reduce(
                  (total, service) => total + service.restartCount,
                  0,
                )}
              />
              <Row
                label="Prag restart"
                value={`${watchdog.data.policy.failureThreshold} eșecuri consecutive`}
              />

              <div className="mt-3 space-y-2">
                {Object.entries(watchdog.data.services).map(([name, service]) => (
                  <div
                    key={name}
                    className="rounded-xl border border-white/10 bg-black/20 px-3 py-2"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-xs font-semibold capitalize text-zinc-300">
                        {name}
                      </span>
                      <StatusPill up={service.healthy} />
                    </div>
                    <div className="mt-1 flex items-center justify-between text-[10px] text-zinc-500">
                      <span>
                        {service.latencyMs != null
                          ? `${service.latencyMs} ms`
                          : 'latență indisponibilă'}
                      </span>
                      <span>
                        restarturi: {service.restartCount}
                      </span>
                    </div>
                    {service.lastError ? (
                      <p className="mt-1 text-[10px] text-rose-300">
                        {service.lastError}
                      </p>
                    ) : null}
                  </div>
                ))}
              </div>

              <Row
                label="Observability :4050"
                value={
                  observability.data ? (
                    <StatusPill
                      up={observability.data.ok}
                      label={
                        observability.data.ok
                          ? 'Operațional'
                          : 'Degradat'
                      }
                    />
                  ) : (
                    observability.error ?? 'Se încarcă'
                  )
                }
              />
              {observability.data ? (
                <>
                  <Row
                    label="Probe finalizate"
                    value={observability.data.completedCycles.toLocaleString(
                      'ro-RO',
                    )}
                  />
                  <Row
                    label="Alerte active"
                    value={observability.data.alerts.active}
                  />
                  <Row
                    label="Alerte critice"
                    value={observability.data.alerts.critical}
                  />
                  <Row
                    label="Evenimente"
                    value={observability.data.events.total}
                  />
                </>
              ) : null}
              <Row
                label="Stability :4060"
                value={
                  stability.data ? (
                    <StatusPill
                      up={stability.data.ok}
                      label={
                        stability.data.state === 'stable'
                          ? 'Stabil'
                          : stability.data.state === 'degraded'
                            ? 'Degradat'
                            : 'Critic'
                      }
                    />
                  ) : (
                    stability.error ?? 'Se încarcă'
                  )
                }
              />
              {stability.data ? (
                <>
                  <Row
                    label="Scor stabilitate"
                    value={`${stability.data.score}/100`}
                  />
                  <Row
                    label="Incidente active"
                    value={stability.data.incidents.active}
                  />
                  <Row
                    label="Failover-uri active"
                    value={stability.data.failovers.active}
                  />
                  <Row
                    label="Recuperări"
                    value={stability.data.recoveries.total}
                  />
                </>
              ) : null}
            </>
          ) : (
            <p className="text-xs text-zinc-500">
              Sondă indisponibilă: {watchdog.error}
            </p>
          )}
        </DetailCard>
      </div>

      <p className="mt-8 border-t border-white/5 pt-4 text-[11px] leading-relaxed text-zinc-500">
        Toate datele de pe această pagină sunt sondate LIVE din serviciile reale ale platformei
        (backend, edge public, gateway global, watchdog, observability și stability). Nicio valoare nu este simulată — dacă un serviciu
        cade, cardul lui devine roșu în maximum 30 de secunde.
      </p>
    </section>
  );
}
