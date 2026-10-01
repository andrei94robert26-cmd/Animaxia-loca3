'use client';

/**
 * scale-report-view.tsx — Raport Scalabilitate (#/scale, FAZA 16).
 *
 * Țintele declarate (10M utilizatori · 10M conturi conectate simultan · 30B
 * contente externe · 10M căutări simultane) analizate onest, cu măsurători
 * LIVE de pe nodul curent (latență DB, p50/p95 căutare, dimensiuni tabele,
 * cache, provideri, pool Neon), verdicte per țintă, lista lipsurilor sortată
 * pe severitate și o concluzie fără cosmetizare. Auto-refresh la 30s.
 */

import { useEffect, useState } from 'react';
import {
  Activity,
  AlertOctagon,
  ArrowRight,
  Database,
  Gauge,
  Globe,
  Link2,
  RefreshCw,
  Server,
  Timer,
  Users,
  Zap,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/animaxia/api';
import { useApi } from '@/lib/animaxia/hooks';
import type { ScaleGap, ScaleVerdict } from '@/lib/animaxia/types';
import { Container, PageHeader } from '../section';
import { ErrorState } from '../states';
import { cn } from '@/lib/utils';

const REFRESH_MS = 30_000;

/* ------------------------------- formatting ------------------------------- */

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toLocaleString('ro-RO', { maximumFractionDigits: 1 })} ${units[unit]}`;
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

/* ------------------------------ target cards ------------------------------ */

const TARGET_META: Record<
  ScaleVerdict['targetKey'],
  { icon: typeof Users; title: string; accent: string }
> = {
  users: { icon: Users, title: '10M Utilizatori', accent: 'from-rose-500/20 to-rose-500/5 text-rose-300' },
  connectedAccounts: {
    icon: Link2,
    title: '10M Conturi conectate simultan',
    accent: 'from-fuchsia-500/20 to-fuchsia-500/5 text-fuchsia-300',
  },
  contents: { icon: Database, title: '30B Contente externe', accent: 'from-amber-500/20 to-amber-500/5 text-amber-300' },
  concurrentSearches: { icon: Zap, title: '10M Căutări simultane', accent: 'from-teal-500/20 to-teal-500/5 text-teal-300' },
};

const STATUS_BADGES: Record<ScaleVerdict['status'], { label: string; className: string }> = {
  'not-ready': { label: 'NE-GATA', className: 'border-red-500/40 bg-red-500/15 text-red-300' },
  partial: { label: 'PARȚIAL', className: 'border-amber-500/40 bg-amber-500/15 text-amber-300' },
  ready: { label: 'GATA', className: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300' },
};

function VerdictCard({ verdict }: { verdict: ScaleVerdict }) {
  const meta = TARGET_META[verdict.targetKey];
  const badge = STATUS_BADGES[verdict.status] ?? STATUS_BADGES['not-ready'];
  const Icon = meta.icon;
  return (
    <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03] p-4">
      <div aria-hidden className={cn('pointer-events-none absolute inset-0 bg-gradient-to-br opacity-60', meta.accent)} />
      <div className="relative space-y-3">
        <div className="flex items-start justify-between gap-3">
          <span className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-black/40', meta.accent.split(' ').pop())}>
            <Icon className="h-5 w-5" aria-hidden />
          </span>
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[10px] font-black tracking-wider',
              badge.className,
            )}
          >
            {verdict.status === 'not-ready' ? <AlertOctagon className="h-3 w-3" aria-hidden /> : null}
            {badge.label}
          </span>
        </div>
        <div>
          <h3 className="text-sm font-bold text-white">{meta.title}</h3>
          <p className="mt-1 text-xs leading-relaxed text-zinc-400" title={verdict.reasoning}>
            {verdict.currentEstimate}
          </p>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------- gap cards ------------------------------- */

const SEVERITY_STYLES: Record<ScaleGap['severity'], string> = {
  critical: 'border-red-500/40 bg-red-500/15 text-red-300',
  high: 'border-amber-500/40 bg-amber-500/15 text-amber-300',
  medium: 'border-zinc-500/40 bg-zinc-500/15 text-zinc-300',
};

const SEVERITY_ORDER: Record<ScaleGap['severity'], number> = { critical: 0, high: 1, medium: 2 };

const SEVERITY_LABELS: Record<ScaleGap['severity'], string> = {
  critical: 'critic',
  high: 'ridicat',
  medium: 'mediu',
};

/* -------------------------------- metric tile ------------------------------ */

function MetricTile({
  label,
  value,
  hint,
  icon: Icon,
}: {
  label: string;
  value: string;
  hint?: string;
  icon: typeof Gauge;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
      <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-500">
        <Icon className="h-3.5 w-3.5" aria-hidden />
        {label}
      </p>
      <p className="mt-1.5 text-lg font-black text-white">{value}</p>
      {hint ? <p className="mt-0.5 text-[11px] text-zinc-500">{hint}</p> : null}
    </div>
  );
}

/* --------------------- FAZA 14 — Conformitate 30B ---------------------- */

/** Compact live check of the FAZA 14 rules against the real global feed
 *  (api.platform.globalFeed({limit:1}).stats): logical 30B space, real
 *  overlay count, the range sharding rule and the logical/physical mode. */
function Global30BComplianceCard() {
  const feed = useApi('scale-global30b', () => api.platform.globalFeed({ limit: 1 }));
  const s = feed.data?.stats;

  return (
    <Card className="border-white/10 bg-white/[0.03]">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Globe className="h-4 w-4 text-amber-400" aria-hidden /> Conformitate 30B
        </CardTitle>
        <CardDescription>
          Regulile FAZA 14 verificate live pe feed-ul global ({feed.data ? feed.data.engine : 'animaxia-global-30b'}) —
          spațiul e simulat logic, metadata reală rămâne în Neon.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {feed.loading && !feed.data ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-5 w-full" />
            ))}
          </div>
        ) : feed.error && !feed.data ? (
          <ErrorState compact message={feed.error} onRetry={() => void feed.refetch()} />
        ) : s ? (
          <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Spațiu logic</dt>
              <dd className="mt-0.5 font-bold text-white">{formatCount(s.addressSpace)} ID-uri</dd>
              <dd className="text-[11px] text-zinc-500">
                {formatCount(s.shardcount)} sharduri × {formatCount(s.shardSpan)} ID-uri (0 …{' '}
                {formatCount(s.addressSpace - 1)})
              </dd>
            </div>
            <div>
              <dt className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Conținuturi reale</dt>
              <dd className="mt-0.5 font-bold text-emerald-300">{formatCount(s.realCount)}</dd>
              <dd className="text-[11px] text-zinc-500">salvate 100% în Neon — overlay la id-ul propriu</dd>
            </div>
            <div>
              <dt className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Regula de sharding</dt>
              <dd className="mt-0.5 font-mono text-xs font-bold text-white">
                computeShardIdFromContentId = floor(id / 10⁹) % {s.shardcount}
              </dd>
              <dd className="text-[11px] text-zinc-500">
                shardul s acoperă exact [s × 10⁹, (s+1) × 10⁹ − 1] — zero migrare pentru id-uri &lt; 1 miliard
              </dd>
            </div>
            <div>
              <dt className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Modul</dt>
              <dd className="mt-0.5 font-bold capitalize text-white">{feed.data?.mode ?? 'logical'}</dd>
              <dd className="text-[11px] text-zinc-500">
                un singur branch Neon; izolare fizică prin SHARD{'{n}'}URL fără schimbare de cod
              </dd>
            </div>
          </dl>
        ) : null}
      </CardContent>
    </Card>
  );
}

/* ---------------------------------- view ---------------------------------- */

export function ScaleReportView() {
  const [tick, setTick] = useState(0);

  /* Auto-refresh every 30s — the key change re-runs the fetcher. */
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  const report = useApi(`scale-report-${tick}`, () => api.scaleReport());

  const refresh = async () => {
    await report.refetch();
    toast.success('Măsurătorile au fost reîmprospătate');
  };

  if (report.error && !report.loading && !report.data) {
    return (
      <Container className="py-10">
        <PageHeader title="Raport Scalabilitate" subtitle="Măsurători live de pe nodul curent." />
        <div className="mt-6">
          <ErrorState message={report.error} onRetry={() => void report.refetch()} />
        </div>
      </Container>
    );
  }

  const data = report.data;
  const m = data?.measured;
  const gaps = [...(data?.gaps ?? [])].sort(
    (a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9),
  );

  return (
    <Container className="space-y-8 py-8 sm:py-10">
      <PageHeader
        title="Raport Scalabilitate"
        subtitle="10M utilizatori · 30B contente · 10M căutări simultane — analiză reală, live"
      >
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Badge className="border-rose-500/30 bg-rose-500/15 text-rose-300 hover:bg-rose-500/15">
            <Activity className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            LIVE · auto-refresh 30s
          </Badge>
          {data ? (
            <span className="text-[11px] text-zinc-500">
              generat{' '}
              {new Date(data.measured?.measuredAt ?? data.generatedAt).toLocaleTimeString('ro-RO')}
            </span>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refresh()}
            disabled={report.loading}
            className="h-8 border-white/15 bg-white/5 text-zinc-200 hover:bg-white/10 hover:text-white"
          >
            <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', report.loading && 'animate-spin')} aria-hidden />
            Reîmprospătează măsurătorile
          </Button>
        </div>
      </PageHeader>

      {/* -------------------------- 4 target cards -------------------------- */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {(data?.verdicts ?? []).map((v) => (
          <VerdictCard key={v.targetKey} verdict={v} />
        ))}
        {!data && report.loading
          ? Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-36 animate-pulse rounded-2xl border border-white/10 bg-white/[0.03]" />
            ))
          : null}
      </div>

      {/* ------------------- FAZA 14 — Conformitate 30B ------------------- */}
      <Global30BComplianceCard />

      {/* ---------------------- live measured metrics ---------------------- */}
      <section className="space-y-3" aria-label="Metrici măsurate live">
        <h2 className="text-lg font-bold tracking-tight text-zinc-100 sm:text-xl">Metrici măsurate — live</h2>
        {m ? (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
            <MetricTile label="Latență DB" value={`${m.dbLatencyMs}ms`} hint="SELECT 1 · live" icon={Timer} />
            <MetricTile
              label="Căutare p50 / p95"
              value={`${m.searchLatency.p50Ms} / ${m.searchLatency.p95Ms}ms`}
              hint={`${m.searchLatency.samples} eșantioane`}
              icon={Zap}
            />
            <MetricTile label="Itemi bibliotecă" value={formatCount(m.items)} hint="rânduri content" icon={Database} />
            <MetricTile label="Utilizatori" value={formatCount(m.users)} hint="conturi înregistrate" icon={Users} />
            <MetricTile label="Search docs" value={formatCount(m.searchdocs)} hint="index FTS Neon" icon={Gauge} />
            <MetricTile
              label="Surse înregistrate"
              value={formatCount(m.contentsources)}
              hint="registru anti-duplicat"
              icon={Link2}
            />
            <MetricTile label="DB size" value={formatBytes(m.dbSizeBytes)} hint="pg_database_size" icon={Database} />
            <MetricTile
              label="Cache hit rate"
              value={`${(m.cache.hitRate * 100).toLocaleString('ro-RO', { maximumFractionDigits: 1 })}%`}
              hint={`${m.cache.keys} chei`}
              icon={Gauge}
            />
            <MetricTile label="Uptime" value={formatUptime(m.uptimeSec)} hint="proces backend" icon={Activity} />
            <MetricTile
              label="Pool Neon"
              value={`${m.neon.pool.total}/${m.neon.poolMax}`}
              hint={`${m.neon.branch} · idle ${m.neon.pool.idle} · waiting ${m.neon.pool.waiting}`}
              icon={Server}
            />
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
            {Array.from({ length: 10 }).map((_, i) => (
              <div key={i} className="h-20 animate-pulse rounded-xl border border-white/10 bg-white/[0.03]" />
            ))}
          </div>
        )}

        {/* providers + top tables */}
        <div className="grid gap-3 lg:grid-cols-2">
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-500">
              <Server className="h-3.5 w-3.5" aria-hidden /> Provideri externi
            </p>
            <ul className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {(m?.providers ?? []).map((p) => (
                <li key={p.name} className="flex items-center gap-2 rounded-lg bg-black/30 px-2.5 py-2" title={`${p.name}: ${p.state} · ${p.failures} erori`}>
                  <span
                    aria-hidden
                    className={cn(
                      'h-2 w-2 shrink-0 rounded-full',
                      p.state === 'closed' ? 'bg-emerald-400' : p.state === 'half-open' ? 'bg-amber-400' : 'bg-red-400',
                    )}
                  />
                  <span className="truncate text-xs font-semibold text-zinc-300">{p.name}</span>
                  <span className="ml-auto text-[10px] text-zinc-500">{p.failures}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-500">
              <Database className="h-3.5 w-3.5" aria-hidden /> Top 10 tabele după dimensiune
            </p>
            <div className="custom-scrollbar mt-3 max-h-64 space-y-1 overflow-y-auto pr-1">
              {(m?.tableSizes ?? []).map((t) => (
                <div key={t.name} className="flex items-center justify-between gap-3 rounded-lg bg-black/30 px-2.5 py-1.5">
                  <span className="truncate font-mono text-xs text-zinc-300">{t.name}</span>
                  <span className="shrink-0 text-xs font-bold text-zinc-400">{formatBytes(t.bytes)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ------------------------------ gaps ------------------------------ */}
      <section className="space-y-3" aria-label="Lipsuri pentru scalare">
        <h2 className="text-lg font-bold tracking-tight text-zinc-100 sm:text-xl">
          Lipsuri — {gaps.length} {gaps.length === 1 ? 'element' : 'elemente'} de scalabilitate
        </h2>
        <div className="custom-scrollbar max-h-96 space-y-2 overflow-y-auto pr-1">
          {gaps.length === 0 && !report.loading ? (
            <p className="rounded-xl border border-white/10 bg-white/[0.03] p-4 text-sm text-zinc-400">
              Nicio lipsă raportată.
            </p>
          ) : (
            gaps.map((gap, i) => (
              <div key={`${gap.missing}-${i}`} className="rounded-xl border border-white/10 bg-white/[0.03] p-3.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={cn(
                      'inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-black uppercase tracking-wider',
                      SEVERITY_STYLES[gap.severity] ?? SEVERITY_STYLES.medium,
                    )}
                  >
                    {SEVERITY_LABELS[gap.severity] ?? gap.severity}
                  </span>
                  <p className="min-w-0 flex-1 text-sm font-bold text-zinc-100">{gap.missing}</p>
                </div>
                <p className="mt-1.5 flex items-start gap-1.5 text-xs leading-relaxed text-zinc-400">
                  <ArrowRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-400" aria-hidden />
                  {gap.recommendation}
                </p>
              </div>
            ))
          )}
          {report.loading && !data
            ? Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-16 animate-pulse rounded-xl border border-white/10 bg-white/[0.03]" />
              ))
            : null}
        </div>
      </section>

      {/* --------------------------- conclusion --------------------------- */}
      {data ? (
        <blockquote className="rounded-2xl border-l-4 border-rose-500 bg-rose-500/[0.06] p-5">
          <p className="text-[10px] font-bold uppercase tracking-wider text-rose-300">Concluzie</p>
          <p className="mt-2 text-sm leading-relaxed text-zinc-200">{data.conclusion}</p>
        </blockquote>
      ) : null}
    </Container>
  );
}
