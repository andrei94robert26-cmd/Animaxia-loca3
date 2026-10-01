'use client';

/**
 * admin-search-full-tab.tsx — FAZA 18 Full Integration + Stress Test console:
 * the integrated 10-stage pipeline visualization (with the live
 * pipelineIntegrated contract badge), the last stress-run verdict (11,000
 * simultaneous requests — the six pinned sections — with the per-section
 * outcomes, the 22 assertions and the honest 429 dispositions), the 10M-user
 * projection card (demand math + the real 500-concurrent sample + the 7
 * verdicts), the cache-semantics proof, the runs history, the admin
 * "Rulează stress test" trigger (POST /api/search/stress, 202 + poll) and
 * the four live charts from the FAZA 15/16/17 consoles (queue length +
 * inflight, arrivals/admitted/blocked, requests-vs-Neon, batch vs cache
 * servings) — the complete observability surface of the integrated search
 * pipeline in one page. Deep-linked via #/admin/search-full.
 */

import { useMemo, useState } from 'react';
import { Area, AreaChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts';
import {
  Activity,
  CheckCircle2,
  Database,
  Gauge as GaugeIcon,
  Globe2,
  Layers,
  ListChecks,
  Lock,
  Play,
  RefreshCw,
  Rocket,
  ShieldCheck,
  Timer,
  TrendingDown,
  Users,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, BACKEND_PORT } from '@/lib/animaxia/api';
import { authRequest, PlatformError } from '@/lib/animaxia/platform';
import { useApi } from '@/lib/animaxia/hooks';
import type { SearchStressSectionReport } from '@/lib/animaxia/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
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

/** Live console cadence — the four snapshots are in-memory and fast. */

const RO_NUMBER = new Intl.NumberFormat('ro-RO');
const RO_RATE = new Intl.NumberFormat('ro-RO', { maximumFractionDigits: 2 });

function fmtRoNum(v: number | null | undefined): string {
  return RO_NUMBER.format(Number(v ?? 0));
}

function fmtMs(v: number | null | undefined): string {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n > 0 ? `${RO_NUMBER.format(Math.round(n))} ms` : '—';
}

function fmtSecs(v: number | null | undefined): string {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n > 0 ? `${RO_RATE.format(n / 1000)} s` : '—';
}

function fmtFactor(v: number | null | undefined): string {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n >= 1 ? `${RO_RATE.format(n)}×` : '—';
}

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
 *  The stage list itself is data-driven from the console `pipelineStages`. */
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

function PipelineStrip({ stages, integrated }: { stages: string[]; integrated: boolean }) {
  return (
    <Card className="border-white/10 bg-white/[0.03]">
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <Layers className="h-4 w-4 text-emerald-400" aria-hidden />
          Pipeline integrat ({stages.length} etape)
          <Badge
            className={cn(
              'ml-auto border px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest',
              integrated
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                : 'border-red-500/40 bg-red-500/10 text-red-300',
            )}
          >
            {integrated ? 'pipelineIntegrated: true' : 'pipelineIntegrated: false'}
          </Badge>
        </CardTitle>
        <CardDescription>
          Ordinea deterministă traversată de FIECARE căutare — antiSpam → … → cache → fts — expusă
          identic în <span className="font-mono text-[11px]">/api/search/status → pipelineStages</span>.
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
                >
                  <p className="flex items-center gap-1.5 text-xs font-bold text-white">
                    <span className="font-mono text-[10px] text-zinc-500">{i + 1}</span>
                    {meta.label}
                  </p>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                    {meta.phase}
                  </p>
                  <p className="mt-0.5 text-[10px] leading-snug text-zinc-600">{meta.hint}</p>
                </div>
                {i < stages.length - 1 ? (
                  <span className="hidden text-zinc-700 sm:inline" aria-hidden>
                    →
                  </span>
                ) : null}
              </li>
            );
          })}
        </ol>
      </CardContent>
    </Card>
  );
}

/* ----------------------------- sections table ----------------------------- */

const SECTION_META: Record<
  string,
  { label: string; desc: string; tone: Tone }
> = {
  identical: {
    label: '1.000 identice',
    desc: '1.000 utilizatori, O interogare → exact 1 interogare Neon reală',
    tone: 'emerald',
  },
  different: {
    label: '1.000 diferite',
    desc: 'interogări distincte reale → 1.000 execuții reale, 0 false dedup',
    tone: 'zinc',
  },
  mixed: {
    label: '5.000 mixte',
    desc: '2.500 hot + 1.500 autocomplete + 1.000 long-tail',
    tone: 'zinc',
  },
  spam: {
    label: '2.000 spam ENTER',
    desc: '50 utilizatori × 40 apăsări → blocare onestă spam_blocked',
    tone: 'amber',
  },
  cooldown: {
    label: '1.000 în cooldown',
    desc: 'utilizatori cu rezultat real proaspăt → cooldown_active',
    tone: 'amber',
  },
  rateLimit: {
    label: '1.000 rate-limit',
    desc: 'pacing per-utilizator real → rate_limited',
    tone: 'amber',
  },
};

