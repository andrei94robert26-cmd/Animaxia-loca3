'use client';

/**
 * admin-search-opt-tab.tsx — FAZA 17 Search Optimization Layer console: live
 * gauges (active batches, batch hits, cache hits/misses, dedup total, REAL
 * Neon FTS queries, the ×N reduction factor), the money chart „Cereri vs
 * Interogări Neon" (recharts via the shadcn chart wrapper — the visual proof
 * of the 100×–1000× reduction), the 10-stage pipeline visualization, the
 * active configuration cards (cache TTL 1–5 s, capacity bounds), the live
 * in-flight batch list, the 30-row per-shard attribution table (served /
 * cache / batch / Neon per shard) and the admin runtime settings form
 * (POST /api/search/opt/settings, Bearer + admin-gated). The banner keeps
 * the FAZA 17 promise visible: identical requests share ONE real Neon query
 * and every served result is the EXACT output of a real execution — nothing
 * fabricated, nothing stale beyond the pinned TTL. Public read-only data
 * (GET /api/search/opt); auto-refreshes every 2 s while visible.
 * Deep-linked via #/admin/search-opt.
 */

import { useEffect, useMemo, useState } from 'react';
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import {
  ArrowRight,
  Boxes,
  CheckCircle2,
  Database,
  Gauge,
  Layers,
  LineChart,
  Lock,
  RefreshCw,
  Save,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  TrendingDown,
  Zap,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, BACKEND_PORT } from '@/lib/animaxia/api';
import { authRequest, PlatformError } from '@/lib/animaxia/platform';
import { useApi } from '@/lib/animaxia/hooks';
import type { SearchOptConfig, SearchOptShardStats } from '@/lib/animaxia/types';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { useAuth } from '../auth-provider';
import { EmptyState, ErrorState } from '../states';

/* ------------------------------- helpers --------------------------------- */

/** Live console cadence — /api/search/opt is in-memory and fast. */

const RO_NUMBER = new Intl.NumberFormat('ro-RO');
const RO_RATE = new Intl.NumberFormat('ro-RO', { maximumFractionDigits: 2 });

function fmtRoNum(v: number | null | undefined): string {
  return RO_NUMBER.format(Number(v ?? 0));
}

function fmtMs(v: number | null | undefined): string {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n > 0 ? `${RO_NUMBER.format(Math.round(n))} ms` : '—';
}

function fmtFactor(v: number | null | undefined): string {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n >= 1 ? `${RO_RATE.format(n)}×` : '—';
}

/** HH:MM:SS clock label for the history X axis (samples are 1 s apart). */
function fmtClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/* ------------------------------ gauges strip ------------------------------ */

type Tone = 'zinc' | 'emerald' | 'amber' | 'red';

const TONE_CHIP: Record<Tone, string> = {
  zinc: 'border-white/10 bg-white/[0.04] text-zinc-300',
  emerald: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  amber: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  red: 'border-red-500/30 bg-red-500/10 text-red-300',
};

function GaugeCard({
  icon,
  label,
  value,
  sub,
  tone = 'zinc',
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: Tone;
}) {
  return (
    <Card className="border-white/10 bg-white/[0.03]">
      <CardContent className="flex items-center gap-3 p-4">
        <span
          className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-xl border', TONE_CHIP[tone])}
          aria-hidden
        >
          {icon}
        </span>
        <div className="min-w-0">
          <p className="truncate text-2xl font-black leading-tight text-white">{value}</p>
          <p className="text-[11px] font-semibold uppercase tracking-widest text-zinc-500">{label}</p>
          {sub ? <p className="mt-0.5 truncate text-[11px] leading-snug text-zinc-600">{sub}</p> : null}
        </div>
      </CardContent>
    </Card>
  );
}

/* -------------------------------- pipeline -------------------------------- */

/** The 10-stage pinned pipeline — labels + owning phase + short descriptions.
 *  The stage list itself is data-driven from the console `pipeline` array. */
