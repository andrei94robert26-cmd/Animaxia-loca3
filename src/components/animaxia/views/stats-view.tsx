'use client';

/**
 * stats-view.tsx — FAZA 21 (#/stats, PUBLIC): live platform gauges.
 * Six custom semicircular SVG gauges over real public endpoints
 * (/api/hub/stats, /api/hub/feed, /api/search/status, /api/ai/status,
 * /api/metrics) — every maximum is labeled so the percentage can't mislead.
 * Plus a personal engagement section for signed-in users
 * (/api/users/me/stats). No recharts — pure SVG, zero new dependencies.
 */

import { useMemo } from 'react';
import {
  Activity,
  BarChart3,
  Bot,
  Clock,
  Database,
  Flame,
  Layers,
  Rss,
  Search,
  Users,
} from 'lucide-react';
import { api } from '@/lib/animaxia/api';
import { platform } from '@/lib/animaxia/platform';
import { useApi } from '@/lib/animaxia/hooks';
import { navigate } from '@/lib/animaxia/router';
import { useAuth } from '@/components/animaxia/auth-provider';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { Container, PageHeader, Section } from '../section';
import { EmptyState, ErrorState } from '../states';

/* ------------------------------- helpers --------------------------------- */

function formatRo(n: number): string {
  return n.toLocaleString('ro-RO');
}

function formatUptime(sec: number): string {
  const days = Math.floor(sec / 86_400);
  const hours = Math.floor((sec % 86_400) / 3_600);
  const minutes = Math.floor((sec % 3_600) / 60);
  if (days > 0) return `${days}z ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${Math.floor(sec % 60)}s`;
  return `${Math.floor(sec)}s`;
}

/* --------------------------- semicircular gauge ---------------------------- */

/** Semicircle arc length for r=50 (viewBox 0 0 120 64). */
const ARC_LEN = Math.PI * 50;

function Gauge({
  icon,
  label,
  value,
  percent,
  maxLabel,
  sub,
  stroke,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  /** Honest fill ratio 0..1 — computed by the caller against a labeled max. */
  percent: number;
  maxLabel: string;
  sub: React.ReactNode;
  stroke: string;
}) {
  const ratio = Math.min(1, Math.max(0, Number.isFinite(percent) ? percent : 0));
  const dash = ARC_LEN * (1 - ratio);
  return (
    <div className="flex flex-col items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.03] p-4 text-center">
      <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-zinc-400">
        {icon}
        {label}
      </p>
      <svg viewBox="0 0 120 68" className="w-full max-w-[180px]" role="img" aria-label={`${label}: ${value} din maxim ${maxLabel}`}>
        {/* track */}
        <path d="M 10 60 A 50 50 0 0 1 110 60" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="9" strokeLinecap="round" />
        {/* value arc */}
        <path
          d="M 10 60 A 50 50 0 0 1 110 60"
          fill="none"
          stroke={stroke}
          strokeWidth="9"
          strokeLinecap="round"
          strokeDasharray={ARC_LEN}
          strokeDashoffset={dash}
          style={{ transition: 'stroke-dashoffset 0.6s ease' }}
        />
        <text x="60" y="52" textAnchor="middle" className="fill-white" style={{ fontSize: 17, fontWeight: 900 }}>
          {Math.round(ratio * 100)}%
        </text>
        <text x="60" y="63" textAnchor="middle" className="fill-zinc-500" style={{ fontSize: 7.5 }}>
          {maxLabel}
        </text>
      </svg>
      <p className="text-xl font-black leading-none text-white">{value}</p>
      <p className="min-h-[32px] text-[11px] leading-snug text-zinc-500">{sub}</p>
    </div>
  );
}

/* --------------------------- gauge skeleton tile --------------------------- */

function GaugeSkeleton() {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
      <Skeleton className="h-3.5 w-24" />
      <Skeleton className="mt-2 h-[72px] w-full max-w-[180px] rounded-full" />
      <Skeleton className="h-6 w-20" />
      <Skeleton className="h-3.5 w-4/5" />
    </div>
  );
}

/* -------------------------------- the view -------------------------------- */