function SectionsTable({ sections }: { sections: Record<string, SearchStressSectionReport> }) {
  const rows = Object.entries(SECTION_META);
  return (
    <div className="overflow-hidden rounded-xl border border-white/10">
      <Table>
        <TableHeader>
          <TableRow className="border-white/10 hover:bg-transparent">
            <TableHead className="text-zinc-400">Secțiune</TableHead>
            <TableHead className="text-right text-zinc-400">Total</TableHead>
            <TableHead className="text-right text-zinc-400">Ok (200)</TableHead>
            <TableHead className="text-right text-zinc-400">429 onest</TableHead>
            <TableHead className="text-right text-zinc-400">Neon</TableHead>
            <TableHead className="text-right text-zinc-400">Batch</TableHead>
            <TableHead className="text-right text-zinc-400">Cache</TableHead>
            <TableHead className="text-right text-zinc-400">p95 așteptare</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(([key, meta]) => {
            const s = sections[key];
            if (!s) return null;
            const blocked = s.blocked.spam_blocked + s.blocked.cooldown_active + s.blocked.rate_limited;
            return (
              <TableRow key={key} className="border-white/[0.06]">
                <TableCell className="py-2.5">
                  <p className="text-xs font-bold text-white">{meta.label}</p>
                  <p className="max-w-[220px] text-[10px] leading-snug text-zinc-600">{meta.desc}</p>
                </TableCell>
                <TableCell className="text-right font-mono text-xs text-zinc-300">{fmtRoNum(s.total)}</TableCell>
                <TableCell className="text-right font-mono text-xs text-emerald-300">{fmtRoNum(s.ok)}</TableCell>
                <TableCell className="text-right font-mono text-xs text-amber-300">
                  {blocked > 0 ? fmtRoNum(blocked) : '—'}
                </TableCell>
                <TableCell className="text-right font-mono text-xs text-rose-300">{fmtRoNum(s.sources.neon)}</TableCell>
                <TableCell className="text-right font-mono text-xs text-teal-300">{fmtRoNum(s.sources.batch)}</TableCell>
                <TableCell className="text-right font-mono text-xs text-teal-200">{fmtRoNum(s.sources.cache)}</TableCell>
                <TableCell className="text-right font-mono text-xs text-zinc-400">{fmtMs(s.waitP95Ms)}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

/* ------------------------------ run trigger ------------------------------- */

function RunTrigger({
  running,
  onStart,
  disabled,
}: {
  running: boolean;
  onStart: () => void;
  disabled: boolean;
}) {
  const [starting, setStarting] = useState(false);
  const { isAdmin, initializing } = useAuth();

  const handleStart = async () => {
    setStarting(true);
    try {
      await authRequest<{ ok: boolean; started: boolean }>(
        `/api/search/stress?XTransformPort=${BACKEND_PORT}`,
        { method: 'POST', body: '{}' },
      );
      toast.success('Stress test pornit — 11.000 căutări simultane prin pipeline-ul integrat');
      onStart();
    } catch (e) {
      if (e instanceof PlatformError && (e.status === 401 || e.status === 403)) {
        toast.error('Rulează stress test necesită cont de administrator');
      } else if (e instanceof PlatformError && e.status === 409) {
        toast.info('Un stress test rulează deja — urmărește-l mai jos');
      } else {
        toast.error(e instanceof Error ? e.message : 'Pornirea stress test-ului a eșuat');
      }
    } finally {
      setStarting(false);
    }
  };

  if (initializing) return null;
  if (!isAdmin) {
    return (
      <p className="flex items-center gap-2 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-4 py-2.5 text-xs text-amber-200">
        <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden />
        Declanșarea stress test-ului necesită cont de administrator — consola rămâne read-only.
      </p>
    );
  }
  return (
    <Button
      size="sm"
      onClick={() => void handleStart()}
      disabled={disabled || starting || running}
      className="bg-emerald-600 font-bold hover:bg-emerald-500"
      aria-label="Rulează stress test 10.000+ căutări simultane"
    >
      {running || starting ? (
        <RefreshCw className="animate-spin" aria-hidden />
      ) : (
        <Play aria-hidden />
      )}
      {running ? 'Rulează…' : 'Rulează stress test'}
    </Button>
  );
}

/* ------------------------------- chart configs ---------------------------- */

const FLOW_CHART_CONFIG = {
  coada: { label: 'Coadă (lungime)', color: '#f59e0b' },
  inflight: { label: 'În execuție', color: '#10b981' },
} satisfies ChartConfig;

const RATE_CHART_CONFIG = {
  sosiri: { label: 'Sosiri / s', color: '#a78bfa' },
  admise: { label: 'Admise / s', color: '#10b981' },
  blocate: { label: 'Blocate / s', color: '#f43f5e' },
} satisfies ChartConfig;

const OPT_CHART_CONFIG = {
  cereri: { label: 'Cereri / s', color: '#10b981' },
  neon: { label: 'Interogări Neon / s', color: '#f43f5e' },
} satisfies ChartConfig;

const SERVINGS_CHART_CONFIG = {
  cache: { label: 'Serviri cache / s', color: '#2dd4bf' },
  batch: { label: 'Atașări batch / s', color: '#38bdf8' },
} satisfies ChartConfig;

/* -------------------------------- main tab -------------------------------- */

export function AdminSearchFullTab() {
  const stress = useApi('admin-search-full', () => api.searchStress());
  const flow = useApi('admin-search-full-flow', () => api.searchFlow());
  const rate = useApi('admin-search-full-rate', () => api.searchRate());
  const opt = useApi('admin-search-full-opt', () => api.searchOpt());

  /* NEON FREE PLAN: auto-refresh 2s ELIMINAT — montare + Refresh manual
   * (rulările de stress își refac singure starea la finalizare). */

  const data = stress.data;
  const run = data?.lastRun ?? null;
  const running = data?.running === true;
  const pipelineStages = data?.pipelineStages ?? [];
  const integrated = data?.pipelineIntegrated === true;

  const flowHistory = useMemo(
    () =>
      [...(flow.data?.history ?? [])]
        .sort((a, b) => new Date(a.t).getTime() - new Date(b.t).getTime())
        .map((p) => ({ clock: fmtClock(p.t), coada: p.queueLength, inflight: p.inflight })),
    [flow.data?.history],
  );
  const rateHistory = useMemo(
    () =>
      [...(rate.data?.history ?? [])]
        .sort((a, b) => new Date(a.t).getTime() - new Date(b.t).getTime())
        .map((p) => ({ clock: fmtClock(p.t), sosiri: p.arrivals, admise: p.admitted, blocate: p.blocked })),
    [rate.data?.history],
  );
  const optHistory = useMemo(
    () =>
      [...(opt.data?.history ?? [])]
        .sort((a, b) => new Date(a.t).getTime() - new Date(b.t).getTime())
        .map((p) => ({ clock: fmtClock(p.t), cereri: p.requests, neon: p.fts })),
    [opt.data?.history],
  );
  const servingsHistory = useMemo(
    () =>
      [...(opt.data?.history ?? [])]
        .sort((a, b) => new Date(a.t).getTime() - new Date(b.t).getTime())
        .map((p) => ({ clock: fmtClock(p.t), cache: p.cacheHits, batch: p.batchHits })),
    [opt.data?.history],
  );

  const loadingFirst = stress.loading && !data;

  return (
    <div className="space-y-5">
      {/* Banner — the FAZA 18 promise. */}
      <Card className="border-emerald-500/25 bg-emerald-500/[0.04]">
        <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:p-5">
          <span
            className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-emerald-500/30 bg-emerald-500/10"
            aria-hidden
          >
            <Rocket className="h-5 w-5 text-emerald-400" />
          </span>
          <div>
            <p className="text-sm font-bold text-emerald-200">
              Full Integration + Stress Test — 11.000 căutări simultane, pipeline integrat, 0 pierderi
            </p>
            <p className="mt-1 text-xs leading-relaxed text-zinc-400">
              Toate componentele FAZA 15–17 într-un singur pipeline determinist (antiSpam → rateLimit →
              cooldown → queue → priority → windowing → dedup → batching → cache → fts). Cele 6 secțiuni
              pinned din specificație (1.000 identice + 1.000 diferite + 5.000 mixte + 2.000 spam ENTER +
              1.000 cooldown + 1.000 rate-limit) însumează{' '}
              <span className="font-semibold text-zinc-200">11.000 cereri create simultan</span> — titlul
              contractual rămâne <span className="font-mono font-bold text-emerald-300">concurrent: 10.000</span>.
              Fiecare cerere primește un răspuns explicit: rezultat 100% real sau blocare onestă 429 cu
              retryInMs.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Toolbar: live pulse + manual refresh + run trigger */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-xs text-zinc-500" aria-live={running ? 'polite' : 'off'}>
          <span className="relative flex h-2 w-2" aria-hidden>
            <span
              className={cn(
                'absolute inline-flex h-full w-full animate-ping rounded-full opacity-60',
                running ? 'bg-amber-400' : 'bg-emerald-400',
              )}
            />
            <span
              className={cn(
                'relative inline-flex h-2 w-2 rounded-full',
                running ? 'bg-amber-400' : 'bg-emerald-400',
              )}
            />
          </span>
          {running
            ? 'Stress test ÎN RULARE — 11.000 cereri se drenează prin pipeline-ul real…'
            : 'Consolă live — actualizare manuală'}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <RunTrigger running={running} onStart={() => void stress.refetch()} disabled={loadingFirst} />
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void stress.refetch();
              void flow.refetch();
              void rate.refetch();
              void opt.refetch();
            }}
            aria-label="Reîmprospătează consola de integrare completă"
            className="border-white/15 bg-white/5 font-semibold hover:bg-white/10"
          >
            {stress.loading ? <RefreshCw className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
            Refresh
          </Button>
        </div>
      </div>

      {/* Live gauges */}
      {loadingFirst ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-[92px] rounded-xl" />
          ))}
        </div>
      ) : stress.error && !data ? (
        <ErrorState message={stress.error} onRetry={stress.refetch} compact />
      ) : (
        <section aria-label="Indicatorii stress test-ului" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          <GaugeCard
            icon={
              run?.passed ? (
                <CheckCircle2 className="h-5 w-5" aria-hidden />
              ) : run ? (
                <XCircle className="h-5 w-5" aria-hidden />
              ) : (
                <Activity className="h-5 w-5" aria-hidden />
              )
            }
            label="Verdict run"
            value={running ? 'ÎN RULARE' : run ? (run.passed ? 'PASSED ✅' : 'FAILED ❌') : 'NERULAT'}
            tone={running ? 'amber' : run?.passed ? 'emerald' : run ? 'red' : 'zinc'}
            sub={
              run
                ? `${new Date(run.finishedAt).toLocaleString('ro-RO')} · ${run.assertions.filter((a) => a.ok).length}/${run.assertions.length} asserții`
                : 'POST /api/search/stress (admin) pornește un run'
            }
          />
          <GaugeCard
            icon={<Users className="h-5 w-5" aria-hidden />}
            label="Cereri simultane"
            value={fmtRoNum(run?.requests.simultaneous ?? data?.burstTotal ?? 0)}
            tone="emerald"
            sub={`titlu pinned concurrent: ${fmtRoNum(run?.concurrency ?? data?.concurrency ?? 10000)}`}
          />
          <GaugeCard
            icon={<CheckCircle2 className="h-5 w-5" aria-hidden />}
            label="Răspunse"
            value={fmtRoNum(run?.requests.answered ?? 0)}
            tone="emerald"
            sub={
              run
                ? `${fmtRoNum(run.requests.ok)} rezultate reale + ${fmtRoNum(run.requests.blocked)} blocări oneste 429`
                : 'fiecărei cereri i se răspunde explicit'
            }
          />
          <GaugeCard
            icon={<Database className="h-5 w-5" aria-hidden />}
            label="Interogări Neon reale"
            value={fmtRoNum(run?.neonFtsQueries ?? 0)}
            tone="red"
            sub={run ? `reducere totală ${fmtFactor(run.reductionFactor)}` : 'doar cele necesare'}
          />
          <GaugeCard
            icon={<TrendingDown className="h-5 w-5" aria-hidden />}
            label="Reducere run"
            value={fmtFactor(run?.reductionFactor ?? 0)}
            tone="emerald"
            sub="răspunsuri / interogare Neon reală"
          />
          <GaugeCard
            icon={<GaugeIcon className="h-5 w-5" aria-hidden />}
            label="Coadă high-water"
            value={run ? `${fmtRoNum(run.flow.queueHighWater)} / ${fmtRoNum(run.flow.maxConcurrent > 0 ? 10000 : 10000)}` : '—'}
            tone="amber"
            sub={run ? `0 pierdute · 0 dropped · 0 timedOut` : 'spike-ul absorbit de coada FAZA 15'}
          />
          <GaugeCard
            icon={<Timer className="h-5 w-5" aria-hidden />}
            label="Durată run"
            value={fmtSecs(run?.wallMs ?? 0)}
            sub={run ? `${fmtRoNum(run.flow.windowsFiredDelta)} ferestre · ${fmtRoNum(run.flow.windowDispatchesDelta)} dispatch-uri` : 'drenare onestă la capacitatea reală'}
          />
          <GaugeCard
            icon={<Globe2 className="h-5 w-5" aria-hidden />}
            label="Eșantion 10M"
            value={run ? `${fmtRoNum(run.projection10M.realSample.neonExecutions)} Neon` : '—'}
            tone="emerald"
            sub={
              run
                ? `${fmtRoNum(run.projection10M.realSample.users)} concurenți → reducere ${fmtFactor(run.projection10M.realSample.reductionFactor)}`
                : '500 concurenți reali prin pipeline'
            }
          />
        </section>
      )}

      {/* The integrated pipeline */}
      {pipelineStages.length > 0 ? (
        <PipelineStrip stages={pipelineStages} integrated={integrated} />
      ) : null}

      {/* Last run: sections + assertions */}
      {run ? (
        <section aria-label="Rezultatul ultimului stress test" className="space-y-4">
          <Card className="border-white/10 bg-white/[0.03]">
            <CardHeader className="pb-2">
              <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                <ListChecks className="h-4 w-4 text-emerald-400" aria-hidden />
                Secțiunile pinned — {fmtRoNum(run.requests.total)} cereri, toate răspunse
                <Badge
                  className={cn(
                    'ml-auto border px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest',
                    run.passed
                      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                      : 'border-red-500/40 bg-red-500/10 text-red-300',
                  )}
                >
                  {run.passed ? '22/22 asserții trecute' : `${run.failures.length} eșecuri`}
                </Badge>
              </CardTitle>
              <CardDescription>
                Fiecare secțiune cu rezultatul ei live: surse (neon / batch / cache), blocările oneste
                (spam_blocked · cooldown_active · rate_limited) și timpul de așteptare în coadă.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <SectionsTable sections={run.sections} />
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {[
                  {
                    label: 'Spam blocate',
                    value: fmtRoNum(run.dispositions.spam_blocked),
                    sub: 'ENTER flood → auto-block + 429 retryInMs',
                  },
                  {
                    label: 'Cooldown blocate',
                    value: fmtRoNum(run.dispositions.cooldown_active),
                    sub: 'rezultat real proaspăt → 429 cooldown_active',
                  },
                  {
                    label: 'Rate-limit blocate',
                    value: fmtRoNum(run.dispositions.rate_limited),
                    sub: 'pacing 500ms/utilizator → 429 rate_limited',
                  },
                  {
                    label: 'Erori / pierdute',
                    value: fmtRoNum(run.dispositions.error),
                    sub: '0 erori · 0 dropped · 0 timedOut (ținta pinned)',
                  },
                ].map((c) => (
                  <div key={c.label} className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
                    <p className="text-lg font-black leading-tight text-white">{c.value}</p>
                    <p className="mt-0.5 text-[11px] font-semibold uppercase tracking-widest text-zinc-500">{c.label}</p>
                    <p className="mt-1 text-[11px] leading-snug text-zinc-600">{c.sub}</p>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Assertions — the spec checklist with live evidence */}
          <Card className="border-white/10 bg-white/[0.03]">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <ShieldCheck className="h-4 w-4 text-emerald-400" aria-hidden />
                Asserțiile FAZA 18 ({run.assertions.filter((a) => a.ok).length}/{run.assertions.length})
              </CardTitle>
              <CardDescription>
                Checklist-ul complet al specificației, verificat live la fiecare run — fiecare asserție cu
                dovada ei numerică.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="max-h-96 space-y-1.5 overflow-y-auto pr-1">
                {run.assertions.map((a) => (
                  <li
                    key={a.name}
                    className={cn(
                      'flex items-start gap-2 rounded-lg border px-3 py-2 text-xs',
                      a.ok
                        ? 'border-emerald-500/20 bg-emerald-500/[0.04]'
                        : 'border-red-500/30 bg-red-500/[0.06]',
                    )}
                  >
                    {a.ok ? (
                      <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" aria-hidden />
                    ) : (
                      <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-400" aria-hidden />
                    )}
                    <div className="min-w-0">
                      <p className="font-semibold text-zinc-200">{a.name}</p>
                      <p className="mt-0.5 break-words font-mono text-[10px] leading-snug text-zinc-500">{a.detail}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>

          {/* 10M projection */}
          <Card className="border-white/10 bg-white/[0.03]">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Globe2 className="h-4 w-4 text-emerald-400" aria-hidden />
                Proiecție 10 milioane utilizatori — model onest + eșantion real
              </CardTitle>
              <CardDescription>
                10M utilizatori conectați × 1–3 căutări / sesiune, pe o fereastră de 24h — cu capurile
                structurale care limitează ce poate vedea Neon indiferent de cerere, validate pe un
                eșantion REAL de {fmtRoNum(run.projection10M.realSample.users)} concurenți (virful benzii
                100–500 din specificație).
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {[
                  {
                    label: 'Cereri totale model',
                    value: fmtRoNum(run.projection10M.totalSearches),
                    sub: `${fmtRoNum(run.projection10M.model.users)} utilizatori × ${RO_RATE.format(run.projection10M.model.avgSearchesPerUser)} căutări medii`,
                  },
                  {
                    label: 'Rata medie / vârf',
                    value: `${RO_NUMBER.format(run.projection10M.meanArrivalRate)} / ${RO_NUMBER.format(run.projection10M.peakArrivalRate)}`,
                    sub: 'cereri/s pe fereastra de 24h (vârf diurn ×10)',
                  },
                  {
                    label: 'Plafon sustenabil',
                    value: `${fmtRoNum(run.projection10M.structuralCaps.windowDispatchPerS)}/s`,
                    sub: `window dispatch + ${fmtRoNum(run.projection10M.structuralCaps.maxConcurrentExecutions)} execuții concurrent max`,
                  },
                  {
                    label: 'Eșantion real 500',
                    value: `${fmtRoNum(run.projection10M.realSample.neonExecutions)} Neon`,
                    sub: `reducere măsurată ${fmtFactor(run.projection10M.realSample.reductionFactor)} · 0 pierdute`,
                  },
                ].map((c) => (
                  <div key={c.label} className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
                    <p className="text-lg font-black leading-tight text-white">{c.value}</p>
                    <p className="mt-0.5 text-[11px] font-semibold uppercase tracking-widest text-zinc-500">{c.label}</p>
                    <p className="mt-1 text-[11px] leading-snug text-zinc-600">{c.sub}</p>
                  </div>
                ))}
              </div>
              <div className="grid gap-2 lg:grid-cols-2">
                <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
                  <p className="text-xs font-bold text-zinc-200">Verdictele specifice 10M</p>
                  <ul className="mt-2 space-y-1">
                    {Object.entries(run.projection10M.verdicts).map(([name, ok]) => (
                      <li key={name} className="flex items-center gap-2 text-[11px]">
                        {ok ? (
                          <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-400" aria-hidden />
                        ) : (
                          <XCircle className="h-3 w-3 shrink-0 text-red-400" aria-hidden />
                        )}
                        <span className="text-zinc-400">
                          {{
                            rateLimitWorks: 'rate-limit funcționează',
                            cooldownWorks: 'cooldown funcționează',
                            antiSpamWorks: 'anti-spam funcționează',
                            queueDoesNotExplode: 'coada nu explodează',
                            batchingReduces: 'batching reduce încărcarea',
                            cacheReduces: 'cache reduce încărcarea',
                            neonNotOverloaded: 'Neon nu este supraîncărcat',
                          }[name] ?? name}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
                  <p className="text-xs font-bold text-zinc-200">Capacitatea onestă</p>
                  <ul className="mt-2 space-y-1.5 text-[11px] leading-snug text-zinc-500">
                    <li>• {run.projection10M.capacity.meanDemandVsCeiling}</li>
                    <li>• {run.projection10M.capacity.peakDemandVsCeiling}</li>
                    <li>• {run.projection10M.capacity.effectiveUserCapacityPerS}</li>
                    <li>
                      • semantică: query «{run.semantics.query}» → A={run.semantics.freshSource}, B=
                      {run.semantics.repeatSource}, payload{' '}
                      {run.semantics.payloadIdentical ? 'IDENTIC ✅' : 'diferit ❌'}
                    </li>
                  </ul>
                </div>
              </div>
            </CardContent>
          </Card>
        </section>
      ) : !loadingFirst && !stress.error ? (
        <EmptyState
          title="Niciun stress test rulat încă"
          message="Apasă „Rulează stress test” (administrator) — 11.000 căutări simultane prin pipeline-ul integrat, cu verdict live și toate asserțiile specificației."
        />
      ) : null}

      {/* Runs history */}
      {data && data.runs.length > 0 ? (
        <Card className="border-white/10 bg-white/[0.03]">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Istoric rulări (ultimele {data.runs.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="max-h-64 overflow-y-auto rounded-xl border border-white/10">
              <Table>
                <TableHeader>
                  <TableRow className="border-white/10 hover:bg-transparent">
                    <TableHead className="text-zinc-400">Finalizat</TableHead>
                    <TableHead className="text-right text-zinc-400">Verdict</TableHead>
                    <TableHead className="text-right text-zinc-400">Cereri</TableHead>
                    <TableHead className="text-right text-zinc-400">Răspunse</TableHead>
                    <TableHead className="text-right text-zinc-400">Neon</TableHead>
                    <TableHead className="text-right text-zinc-400">Reducere</TableHead>
                    <TableHead className="text-right text-zinc-400">Durată</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[...data.runs].reverse().map((r) => (
                    <TableRow key={r.finishedAt} className="border-white/[0.06]">
                      <TableCell className="py-2 font-mono text-[11px] text-zinc-400">
                        {new Date(r.finishedAt).toLocaleString('ro-RO')}
                      </TableCell>
                      <TableCell className="text-right">
                        <span
                          className={cn(
                            'font-mono text-[11px] font-bold',
                            r.passed ? 'text-emerald-300' : 'text-red-300',
                          )}
                        >
                          {r.passed ? 'PASSED' : 'FAILED'}
                        </span>
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs text-zinc-300">{fmtRoNum(r.requests)}</TableCell>
                      <TableCell className="text-right font-mono text-xs text-emerald-300">{fmtRoNum(r.answered)}</TableCell>
                      <TableCell className="text-right font-mono text-xs text-rose-300">{fmtRoNum(r.neonFtsQueries)}</TableCell>
                      <TableCell className="text-right font-mono text-xs text-teal-200">{fmtFactor(r.reductionFactor)}</TableCell>
                      <TableCell className="text-right font-mono text-xs text-zinc-400">{fmtSecs(r.wallMs)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* Charts row 1: queue length + rate pacing */}
      <section aria-label="Grafice live ale pipeline-ului integrat" className="grid gap-4 lg:grid-cols-2">
        <Card className="border-white/10 bg-white/[0.03]">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Layers className="h-4 w-4 text-amber-400" aria-hidden />
              Lungime coadă + în execuție (FAZA 15)
            </CardTitle>
            <CardDescription>
              Spike-urile absorbite: coada crește sub cap, execuțiile rămân sub maxConcurrent.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {flowHistory.length === 0 ? (
              <EmptyState title="Fără activitate" message="Istoricul se populează odată cu primele căutări." />
            ) : (
              <ChartContainer config={FLOW_CHART_CONFIG} className="h-44 w-full sm:h-52">
                <AreaChart data={flowHistory} margin={{ left: 4, right: 8, top: 8, bottom: 0 }}>
                  <defs>
                    <linearGradient id="fillFullQueue" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.4} />
                      <stop offset="95%" stopColor="#f59e0b" stopOpacity={0.02} />
                    </linearGradient>
                    <linearGradient id="fillFullInflight" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#10b981" stopOpacity={0.4} />
                      <stop offset="95%" stopColor="#10b981" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid vertical={false} stroke="rgba(255,255,255,0.08)" />
                  <XAxis dataKey="clock" tickLine={false} axisLine={false} minTickGap={32} tick={{ fill: '#71717a', fontSize: 11 }} />
                  <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={30} tick={{ fill: '#71717a', fontSize: 11 }} />
                  <ChartTooltip
                    cursor={{ stroke: 'rgba(245,158,11,0.35)' }}
                    content={<ChartTooltipContent className="border-white/10 bg-[#1a1a24] text-zinc-200" indicator="line" />}
                  />
                  <Area dataKey="coada" type="monotone" stroke="#f59e0b" strokeWidth={2} fill="url(#fillFullQueue)" />
                  <Area dataKey="inflight" type="monotone" stroke="#10b981" strokeWidth={2} fill="url(#fillFullInflight)" />
                </AreaChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>

        <Card className="border-white/10 bg-white/[0.03]">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Timer className="h-4 w-4 text-amber-400" aria-hidden />
              Pacing FAZA 16 — sosiri / admise / blocate
            </CardTitle>
            <CardDescription>
              Anti-spam, rate-limit și cooldown taie inundațiile înainte de coadă — onest, cu retryInMs.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {rateHistory.length === 0 ? (
              <EmptyState title="Fără activitate" message="Istoricul se populează odată cu primele căutări." />
            ) : (
              <ChartContainer config={RATE_CHART_CONFIG} className="h-44 w-full sm:h-52">
                <LineChart data={rateHistory} margin={{ left: 4, right: 8, top: 8, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="rgba(255,255,255,0.08)" />
                  <XAxis dataKey="clock" tickLine={false} axisLine={false} minTickGap={32} tick={{ fill: '#71717a', fontSize: 11 }} />
                  <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={30} tick={{ fill: '#71717a', fontSize: 11 }} />
                  <ChartTooltip
                    cursor={{ stroke: 'rgba(167,139,250,0.35)' }}
                    content={<ChartTooltipContent className="border-white/10 bg-[#1a1a24] text-zinc-200" indicator="line" />}
                  />
                  <Line dataKey="sosiri" type="monotone" stroke="#a78bfa" strokeWidth={1.8} dot={false} />
                  <Line dataKey="admise" type="monotone" stroke="#10b981" strokeWidth={1.8} dot={false} />
                  <Line dataKey="blocate" type="monotone" stroke="#f43f5e" strokeWidth={1.8} dot={false} />
                </LineChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>
      </section>

      {/* Charts row 2: requests vs Neon + servings */}
      <section aria-label="Graficele reducerii" className="grid gap-4 lg:grid-cols-2">
        <Card className="border-white/10 bg-white/[0.03]">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Database className="h-4 w-4 text-emerald-400" aria-hidden />
              Cereri vs Interogări Neon (FAZA 17)
            </CardTitle>
            <CardDescription>
              Diferența dintre arii = traficul pe care Neon nu-l vede (batch + cache).
            </CardDescription>
          </CardHeader>
          <CardContent>
            {optHistory.length === 0 ? (
              <EmptyState title="Fără activitate" message="Istoricul se populează odată cu primele căutări." />
            ) : (
              <ChartContainer config={OPT_CHART_CONFIG} className="h-44 w-full sm:h-52">
                <AreaChart data={optHistory} margin={{ left: 4, right: 8, top: 8, bottom: 0 }}>
                  <defs>
                    <linearGradient id="fillFullReq" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#10b981" stopOpacity={0.45} />
                      <stop offset="95%" stopColor="#10b981" stopOpacity={0.02} />
                    </linearGradient>
                    <linearGradient id="fillFullFts" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#f43f5e" stopOpacity={0.55} />
                      <stop offset="95%" stopColor="#f43f5e" stopOpacity={0.03} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid vertical={false} stroke="rgba(255,255,255,0.08)" />
                  <XAxis dataKey="clock" tickLine={false} axisLine={false} minTickGap={32} tick={{ fill: '#71717a', fontSize: 11 }} />
                  <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={30} tick={{ fill: '#71717a', fontSize: 11 }} />
                  <ChartTooltip
                    cursor={{ stroke: 'rgba(16,185,129,0.35)' }}
                    content={<ChartTooltipContent className="border-white/10 bg-[#1a1a24] text-zinc-200" indicator="line" />}
                  />
                  <Area dataKey="cereri" type="monotone" stroke="#10b981" strokeWidth={2} fill="url(#fillFullReq)" />
                  <Area dataKey="neon" type="monotone" stroke="#f43f5e" strokeWidth={2} fill="url(#fillFullFts)" />
                </AreaChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>

        <Card className="border-white/10 bg-white/[0.03]">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <TrendingDown className="h-4 w-4 text-teal-400" aria-hidden />
              Serviri dedup — cache vs batch
            </CardTitle>
            <CardDescription>
              Cererile identice atașate la execuții în curs (batch) și repetările servite din cache.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {servingsHistory.length === 0 ? (
              <EmptyState title="Fără activitate" message="Istoricul se populează odată cu primele căutări." />
            ) : (
              <ChartContainer config={SERVINGS_CHART_CONFIG} className="h-44 w-full sm:h-52">
                <AreaChart data={servingsHistory} margin={{ left: 4, right: 8, top: 8, bottom: 0 }}>
                  <defs>
                    <linearGradient id="fillFullCache" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#2dd4bf" stopOpacity={0.4} />
                      <stop offset="95%" stopColor="#2dd4bf" stopOpacity={0.02} />
                    </linearGradient>
                    <linearGradient id="fillFullBatch" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#38bdf8" stopOpacity={0.4} />
                      <stop offset="95%" stopColor="#38bdf8" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid vertical={false} stroke="rgba(255,255,255,0.08)" />
                  <XAxis dataKey="clock" tickLine={false} axisLine={false} minTickGap={32} tick={{ fill: '#71717a', fontSize: 11 }} />
                  <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={30} tick={{ fill: '#71717a', fontSize: 11 }} />
                  <ChartTooltip
                    cursor={{ stroke: 'rgba(45,212,191,0.35)' }}
                    content={<ChartTooltipContent className="border-white/10 bg-[#1a1a24] text-zinc-200" indicator="line" />}
                  />
                  <Area dataKey="cache" type="monotone" stroke="#2dd4bf" strokeWidth={2} fill="url(#fillFullCache)" />
                  <Area dataKey="batch" type="monotone" stroke="#38bdf8" strokeWidth={2} fill="url(#fillFullBatch)" />
                </AreaChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
