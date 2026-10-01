'use client';

/**
 * admin-analytics-tab.tsx — Platform analytics overview for the admin panel
 * (TS2b: extins). Keeps the original 14-day views AreaChart and adds:
 *   • PieChart — plays per content type (aggregated from the playerhub
 *     top-10 most-watched titles — honest label, real view data)
 *   • BarChart — top 10 most-watched titles (playerhub topWatched plays)
 *   • AreaChart — search latency p50/p95, collected locally at every 15s
 *     refresh from /api/search/status (last 40 samples)
 *   • StatCards — total users, 24h plays, metadata completeness, cache hit-rate
 *
 * Note: /api/analytics/overview is auth+admin-gated on the backend, so this
 * tab calls it through the exported `authRequest` helper (Bearer + refresh).
 */

import { useEffect, useState } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from 'recharts';
import {
  BarChart3,
  Database,
  Eye,
  Film,
  Layers,
  Lock,
  MessageSquare,
  Play,
  RefreshCw,
  Search,
  Timer,
  UserRound,
} from 'lucide-react';
import { api, BACKEND_PORT } from '@/lib/animaxia/api';
import { authRequest, type AnalyticsOverview } from '@/lib/animaxia/platform';
import { useAuth } from '../auth-provider';
import { useApi } from '@/lib/animaxia/hooks';
import { navigate } from '@/lib/animaxia/router';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import { EmptyState, ErrorState, TypeBadge } from '../states';

/* ------------------------------- helpers ------------------------------- */

const MAX_LATENCY_SAMPLES = 40;

function isForbidden(message: string | null): boolean {
  return Boolean(message && /admin access required|forbidden|status 40[13]/i.test(message));
}

function timeAgo(iso?: string | null): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diff = Date.now() - then;
  if (diff < 60_000) return 'chiar acum';
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `acum ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `acum ${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `acum ${days}z`;
  return new Date(iso).toLocaleDateString('ro-RO', { month: 'short', day: 'numeric' });
}

function shortDay(date: string): string {
  const d = new Date(`${date}T00:00:00`);
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString('ro-RO', { month: 'short', day: 'numeric' });
}

const PLAN_COLORS: Record<string, { bar: string; text: string }> = {
  free: { bar: 'bg-zinc-400', text: 'text-zinc-300' },
  plus: { bar: 'bg-rose-500', text: 'text-rose-300' },
  pro: { bar: 'bg-amber-400', text: 'text-amber-300' },
};

/** Type palette for the pie chart (same family as the platform accents). */
const TYPE_COLORS: Record<string, string> = {
  movie: '#f43f5e',
  tv: '#f59e0b',
  anime: '#a78bfa',
  featured: '#34d399',
  mined: '#22d3ee',
  page: '#94a3b8',
  video: '#fb7185',
};

const chartConfig = {
  views: { label: 'Vizionări', color: '#f43f5e' },
} satisfies ChartConfig;

const playsConfig = {
  plays: { label: 'Redări', color: '#f59e0b' },
} satisfies ChartConfig;

const latencyConfig = {
  p50: { label: 'p50', color: '#34d399' },
  p95: { label: 'p95', color: '#f43f5e' },
} satisfies ChartConfig;

/* ------------------------------ lock card ------------------------------ */

function LockCard() {
  return (
    <Card className="border-rose-500/20 bg-white/[0.03]">
      <CardContent className="flex flex-col items-center gap-4 p-10 text-center">
        <div className="grid h-14 w-14 place-items-center rounded-2xl bg-rose-500/10">
          <Lock className="h-6 w-6 text-rose-400" aria-hidden />
        </div>
        <div>
          <p className="font-semibold text-zinc-100">Sunt necesare drepturi de administrator</p>
          <p className="mt-1 max-w-md text-sm text-zinc-400">
            Conectează-te ca administrator pentru a vedea statisticile platformei.
          </p>
          <p className="mt-1 text-xs text-zinc-600">Admin demo: admin@animaxia.test</p>
        </div>
        <Button className="bg-rose-600 font-bold hover:bg-rose-500" onClick={() => navigate('/auth')}>
          Conectare
        </Button>
      </CardContent>
    </Card>
  );
}

/* ------------------------------ stat card ------------------------------ */

function MetricCard({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
}) {
  return (
    <Card className="border-white/10 bg-white/[0.03]">
      <CardContent className="flex items-center gap-3 p-4">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-white/10 bg-white/[0.04]">
          {icon}
        </span>
        <div className="min-w-0">
          <p className="truncate text-2xl font-black leading-tight text-white">{value}</p>
          <p className="text-[11px] font-semibold uppercase tracking-widest text-zinc-500">{label}</p>
        </div>
      </CardContent>
    </Card>
  );
}