const PIPELINE_META: Record<string, { label: string; phase: string; hint: string }> = {
  antiSpam: { label: 'Anti-Spam', phase: 'FAZA 16', hint: 'flood ≥3 / 200ms → auto-block' },
  rateLimit: { label: 'Rate-Limit', phase: 'FAZA 16', hint: '1 căutare / 500ms / utilizator' },
  cooldown: { label: 'Cooldown', phase: 'FAZA 16', hint: '1200ms după rezultat' },
  queue: { label: 'Queue', phase: 'FAZA 15', hint: 'admission — 503/504 explicite' },
  priority: { label: 'Priority', phase: 'FAZA 15', hint: 'high → normal → low' },
  windowing: { label: 'Windowing', phase: 'FAZA 15', hint: '80ms × batch 80' },
  dedup: { label: 'Dedup', phase: 'FAZA 17', hint: 'cereri identice = 1 logică' },
  batching: { label: 'Batching', phase: 'FAZA 17', hint: 'atașare la execuția în curs' },
  cache: { label: 'Cache', phase: 'FAZA 17', hint: 'rezultate reale, TTL 1–5s' },
  fts: { label: 'Neon FTS', phase: 'REAL', hint: 'căutarea 100% reală' },
};

function PipelineStrip({ stages }: { stages: string[] }) {
  return (
    <Card className="border-white/10 bg-white/[0.03]">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Layers className="h-4 w-4 text-emerald-400" aria-hidden />
          Pipeline-ul căutării ({stages.length} etape)
        </CardTitle>
        <CardDescription>
          Ordinea deterministă pe care o parcurge fiecare căutare — expusă identic în{' '}
          <span className="font-mono text-[11px]">/api/search/status → pipeline</span>.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ol className="flex list-none flex-wrap items-stretch gap-2">
          {stages.map((stage, i) => {
            const meta = PIPELINE_META[stage] ?? { label: stage, phase: '—', hint: '' };
            const isReal = stage === 'fts';
            const is17 = meta.phase === 'FAZA 17';
            return (
              <li key={stage} className="flex items-center gap-2">
                <div
                  className={cn(
                    'min-w-[7.5rem] rounded-xl border px-3 py-2',
                    isReal && 'border-emerald-500/40 bg-emerald-500/[0.08]',
                    is17 && !isReal && 'border-teal-500/30 bg-teal-500/[0.06]',
                    !isReal && !is17 && 'border-white/10 bg-white/[0.03]',
                  )}
                  title={meta.hint}
                >
                  <p className="flex items-baseline gap-1.5">
                    <span className="font-mono text-[10px] text-zinc-600">{i + 1}.</span>
                    <span className={cn('text-xs font-bold', isReal ? 'text-emerald-300' : 'text-zinc-100')}>
                      {meta.label}
                    </span>
                  </p>
                  <p className="mt-0.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-600">
                    {meta.phase}
                  </p>
                  <p className="mt-0.5 hidden text-[10px] leading-snug text-zinc-500 sm:block">{meta.hint}</p>
                </div>
                {i < stages.length - 1 ? (
                  <ArrowRight className="h-3.5 w-3.5 shrink-0 text-zinc-700" aria-hidden />
                ) : null}
              </li>
            );
          })}
        </ol>
      </CardContent>
    </Card>
  );
}

/* -------------------------------- chart ---------------------------------- */

const OPT_CHART_CONFIG = {
  cereri: { label: 'Cereri servite', color: '#10b981' },
  neon: { label: 'Interogări Neon reale', color: '#f43f5e' },
} satisfies ChartConfig;

/* ---------------------------- settings form ------------------------------ */

const SETTINGS_FIELDS = [
  { key: 'cacheTtlMs', label: 'Cache TTL', hint: '1.000 – 5.000 ms', min: 1000, max: 5000 },
  { key: 'cacheMax', label: 'Intrări cache max', hint: '100 – 100.000', min: 100, max: 100000 },
  { key: 'batchMax', label: 'Batch-uri max', hint: '100 – 50.000', min: 100, max: 50000 },
] as const;

type SettingsKey = (typeof SETTINGS_FIELDS)[number]['key'];
type SettingsForm = Record<SettingsKey, string>;

