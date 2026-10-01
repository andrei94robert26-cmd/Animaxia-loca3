'use client';

/**
 * admin-analytics-tab.tsx — Platform analytics overview for the admin panel:
 * totals, a 14-day views chart (recharts via the shadcn chart wrapper), top
 * content, plan distribution, active users and recent signups.
 *
 * Note: /api/analytics/overview is auth+admin-gated on the backend, but the
 * frozen platform client sends it anonymously — so this tab calls it through
 * the exported `authRequest` helper (Bearer token + auto refresh) instead.
 */

import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { BarChart3, Eye, Film, Lock, MessageSquare, Play, RefreshCw, UserRound } from 'lucide-react';
import { authRequest, type AnalyticsOverview } from '@/lib/animaxia/platform';
import { BACKEND_PORT } from '@/lib/animaxia/api';
import { useAuth } from '../auth-provider';
import { useApi } from '@/lib/animaxia/hooks';
import { navigate } from '@/lib/animaxia/router';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import { EmptyState, ErrorState, TypeBadge } from '../states';

/* ------------------------------- helpers ------------------------------- */

function isForbidden(message: string | null): boolean {
  return Boolean(message && /admin access required|forbidden|status 40[13]/i.test(message));
}

function timeAgo(iso?: string | null): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diff = Date.now() - then;
  if (diff < 60_000) return 'just now';
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function shortDay(date: string): string {
  const d = new Date(`${date}T00:00:00`);
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

const PLAN_COLORS: Record<string, { bar: string; text: string }> = {
  free: { bar: 'bg-zinc-400', text: 'text-zinc-300' },
  plus: { bar: 'bg-rose-500', text: 'text-rose-300' },
  pro: { bar: 'bg-amber-400', text: 'text-amber-300' },
};

const chartConfig = {
  views: { label: 'Views', color: '#f43f5e' },
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
          <p className="font-semibold text-zinc-100">Admin access required</p>
          <p className="mt-1 max-w-md text-sm text-zinc-400">
            Sign in as an administrator to view platform analytics.
          </p>
        </div>
        <Button className="bg-rose-600 font-bold hover:bg-rose-500" onClick={() => navigate('/auth')}>
          Sign in
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

export function AdminAnalyticsTab() {
  const { isAdmin, initializing } = useAuth();

  const overview = useApi(
    `admin:analytics:${isAdmin}`,
    () => authRequest<AnalyticsOverview>(`/api/analytics/overview?XTransformPort=${BACKEND_PORT}`),
    { enabled: !initializing && isAdmin },
  );

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

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-zinc-500">Live platform metrics — views, plays and audience.</p>
        <Button
          variant="outline"
          size="sm"
          className="border-white/15 bg-white/5 font-semibold hover:bg-white/10"
          onClick={() => overview.refetch()}
        >
          <RefreshCw aria-hidden /> Refresh
        </Button>
      </div>

      {/* Totals */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <MetricCard icon={<UserRound className="h-5 w-5 text-rose-400" aria-hidden />} label="Users" value={totals.users} />
        <MetricCard icon={<Film className="h-5 w-5 text-amber-400" aria-hidden />} label="Content" value={totals.content} />
        <MetricCard
          icon={<MessageSquare className="h-5 w-5 text-teal-400" aria-hidden />}
          label="Comments"
          value={totals.comments}
        />
        <MetricCard icon={<Eye className="h-5 w-5 text-fuchsia-400" aria-hidden />} label="Views" value={totals.views} />
        <MetricCard icon={<Play className="h-5 w-5 text-lime-400" aria-hidden />} label="Plays" value={totals.plays} />
      </div>

      {/* Views chart */}
      <Card className="border-white/10 bg-white/[0.03]">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <BarChart3 className="h-4 w-4 text-rose-400" aria-hidden />
            Views — last 14 days
          </CardTitle>
          <CardDescription>Daily view events across every title.</CardDescription>
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
                name="Views"
                dot={false}
                activeDot={{ r: 4, fill: '#f43f5e' }}
              />
            </AreaChart>
          </ChartContainer>
        </CardContent>
      </Card>

      {/* Top content + plans */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="border-white/10 bg-white/[0.03]">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Top content</CardTitle>
            <CardDescription>Most-viewed titles on the platform.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {data.topContent.length === 0 ? (
              <EmptyState title="No views yet" message="Views will appear once titles are watched." />
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
                    <span className="block text-[10px] uppercase tracking-wider text-zinc-600">views</span>
                  </span>
                </button>
              ))
            )}
          </CardContent>
        </Card>

        <Card className="border-white/10 bg-white/[0.03]">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Plan distribution</CardTitle>
            <CardDescription>Users per subscription tier.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {planKeys.length === 0 || planTotal === 0 ? (
              <EmptyState title="No users yet" message="Signups will show up here." />
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
                        {count} user{count === 1 ? '' : 's'} · {pct}%
                      </span>
                    </div>
                    <div
                      role="progressbar"
                      aria-label={`${key} plan share`}
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

      {/* Active users + recent signups */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="border-white/10 bg-white/[0.03]">
          <CardContent className="flex items-center gap-4 p-5">
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl border border-rose-500/30 bg-rose-500/10">
              <UserRound className="h-5 w-5 text-rose-400" aria-hidden />
            </span>
            <div>
              <p className="text-3xl font-black leading-none text-white">{data.activeUsers7d}</p>
              <p className="mt-1 text-xs font-semibold uppercase tracking-widest text-zinc-500">
                Active users (7 days)
              </p>
            </div>
          </CardContent>
        </Card>

        <Card className="border-white/10 bg-white/[0.03]">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Recent signups</CardTitle>
          </CardHeader>
          <CardContent>
            {data.recentSignups.length === 0 ? (
              <p className="text-sm text-zinc-500">No signups yet.</p>
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