/* -------------------------------- tab ---------------------------------- */

interface LatencySample {
  t: string;
  p50: number;
  p95: number;
}

export function AdminAnalyticsTab() {
  const { isAdmin, initializing } = useAuth();

  const overview = useApi(
    `admin:analytics:${isAdmin}`,
    () => authRequest<AnalyticsOverview>(`/api/analytics/overview?XTransformPort=${BACKEND_PORT}`),
    { enabled: !initializing && isAdmin },
  );
  const playerhub = useApi('admin:analytics:playerhub', () => api.playerhub.status(), {
    enabled: !initializing && isAdmin,
  });
  const hub = useApi('admin:analytics:hub', () => api.hub.stats());
  const searchStatus = useApi('admin:analytics:search', () => api.searchStatus());
  const metrics = useApi('admin:analytics:metrics', () => api.metricsJson());

  /* Local latency history — every fresh /api/search/status payload adds one
     sample (capped at 40); the chart renders what was actually observed. */
  const [latencyHistory, setLatencyHistory] = useState<LatencySample[]>([]);

  useEffect(() => {
    const data = searchStatus.data;
    if (!data) return undefined;
    const timer = setTimeout(() => {
      const stage = (data.pipelineStages ?? []).find((s) => s.name === 'neon-fts');
      const ftsStats = (stage?.stats ?? {}) as { p50Ms?: number; p95Ms?: number };
      const p50 = data.latency?.p50Ms ?? Number(ftsStats.p50Ms ?? 0);
      const p95 = data.latency?.p95Ms ?? Number(ftsStats.p95Ms ?? 0);
      setLatencyHistory((prev) =>
        [...prev, { t: new Date().toLocaleTimeString('ro-RO', { hour12: false }), p50, p95 }].slice(
          -MAX_LATENCY_SAMPLES,
        ),
      );
    }, 0);
    return () => clearTimeout(timer);
  }, [searchStatus.data]);

  /* NEON FREE PLAN: auto-refresh 15s ELIMINAT — montare + Refresh manual
   * (latency history + cache hit-rate se actualizează la cerere). */

  /* A 403 means the session is no longer admin — surface the lock card. */
  const locked = !initializing && (!isAdmin || (overview.error != null && isForbidden(overview.error)));

  if (locked) return <LockCard />;

  if (overview.loading && !overview.data) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-64 rounded-xl" />
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-64 rounded-xl" />
          <Skeleton className="h-64 rounded-xl" />
        </div>
      </div>
    );
  }

  if (overview.error && !overview.data) {
    return <ErrorState message={overview.error} onRetry={overview.refetch} compact />;
  }

  const data = overview.data;
  if (!data) return null;

  const totals = data.totals;
  const plans = data.planDistribution ?? {};
  const planKeys = ['free', 'plus', 'pro'].filter((k) => k in plans);
  const planTotal = planKeys.reduce((sum, k) => sum + (plans[k] ?? 0), 0);

  const topWatched = playerhub.data?.topWatched ?? [];
  /* Pie data — plays aggregated per content type across the top-watched set. */
  const pieByType = Object.entries(
    topWatched.reduce<Record<string, number>>((acc, item) => {
      const key = item.type || 'necunoscut';
      acc[key] = (acc[key] ?? 0) + (item.plays ?? 0);
      return acc;
    }, {}),
  ).map(([name, plays]) => ({ name, plays }));

  const cacheCollector = metrics.data?.collectors?.cache as
    | { hitRate?: number; hits?: number; misses?: number; keys?: number }
    | undefined;
  const cacheHitPct =
    cacheCollector?.hitRate != null
      ? cacheCollector.hitRate <= 1
        ? Math.round(cacheCollector.hitRate * 100)
        : Math.round(cacheCollector.hitRate)
      : null;

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-zinc-500">
          Metrici live ale platformei — vizionări, redări și audiență (actualizare manuală pe sursele publice).
        </p>
        <Button
          variant="outline"
          size="sm"
          className="border-white/15 bg-white/5 font-semibold hover:bg-white/10"
          onClick={() => {
            void overview.refetch();
            void playerhub.refetch();
            void hub.refetch();
            void searchStatus.refetch();
            void metrics.refetch();
          }}
        >
          <RefreshCw aria-hidden /> Reîmprospătează
        </Button>
      </div>

      {/* Stat cards (TS2b) */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MetricCard
          icon={<UserRound className="h-5 w-5 text-rose-400" aria-hidden />}
          label="Utilizatori totali"
          value={totals.users}
        />
        <MetricCard
          icon={<Play className="h-5 w-5 text-lime-400" aria-hidden />}
          label="Redări ultimele 24h"
          value={playerhub.data?.playback.last24h ?? '—'}
        />
        <MetricCard
          icon={<Database className="h-5 w-5 text-amber-400" aria-hidden />}
          label="Completitudine metadate"
          value={`${hub.data?.metadataCompleteness ?? '—'}%`}
        />
        <MetricCard
          icon={<Layers className="h-5 w-5 text-teal-400" aria-hidden />}
          label="Rată cache hit"
          value={cacheHitPct != null ? `${cacheHitPct}%` : '—'}
        />
      </div>

      {/* Totals (original cards) */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <MetricCard icon={<UserRound className="h-5 w-5 text-rose-400" aria-hidden />} label="Utilizatori" value={totals.users} />
        <MetricCard icon={<Film className="h-5 w-5 text-amber-400" aria-hidden />} label="Conținut" value={totals.content} />
        <MetricCard
          icon={<MessageSquare className="h-5 w-5 text-teal-400" aria-hidden />}
          label="Comentarii"
          value={totals.comments}
        />
        <MetricCard icon={<Eye className="h-5 w-5 text-fuchsia-400" aria-hidden />} label="Vizionări" value={totals.views} />
        <MetricCard icon={<Play className="h-5 w-5 text-lime-400" aria-hidden />} label="Redări" value={totals.plays} />
      </div>

      {/* Views chart (original, 14 days) */}
      <Card className="border-white/10 bg-white/[0.03]">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <BarChart3 className="h-4 w-4 text-rose-400" aria-hidden />
            Vizionări — ultimele 14 zile
          </CardTitle>
          <CardDescription>Evenimente de vizionare zilnice, pe toate titlurile.</CardDescription>
        </CardHeader>
        <CardContent>
          <ChartContainer config={chartConfig} className="h-64 w-full">
            <AreaChart data={data.viewsByDay} margin={{ left: 4, right: 8, top: 8, bottom: 0 }}>
              <defs>
                <linearGradient id="fillViews" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#f43f5e" stopOpacity={0.45} />
                  <stop offset="95%" stopColor="#f43f5e" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} stroke="rgba(255,255,255,0.08)" />
              <XAxis
                dataKey="date"
                tickLine={false}
                axisLine={false}
                minTickGap={24}
                tickFormatter={(value: string) => shortDay(value)}
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
                cursor={{ stroke: 'rgba(244,63,94,0.35)' }}
                content={
                  <ChartTooltipContent
                    className="border-white/10 bg-[#1a1a24] text-zinc-200"
                    labelFormatter={(value) => (typeof value === 'string' ? shortDay(value) : value)}
                  />
                }
              />
              <Area
                dataKey="count"
                type="monotone"
                stroke="#f43f5e"
                strokeWidth={2}
                fill="url(#fillViews)"
                name="Vizionări"
                dot={false}
                activeDot={{ r: 4, fill: '#f43f5e' }}
              />
            </AreaChart>
          </ChartContainer>
        </CardContent>
      </Card>

      {/* TS2b: plays pie by type + top-10 bar + latency area */}
      <div className="grid gap-4 lg:grid-cols-2">
        {/* (a) PieChart — plays per content type */}
        <Card className="border-white/10 bg-white/[0.03]">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Layers className="h-4 w-4 text-rose-400" aria-hidden />
              Redări pe tip de conținut
            </CardTitle>
            <CardDescription>
              Agregat din top 10 titluri vizionate (playerhub) — date reale de redare.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {pieByType.length === 0 || pieByType.every((d) => d.plays === 0) ? (
              <EmptyState
                title="Nicio redare încă"
                message="Graficul se umplu pe măsură ce titlurile sunt vizionate."
              />
            ) : (
              <ChartContainer config={playsConfig} className="h-64 w-full">
                <PieChart>
                  <ChartTooltip
                    content={<ChartTooltipContent className="border-white/10 bg-[#1a1a24] text-zinc-200" nameKey="name" />}
                  />
                  <Pie data={pieByType} dataKey="plays" nameKey="name" innerRadius={45} outerRadius={85} paddingAngle={3}>
                    {pieByType.map((entry) => (
                      <Cell key={entry.name} fill={TYPE_COLORS[entry.name] ?? '#71717a'} stroke="#0a0a10" strokeWidth={2} />
                    ))}
                  </Pie>
                </PieChart>
              </ChartContainer>
            )}
            {pieByType.length > 0 && (
              <div className="mt-2 flex flex-wrap justify-center gap-2">
                {pieByType.map((entry) => (
                  <span
                    key={entry.name}
                    className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[11px] font-medium text-zinc-300"
                  >
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: TYPE_COLORS[entry.name] ?? '#71717a' }}
                      aria-hidden
                    />
                    {entry.name} · {entry.plays}
                  </span>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* (b) BarChart — top 10 most watched */}
        <Card className="border-white/10 bg-white/[0.03]">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Play className="h-4 w-4 text-amber-400" aria-hidden />
              Top 10 titluri vizionate
            </CardTitle>
            <CardDescription>Numărul de redări per titlu (playerhub live).</CardDescription>
          </CardHeader>
          <CardContent>
            {topWatched.length === 0 ? (
              <EmptyState title="Nicio redare încă" message="Topul se compilează din evenimentele de redare." />
            ) : (
              <ChartContainer config={playsConfig} className="h-64 w-full">
                <BarChart data={topWatched} layout="vertical" margin={{ left: 8, right: 16, top: 4, bottom: 0 }}>
                  <CartesianGrid horizontal={false} stroke="rgba(255,255,255,0.08)" />
                  <XAxis
                    type="number"
                    allowDecimals={false}
                    tickLine={false}
                    axisLine={false}
                    tick={{ fill: '#71717a', fontSize: 11 }}
                  />
                  <YAxis
                    type="category"
                    dataKey="title"
                    width={130}
                    tickLine={false}
                    axisLine={false}
                    tick={{ fill: '#a1a1aa', fontSize: 10 }}
                    tickFormatter={(value: string) => (value.length > 20 ? `${value.slice(0, 19)}…` : value)}
                  />
                  <ChartTooltip
                    cursor={{ fill: 'rgba(244,63,94,0.08)' }}
                    content={<ChartTooltipContent className="border-white/10 bg-[#1a1a24] text-zinc-200" />}
                  />
                  <Bar dataKey="plays" name="Redări" fill="#f59e0b" radius={[0, 4, 4, 0]} barSize={14} />
                </BarChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>
      </div>

      {/* (c) AreaChart — search latency p50/p95 (locally collected) */}
      <Card className="border-white/10 bg-white/[0.03]">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Timer className="h-4 w-4 text-emerald-400" aria-hidden />
            Latență căutare — p50 / p95
          </CardTitle>
          <CardDescription>
            Istoric local colectat la fiecare refresh (15s) din /api/search/status — ultimele{' '}
            {MAX_LATENCY_SAMPLES} mostre. Mostre server acum: {searchStatus.data?.latency?.samples ?? 0}.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {latencyHistory.length < 2 ? (
            <EmptyState
              icon={<Search className="h-6 w-6" aria-hidden />}
              title="Se colectează mostre…"
              message="Graficul se populează cu fiecare refresh; valorile devin non-zero după ce se execută căutări reale."
            />
          ) : (
            <ChartContainer config={latencyConfig} className="h-56 w-full">
              <AreaChart data={latencyHistory} margin={{ left: 4, right: 8, top: 8, bottom: 0 }}>
                <defs>
                  <linearGradient id="fillP50" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#34d399" stopOpacity={0.35} />
                    <stop offset="95%" stopColor="#34d399" stopOpacity={0.02} />
                  </linearGradient>
                  <linearGradient id="fillP95" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#f43f5e" stopOpacity={0.35} />
                    <stop offset="95%" stopColor="#f43f5e" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} stroke="rgba(255,255,255,0.08)" />
                <XAxis
                  dataKey="t"
                  tickLine={false}
                  axisLine={false}
                  minTickGap={40}
                  tick={{ fill: '#71717a', fontSize: 10 }}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  width={40}
                  tick={{ fill: '#71717a', fontSize: 11 }}
                  tickFormatter={(value: number) => `${Math.round(value)}ms`}
                />
                <ChartTooltip
                  cursor={{ stroke: 'rgba(52,211,153,0.35)' }}
                  content={
                    <ChartTooltipContent
                      className="border-white/10 bg-[#1a1a24] text-zinc-200"
                      formatter={(value) => (typeof value === 'number' ? `${Math.round(value)}ms` : value)}
                    />
                  }
                />
                <Area
                  dataKey="p95"
                  type="monotone"
                  stroke="#f43f5e"
                  strokeWidth={2}
                  fill="url(#fillP95)"
                  name="p95"
                  dot={false}
                />
                <Area
                  dataKey="p50"
                  type="monotone"
                  stroke="#34d399"
                  strokeWidth={2}
                  fill="url(#fillP50)"
                  name="p50"
                  dot={false}
                />
              </AreaChart>
            </ChartContainer>
          )}
        </CardContent>
      </Card>

      {/* Top content + plans (original) */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="border-white/10 bg-white/[0.03]">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Conținut de top</CardTitle>
            <CardDescription>Titlurile cele mai vizionate pe platformă.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {data.topContent.length === 0 ? (
              <EmptyState title="Nicio vizionare încă" message="Vizionările apar aici după ce se urmărește conținut." />
            ) : (
              data.topContent.map((c, i) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => navigate(`/content/${c.id}`)}
                  className="flex w-full items-center gap-3 rounded-xl border border-white/5 bg-white/[0.02] p-2 text-left transition hover:border-rose-500/30 hover:bg-white/[0.05]"
                >
                  <span className="w-5 shrink-0 text-center text-xs font-black text-zinc-600">{i + 1}</span>
                  {c.thumbnail ? (
                    <img
                      src={c.thumbnail}
                      alt=""
                      loading="lazy"
                      className="h-12 w-8 shrink-0 rounded object-cover"
                    />
                  ) : (
                    <span className="grid h-12 w-8 shrink-0 place-items-center rounded bg-gradient-to-br from-white/10 to-white/[0.03]">
                      <Film className="h-3.5 w-3.5 text-zinc-600" aria-hidden />
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-zinc-100">{c.title}</span>
                    <TypeBadge type={c.type} />
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="block text-sm font-bold text-rose-300">{c.views}</span>
                    <span className="block text-[10px] uppercase tracking-wider text-zinc-600">vizionări</span>
                  </span>
                </button>
              ))
            )}
          </CardContent>
        </Card>

        <Card className="border-white/10 bg-white/[0.03]">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Distribuția planurilor</CardTitle>
            <CardDescription>Utilizatori per nivel de abonament.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {planKeys.length === 0 || planTotal === 0 ? (
              <EmptyState title="Niciun utilizator încă" message="Înregistrările vor apărea aici." />
            ) : (
              planKeys.map((key) => {
                const count = plans[key] ?? 0;
                const pct = planTotal > 0 ? Math.round((count / planTotal) * 100) : 0;
                const colors = PLAN_COLORS[key] ?? PLAN_COLORS.free;
                return (
                  <div key={key} className="space-y-1.5">
                    <div className="flex items-center justify-between text-sm">
                      <span className={`font-semibold capitalize ${colors.text}`}>{key}</span>
                      <span className="text-zinc-400">
                        {count} {count === 1 ? 'utilizator' : 'utilizatori'} · {pct}%
                      </span>
                    </div>
                    <div
                      role="progressbar"
                      aria-label={`Cota planului ${key}`}
                      aria-valuenow={pct}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      className="h-2 w-full overflow-hidden rounded-full bg-white/10"
                    >
                      <div
                        className={`h-full rounded-full ${colors.bar} transition-all`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>
      </div>

      {/* Active users + recent signups (original) */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="border-white/10 bg-white/[0.03]">
          <CardContent className="flex items-center gap-4 p-5">
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl border border-rose-500/30 bg-rose-500/10">
              <UserRound className="h-5 w-5 text-rose-400" aria-hidden />
            </span>
            <div>
              <p className="text-3xl font-black leading-none text-white">{data.activeUsers7d}</p>
              <p className="mt-1 text-xs font-semibold uppercase tracking-widest text-zinc-500">
                Utilizatori activi (7 zile)
              </p>
            </div>
          </CardContent>
        </Card>

        <Card className="border-white/10 bg-white/[0.03]">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Înregistrări recente</CardTitle>
          </CardHeader>
          <CardContent>
            {data.recentSignups.length === 0 ? (
              <p className="text-sm text-zinc-500">Nicio înregistrare încă.</p>
            ) : (
              <ul className="divide-y divide-white/5">
                {data.recentSignups.map((s) => (
                  <li key={s.username + s.createdat} className="flex items-center justify-between gap-3 py-2">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-gradient-to-br from-rose-500/30 to-fuchsia-500/20 text-[11px] font-bold text-rose-200">
                        {s.username.slice(0, 1).toUpperCase()}
                      </span>
                      <span className="truncate text-sm font-medium text-zinc-200">{s.username}</span>
                    </span>
                    <span className="shrink-0 text-xs text-zinc-500">{timeAgo(s.createdat)}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
