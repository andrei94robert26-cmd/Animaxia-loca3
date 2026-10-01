'use client';

/**
 * stability-lab-view.tsx — Laborator Stres & Stabilitate (#/stability, FAZA 17).
 *
 * Secțiuni pe date REALE de pe nodul live (backend FAZA 17-a):
 *  1. Stabilitate live — snapshot de reziliență (lag event-loop, RSS + bară
 *     raport, heap, cereri în curs, pool DB, shed, timeout-uri, căutare,
 *     uptime) cu pragurile de protecție afișate onest.
 *  2. Rulează un test de stres real — suite-uri (Căutare Neon FTS, Ingest &
 *     Dedup) executate IN-PROCES pe backend; cifre mari, latențe p50/p95/p99/max,
 *     delta memorie, verdict onest (load shedding afișat ca protecție
 *     funcțională, nu ca eșec).
 */

import { useEffect, useState } from 'react';
import {
  Activity,
  ArrowRight,
  Database,
  Hourglass,
  Layers,
  Loader2,
  MemoryStick,
  Play,
  RefreshCw,
  Search,
  ShieldAlert,
  Timer,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ApiError, api } from '@/lib/animaxia/api';
import { useApi } from '@/lib/animaxia/hooks';
import { navigate } from '@/lib/animaxia/router';
import type {
  StabilitySnapshot,
  StressRunExtra,
  StressRunResponse,
} from '@/lib/animaxia/types';
import { Container, PageHeader, Section } from '../section';
import { ErrorState } from '../states';
import { cn } from '@/lib/utils';

