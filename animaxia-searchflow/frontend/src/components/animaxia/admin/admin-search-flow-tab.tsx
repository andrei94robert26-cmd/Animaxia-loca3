'use client';

/**
 * admin-search-flow-tab.tsx — FAZA 15 Search Flow Control console: live queue
 * gauges, the rolling queue-length / inflight chart (recharts via the shadcn
 * chart wrapper), the three priority lanes with the anti-starvation aging
 * policy, the 30-row per-shard attribution table and the admin runtime
 * settings form (POST /api/search/flow/settings, Bearer + admin-gated).
 * The banner keeps the FAZA 15 promise visible: searches stay 100% REAL —
 * the queue only schedules the flow towards Neon; the FTS queries themselves
 * are untouched. Public read-only data (GET /api/search/flow); auto-refreshes
 * every 2 s while visible. Deep-linked via #/admin/search-flow.
 */

import { useEffect, useMemo, useState } from 'react';
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import {
  Ban,
  CheckCircle2,
  Gauge as GaugeIcon,
  Hourglass,
  Layers,
  LineChart,
  Lock,
  Network,
  RefreshCw,
  Save,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  TimerOff,
  TrendingUp,
  Waves,
  Zap,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, BACKEND_PORT } from '@/lib/animaxia/api';
import { authRequest, PlatformError } from '@/lib/animaxia/platform';
import { useApi } from '@/lib/animaxia/hooks';
import type {
  SearchFlowConfig,
  SearchFlowControlStatus,
  SearchFlowPriorityKey,
  SearchFlowShardStats,
} from '@/lib/animaxia/types';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
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

/** Live console cadence — /api/search/flow is in-memory and fast. */
const POLL_MS = 2_000;

const RO_NUMBER = new Intl.NumberFormat('ro-RO');
const RO_RATE = new Intl.NumberFormat('ro-RO', { maximumFractionDigits: 2 });

function fmtRoNum(v: number | null | undefined): string {
  return RO_NUMBER.format(Number(v ?? 0));
}