export function StatsView() {
  const { user } = useAuth();

  const hubStats = useApi('faza21-hub-stats', () => api.hub.stats());
  const hubFeed = useApi('faza21-hub-feed', () => api.hub.feed());
  const searchStatus = useApi('faza21-search-status', () => api.searchStatus());
  const aiStatus = useApi('faza21-ai-status', () => platform.aiStatus());
  const metrics = useApi('faza21-metrics', () => api.metricsJson());
  const myStats = useApi('faza21-my-stats', () => api.myStats(), { enabled: Boolean(user) });

  /* ---------------- gauge inputs (all real, all labeled) ---------------- */

  const totalItems = hubStats.data?.totalItems ?? null;
  const countsByType = hubStats.data?.countsByType ?? null;
  const indexCapacity = searchStatus.data?.capacity?.indexedDocs ?? null;

  const activityTotal = hubStats.data?.viewevents.total ?? null;
  const usersCount = hubStats.data?.users.count ?? null;
  /* Honest activity bound: every user having viewed every title once. */
  const activityMax = usersCount != null && totalItems != null ? usersCount * totalItems : null;

  /* AI calls: metrics registry first, /api/ai/status as fallback. */
  const aiCalls =
    metrics.data?.collectors?.ai?.usage?.callsToday ?? metrics.data?.collectors?.ai?.usage?.totalCalls ?? null;
  const aiCallsFallback = aiStatus.data?.requestsToday ?? null;
  const aiQuota = aiStatus.data?.quota ?? null;
  const aiQuotaForVisitor = aiQuota
    ? user
      ? user.plan === 'pro'
        ? aiQuota.pro
        : user.plan === 'plus'
          ? aiQuota.plus
          : aiQuota.free
      : aiQuota.anonymous
    : null;

  const uptimeSec = hubStats.data?.uptimeSec ?? null;
  const UPTIME_MAX = 86_400;

  const feedCount = hubFeed.data?.combinedCount ?? hubFeed.data?.combined.length ?? null;
  const FEED_MAX = 24; /* FEED_COMBINED_CAP on the backend (hub.js) */

  const docs = searchStatus.data?.docs ?? null;
  /* Pipeline layer 9 = the LRU cache — live hit rate. */
  const cacheStage = useMemo(
    () => (searchStatus.data?.pipelineStages ?? []).find((s) => s.name === 'cache'),
    [searchStatus.data],
  );
  const cacheStats = (cacheStage?.stats ?? {}) as { hits?: number; misses?: number; hitRate?: number };
  const cacheHitRate = typeof cacheStats.hitRate === 'number' ? cacheStats.hitRate : null;

  const gaugesLoading =
    hubStats.loading && !hubStats.data ? true : searchStatus.loading && !searchStatus.data ? true : false;

  /* ------------------------------ gauges grid ------------------------------ */

  let gauges: React.ReactNode = null;
  if (gaugesLoading) {
    gauges = (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <GaugeSkeleton key={i} />
        ))}
      </div>
    );
  } else if (hubStats.error && !hubStats.data) {
    gauges = <ErrorState message={hubStats.error} onRetry={() => void hubStats.refetch()} compact />;
  } else if (totalItems != null) {
    const typeSummary = countsByType
      ? Object.entries(countsByType)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([t, c]) => `${t} ${c}`)
          .join(' · ') + (Object.keys(countsByType).length > 3 ? ' · altele' : '')
      : null;

    gauges = (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Gauge
          icon={<Database className="h-3.5 w-3.5 text-rose-400" aria-hidden />}
          label="Conținut"
          value={formatRo(totalItems)}
          percent={indexCapacity != null ? totalItems / indexCapacity : 0}
          maxLabel={indexCapacity != null ? `capacitate index ${formatRo(indexCapacity)}` : 'fără capacitate'}
          sub={<span>titluri reale în SQLite{typeSummary ? <><br />{typeSummary}</> : null}</span>}
          stroke="#f43f5e"
        />
        <Gauge
          icon={<Activity className="h-3.5 w-3.5 text-teal-400" aria-hidden />}
          label="Activitate"
          value={activityTotal != null ? formatRo(activityTotal) : '—'}
          percent={activityTotal != null && activityMax ? activityTotal / activityMax : 0}
          maxLabel={activityMax ? `max teoretic ${formatRo(activityMax)}` : 'fără maxim'}
          sub={
            <span>
              evenimente de vizionare{usersCount != null ? <> · {formatRo(usersCount)} utilizatori</> : null}
              {hubStats.data ? <> · +{formatRo(hubStats.data.viewevents.last24h)} în 24h</> : null}
            </span>
          }
          stroke="#14b8a6"
        />
        <Gauge
          icon={<Bot className="h-3.5 w-3.5 text-fuchsia-400" aria-hidden />}
          label="AI usage"
          value={formatRo(aiCalls ?? aiCallsFallback ?? 0)}
          percent={aiQuotaForVisitor ? (aiCalls ?? aiCallsFallback ?? 0) / aiQuotaForVisitor : 0}
          maxLabel={aiQuotaForVisitor ? `cotă zilnică ${aiQuotaForVisitor}${user ? ` (${user.plan})` : ' (anonim)'}` : 'fără cotă'}
          sub={
            <span>
              cereri AI azi{aiStatus.data ? <> · {aiStatus.data.provider}/{aiStatus.data.model}</> : null}
              {!user && <> · <a className="underline hover:text-rose-300" href="#/auth?next=/stats">conectează-te pentru cotă mai mare</a></>}
            </span>
          }
          stroke="#d946ef"
        />
        <Gauge
          icon={<Clock className="h-3.5 w-3.5 text-amber-400" aria-hidden />}
          label="Uptime"
          value={uptimeSec != null ? formatUptime(uptimeSec) : '—'}
          percent={uptimeSec != null ? uptimeSec / UPTIME_MAX : 0}
          maxLabel="fereastră 24h"
          sub={<span>monolitul rulează fără restart{uptimeSec != null && uptimeSec > UPTIME_MAX ? ' (peste 24h — bară plină)' : ''}</span>}
          stroke="#f59e0b"
        />
        <Gauge
          icon={<Rss className="h-3.5 w-3.5 text-emerald-400" aria-hidden />}
          label="Feed"
          value={feedCount != null ? formatRo(feedCount) : '—'}
          percent={feedCount != null ? feedCount / FEED_MAX : 0}
          maxLabel={`cap combined ${FEED_MAX}`}
          sub={
            hubFeed.data ? (
              <span>
                personal {hubFeed.data.personal.items.length} · global {hubFeed.data.global.items.length} · AI {hubFeed.data.ai.items.length}
              </span>
            ) : (
              'feed combinat live'
            )
          }
          stroke="#10b981"
        />
        <Gauge
          icon={<Search className="h-3.5 w-3.5 text-sky-400" aria-hidden />}
          label="Search"
          value={docs != null ? formatRo(docs) : '—'}
          percent={indexCapacity != null && docs != null ? docs / indexCapacity : 0}
          maxLabel={indexCapacity != null ? `capacitate ${formatRo(indexCapacity)} docs` : 'fără capacitate'}
          sub={
            <span>
              docs indexate FTS
              {cacheHitRate != null ? <> · cache {Math.round(cacheHitRate * 100)}%</> : null}
              {typeof cacheStats.hits === 'number' && typeof cacheStats.misses === 'number' ? (
                <>
                  {' '}
                  ({formatRo(cacheStats.hits)} hit / {formatRo(cacheStats.misses)} miss)
                </>
              ) : null}
            </span>
          }
          stroke="#0ea5e9"
        />
      </div>
    );
  }

  /* ------------------------------ main render ------------------------------ */

  return (
    <Container className="space-y-10 py-8 sm:py-10">
      <PageHeader
        title="Statisticile platformei"
        subtitle="Gauge-uri live peste date reale (Neon, pipeline de căutare, feed, AI) — fiecare maxim este etichetat, fiecare procent este onest."
      />

      <Section title="Gauge-uri live" subtitle="Sase indicatori semicirculari — valorile se actualizează la fiecare încărcare a paginii.">
        {gauges}
      </Section>

      {/* ------------------------- engagement section ------------------------- */}
      <Section
        title="Angajament"
        subtitle="Comunitatea în cifre reale — plus conturul tău personal când ești conectat."
      >
        {hubStats.loading && !hubStats.data ? (
          <div className="grid gap-4 sm:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-32 rounded-2xl" />
            ))}
          </div>
        ) : hubStats.error && !hubStats.data ? (
          <ErrorState message={hubStats.error} onRetry={() => void hubStats.refetch()} compact />
        ) : hubStats.data ? (
          <div className={cn('grid gap-4', user ? 'sm:grid-cols-2' : 'sm:grid-cols-3')}>
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
              <p className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-widest text-zinc-400">
                <Users className="h-4 w-4 text-rose-400" aria-hidden /> Comunitate
              </p>
              <p className="mt-2 text-3xl font-black text-white">{formatRo(hubStats.data.users.count)}</p>
              <p className="mt-1 text-xs text-zinc-500">conturi înregistrate reale</p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
              <p className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-widest text-zinc-400">
                <Activity className="h-4 w-4 text-teal-400" aria-hidden /> Ultimele 24h
              </p>
              <p className="mt-2 text-3xl font-black text-white">{formatRo(hubStats.data.viewevents.last24h)}</p>
              <p className="mt-1 text-xs text-zinc-500">
                evenimente de vizionare (din {formatRo(hubStats.data.viewevents.total)} total)
              </p>
            </div>

            {user ? (
              myStats.loading && !myStats.data ? (
                <Skeleton className="h-32 rounded-2xl" />
              ) : myStats.error && !myStats.data ? (
                <ErrorState message={myStats.error} onRetry={() => void myStats.refetch()} compact />
              ) : myStats.data ? (
                <div className="rounded-2xl border border-rose-500/25 bg-gradient-to-br from-rose-500/[0.08] to-fuchsia-500/[0.05] p-5">
                  <p className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-widest text-rose-300">
                    <Flame className="h-4 w-4" aria-hidden /> Angajamentul tău
                  </p>
                  <div className="mt-2 flex flex-wrap items-baseline gap-x-5 gap-y-1">
                    <span className="text-3xl font-black text-white">
                      {myStats.data.engagement.streakDays}
                      <span className="ml-1 text-sm font-bold text-zinc-400">zile streak</span>
                    </span>
                    <span className="text-sm font-semibold text-zinc-300">
                      {formatRo(myStats.data.engagement.activeDays)} zile active
                    </span>
                    <span className="text-sm font-semibold text-zinc-300">
                      {formatRo(myStats.data.watch.totalMinutes)} min vizionate
                    </span>
                  </div>
                  {myStats.data.topGenres.length > 0 ? (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {myStats.data.topGenres.map((g) => (
                        <span
                          key={g.genre}
                          className="rounded-full border border-white/10 bg-white/[0.05] px-2.5 py-0.5 text-[11px] font-semibold text-zinc-300"
                        >
                          {g.genre} ×{g.count}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-3 text-xs text-zinc-500">
                      Încă fără genuri în istoric — vizionează câteva titluri și profilul tău se conturează aici.
                    </p>
                  )}
                </div>
              ) : null
            ) : (
              <div className="flex flex-col items-start justify-center gap-2 rounded-2xl border border-white/10 bg-white/[0.02] p-5">
                <p className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-widest text-zinc-400">
                  <BarChart3 className="h-4 w-4 text-fuchsia-400" aria-hidden /> Angajamentul tău
                </p>
                <p className="text-sm leading-relaxed text-zinc-400">
                  Streak-ul zilier, minutele vizionate și genurile tale favorite apar aici după conectare.
                </p>
                <Button size="sm" className="bg-rose-600 font-bold hover:bg-rose-500" onClick={() => navigate('/auth?next=/stats')}>
                  Conectează-te
                </Button>
              </div>
            )}
          </div>
        ) : null}
      </Section>

      {/* ---------------------- top viewed (bonus, real) ---------------------- */}
      {hubStats.data && hubStats.data.viewevents.topViewed.length > 0 ? (
        <Section title="Cele mai vizionate" subtitle="Top 5 din evenimentele reale de vizionare.">
          <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            {hubStats.data.viewevents.topViewed.slice(0, 5).map((row, i) => (
              <li
                key={row.id}
                className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-3"
              >
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-rose-600/20 font-mono text-xs font-black text-rose-300">
                  {i + 1}
                </span>
                {row.thumbnail ? (
                  <img src={row.thumbnail} alt="" loading="lazy" className="h-12 w-8 shrink-0 rounded object-cover border border-white/10" />
                ) : (
                  <span className="grid h-12 w-8 shrink-0 place-items-center rounded border border-white/10 bg-white/[0.04] text-zinc-600">
                    <Layers className="h-3.5 w-3.5" aria-hidden />
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <button
                    type="button"
                    onClick={() => navigate(`/content/${row.id}`)}
                    className="line-clamp-1 text-left text-xs font-bold text-zinc-100 transition hover:text-rose-300"
                  >
                    {row.title}
                  </button>
                  <p className="font-mono text-[10px] text-zinc-500">{formatRo(row.views)} vizionări</p>
                </div>
              </li>
            ))}
          </ol>
        </Section>
      ) : null}

      {hubStats.data == null && !hubStats.loading && hubStats.error == null ? (
        <EmptyState title="Statistici indisponibile" message="Nu am putut încărca statisticile hub." />
      ) : null}
    </Container>
  );
}
