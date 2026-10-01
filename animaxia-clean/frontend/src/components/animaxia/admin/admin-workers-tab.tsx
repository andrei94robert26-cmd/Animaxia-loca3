'use client';

/**
 * admin-workers-tab.tsx — Worker-threads operations: pool/job stats, admin
 * actions (TMDB/Jikan refresh, missing thumbnails), scheduler status and the
 * live jobs table. Polls every 5 s while mounted (pauses on hidden tabs).
 */

import { useEffect, useState } from 'react';
import { AlertTriangle, Cpu, ImagePlus, ListChecks, Lock, RefreshCw, Timer } from 'lucide-react';
import { toast } from 'sonner';
import { platform, type WorkerJob } from '@/lib/animaxia/platform';
import { useAuth } from '../auth-provider';
import { useApi } from '@/lib/animaxia/hooks';
import { navigate } from '@/lib/animaxia/router';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { EmptyState, ErrorState } from '../states';

/* ------------------------------- helpers ------------------------------- */

function isForbidden(message: string | null): boolean {
  return Boolean(message && /admin access required|forbidden|authentication required|status 40[13]/i.test(message));
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
  return `${Math.floor(hours / 24)}d ago`;
}

function timeUntil(iso?: string | null): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diff = then - Date.now();
  if (diff <= 0) return 'due now';
  const mins = Math.ceil(diff / 60_000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.round(mins / 60);
  return `in ${hours}h`;
}

