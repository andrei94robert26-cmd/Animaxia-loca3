'use client';

/**
 * admin-miner-tab.tsx — FAZA 12 Miner console: ingest pipeline status, job
 * queue with manual runs, per-tenant sync state and counters. Deep-linked
 * via #/admin/ingest. Read surface is public; every mutation requires the
 * admin session (backend enforces requireAdmin on /api/miner/* POSTs).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Database,
  DatabaseZap,
  Layers,
  Loader2,
  Lock,
  Play,
  Plus,
  RefreshCw,
  Search,
  Server,
} from 'lucide-react';
import { toast } from 'sonner';
import { minerApi, MINER_JOB_TYPES, type MinerJob, type MinerJobStatus, type MinerStatus, type MinerJobType } from '@/lib/animaxia/miner';
import { useApi } from '@/lib/animaxia/hooks';
import { navigate } from '@/lib/animaxia/router';
import { useAuth } from '../auth-provider';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
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
import { EmptyState, ErrorState } from '../states';

/* ------------------------------- helpers --------------------------------- */

const STATUS_TONE: Record<MinerJobStatus, string> = {
  queued: 'border-amber-500/30 bg-amber-500/15 text-amber-300',
  running: 'border-sky-500/30 bg-sky-500/15 text-sky-300',
  done: 'border-emerald-500/30 bg-emerald-500/15 text-emerald-300',
  failed: 'border-rose-500/30 bg-rose-500/15 text-rose-300',
};

function StatusBadge({ status }: { status: MinerJobStatus }) {
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide', STATUS_TONE[status] ?? STATUS_TONE.queued)}>
      {status === 'running' && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
      {status}
    </span>
  );
}

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '—';
  }
}