/* ------------------------------- formatting ------------------------------- */

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toLocaleString('ro-RO', { maximumFractionDigits: 1 })} ${units[unit]}`;
}

function formatSignedBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes === 0) return '±0 KB';
  const sign = bytes > 0 ? '+' : '-';
  return `${sign}${formatBytes(Math.abs(bytes))}`;
}

function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  return `${ms.toLocaleString('ro-RO', { maximumFractionDigits: 2 })}ms`;
}

function formatUptime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatCount(n: number): string {
  return n.toLocaleString('ro-RO');
}

/* ------------------------------ shared tile bits ---------------------------- */

type Tone = 'emerald' | 'amber' | 'red' | 'neutral';

const TONE_TEXT: Record<Tone, string> = {
  emerald: 'text-emerald-300',
  amber: 'text-amber-300',
  red: 'text-red-300',
  neutral: 'text-white',
};

const TONE_BAR: Record<Tone, string> = {
  emerald: '[&_[data-slot=progress-indicator]]:bg-emerald-500',
  amber: '[&_[data-slot=progress-indicator]]:bg-amber-500',
  red: '[&_[data-slot=progress-indicator]]:bg-red-500',
  neutral: '[&_[data-slot=progress-indicator]]:bg-zinc-400',
};

function StatTile({
  label,
  icon: Icon,
  value,
  hint,
  tone = 'neutral',
  children,
}: {
  label: string;
  icon: typeof Timer;
  value: string;
  hint?: string;
  tone?: Tone;
  children?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
      <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-500">
        <Icon className="h-3.5 w-3.5" aria-hidden />
        {label}
      </p>
      <p className={cn('mt-1.5 truncate text-lg font-black', TONE_TEXT[tone])} title={value}>
        {value}
      </p>
      {hint ? <p className="mt-0.5 text-[11px] leading-snug text-zinc-500">{hint}</p> : null}
      {children}
    </div>
  );
}

/* --------------------------- section 1: live stability ---------------------- */

/* NEON FREE PLAN: poll auto la 10 MIN (fost 5s), doar tab vizibil — lab de
 * stabilitate; butonul Refresh manual rămâne disponibil instant. */
const STABILITY_POLL_MS = 10 * 60 * 1000;

function LiveStabilitySection() {
  const [tick, setTick] = useState(0);

  /* Poll la 10 min — cheia useApi se schimbă la interval, ca în scale-report-view. */
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') setTick((t) => t + 1);
    }, STABILITY_POLL_MS);
    return () => clearInterval(id);
  }, []);

  const snap = useApi(`platform-stability-${tick}`, () => api.platform.stability());

  if (snap.error && !snap.loading && !snap.data) {
    return (
      <Section title="Stabilitate live" subtitle="Snapshot de reziliență al nodului — refresh manual sau la 10 minute.">
        <ErrorState message={snap.error} onRetry={() => void snap.refetch()} />
      </Section>
    );
  }

  const s: StabilitySnapshot | null = snap.data;

  const lagTone: Tone = !s ? 'neutral' : s.eventLoopLag.p95Ms < 50 ? 'emerald' : s.eventLoopLag.p95Ms < 200 ? 'amber' : 'red';
  const rssRatio = s && s.memory.rssLimitBytes > 0 ? s.memory.rssBytes / s.memory.rssLimitBytes : 0;
  const rssTone: Tone = rssRatio >= 0.85 ? 'red' : rssRatio >= 0.6 ? 'amber' : 'emerald';
  const inFlightTone: Tone = !s ? 'neutral' : s.inFlight < 50 ? 'emerald' : s.inFlight < 100 ? 'amber' : 'red';
  const poolTone: Tone = s && s.pool.waiting > 0 ? 'red' : 'neutral';
  const shedTone: Tone = s && s.shed.count > 0 ? 'red' : 'emerald';
  const timeoutTone: Tone = s && s.timeouts > 0 ? 'amber' : 'emerald';
  const searchTone: Tone = s && s.search.errors > 0 ? 'red' : 'neutral';

  return (
    <Section
      title="Stabilitate live"
      subtitle="Snapshot de reziliență al nodului — refresh manual sau la 10 minute."
      action={
        <Button
          variant="outline"
          size="sm"
          onClick={() => void snap.refetch()}
          disabled={snap.loading}
          className="h-8 border-white/15 bg-white/5 text-zinc-200 hover:bg-white/10 hover:text-white"
        >
          <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', snap.loading && 'animate-spin')} aria-hidden />
          Reîmprospătează
        </Button>
      }
    >
      {!s ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 9 }).map((_, i) => (
            <div key={i} className="h-[76px] animate-pulse rounded-xl border border-white/10 bg-white/[0.03]" />
          ))}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            <StatTile
              label="Latență event-loop"
              icon={Timer}
              value={formatMs(s.eventLoopLag.currentMs)}
              hint={`p50 ${formatMs(s.eventLoopLag.p50Ms)} · p95 ${formatMs(s.eventLoopLag.p95Ms)}`}
              tone={lagTone}
            />
            <StatTile
              label="Memorie RSS"
              icon={MemoryStick}
              value={formatBytes(s.memory.rssBytes)}
              hint={`din ${formatBytes(s.memory.rssLimitBytes)} · ${(rssRatio * 100).toLocaleString('ro-RO', { maximumFractionDigits: 1 })}%`}
              tone={rssTone}
            >
              <Progress value={Math.min(100, rssRatio * 100)} className={cn('mt-2 h-1.5 bg-white/10', TONE_BAR[rssTone])} />
            </StatTile>
            <StatTile
              label="Heap"
              icon={Layers}
              value={formatBytes(s.memory.heapUsedBytes)}
              hint={`total ${formatBytes(s.memory.heapTotalBytes)} · extern ${formatBytes(s.memory.externalBytes)}`}
            />
            <StatTile
              label="Cereri în curs"
              icon={Activity}
              value={formatCount(s.inFlight)}
              hint={`max ${formatCount(s.inFlightMax)}`}
              tone={inFlightTone}
            />
            <StatTile
              label="Pool DB"
              icon={Database}
              value={`${formatCount(s.pool.total)} conexiuni`}
              hint={`idle ${formatCount(s.pool.idle)} · în așteptare ${formatCount(s.pool.waiting)}`}
              tone={poolTone}
            />
            <StatTile
              label="Shed (respinseri)"
              icon={ShieldAlert}
              value={formatCount(s.shed.count)}
              hint={
                s.shed.lastShedAt
                  ? `ultima ${new Date(s.shed.lastShedAt).toLocaleTimeString('ro-RO')}${s.shed.reason ? ` · ${s.shed.reason}` : ''}`
                  : 'nicio respingere'
              }
              tone={shedTone}
            />
            <StatTile
              label="Timeout-uri"
              icon={Hourglass}
              value={formatCount(s.timeouts)}
              hint={`purgeri memorie ${formatCount(s.memoryPurges)}`}
              tone={timeoutTone}
            />
            <StatTile
              label="Căutare"
              icon={Search}
              value={`${formatCount(s.search.coalesced)} grupate`}
              hint={`erori ${formatCount(s.search.errors)} · offset blocat ${formatCount(s.search.offsetCapped)}`}
              tone={searchTone}
            />
            <StatTile label="Uptime" icon={Activity} value={formatUptime(s.uptimeSec)} hint="proces backend" />
          </div>
          <p className="text-[11px] leading-relaxed text-zinc-500">
            Praguri: shed la lag p95 &gt; {s.config.shedThresholds.lagP95Ms}ms sau RSS &gt;{' '}
            {(s.config.shedThresholds.rssRatio * 100).toLocaleString('ro-RO')}% · timeout cerere{' '}
            {s.config.requestTimeoutMs / 1000}s · timeout interogare 8s
          </p>
        </>
      )}
    </Section>
  );
}

/* ---------------------------- section 2: stress runner ---------------------- */

type SuiteKey = StressRunResponse['suite'];

const SUITES: { key: SuiteKey; emoji: string; title: string; desc: string }[] = [
  {
    key: 'search',
    emoji: '🔍',
    title: 'Căutare Neon FTS',
    desc: 'Interogări reale concurente pe motorul Neon FTS.',
  },
  {
    key: 'ingest',
    emoji: '📥',
    title: 'Ingest & Dedup',
    desc: 'Încarcă repetat ACELAȘI link — probează registrul anti-duplicat.',
  },
];

function stressExtraLines(suite: SuiteKey, extra: StressRunExtra): string[] {
  if (suite === 'search') {
    return [`${formatCount(extra.queries ?? 0)} interogări, ${formatCount(extra.hitQueries ?? 0)} cu rezultate`];
  }
  return [
    `${formatCount(extra.unique ?? 0)} unice + ${formatCount(extra.duplicates ?? 0)} duplicate blocate — registru Neon integru`,
  ];
}

function ResultStat({ label, value, tone = 'neutral' }: { label: string; value: string; tone?: Tone }) {
  return (
    <div className="rounded-lg bg-black/30 px-3 py-2">
      <p className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">{label}</p>
      <p className={cn('mt-0.5 text-base font-black', TONE_TEXT[tone])}>{value}</p>
    </div>
  );
}

function StressSection() {
  const [suite, setSuite] = useState<SuiteKey>('search');
  const [durationSec, setDurationSec] = useState(5);
  const [concurrency, setConcurrency] = useState(8);
  const [q, setQ] = useState('dune');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<StressRunResponse | null>(null);

  const suiteMeta = SUITES.find((x) => x.key === suite) ?? SUITES[0];

  const run = async () => {
    setRunning(true);
    setResult(null);
    try {
      const res = await api.platform.stressRun({
        suite,
        durationSec,
        concurrency,
        q: q.trim() || 'dune',
      });
      setResult(res);
      toast.success(`Test finalizat — ${formatCount(res.requests)} cereri, ${res.errorCount} erori`);
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.status === 409) {
          toast.error('Un test rulează deja', {
            description: 'Nodul acceptă un singur test de stres simultan — așteaptă finalizarea lui.',
          });
        } else if (e.status === 429) {
          toast.error('Prea multe teste — așteaptă un minut', {
            description: 'Limita backend este de 2 teste de stres pe minut.',
          });
        } else {
          toast.error(e.message);
        }
      } else {
        toast.error(e instanceof Error ? e.message : 'Testul de stres a eșuat');
      }
    } finally {
      setRunning(false);
    }
  };

  const verdict = result
    ? result.errorCount > 0
      ? {
          label: `${formatCount(result.errorCount)} erori`,
          cls: 'border-red-500/40 bg-red-500/15 text-red-300',
        }
      : result.shed > 0
        ? {
            label: `${formatCount(result.shed)} cereri respinse de protecție (load shedding) — serverul a rămas în picioare`,
            cls: 'border-amber-500/40 bg-amber-500/15 text-amber-300',
          }
        : {
            label: 'Nod stabil — zero erori',
            cls: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300',
          }
    : null;

  return (
    <Section
      title="Rulează un test de stres real"
      subtitle="Sarcină generată în-proces pe nodul live — nu un demo: fiecare cerere lovește motorul real."
    >
      {/* suite selector */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {SUITES.map((s) => {
          const selected = s.key === suite;
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => setSuite(s.key)}
              aria-pressed={selected}
              className={cn(
                'rounded-2xl border p-4 text-left transition-all',
                selected
                  ? 'border-rose-500 bg-rose-500/10 ring-2 ring-rose-500'
                  : 'border-white/10 bg-white/[0.03] hover:border-white/25 hover:bg-white/[0.05]',
              )}
            >
              <span className="text-2xl" aria-hidden>
                {s.emoji}
              </span>
              <p className="mt-2 text-sm font-bold text-white">{s.title}</p>
              <p className="mt-1 text-xs leading-relaxed text-zinc-400">{s.desc}</p>
            </button>
          );
        })}
      </div>

      {/* params + run */}
      <div className="flex flex-col gap-4 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-32">
            <Label htmlFor="stress-duration" className="text-[11px] font-semibold text-zinc-400">
              Durată
            </Label>
            <Select value={String(durationSec)} onValueChange={(v) => setDurationSec(Number(v))} disabled={running}>
              <SelectTrigger id="stress-duration" className="mt-1 w-full border-white/15 bg-black/30">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[5, 10, 15, 30].map((d) => (
                  <SelectItem key={d} value={String(d)}>
                    {d}s
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="w-36">
            <Label htmlFor="stress-concurrency" className="text-[11px] font-semibold text-zinc-400">
              Concurență
            </Label>
            <Select value={String(concurrency)} onValueChange={(v) => setConcurrency(Number(v))} disabled={running}>
              <SelectTrigger id="stress-concurrency" className="mt-1 w-full border-white/15 bg-black/30">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[4, 8, 16, 32].map((c) => (
                  <SelectItem key={c} value={String(c)}>
                    {c} workere
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="min-w-[180px] flex-1 sm:max-w-xs">
            <Label htmlFor="stress-q" className="text-[11px] font-semibold text-zinc-400">
              Interogare
            </Label>
            <Input
              id="stress-q"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="termen de căutat"
              disabled={running}
              className="mt-1 border-white/15 bg-black/30 text-zinc-100 placeholder:text-zinc-600"
            />
          </div>
          <Button
            onClick={() => void run()}
            disabled={running}
            className="h-11 w-full bg-rose-600 px-8 text-base font-black hover:bg-rose-500 sm:w-auto"
          >
            {running ? (
              <Loader2 className="mr-2 h-5 w-5 animate-spin" aria-hidden />
            ) : (
              <Play className="mr-2 h-5 w-5 fill-white" aria-hidden />
            )}
            {running ? `Rulează ${suiteMeta.title}… ${durationSec}s` : 'Rulează testul'}
          </Button>
        </div>
        <p className="text-[11px] text-zinc-500">
          Un singur test simultan pe nod · maxim 2 teste / minut · durată 1–30s · concurență 1–32 workere.
        </p>
      </div>

      {/* result */}
      {running ? (
        <div className="flex items-center justify-center gap-3 rounded-2xl border border-rose-500/25 bg-rose-500/[0.06] p-6">
          <Loader2 className="h-5 w-5 animate-spin text-rose-400" aria-hidden />
          <p className="text-sm font-bold text-rose-200">
            Rulează {suiteMeta.title} · {durationSec}s × {concurrency} workere — generează sarcină reală pe nod…
          </p>
        </div>
      ) : null}
      {result && !running ? (
        <div className="space-y-4 rounded-2xl border border-white/10 bg-white/[0.03] p-4 sm:p-5">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <p className="text-2xl font-black text-white sm:text-3xl">{formatCount(result.requests)} cereri</p>
            <span className="text-lg font-bold text-zinc-300">{formatCount(Math.round(result.rps))} req/s</span>
            <span
              className={cn(
                'text-sm font-bold',
                result.errorCount === 0 ? 'text-emerald-300' : 'text-red-300',
              )}
            >
              {formatCount(result.errorCount)} erori
            </span>
            <span
              className={cn(
                'ml-auto inline-flex items-center rounded-full border px-3 py-1 text-xs font-black',
                verdict?.cls,
              )}
            >
              {verdict?.label}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            <ResultStat label="Latență p50" value={formatMs(result.latency.p50Ms)} />
            <ResultStat label="Latență p95" value={formatMs(result.latency.p95Ms)} />
            <ResultStat label="Latență p99" value={formatMs(result.latency.p99Ms)} />
            <ResultStat label="Latență max" value={formatMs(result.latency.maxMs)} />
          </div>

          <div className="flex flex-wrap gap-x-6 gap-y-2 text-xs text-zinc-400">
            <span>
              Lag max event-loop{' '}
              <strong className="text-zinc-200">{formatMs(result.maxEventLoopLagMs)}</strong>
            </span>
            <span>
              Memorie{' '}
              <strong className={result.memory.deltaBytes < 0 ? 'text-emerald-300' : 'text-zinc-200'}>
                {formatSignedBytes(result.memory.deltaBytes)}
              </strong>
              {result.memory.deltaBytes < 0 ? ' (recuperată)' : ''}
            </span>
            <span>
              Shed <strong className="text-zinc-200">{formatCount(result.shed)}</strong>
            </span>
            <span>
              Durată reală <strong className="text-zinc-200">{(result.durationMs / 1000).toLocaleString('ro-RO', { maximumFractionDigits: 1 })}s</strong>
            </span>
          </div>

          <ul className="space-y-1.5 border-t border-white/10 pt-3">
            {stressExtraLines(result.suite, result.extra).map((line) => (
              <li key={line} className="flex items-start gap-2 text-xs text-zinc-300">
                <ArrowRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-400" aria-hidden />
                {line}
              </li>
            ))}
          </ul>

          {result.errors.length > 0 ? (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3">
              <p className="text-[10px] font-bold uppercase tracking-wider text-red-300">Primele erori</p>
              <ul className="mt-1 space-y-0.5">
                {result.errors.map((err, i) => (
                  <li key={i} className="font-mono text-[11px] text-red-200">
                    {err}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </Section>
  );
}

/* ---------------------------------- the view -------------------------------- */

export function StabilityLabView() {
  return (
    <Container className="space-y-8 py-8 sm:py-10">
      <PageHeader
        title="🛡️ Laborator Stres & Stabilitate"
        subtitle="Testează rezistența reală a nodului, live — căutare FTS concurentă și ingest cu registru anti-duplicat"
      >
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Badge className="border-rose-500/30 bg-rose-500/15 text-rose-300 hover:bg-rose-500/15">
            <span className="relative mr-1.5 flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-rose-500" />
            </span>
            LIVE · refresh 10min
          </Badge>
          <span className="text-[11px] text-zinc-500">măsurători direct de pe nodul backend</span>
        </div>
      </PageHeader>

      <LiveStabilitySection />
      <StressSection />

      {/* quick links */}
      <div className="grid gap-3 sm:grid-cols-2">
        <button
          type="button"
          onClick={() => navigate('/scale')}
          className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.03] p-4 text-left transition-colors hover:border-white/25 hover:bg-white/[0.05]"
        >
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-black/40 text-xl" aria-hidden>
            📊
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-bold text-white">Arhitectura Reală</span>
            <span className="block text-xs text-zinc-500">Contori reali · capacitate declarată separat · 15 sharduri</span>
          </span>
          <ArrowRight className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden />
        </button>
        <button
          type="button"
          onClick={() => navigate('/aihub')}
          className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.03] p-4 text-left transition-colors hover:border-white/25 hover:bg-white/[0.05]"
        >
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-black/40 text-xl" aria-hidden>
            🤖
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-bold text-white">AI Hub</span>
            <span className="block text-xs text-zinc-500">Cele 6 AI-uri ale platformei, comutabile live</span>
          </span>
          <ArrowRight className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden />
        </button>
      </div>
    </Container>
  );
}