function formatInterval(ms: number): string {
  if (ms % 3_600_000 === 0) return `every ${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `every ${ms / 60_000} min`;
  return `every ${Math.round(ms / 1000)}s`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function jobDuration(job: WorkerJob): string {
  if (job.finishedat && job.queuedat) {
    const ms = new Date(job.finishedat).getTime() - new Date(job.queuedat).getTime();
    if (Number.isFinite(ms) && ms >= 0) return formatDuration(ms);
  }
  if (job.startedat && job.status === 'running') {
    const ms = Date.now() - new Date(job.startedat).getTime();
    if (Number.isFinite(ms) && ms >= 0) return `${formatDuration(ms)} · running`;
  }
  return timeAgo(job.queuedat);
}

const JOB_TYPE_CLASS: Record<string, string> = {
  mine: 'border-fuchsia-500/30 bg-fuchsia-500/15 text-fuchsia-300',
  prefetch: 'border-teal-500/30 bg-teal-500/15 text-teal-300',
  thumbnail: 'border-amber-500/30 bg-amber-500/15 text-amber-300',
  refresh: 'border-lime-500/30 bg-lime-500/15 text-lime-300',
};

const JOB_STATUS_CLASS: Record<string, string> = {
  done: 'border-emerald-500/30 bg-emerald-500/15 text-emerald-300',
  running: 'border-amber-500/30 bg-amber-500/15 text-amber-300',
  queued: 'border-zinc-500/30 bg-zinc-500/15 text-zinc-300',
  failed: 'border-rose-500/30 bg-rose-500/15 text-rose-300',
};

function JobTypeBadge({ type }: { type: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
        JOB_TYPE_CLASS[type] ?? 'border-zinc-500/30 bg-zinc-500/15 text-zinc-300',
      )}
    >
      {type}
    </span>
  );
}

function JobStatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
        JOB_STATUS_CLASS[status] ?? JOB_STATUS_CLASS.queued,
        status === 'running' && 'animate-pulse',
      )}
    >
      {status === 'running' && <span className="h-1.5 w-1.5 rounded-full bg-amber-400" aria-hidden />}
      {status}
    </span>
  );
}

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
            Sign in as an administrator to operate the worker pool.
          </p>
        </div>
        <Button className="bg-rose-600 font-bold hover:bg-rose-500" onClick={() => navigate('/auth')}>
          Sign in
        </Button>
      </CardContent>
    </Card>
  );
}

/* -------------------------------- tab ---------------------------------- */

type Action = 'tmdb' | 'jikan' | 'thumbnails' | null;

export function AdminWorkersTab() {
  const { isAdmin, initializing } = useAuth();
  const [action, setAction] = useState<Action>(null);

  const status = useApi(`admin:workers:status:${isAdmin}`, () => platform.workerStatus(), {
    enabled: !initializing && isAdmin,
  });
  const jobs = useApi(`admin:workers:jobs:${isAdmin}`, () => platform.workerJobs(), {
    enabled: !initializing && isAdmin,
  });

  /* Poll both endpoints every 5s while mounted (pause when the tab is hidden). */
  useEffect(() => {
    if (!isAdmin) return undefined;
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void status.refetch();
      void jobs.refetch();
    }, 5000);
    return () => clearInterval(timer);
  }, [isAdmin, status.refetch, jobs.refetch]);

  const locked = !initializing && (!isAdmin || isForbidden(status.error) || isForbidden(jobs.error));
  if (locked) return <LockCard />;

  async function handleRefresh(source: 'tmdb' | 'jikan') {
    if (action) return;
    setAction(source);
    try {
      const res = await platform.workerRefresh(source);
      toast.success(`Queued ${source} refresh — job ${res.jobId.slice(0, 8)}`);
      void jobs.refetch();
      void status.refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to queue refresh');
    } finally {
      setAction(null);
    }
  }

  async function handleThumbnails() {
    if (action) return;
    setAction('thumbnails');
    try {
      const res = await platform.workerThumbnails({ missing: true });
      toast.success(`Thumbnail job queued — ${res.jobId.slice(0, 8)}`);
      void jobs.refetch();
      void status.refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to queue thumbnails');
    } finally {
      setAction(null);
    }
  }

  const loadingFirst = (status.loading && !status.data) || (jobs.loading && !jobs.data);
  const failed = status.data?.jobs.failed ?? 0;

  return (
    <div className="space-y-4">
      {/* Stat cards */}
      {loadingFirst ? (
        <div className="grid gap-3 sm:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
      ) : status.error && !status.data ? (
        <ErrorState message={status.error} onRetry={status.refetch} compact />
      ) : status.data ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <Card className="border-white/10 bg-white/[0.03]">
            <CardContent className="flex items-center gap-3 p-4">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-white/10 bg-white/[0.04]">
                <Cpu className="h-5 w-5 text-rose-400" aria-hidden />
              </span>
              <div className="min-w-0">
                <p className="truncate text-lg font-black leading-tight text-white">
                  {status.data.pool.size} worker{status.data.pool.size === 1 ? '' : 's'}
                </p>
                <p className="text-[11px] font-semibold uppercase tracking-widest text-zinc-500">
                  {status.data.pool.busy} busy · {status.data.pool.queued} queued
                </p>
              </div>
            </CardContent>
          </Card>
          <Card className="border-white/10 bg-white/[0.03]">
            <CardContent className="flex items-center gap-3 p-4">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-white/10 bg-white/[0.04]">
                <ListChecks className="h-5 w-5 text-teal-400" aria-hidden />
              </span>
              <div className="min-w-0">
                <p className="truncate text-lg font-black leading-tight text-white">
                  {status.data.jobs.done}/{status.data.jobs.total} done
                </p>
                <p className="text-[11px] font-semibold uppercase tracking-widest text-zinc-500">
                  {status.data.jobs.running} running · {status.data.jobs.total} total
                </p>
              </div>
            </CardContent>
          </Card>
          <Card className={cn('border-white/10 bg-white/[0.03]', failed > 0 && 'border-rose-500/30')}>
            <CardContent className="flex items-center gap-3 p-4">
              <span
                className={cn(
                  'grid h-10 w-10 shrink-0 place-items-center rounded-xl border',
                  failed > 0 ? 'border-rose-500/30 bg-rose-500/10' : 'border-white/10 bg-white/[0.04]',
                )}
              >
                {failed > 0 ? (
                  <AlertTriangle className="h-5 w-5 text-rose-400" aria-hidden />
                ) : (
                  <Timer className="h-5 w-5 text-amber-400" aria-hidden />
                )}
              </span>
              <div className="min-w-0">
                <p className={cn('truncate text-lg font-black leading-tight', failed > 0 ? 'text-rose-300' : 'text-white')}>
                  {failed} failed
                </p>
                <p className="text-[11px] font-semibold uppercase tracking-widest text-zinc-500">
                  {failed > 0 ? 'needs attention' : 'all jobs healthy'}
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      ) : null}

      {/* Actions */}
      <Card className="border-white/10 bg-white/[0.03]">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <RefreshCw className="h-4 w-4 text-rose-400" aria-hidden />
            Worker actions
          </CardTitle>
          <CardDescription>
            Queue background jobs on the worker pool — refresh catalog sources or generate missing thumbnails.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          <Button
            className="bg-rose-600 font-bold hover:bg-rose-500"
            disabled={action !== null}
            onClick={() => handleRefresh('tmdb')}
          >
            {action === 'tmdb' ? <RefreshCw className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
            Refresh TMDB
          </Button>
          <Button
            className="bg-rose-600 font-bold hover:bg-rose-500"
            disabled={action !== null}
            onClick={() => handleRefresh('jikan')}
          >
            {action === 'jikan' ? <RefreshCw className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
            Refresh Jikan
          </Button>
          <Button
            variant="outline"
            className="border-white/15 bg-white/5 font-semibold hover:bg-white/10"
            disabled={action !== null}
            onClick={handleThumbnails}
          >
            {action === 'thumbnails' ? <RefreshCw className="animate-spin" aria-hidden /> : <ImagePlus aria-hidden />}
            Generate missing thumbnails
          </Button>
        </CardContent>
      </Card>

      {/* Schedules */}
      {status.data && (
        <Card className="border-white/10 bg-white/[0.03]">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Schedules</CardTitle>
            <CardDescription>Recurring jobs managed by the backend scheduler.</CardDescription>
          </CardHeader>
          <CardContent>
            {status.data.schedules.length === 0 ? (
              <p className="text-sm text-zinc-500">No schedules configured.</p>
            ) : (
              <ul className="divide-y divide-white/5">
                {status.data.schedules.map((s) => (
                  <li key={s.name} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="font-mono text-sm font-semibold text-zinc-100">{s.name}</span>
                      <span
                        className={cn(
                          'inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
                          s.enabled
                            ? 'border-emerald-500/30 bg-emerald-500/15 text-emerald-300'
                            : 'border-zinc-500/30 bg-zinc-500/15 text-zinc-400',
                        )}
                      >
                        {s.enabled ? 'enabled' : 'disabled'}
                      </span>
                    </div>
                    <div className="text-xs text-zinc-500">
                      <span className="text-zinc-300">{formatInterval(s.intervalMs)}</span>
                      <span className="mx-2" aria-hidden>
                        ·
                      </span>
                      last {timeAgo(s.lastRunAt)} · next {timeUntil(s.nextRunAt)}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      {/* Jobs table */}
      <Card className="border-white/10 bg-white/[0.03]">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Recent jobs</CardTitle>
          <CardDescription>The 20 most recent jobs across the pool — refreshes every 5 seconds.</CardDescription>
        </CardHeader>
        <CardContent>
          {jobs.loading && !jobs.data ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full rounded-xl" />
              ))}
            </div>
          ) : jobs.error && !jobs.data ? (
            <ErrorState message={jobs.error} onRetry={jobs.refetch} compact />
          ) : !jobs.data || jobs.data.data.length === 0 ? (
            <EmptyState title="No jobs yet" message="Queue an action above to see jobs appear here." />
          ) : (
            <div className="custom-scrollbar max-h-96 overflow-y-auto rounded-xl border border-white/10 bg-white/[0.02]">
              <Table className="min-w-[720px]">
                <TableHeader className="sticky top-0 z-10 bg-[#16161f]">
                  <TableRow className="border-white/10 hover:bg-transparent">
                    <TableHead className="text-zinc-400">Type</TableHead>
                    <TableHead className="text-zinc-400">Status</TableHead>
                    <TableHead className="text-zinc-400">Timing</TableHead>
                    <TableHead className="text-zinc-400">Result</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {jobs.data.data.map((job) => {
                    const summary =
                      job.error ?? (job.result != null ? JSON.stringify(job.result) : '—');
                    const truncated = summary.length > 46 ? `${summary.slice(0, 46)}…` : summary;
                    return (
                      <TableRow key={job.id} className="border-white/5">
                        <TableCell>
                          <JobTypeBadge type={job.type} />
                        </TableCell>
                        <TableCell>
                          <JobStatusBadge status={job.status} />
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs text-zinc-400">
                          {jobDuration(job)}
                        </TableCell>
                        <TableCell className="max-w-[280px]">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span
                                className={cn(
                                  'block cursor-help truncate font-mono text-xs',
                                  job.error ? 'text-rose-300' : 'text-zinc-400',
                                )}
                              >
                                {truncated}
                              </span>
                            </TooltipTrigger>
                            <TooltipContent
                              side="bottom"
                              className="max-w-md break-all border-white/10 bg-[#1a1a24] font-mono text-xs text-zinc-200"
                            >
                              {summary}
                            </TooltipContent>
                          </Tooltip>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