function OptSettingsCard({
  config,
  isAdmin,
  onSaved,
}: {
  config: SearchOptConfig;
  isAdmin: boolean;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<SettingsForm>({
    cacheTtlMs: String(config.cacheTtlMs),
    cacheMax: String(config.cacheMax),
    batchMax: String(config.batchMax),
  });
  const [enabled, setEnabled] = useState<boolean>(config.enabled);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  /* Re-sync the pre-filled inputs from the polled config while the user has
     not edited anything (and right after a successful save). */
  useEffect(() => {
    if (dirty) return;
    setForm((prev) => {
      const next: SettingsForm = {
        cacheTtlMs: String(config.cacheTtlMs),
        cacheMax: String(config.cacheMax),
        batchMax: String(config.batchMax),
      };
      return (Object.keys(next) as SettingsKey[]).every((k) => prev[k] === next[k]) ? prev : next;
    });
    setEnabled((prev) => (prev === config.enabled ? prev : config.enabled));
  }, [config, dirty]);

  async function handleSave() {
    if (saving) return;
    const parsed: Record<SettingsKey, number> = {
      cacheTtlMs: Number(form.cacheTtlMs),
      cacheMax: Number(form.cacheMax),
      batchMax: Number(form.batchMax),
    };
    for (const f of SETTINGS_FIELDS) {
      const v = parsed[f.key];
      if (!Number.isFinite(v) || v < f.min || v > f.max) {
        toast.error(`${f.label} trebuie să fie între ${RO_NUMBER.format(f.min)} și ${RO_NUMBER.format(f.max)}`);
        return;
      }
    }
    setSaving(true);
    try {
      await authRequest<{ ok: boolean; config: SearchOptConfig }>(
        `/api/search/opt/settings?XTransformPort=${BACKEND_PORT}`,
        { method: 'POST', body: JSON.stringify({ ...parsed, enabled }) },
      );
      toast.success('Setări salvate');
      setDirty(false);
      onSaved();
    } catch (e) {
      if (e instanceof PlatformError && (e.status === 401 || e.status === 403)) {
        toast.error('Setările de optimizare necesită cont de administrator');
      } else {
        toast.error(e instanceof Error ? e.message : 'Salvarea setărilor a eșuat');
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="border-white/10 bg-white/[0.03]">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="h-4 w-4 text-emerald-400" aria-hidden />
          Setări runtime (administrator)
        </CardTitle>
        <CardDescription>
          Reglare live a stratului de optimizare — se aplică imediat, fără restart.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isAdmin ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3">
              <div>
                <p className="text-xs font-semibold text-zinc-200">Stratul de optimizare</p>
                <p className="mt-0.5 text-[11px] leading-snug text-zinc-600">
                  {enabled
                    ? 'Dedup + batching + cache ACTIVE — cererile identice partajează interogări reale.'
                    : 'DEZACTIVAT — fiecare cerere execută propriul FTS (comportament FAZA 16).'}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  id="opt-enabled"
                  checked={enabled}
                  onCheckedChange={(v) => {
                    setDirty(true);
                    setEnabled(v);
                  }}
                  aria-label="Activează stratul de optimizare a căutării"
                />
                <Label htmlFor="opt-enabled" className="text-xs text-zinc-400">
                  {enabled ? 'Activ' : 'Dezactivat'}
                </Label>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              {SETTINGS_FIELDS.map((f) => (
                <div key={f.key} className="space-y-1.5">
                  <Label htmlFor={`opt-setting-${f.key}`} className="text-xs text-zinc-400">
                    {f.label} <span className="font-normal text-zinc-600">({f.hint})</span>
                  </Label>
                  <Input
                    id={`opt-setting-${f.key}`}
                    type="number"
                    inputMode="numeric"
                    min={f.min}
                    max={f.max}
                    step={1}
                    value={form[f.key]}
                    onChange={(e) => {
                      setDirty(true);
                      setForm((prev) => ({ ...prev, [f.key]: e.target.value }));
                    }}
                    className="border-white/10 bg-white/[0.04] font-mono text-zinc-100"
                    aria-label={`${f.label}, interval acceptat ${f.hint}`}
                  />
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="max-w-xl text-[11px] leading-snug text-zinc-600">
                Validarea și limitarea valorilor (clamping) se fac pe server — TTL-ul rămâne în plaja
                pinned 1.000–5.000 ms din specificația FAZA 17.
              </p>
              <Button
                size="sm"
                onClick={() => void handleSave()}
                disabled={saving || !dirty}
                className="bg-emerald-600 font-bold hover:bg-emerald-500"
              >
                {saving ? <RefreshCw className="animate-spin" aria-hidden /> : <Save aria-hidden />}
                Salvează
              </Button>
            </div>
          </>
        ) : (
          <p className="flex items-center gap-2 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-4 py-2.5 text-xs text-amber-200">
            <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden />
            Setările de optimizare necesită cont de administrator — valorile curente sunt read-only.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/* -------------------------------- main tab -------------------------------- */

export function AdminSearchOptTab() {
  const { isAdmin, initializing } = useAuth();
  const opt = useApi('admin-search-opt', () => api.searchOpt());

  /* NEON FREE PLAN: auto-refresh ELIMINAT (fost 2s) — încărcare la montare +
   * butonul Refresh manual existent. */

  const data = opt.data;
  const batching = data?.batching ?? null;
  const cache = data?.cache ?? null;
  const dedup = data?.dedup ?? null;
  const config = data?.config ?? null;
  const counters = data?.counters ?? null;
  const pipeline = data?.pipeline ?? [];
  const activeBatches = useMemo(() => data?.activeBatches ?? [], [data?.activeBatches]);
  const shards = useMemo<SearchOptShardStats[]>(
    () => [...(data?.perShard ?? [])].sort((a, b) => a.shardid - b.shardid),
    [data?.perShard],
  );
  /* Chronological history (oldest → newest) for the money chart. */
  const chartData = useMemo(
    () =>
      [...(data?.history ?? [])]
        .sort((a, b) => new Date(a.t).getTime() - new Date(b.t).getTime())
        .map((p) => ({ clock: fmtClock(p.t), cereri: p.requests, neon: p.fts })),
    [data?.history],
  );

  const loadingFirst = opt.loading && !data;

  return (
    <div className="space-y-5">
      {/* Banner — the FAZA 17 promise: 1000 users → 1 real Neon query. */}
      <Card className="border-emerald-500/25 bg-emerald-500/[0.04]">
        <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:p-5">
          <span
            className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-emerald-500/30 bg-emerald-500/10"
            aria-hidden
          >
            <TrendingDown className="h-5 w-5 text-emerald-400" />
          </span>
          <div>
            <p className="text-sm font-bold text-emerald-200">
              Optimizarea căutării — 1.000 utilizatori, 1 interogare Neon, rezultate 100% reale
            </p>
            <p className="mt-1 text-xs leading-relaxed text-zinc-400">
              Cererile identice sosite în fereastra TTL partajează{' '}
              <span className="font-semibold text-zinc-200">o singură interogare reală FTS</span> (batch),
              iar repetările în {fmtMs(cache?.ttlMs ?? config?.cacheTtlMs)} sunt servite din micro-cache —
              rezultatul stocat este <span className="font-semibold text-zinc-200">exact obiectul produs de
              Neon</span> (nimic fabricat, nimic mai vechi de TTL). Reducerea interogărilor Neon:{' '}
              <span className="font-mono font-bold text-emerald-300">{fmtFactor(dedup?.reductionFactor)}</span>{' '}
              — 10 milioane de utilizatori pot căuta real fără să supraîncarce baza.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Toolbar: live pulse + manual refresh */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-xs text-zinc-500" aria-live="off">
          <span className="relative flex h-2 w-2" aria-hidden>
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
          </span>
          Consolă live — actualizare manuală
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => opt.refetch()}
          aria-label="Reîmprospătează starea optimizării căutării"
          className="border-white/15 bg-white/5 font-semibold hover:bg-white/10"
        >
          {opt.loading ? <RefreshCw className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
          Refresh
        </Button>
      </div>

      {/* Live gauges */}
      {loadingFirst ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-[92px] rounded-xl" />
          ))}
        </div>
      ) : opt.error && !data ? (
        <ErrorState message={opt.error} onRetry={opt.refetch} compact />
      ) : batching && cache && dedup && counters ? (
        <section aria-label="Indicatorii live ai optimizării căutării" className="space-y-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            <GaugeCard
              icon={<Boxes className="h-5 w-5" aria-hidden />}
              label="Batch-uri active"
              value={fmtRoNum(batching.activeBatches)}
              tone={batching.activeBatches > 0 ? 'amber' : 'zinc'}
              sub={`max fan-out văzut ${fmtRoNum(batching.maxFanout)}`}
            />
            <GaugeCard
              icon={<Layers className="h-5 w-5" aria-hidden />}
              label="Batch hits"
              value={fmtRoNum(counters.batchHits)}
              tone="emerald"
              sub="cereri atașate la execuții în curs"
            />
            <GaugeCard
              icon={<Zap className="h-5 w-5" aria-hidden />}
              label="Cache hits"
              value={fmtRoNum(counters.cacheHits)}
              tone="emerald"
              sub={`rată hit ${RO_RATE.format((cache.hitRatio ?? 0) * 100)}%`}
            />
            <GaugeCard
              icon={<CheckCircle2 className="h-5 w-5" aria-hidden />}
              label="Cache misses"
              value={fmtRoNum(counters.cacheMisses)}
              sub={`= interogări reale pornite · ${fmtRoNum(cache.evictions)} evictări`}
            />
            <GaugeCard
              icon={<Database className="h-5 w-5" aria-hidden />}
              label="Interogări Neon"
              value={fmtRoNum(counters.ftsQueries)}
              tone="red"
              sub={`din ${fmtRoNum(counters.served)} cereri servite`}
            />
            <GaugeCard
              icon={<TrendingDown className="h-5 w-5" aria-hidden />}
              label="Reducere"
              value={fmtFactor(dedup.reductionFactor)}
              tone="emerald"
              sub="cereri / interogare Neon reală"
            />
            <GaugeCard
              icon={<Gauge className="h-5 w-5" aria-hidden />}
              label="Dedup total"
              value={fmtRoNum(counters.deduplicatedRequests)}
              tone="emerald"
              sub={`${fmtRoNum(dedup.batchServed)} batch + ${fmtRoNum(dedup.cacheServed)} cache`}
            />
            <GaugeCard
              icon={<Server className="h-5 w-5" aria-hidden />}
              label="Intrări cache"
              value={fmtRoNum(cache.entries)}
              sub={`plafon ${fmtRoNum(cache.maxEntries)} · TTL ${fmtMs(cache.ttlMs)}`}
            />
          </div>
          <p className="flex flex-wrap items-baseline gap-x-4 gap-y-1 rounded-xl border border-white/10 bg-white/[0.02] px-4 py-2.5 font-mono text-[11px] text-zinc-400">
            <span className="font-sans text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
              Status
            </span>
            <span>
              {dedup.active ? 'STRAT ACTIV' : 'DEZACTIVAT'}{' '}
              <span className="text-zinc-600">
                — {fmtRoNum(dedup.served)} cereri servite · {fmtRoNum(dedup.ftsQueries)} interogări Neon ·{' '}
                {fmtRoNum(counters.batchesCreated)} batch-uri create
              </span>
            </span>
            <span>
              ultimul batch: {batching.lastBatchAt ? new Date(batching.lastBatchAt).toLocaleTimeString('ro-RO') : '—'}
            </span>
          </p>
        </section>
      ) : null}

      {/* Pipeline visualization */}
      {pipeline.length > 0 ? <PipelineStrip stages={pipeline} /> : null}

      {/* Config cards */}
      {config ? (
        <section aria-label="Configurația optimizării căutării" className="space-y-3">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-200">
            <SlidersHorizontal className="h-4 w-4 text-emerald-400" aria-hidden />
            Configurație activă
          </h3>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {[
              {
                label: 'Cache TTL',
                value: fmtMs(config.cacheTtlMs),
                sub: 'rezultate reale servite ≤ TTL (pinned 1–5 s)',
              },
              {
                label: 'Intrări cache',
                value: fmtRoNum(config.cacheMax),
                sub: 'plafon cu evictare LRU-ish',
              },
              {
                label: 'Batch-uri max',
                value: fmtRoNum(config.batchMax),
                sub: 'distincte simultane (protectie memorie)',
              },
              {
                label: 'Fan-out max',
                value: fmtRoNum(batching?.maxFanout ?? 0),
                sub: 'cereri partajate într-un singur batch',
              },
              {
                label: 'Strat FAZA 17',
                value: config.enabled ? 'ACTIV' : 'DEZACTIVAT',
                sub: config.enabled
                  ? 'dedup + batching + cache peste coada FAZA 15'
                  : 'fiecare cerere execută propriul FTS',
              },
            ].map((c) => (
              <Card key={c.label} className="border-white/10 bg-white/[0.03]">
                <CardContent className="p-4">
                  <p className="text-lg font-black leading-tight text-white">{c.value}</p>
                  <p className="mt-0.5 text-[11px] font-semibold uppercase tracking-widest text-zinc-500">{c.label}</p>
                  <p className="mt-1 text-[11px] leading-snug text-zinc-600">{c.sub}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      ) : null}

      {/* The money chart: requests served vs REAL Neon queries */}
      <section aria-label="Istoricul optimizării căutării">
        <Card className="border-white/10 bg-white/[0.03]">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <LineChart className="h-4 w-4 text-emerald-400" aria-hidden />
              Cereri vs Interogări Neon (ultimele 3 minute)
            </CardTitle>
            <CardDescription>
              180 eșantioane de 1 s — cereri servite de strat (emerald) vs interogări FTS reale pornite
              către Neon (rose). Diferența dintre cele două arii = căutările servite din batch/cache.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {loadingFirst ? (
              <Skeleton className="h-56 w-full rounded-xl sm:h-64" />
            ) : chartData.length === 0 ? (
              <EmptyState
                title="Fără activitate încă"
                message="Istoricul se populează odată cu primele căutări trecute prin stratul de optimizare."
              />
            ) : (
              <ChartContainer config={OPT_CHART_CONFIG} className="h-56 w-full sm:h-64">
                <AreaChart data={chartData} margin={{ left: 4, right: 8, top: 8, bottom: 0 }}>
                  <defs>
                    <linearGradient id="fillOptRequests" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#10b981" stopOpacity={0.45} />
                      <stop offset="95%" stopColor="#10b981" stopOpacity={0.02} />
                    </linearGradient>
                    <linearGradient id="fillOptFts" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#f43f5e" stopOpacity={0.55} />
                      <stop offset="95%" stopColor="#f43f5e" stopOpacity={0.03} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid vertical={false} stroke="rgba(255,255,255,0.08)" />
                  <XAxis
                    dataKey="clock"
                    tickLine={false}
                    axisLine={false}
                    minTickGap={32}
                    tick={{ fill: '#71717a', fontSize: 11 }}
                  />
                  <YAxis
                    allowDecimals={false}
                    tickLine={false}
                    axisLine={false}
                    width={30}
                    tick={{ fill: '#71717a', fontSize: 11 }}
                  />
                  <ChartTooltip
                    cursor={{ stroke: 'rgba(16,185,129,0.35)' }}
                    content={
                      <ChartTooltipContent
                        className="border-white/10 bg-[#1a1a24] text-zinc-200"
                        indicator="line"
                      />
                    }
                  />
                  <Area
                    dataKey="cereri"
                    type="monotone"
                    stroke="#10b981"
                    strokeWidth={2}
                    fill="url(#fillOptRequests)"
                    dot={false}
                    activeDot={{ r: 4, fill: '#10b981' }}
                  />
                  <Area
                    dataKey="neon"
                    type="monotone"
                    stroke="#f43f5e"
                    strokeWidth={2}
                    fill="url(#fillOptFts)"
                    dot={false}
                    activeDot={{ r: 4, fill: '#f43f5e' }}
                  />
                </AreaChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>
      </section>

      {/* Active batches (live in-flight fan-outs) */}
      {loadingFirst ? (
        <Skeleton className="h-40 w-full rounded-xl" />
      ) : activeBatches.length === 0 ? (
        <EmptyState
          title="Niciun batch în curs"
          message="Batch-urile apar când cereri identice sosesc concomitent — probează 100 de utilizatori căutând același lucru."
        />
      ) : (
        <section aria-label="Batch-uri active în curs" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-200">
              <Boxes className="h-4 w-4 text-amber-400" aria-hidden />
              Batch-uri în curs ({activeBatches.length})
            </h3>
            <span className="font-mono text-[11px] text-zinc-600">
              top 50 după fan-out · o interogare reală per batch
            </span>
          </div>
          <div className="custom-scrollbar max-h-96 overflow-y-auto rounded-xl border border-white/10">
            <Table aria-label="Batch-uri active — cereri identice care partajează o execuție reală">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead scope="col">Query hash</TableHead>
                  <TableHead scope="col">Tip</TableHead>
                  <TableHead scope="col">Descriere</TableHead>
                  <TableHead scope="col">Fan-out</TableHead>
                  <TableHead scope="col">Vârstă</TableHead>
                  <TableHead scope="col">Sharduri</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {activeBatches.map((b) => (
                  <TableRow key={b.queryHash} className="hover:bg-white/[0.03]">
                    <TableCell className="font-mono text-xs text-zinc-300">{b.queryHash}</TableCell>
                    <TableCell className="font-mono text-xs text-zinc-400">{b.kind}</TableCell>
                    <TableCell className="max-w-[16rem] truncate font-mono text-xs text-zinc-400">
                      {b.describe}
                    </TableCell>
                    <TableCell className="font-mono text-xs font-bold text-emerald-300">
                      {fmtRoNum(b.fanout)}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-zinc-400">{fmtMs(b.ageMs)}</TableCell>
                    <TableCell className="font-mono text-xs text-zinc-400">{fmtRoNum(b.shards)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      )}

      {/* Per-shard attribution */}
      {loadingFirst ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full rounded-xl" />
          ))}
        </div>
      ) : opt.error && !data ? (
        <ErrorState message={opt.error} onRetry={opt.refetch} compact />
      ) : shards.length === 0 ? (
        <EmptyState
          title="Fără sharduri"
          message="Backend-ul nu a raportat încă atribuiri per-shard pentru optimizarea căutării."
        />
      ) : (
        <section aria-label="Atribuirea optimizării pe sharduri" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-200">
              <Server className="h-4 w-4 text-emerald-400" aria-hidden />
              Atribuire pe sharduri ({shards.length})
            </h3>
            <span className="font-mono text-[11px] text-zinc-600">
              cereri servite vs interogări Neon pe shard · rândurile cu activitate evidențiate
            </span>
          </div>
          <div className="custom-scrollbar max-h-[32rem] overflow-y-auto rounded-xl border border-white/10">
            <Table aria-label="Atribuirea optimizării căutării pe sharduri — un rând per shard logic">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead scope="col">Shard</TableHead>
                  <TableHead scope="col">Servite</TableHead>
                  <TableHead scope="col">Cache hits</TableHead>
                  <TableHead scope="col">Batch hits</TableHead>
                  <TableHead scope="col">Interogări Neon</TableHead>
                  <TableHead scope="col">Reducere</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shards.map((row) => {
                  const active = row.served > 0;
                  const reduction = row.ftsQueries > 0 ? row.served / row.ftsQueries : 0;
                  return (
                    <TableRow
                      key={row.shardid}
                      className={cn('hover:bg-white/[0.03]', active && 'bg-emerald-500/[0.05]')}
                    >
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Server className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden />
                          <p className="font-mono text-sm font-medium text-zinc-100">#{row.shardid}</p>
                        </div>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-zinc-300">{fmtRoNum(row.served)}</TableCell>
                      <TableCell className="font-mono text-xs text-zinc-400">{fmtRoNum(row.cacheHits)}</TableCell>
                      <TableCell className="font-mono text-xs text-zinc-400">{fmtRoNum(row.batchHits)}</TableCell>
                      <TableCell
                        className={cn('font-mono text-xs', row.ftsQueries > 0 ? 'text-rose-300' : 'text-zinc-600')}
                      >
                        {fmtRoNum(row.ftsQueries)}
                      </TableCell>
                      <TableCell className="font-mono text-xs font-bold text-emerald-300">
                        {reduction >= 1 ? fmtFactor(reduction) : '—'}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </section>
      )}

      {/* Settings (admin only) */}
      {config ? (
        <OptSettingsCard
          config={config}
          isAdmin={!initializing && isAdmin}
          onSaved={() => void opt.refetch()}
        />
      ) : loadingFirst ? (
        <Skeleton className="h-56 w-full rounded-xl" />
      ) : null}
    </div>
  );
}