function fmtDuration(job: MinerJob): string {
  if (!job.startedat || !job.finishedat) return '—';
  const ms = new Date(job.finishedat).getTime() - new Date(job.startedat).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function resultSummary(job: MinerJob): string {
  if (job.status === 'failed') return job.error ?? 'failed';
  const r = job.result;
  if (!r) return '—';
  const bits: string[] = [];
  if (r.upserted != null) bits.push(`${r.upserted} upserted`);
  if (r.created != null && r.created > 0) bits.push(`${r.created} new`);
  if (r.indexed != null) bits.push(`${r.indexed} indexed`);
  if (r.pushed != null) bits.push(`${r.pushed} pushed`);
  if (r.found != null) bits.push(`${r.found} manifests`);
  if (r.scanned != null) bits.push(`${r.scanned} scanned`);
  if (r.scope) bits.push(`scope: ${r.scope}`);
  return bits.join(' · ') || '—';
}

/* ------------------------------ forbidden -------------------------------- */

function ForbiddenCard() {
  return (
    <Card className="border-rose-500/20 bg-white/[0.03]">
      <CardContent className="flex flex-col items-center gap-4 p-10 text-center">
        <div className="grid h-14 w-14 place-items-center rounded-2xl bg-rose-500/10">
          <Lock className="h-6 w-6 text-rose-400" aria-hidden />
        </div>
        <div>
          <p className="font-semibold text-zinc-100">Admin access required</p>
          <p className="mt-1 max-w-md text-sm text-zinc-400">
            The miner console schedules ingest jobs and manages per-tenant indexes.
          </p>
        </div>
        <Button className="bg-rose-600 font-bold hover:bg-rose-500" onClick={() => navigate('/auth')}>
          Sign in as admin
        </Button>
      </CardContent>
    </Card>
  );
}

/* ------------------------------- summary ---------------------------------- */

function SummaryChips({ status }: { status: MinerStatus | null }) {
  const jobs = status?.jobs;
  const items = [
    {
      icon: Activity,
      label: 'Pool',
      value: status ? `${status.pool.running}/${status.pool.maxConcurrent} running` : '—',
      hint: 'in-process queue concurrency',
    },
    {
      icon: CheckCircle2,
      label: 'Jobs done',
      value: jobs ? String(jobs.byStatus.done ?? 0) : '—',
      hint: `${jobs?.byStatus.failed ?? 0} failed`,
      warn: (jobs?.byStatus.failed ?? 0) > 0,
    },
    {
      icon: Database,
      label: 'Sources',
      value: status ? String(status.tenants.reduce((acc, t) => acc + t.sources, 0)) : '—',
      hint: `${status?.tenants.reduce((acc, t) => acc + t.synced24h, 0) ?? 0} synced 24h`,
    },
    {
      icon: Layers,
      label: 'Manifests',
      value: status ? String(status.manifests.total) : '—',
      hint: `${status?.manifests.tenants ?? 0} tenants`,
    },
    {
      icon: Search,
      label: 'Search backend',
      value: status?.searchBackend ?? '—',
      hint: status?.searchBackend === 'opensearch' ? 'external engine' : 'local catalog',
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {items.map(({ icon: Icon, label, value, hint, warn }) => (
        <Card key={label} className="border-white/10 bg-white/[0.03]">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-zinc-400">
              <Icon className="h-3.5 w-3.5" aria-hidden />
              <span className="text-[11px] font-semibold uppercase tracking-wide">{label}</span>
            </div>
            <p className={cn('mt-2 font-mono text-lg font-bold', warn ? 'text-amber-300' : 'text-zinc-100')}>{value}</p>
            <p className="mt-0.5 text-[11px] text-zinc-500">{hint}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/* ----------------------------- schedule form ------------------------------ */

function ScheduleForm({ onScheduled }: { onScheduled: () => void }) {
  const { isAdmin } = useAuth();
  const [type, setType] = useState<MinerJobType>('daily-sync');
  const [tenant, setTenant] = useState('global');
  const [page, setPage] = useState('1');
  const [busy, setBusy] = useState(false);
  const [allBusy, setAllBusy] = useState(false);

  async function schedule(input: Parameters<typeof minerApi.schedule>[0], successMsg: string) {
    const res = await minerApi.schedule(input);
    if (res.allTenants && res.count != null) {
      toast.success(`${successMsg} — ${res.count} tenant job(s) queued`);
    } else if (res.job) {
      toast.success(`${successMsg} — job queued (${res.job.tenant})`);
    }
    onScheduled();
  }

  async function handleSchedule(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      await schedule(
        {
          type,
          tenant: tenant.trim() || 'global',
          ...(type === 'tmdb-sync' || type === 'jikan-sync' ? { page: Number(page) || 1 } : {}),
        },
        `${MINER_JOB_TYPES.find((t) => t.value === type)?.label} scheduled`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Schedule failed');
    } finally {
      setBusy(false);
    }
  }

  async function handleAllTenants() {
    if (allBusy) return;
    setAllBusy(true);
    try {
      await schedule({ type: 'daily-sync', allTenants: true }, 'Daily sync scheduled for all active tenants');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Schedule failed');
    } finally {
      setAllBusy(false);
    }
  }

  return (
    <Card className="border-white/10 bg-white/[0.03]">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Plus className="h-4 w-4 text-rose-400" aria-hidden />
          Schedule an ingest job
        </CardTitle>
        <CardDescription>
          TMDB/Jikan pages are normalized into the library, indexed per-tenant vector namespace and pushed to the
          search catalog.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={handleSchedule}>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="miner-job-type">Job type</Label>
              <Select value={type} onValueChange={(v) => setType(v as MinerJobType)}>
                <SelectTrigger id="miner-job-type" className="w-full border-white/10 bg-black/40">
                  <SelectValue placeholder="Type" />
                </SelectTrigger>
                <SelectContent className="border-white/10 bg-[#12121a]">
                  {MINER_JOB_TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label} — <span className="text-zinc-500">{t.hint}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="miner-job-tenant">Tenant</Label>
              <Input
                id="miner-job-tenant"
                value={tenant}
                onChange={(e) => setTenant(e.target.value)}
                placeholder="global"
                className="border-white/10 bg-black/40 font-mono"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="miner-job-page">Provider page</Label>
              <Input
                id="miner-job-page"
                type="number"
                min={1}
                max={500}
                value={page}
                onChange={(e) => setPage(e.target.value)}
                disabled={type !== 'tmdb-sync' && type !== 'jikan-sync'}
                className="border-white/10 bg-black/40 font-mono disabled:opacity-40"
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={busy || !isAdmin} className="bg-rose-600 font-bold hover:bg-rose-500">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />}
              Schedule job
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={allBusy || !isAdmin}
              onClick={handleAllTenants}
              className="border-white/15 bg-transparent font-semibold text-zinc-200 hover:bg-white/10"
            >
              {allBusy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Server className="h-4 w-4" aria-hidden />}
              Daily sync · all tenants
            </Button>
            {!isAdmin && <span className="text-xs text-zinc-500">admin session required</span>}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/* ------------------------------- jobs table -------------------------------- */

function JobsPanel({ refreshKey, onChanged }: { refreshKey: number; onChanged: () => void }) {
  const { isAdmin } = useAuth();
  const jobs = useApi('miner-jobs', () => minerApi.jobs({ limit: 25 }), { enabled: true });
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    jobs.refetch();
  }, [refreshKey]);

  // Auto-poll while any job is queued/running (the queue settles itself).
  const anyActive = (jobs.data?.data ?? []).some((j) => j.status === 'queued' || j.status === 'running');
  useEffect(() => {
    if (!anyActive) return;
    const t = setInterval(() => {
      jobs.refetch();
    }, 3000);
    return () => clearInterval(t);
  }, [anyActive]);

  const runNow = useCallback(
    async (id: string) => {
      setRunningIds((prev) => new Set(prev).add(id));
      try {
        const res = await minerApi.run(id);
        const st = res.job?.status;
        if (st === 'done') toast.success(`Job done — ${resultSummary(res.job).slice(0, 80)}`);
        else if (st === 'failed') toast.error(`Job failed — ${res.job?.error?.slice(0, 80) ?? 'unknown'}`);
        else toast.info('Job running — the queue will settle it');
        jobs.refetch();
        onChanged();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Run failed');
      } finally {
        setRunningIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [jobs, onChanged],
  );

  if (jobs.loading && !jobs.data) {
    return (
      <Card className="border-white/10 bg-white/[0.03]">
        <CardContent className="space-y-2 p-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full rounded-lg" />
          ))}
        </CardContent>
      </Card>
    );
  }
  if (jobs.error && !jobs.data) {
    return <ErrorState message={`Miner jobs unavailable — ${jobs.error}`} onRetry={() => void jobs.refetch()} />;
  }

  const list = jobs.data?.data ?? [];
  const doneCount = list.filter((j) => j.status === 'done').length;
  const failedCount = list.filter((j) => j.status === 'failed').length;
  const itemsSynced = list.reduce((acc, j) => acc + (j.result?.upserted ?? 0), 0);

  return (
    <Card className="border-white/10 bg-white/[0.03]">
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Clock className="h-4 w-4 text-rose-400" aria-hidden />
            Job queue
            <span className="ml-1 font-mono text-xs font-normal text-zinc-500">
              {doneCount} done · {failedCount} failed · {itemsSynced} items synced
            </span>
          </CardTitle>
          <CardDescription>Latest 25 jobs — click a row for its run log.</CardDescription>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => jobs.refetch()}
          className="border-white/15 bg-transparent text-zinc-300 hover:bg-white/10"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', jobs.loading && 'animate-spin')} aria-hidden />
          Refresh
        </Button>
      </CardHeader>
      <CardContent>
        {list.length === 0 ? (
          <EmptyState
            title="No jobs yet"
            message="Schedule a daily-sync above — the edge cron also fires one per active tenant at 04:30 UTC."
            icon={<DatabaseZap className="h-6 w-6" aria-hidden />}
          />
        ) : (
          <div className="max-h-96 overflow-y-auto pr-1">
            <Table>
              <TableHeader>
                <TableRow className="border-white/10 hover:bg-transparent">
                  <TableHead className="text-zinc-400">Type</TableHead>
                  <TableHead className="text-zinc-400">Tenant</TableHead>
                  <TableHead className="text-zinc-400">Status</TableHead>
                  <TableHead className="hidden text-zinc-400 md:table-cell">Result</TableHead>
                  <TableHead className="hidden text-zinc-400 sm:table-cell">Queued</TableHead>
                  <TableHead className="hidden text-zinc-400 sm:table-cell">Took</TableHead>
                  <TableHead className="w-24 text-right text-zinc-400">Run</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.map((job) => (
                  <TableRow
                    key={job.id}
                    className="cursor-pointer border-white/5"
                    onClick={() => setExpanded(expanded === job.id ? null : job.id)}
                  >
                    <TableCell className="font-mono text-xs text-zinc-200">{job.type}</TableCell>
                    <TableCell className="font-mono text-xs text-zinc-400">{job.tenant}</TableCell>
                    <TableCell>
                      <StatusBadge status={job.status} />
                    </TableCell>
                    <TableCell className="hidden max-w-72 truncate font-mono text-[11px] text-zinc-400 md:table-cell">
                      {resultSummary(job)}
                    </TableCell>
                    <TableCell className="hidden font-mono text-[11px] text-zinc-500 sm:table-cell">
                      {fmtTime(job.queuedat)}
                    </TableCell>
                    <TableCell className="hidden font-mono text-[11px] text-zinc-500 sm:table-cell">
                      {fmtDuration(job)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!isAdmin || runningIds.has(job.id) || job.status === 'running'}
                        onClick={(e) => {
                          e.stopPropagation();
                          void runNow(job.id);
                        }}
                        className="h-7 border-white/15 bg-transparent px-2 font-mono text-[11px] text-zinc-300 hover:bg-white/10"
                      >
                        {runningIds.has(job.id) ? (
                          <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                        ) : (
                          <Play className="h-3 w-3" aria-hidden />
                        )}
                        {job.status === 'queued' ? 'Run now' : job.status === 'running' ? 'Running' : 'Re-run'}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ----------------------------- tenants panel ------------------------------- */

function TenantsPanel({ status, onChanged }: { status: MinerStatus | null; onChanged: () => void }) {
  const { isAdmin } = useAuth();
  const [busyTenant, setBusyTenant] = useState<string | null>(null);

  async function tenantAction(tenant: string, action: 'reindex' | 'push') {
    setBusyTenant(`${tenant}:${action}`);
    try {
      if (action === 'reindex') {
        const res = await minerApi.schedule({ type: 'reindex', tenant });
        toast.success(`Reindex queued for '${tenant}'`);
        if (res.job) {
          void minerApi.run(res.job.id).catch(() => {});
        }
      } else {
        const res = await minerApi.searchPush(tenant);
        toast.success(`Search catalog pushed for '${tenant}' — ${res.pushed} docs (${res.backend})`);
      }
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setBusyTenant(null);
    }
  }

  const tenants = status?.tenants ?? [];
  return (
    <Card className="border-white/10 bg-white/[0.03]">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Database className="h-4 w-4 text-rose-400" aria-hidden />
          Per-tenant ingest state
        </CardTitle>
        <CardDescription>
          Provider sources recorded per tenant (last 24h syncs highlighted) with per-tenant vector reindex and
          search-catalog push.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {tenants.length === 0 ? (
          <EmptyState
            title="No sources yet"
            message="Run a daily-sync — sources appear here per tenant once providers are ingested."
            icon={<Database className="h-6 w-6" aria-hidden />}
          />
        ) : (
          <div className="max-h-72 overflow-y-auto pr-1">
            <Table>
              <TableHeader>
                <TableRow className="border-white/10 hover:bg-transparent">
                  <TableHead className="text-zinc-400">Tenant</TableHead>
                  <TableHead className="text-zinc-400">Sources</TableHead>
                  <TableHead className="text-zinc-400">Synced 24h</TableHead>
                  <TableHead className="w-56 text-right text-zinc-400">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tenants.map((t) => (
                  <TableRow key={t.tenant} className="border-white/5">
                    <TableCell className="font-mono text-xs text-zinc-200">{t.tenant}</TableCell>
                    <TableCell className="font-mono text-xs text-zinc-300">{t.sources}</TableCell>
                    <TableCell>
                      <span
                        className={cn(
                          'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold',
                          t.synced24h > 0
                            ? 'border-emerald-500/30 bg-emerald-500/15 text-emerald-300'
                            : 'border-zinc-500/30 bg-zinc-500/10 text-zinc-400',
                        )}
                      >
                        {t.synced24h > 0 && <CheckCircle2 className="h-3 w-3" aria-hidden />}
                        {t.synced24h}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!isAdmin || busyTenant === `${t.tenant}:reindex`}
                          onClick={() => tenantAction(t.tenant, 'reindex')}
                          className="h-7 border-white/15 bg-transparent px-2 font-mono text-[11px] text-zinc-300 hover:bg-white/10"
                        >
                          {busyTenant === `${t.tenant}:reindex` ? (
                            <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                          ) : (
                            <DatabaseZap className="h-3 w-3" aria-hidden />
                          )}
                          Reindex
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!isAdmin || busyTenant === `${t.tenant}:push`}
                          onClick={() => tenantAction(t.tenant, 'push')}
                          className="h-7 border-white/15 bg-transparent px-2 font-mono text-[11px] text-zinc-300 hover:bg-white/10"
                        >
                          {busyTenant === `${t.tenant}:push` ? (
                            <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                          ) : (
                            <Search className="h-3 w-3" aria-hidden />
                          )}
                          Push catalog
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* -------------------------------- main tab --------------------------------- */

export function AdminMinerTab() {
  const { isAdmin, user } = useAuth();
  const status = useApi('miner-status', () => minerApi.status());
  const [refreshKey, setRefreshKey] = useState(0);

  const bump = useMemo(
    () => () => {
      setRefreshKey((k) => k + 1);
      status.refetch();
    },
    [status],
  );

  if (!user) {
    return <ForbiddenCard />;
  }

  const lastJob = status.data?.jobs.last;

  return (
    <div className="space-y-6">
      {status.error && !status.data ? (
        <ErrorState message={`Miner status unavailable — ${status.error}`} onRetry={() => void status.refetch()} />
      ) : (
        <>
          <SummaryChips status={status.data ?? null} />
          {!isAdmin && (
            <Card className="border-amber-500/20 bg-amber-500/[0.04]">
              <CardContent className="flex items-center gap-3 p-4 text-sm text-amber-200">
                <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
                Read-only view — scheduling jobs and manual runs require an admin session.
              </CardContent>
            </Card>
          )}
          {lastJob && lastJob.status === 'failed' && (
            <Card className="border-rose-500/20 bg-rose-500/[0.04]">
              <CardContent className="flex items-center gap-3 p-4 text-sm text-rose-200">
                <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
                Last job ({lastJob.type} · {lastJob.tenant}) failed: {lastJob.error?.slice(0, 140) ?? 'unknown error'}
              </CardContent>
            </Card>
          )}
        </>
      )}

      <ScheduleForm onScheduled={bump} />
      <JobsPanel refreshKey={refreshKey} onChanged={bump} />
      <TenantsPanel status={status.data ?? null} onChanged={bump} />
    </div>
  );
}