function fmtMs(v: number | null | undefined): string {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n > 0 ? `${RO_NUMBER.format(Math.round(n))} ms` : '—';
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

/** 0-target chip: emerald „0 țintă" while the counter is 0 (the QA target),
 *  red the moment anything was actually rejected. */
function TargetValue({ value }: { value: number }) {
  return value > 0 ? (
    <span className="inline-flex items-center rounded-full border border-red-500/30 bg-red-500/10 px-2.5 py-0.5 font-mono text-base font-bold text-red-300">
      {fmtRoNum(value)}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 font-mono text-base font-bold text-emerald-300">
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden />
      0 țintă
    </span>
  );
}

/* -------------------------------- chart ---------------------------------- */

const FLOW_CHART_CONFIG = {
  coada: { label: 'În coadă', color: '#f59e0b' },
  executii: { label: 'În execuție', color: '#10b981' },
} satisfies ChartConfig;

/* ------------------------------ priorities ------------------------------- */

const PRIORITY_META: { key: SearchFlowPriorityKey; label: string; cls: string; card: string }[] = [
  {
    key: 'high',
    label: 'HIGH',
    cls: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
    card: 'border-amber-500/30',
  },
  {
    key: 'normal',
    label: 'NORMAL',
    cls: 'border-zinc-500/30 bg-zinc-500/10 text-zinc-300',
    card: 'border-white/10',
  },
  {
    key: 'low',
    label: 'LOW',
    cls: 'border-white/10 bg-white/[0.04] text-zinc-500',
    card: 'border-white/10 bg-white/[0.02]',
  },
];

function PriorityCard({
  meta,
  fc,
}: {
  meta: (typeof PRIORITY_META)[number];
  fc: SearchFlowControlStatus;
}) {
  const inQueue = fc.priorities?.[meta.key] ?? 0;
  const processed = fc.processedByPriority?.[meta.key] ?? 0;
  const waitP50 = fc.waitP50ByPriority?.[meta.key] ?? 0;
  const dropped = fc.droppedByPriority?.[meta.key] ?? 0;
  const policy = fc.priorityPolicy?.[meta.key];

  return (
    <Card className={cn('bg-white/[0.03]', meta.card)}>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm text-zinc-200">
          <span
            className={cn(
              'rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold tracking-wider',
              meta.cls,
            )}
          >
            {meta.label}
          </span>
          <span className="font-mono text-lg font-black text-white">{fmtRoNum(inQueue)}</span>
          <span className="text-[11px] font-normal text-zinc-500">în coadă acum</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1.5">
        <p className="font-mono text-xs text-zinc-300">
          Procesate: <span className="text-white">{fmtRoNum(processed)}</span>
        </p>
        <p className="font-mono text-xs text-zinc-300">
          Wait p50: <span className="text-white">{fmtMs(waitP50)}</span>
        </p>
        {dropped > 0 ? (
          <p className="font-mono text-xs text-red-300">Respinse: {fmtRoNum(dropped)}</p>
        ) : null}
        {policy ? (
          <p className="border-t border-white/5 pt-1.5 text-[11px] leading-snug text-zinc-500">{policy}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

/* ---------------------------- settings form ------------------------------ */

const SETTINGS_FIELDS = [
  { key: 'maxConcurrent', label: 'Max concurrent', hint: '1 – 2.000', min: 1, max: 2000 },
  { key: 'intervalMs', label: 'Interval fereastră', hint: '10 – 2.000 ms', min: 10, max: 2000 },
  { key: 'batchSize', label: 'Batch size', hint: '1 – 1.000', min: 1, max: 1000 },
  { key: 'queueCap', label: 'Queue cap', hint: '100 – 500.000', min: 100, max: 500000 },
] as const;

type SettingsKey = (typeof SETTINGS_FIELDS)[number]['key'];
type SettingsForm = Record<SettingsKey, string>;

function FlowSettingsCard({
  config,
  isAdmin,
  onSaved,
}: {
  config: SearchFlowConfig;
  isAdmin: boolean;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<SettingsForm>({
    maxConcurrent: String(config.maxConcurrent),
    intervalMs: String(config.intervalMs),
    batchSize: String(config.batchSize),
    queueCap: String(config.queueCap),
  });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  /* Re-sync the pre-filled inputs from the polled config while the user has
     not edited anything (and right after a successful save). */
  useEffect(() => {
    if (dirty) return;
    setForm((prev) => {
      const next: SettingsForm = {
        maxConcurrent: String(config.maxConcurrent),
        intervalMs: String(config.intervalMs),
        batchSize: String(config.batchSize),
        queueCap: String(config.queueCap),
      };
      return (Object.keys(next) as SettingsKey[]).every((k) => prev[k] === next[k]) ? prev : next;
    });
  }, [config, dirty]);

  async function handleSave() {
    if (saving) return;
    const parsed: Record<SettingsKey, number> = {
      maxConcurrent: Number(form.maxConcurrent),
      intervalMs: Number(form.intervalMs),
      batchSize: Number(form.batchSize),
      queueCap: Number(form.queueCap),
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
      await authRequest<{ ok: boolean; config: SearchFlowConfig }>(
        `/api/search/flow/settings?XTransformPort=${BACKEND_PORT}`,
        { method: 'POST', body: JSON.stringify(parsed) },
      );
      toast.success('Setări salvate');
      setDirty(false);
      onSaved();
    } catch (e) {
      if (e instanceof PlatformError && (e.status === 401 || e.status === 403)) {
        toast.error('Setările fluxului necesită cont de administrator');
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
          <ShieldCheck className="h-4 w-4 text-rose-400" aria-hidden />
          Setări runtime (administrator)
        </CardTitle>
        <CardDescription>
          Reglare live a cozii și a ferestrelor de dispatch — se aplică imediat, fără restart.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isAdmin ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {SETTINGS_FIELDS.map((f) => (
                <div key={f.key} className="space-y-1.5">
                  <Label htmlFor={`flow-setting-${f.key}`} className="text-xs text-zinc-400">
                    {f.label} <span className="font-normal text-zinc-600">({f.hint})</span>
                  </Label>
                  <Input
                    id={`flow-setting-${f.key}`}
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
                Validarea și limitarea valorilor (clamping) se fac pe server — valorile finale sunt cele
                returnate după salvare și reflectate mai sus în cardurile de configurare.
              </p>
              <Button
                size="sm"
                onClick={() => void handleSave()}
                disabled={saving || !dirty}
                className="bg-rose-600 font-bold hover:bg-rose-500"
              >
                {saving ? <RefreshCw className="animate-spin" aria-hidden /> : <Save aria-hidden />}
                Salvează
              </Button>
            </div>
          </>
        ) : (
          <p className="flex items-center gap-2 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-4 py-2.5 text-xs text-amber-200">
            <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden />
            Setările fluxului necesită cont de administrator — valorile curente sunt read-only.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/* -------------------------------- main tab -------------------------------- */

export function AdminSearchFlowTab() {
  const { isAdmin, initializing } = useAuth();
  const flow = useApi('admin-search-flow', () => api.searchFlow());

  /* Auto-refresh every 2 s while mounted (pause when the tab is hidden). */
  useEffect(() => {
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void flow.refetch();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [flow.refetch]);

  const data = flow.data;
  const fc = data?.flowControl ?? null;
  const windowing = data?.windowing ?? null;
  const config = data?.config ?? null;
  const shards = useMemo<SearchFlowShardStats[]>(
    () => [...(data?.perShard ?? [])].sort((a, b) => a.shardid - b.shardid),
    [data?.perShard],
  );
  /* Chronological history (oldest → newest) for the area chart. */
  const chartData = useMemo(
    () =>
      [...(data?.history ?? [])]
        .sort((a, b) => new Date(a.t).getTime() - new Date(b.t).getTime())
        .map((p) => ({ clock: fmtClock(p.t), coada: p.queueLength, executii: p.inflight })),
    [data?.history],
  );

  const loadingFirst = flow.loading && !data;

  return (
    <div className="space-y-5">
      {/* Banner — the FAZA 15 promise: the queue never fakes a search. */}
      <Card className="border-emerald-500/25 bg-emerald-500/[0.04]">
        <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:p-5">
          <span
            className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-emerald-500/30 bg-emerald-500/10"
            aria-hidden
          >
            <Waves className="h-5 w-5 text-emerald-400" />
          </span>
          <div>
            <p className="text-sm font-bold text-emerald-200">
              Controlul fluxului de căutări — căutările rămân 100% reale
            </p>
            <p className="mt-1 text-xs leading-relaxed text-zinc-400">
              Coada doar programează fluxul către Neon: interogările FTS rămân byte-identice cu FAZA 14,
              rezultatele nu se schimbă — doar admission-ul și programarea execuției sunt reglate, ca Neon
              să vadă un flux controlat pe ferestre, nu vârfuri. Priorități:{' '}
              <span className="font-semibold text-amber-300">high</span> = admin / ops / QA (header
              X-Animaxia-Priority), <span className="font-semibold text-zinc-200">normal</span> = utilizatori
              logați, <span className="text-zinc-400">low</span> = anonimi — cu îmbătrânire
              anti-înfometare: low → normal după 2 s, normal → high după 5 s.
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
          Consolă live — auto-refresh la 2 s
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => flow.refetch()}
          aria-label="Reîmprospătează starea fluxului de căutare"
          className="border-white/15 bg-white/5 font-semibold hover:bg-white/10"
        >
          {flow.loading ? <RefreshCw className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
          Refresh
        </Button>
      </div>

      {/* Live gauges */}
      {loadingFirst ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 7 }).map((_, i) => (
            <Skeleton key={i} className="h-[92px] rounded-xl" />
          ))}
        </div>
      ) : flow.error && !data ? (
        <ErrorState message={flow.error} onRetry={flow.refetch} compact />
      ) : fc ? (
        <section aria-label="Indicatori live ai cozii de căutare" className="space-y-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            <GaugeCard
              icon={<Hourglass className="h-5 w-5" aria-hidden />}
              label="Coadă"
              value={fmtRoNum(fc.queueLength)}
              tone={fc.queueLength > 0 ? 'amber' : 'zinc'}
              sub={`capacitate ${fmtRoNum(fc.queueCap)}`}
            />
            <GaugeCard
              icon={<Zap className="h-5 w-5" aria-hidden />}
              label="În execuție"
              value={
                <>
                  {fmtRoNum(fc.inflight)}
                  <span className="text-sm font-bold text-zinc-500"> / {fmtRoNum(fc.maxConcurrent)}</span>
                </>
              }
              tone={fc.inflight > 0 ? 'amber' : 'zinc'}
              sub={`max observat ${fmtRoNum(fc.maxInflightSeen)} simultan`}
            />
            <GaugeCard
              icon={<Ban className="h-5 w-5" aria-hidden />}
              label="Respinate"
              value={<TargetValue value={fc.dropped} />}
              tone={fc.dropped > 0 ? 'red' : 'emerald'}
              sub="coadă plină → 503 explicit"
            />
            <GaugeCard
              icon={<TimerOff className="h-5 w-5" aria-hidden />}
              label="Expirate"
              value={<TargetValue value={fc.timedOut} />}
              tone={fc.timedOut > 0 ? 'red' : 'emerald'}
              sub={`wait > ${fmtRoNum(fc.maxWaitMs)} ms → 504`}
            />
            <GaugeCard
              icon={<CheckCircle2 className="h-5 w-5" aria-hidden />}
              label="Procesate"
              value={fmtRoNum(fc.processed)}
              tone="emerald"
              sub={`rată ${RO_RATE.format(fc.processingRate)} / s`}
            />
            <GaugeCard
              icon={<GaugeIcon className="h-5 w-5" aria-hidden />}
              label="Wait p50 / p95"
              value={
                <>
                  {fmtRoNum(Math.round(fc.waitP50Ms))}
                  <span className="text-sm font-bold text-zinc-500"> / {fmtRoNum(Math.round(fc.waitP95Ms))}</span>
                </>
              }
              sub="timp de așteptare în coadă (ms)"
            />
            <GaugeCard
              icon={<TrendingUp className="h-5 w-5" aria-hidden />}
              label="Queue high-water"
              value={fmtRoNum(fc.queueHighWater)}
              tone={fc.queueHighWater > 0 ? 'amber' : 'zinc'}
              sub="maximul istoric al cozii"
            />
          </div>
          {windowing ? (
            <p className="flex flex-wrap items-baseline gap-x-4 gap-y-1 rounded-xl border border-white/10 bg-white/[0.02] px-4 py-2.5 font-mono text-[11px] text-zinc-400">
              <span className="font-sans text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
                Windowing
              </span>
              <span>
                {fmtRoNum(windowing.windowsFired)} <span className="text-zinc-600">ferestre declanșate</span>
              </span>
              <span>
                {fmtRoNum(windowing.windowDispatches)} <span className="text-zinc-600">dispatch-uri</span>
              </span>
              <span>
                medie {RO_RATE.format(windowing.avgBatchSize)} <span className="text-zinc-600">intrări / fereastră</span>
              </span>
              <span>
                max {fmtRoNum(windowing.maxDispatchPerWindow)} <span className="text-zinc-600">/ fereastră</span>
              </span>
            </p>
          ) : null}
        </section>
      ) : null}

      {/* Config cards */}
      {config ? (
        <section aria-label="Configurația fluxului de căutare" className="space-y-3">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-200">
            <SlidersHorizontal className="h-4 w-4 text-rose-400" aria-hidden />
            Configurație activă
          </h3>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {[
              { label: 'Max concurrent', value: fmtRoNum(config.maxConcurrent), sub: 'execuții simultane admise' },
              { label: 'Interval fereastră', value: `${fmtRoNum(config.intervalMs)} ms`, sub: 'cadența timerului de dispatch' },
              { label: 'Batch size', value: fmtRoNum(config.batchSize), sub: 'intrări noi per fereastră' },
              { label: 'Queue cap', value: fmtRoNum(config.queueCap), sub: 'peste → 503 explicit' },
              { label: 'Max wait', value: `${fmtRoNum(config.maxWaitMs)} ms`, sub: 'peste → 504 explicit' },
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

      {/* Chart: queue length + inflight over the rolling history */}
      <section aria-label="Istoricul cozii de căutare">
        <Card className="border-white/10 bg-white/[0.03]">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <LineChart className="h-4 w-4 text-rose-400" aria-hidden />
              Lungime coadă &amp; execuții (ultimele 3 minute)
            </CardTitle>
            <CardDescription>
              180 eșantioane de 1 s — în coadă (amber) și în execuție (emerald).
            </CardDescription>
          </CardHeader>
          <CardContent>
            {loadingFirst ? (
              <Skeleton className="h-56 w-full rounded-xl sm:h-64" />
            ) : chartData.length === 0 ? (
              <EmptyState
                title="Fără activitate încă"
                message="Istoricul se populează odată cu primele căutări trecute prin coadă."
              />
            ) : (
              <ChartContainer config={FLOW_CHART_CONFIG} className="h-56 w-full sm:h-64">
                <AreaChart data={chartData} margin={{ left: 4, right: 8, top: 8, bottom: 0 }}>
                  <defs>
                    <linearGradient id="fillFlowQueue" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.45} />
                      <stop offset="95%" stopColor="#f59e0b" stopOpacity={0.02} />
                    </linearGradient>
                    <linearGradient id="fillFlowInflight" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#10b981" stopOpacity={0.45} />
                      <stop offset="95%" stopColor="#10b981" stopOpacity={0.02} />
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
                    cursor={{ stroke: 'rgba(245,158,11,0.35)' }}
                    content={
                      <ChartTooltipContent
                        className="border-white/10 bg-[#1a1a24] text-zinc-200"
                        indicator="line"
                      />
                    }
                  />
                  <Area
                    dataKey="coada"
                    type="monotone"
                    stroke="#f59e0b"
                    strokeWidth={2}
                    fill="url(#fillFlowQueue)"
                    dot={false}
                    activeDot={{ r: 4, fill: '#f59e0b' }}
                  />
                  <Area
                    dataKey="executii"
                    type="monotone"
                    stroke="#10b981"
                    strokeWidth={2}
                    fill="url(#fillFlowInflight)"
                    dot={false}
                    activeDot={{ r: 4, fill: '#10b981' }}
                  />
                </AreaChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>
      </section>

      {/* Priorities */}
      {fc ? (
        <section aria-label="Prioritățile cozii de căutare" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-200">
              <Layers className="h-4 w-4 text-rose-400" aria-hidden />
              Priorități
            </h3>
            {fc.priorityPolicy?.aging ? (
              <span
                title="Anti-starvation: intrările vechi sunt promovate automat"
                className="rounded-full border border-white/10 bg-white/5 px-2.5 py-0.5 font-mono text-[10px] text-zinc-400"
              >
                aging: {fc.priorityPolicy.aging}
              </span>
            ) : null}
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            {PRIORITY_META.map((meta) => (
              <PriorityCard key={meta.key} meta={meta} fc={fc} />
            ))}
          </div>
        </section>
      ) : null}

      {/* Per-shard attribution */}
      {loadingFirst ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full rounded-xl" />
          ))}
        </div>
      ) : flow.error && !data ? (
        <ErrorState message={flow.error} onRetry={flow.refetch} compact />
      ) : shards.length === 0 ? (
        <EmptyState
          title="Fără sharduri"
          message="Backend-ul nu a raportat încă atribuiri per-shard pentru fluxul de căutare."
        />
      ) : (
        <section aria-label="Atribuirea fluxului de căutare pe sharduri" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-200">
              <Network className="h-4 w-4 text-rose-400" aria-hidden />
              Atribuire pe sharduri ({shards.length})
            </h3>
            <span className="font-mono text-[11px] text-zinc-600">
              rândurile cu activitate sunt evidențiate în amber · respingerile în roșu
            </span>
          </div>
          <div className="custom-scrollbar max-h-[32rem] overflow-y-auto rounded-xl border border-white/10">
            <Table aria-label="Atribuirea cozii de căutare pe sharduri — un rând per shard logic">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead scope="col">Shard</TableHead>
                  <TableHead scope="col">În coadă</TableHead>
                  <TableHead scope="col">În execuție</TableHead>
                  <TableHead scope="col">Procesate</TableHead>
                  <TableHead scope="col">Respinate</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shards.map((row) => {
                  const active = row.queueLength > 0 || row.inflight > 0;
                  const failed = row.dropped > 0;
                  return (
                    <TableRow
                      key={row.shardid}
                      className={cn(
                        'hover:bg-white/[0.03]',
                        active && !failed && 'bg-amber-500/[0.06]',
                        failed && 'bg-red-500/[0.07]',
                      )}
                    >
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Server className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden />
                          <p className="font-mono text-sm font-medium text-zinc-100">#{row.shardid}</p>
                        </div>
                      </TableCell>
                      <TableCell
                        className={cn('font-mono text-xs', row.queueLength > 0 ? 'text-amber-300' : 'text-zinc-500')}
                      >
                        {fmtRoNum(row.queueLength)}
                      </TableCell>
                      <TableCell
                        className={cn('font-mono text-xs', row.inflight > 0 ? 'text-amber-300' : 'text-zinc-500')}
                      >
                        {fmtRoNum(row.inflight)}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-zinc-300">{fmtRoNum(row.processed)}</TableCell>
                      <TableCell
                        className={cn('font-mono text-xs', row.dropped > 0 ? 'text-red-300' : 'text-zinc-600')}
                      >
                        {fmtRoNum(row.dropped)}
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
        <FlowSettingsCard
          config={config}
          isAdmin={!initializing && isAdmin}
          onSaved={() => void flow.refetch()}
        />
      ) : loadingFirst ? (
        <Skeleton className="h-56 w-full rounded-xl" />
      ) : null}
    </div>
  );
}
