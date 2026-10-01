'use client';

/**
 * admin-security-tab.tsx — Security posture: brute-force lockout stats,
 * rate-limit buckets and the audit log with pagination (50 rows per page).
 */

import { useCallback, useEffect, useState } from 'react';
import { Lock, RefreshCw, ShieldAlert, ShieldCheck, History } from 'lucide-react';
import { platform, type AuditEntry } from '@/lib/animaxia/platform';
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

const PAGE_SIZE = 50;

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

function absoluteTime(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US');
}

function formatWindow(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000} min`;
  return `${Math.round(ms / 1000)}s`;
}

const ACTION_COLORS: { prefix: string; cls: string }[] = [
  { prefix: 'auth.', cls: 'border-teal-500/30 bg-teal-500/15 text-teal-300' },
  { prefix: 'content.', cls: 'border-amber-500/30 bg-amber-500/15 text-amber-300' },
  { prefix: 'comment.', cls: 'border-rose-500/30 bg-rose-500/15 text-rose-300' },
  { prefix: 'premium.', cls: 'border-violet-500/30 bg-violet-500/15 text-violet-300' },
  { prefix: 'miner.', cls: 'border-fuchsia-500/30 bg-fuchsia-500/15 text-fuchsia-300' },
  { prefix: 'workers.', cls: 'border-lime-500/30 bg-lime-500/15 text-lime-300' },
  { prefix: 'admin.', cls: 'border-zinc-500/30 bg-zinc-500/15 text-zinc-300' },
  { prefix: 'ai.', cls: 'border-orange-500/30 bg-orange-500/15 text-orange-300' },
];

function ActionBadge({ action }: { action: string }) {
  const cls = ACTION_COLORS.find((c) => action.startsWith(c.prefix))?.cls;
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold',
        cls ?? 'border-zinc-500/30 bg-zinc-500/15 text-zinc-300',
      )}
    >
      {action}
    </span>
  );
}

function Chip({ label, value, tone = 'zinc' }: { label: string; value: React.ReactNode; tone?: 'zinc' | 'rose' | 'emerald' }) {
  const tones = {
    zinc: 'border-white/10 bg-white/[0.04] text-zinc-300',
    rose: 'border-rose-500/30 bg-rose-500/15 text-rose-300',
    emerald: 'border-emerald-500/30 bg-emerald-500/15 text-emerald-300',
  };
  return (
    <div className={cn('rounded-xl border px-4 py-3', tones[tone])}>
      <p className="text-lg font-black leading-tight">{value}</p>
      <p className="mt-0.5 text-[10px] font-semibold uppercase tracking-widest opacity-70">{label}</p>
    </div>
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
            Sign in as an administrator to view the security dashboard.
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

export function AdminSecurityTab() {
  const { isAdmin, initializing } = useAuth();

  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [total, setTotal] = useState(0);

  const status = useApi(`admin:security:status:${isAdmin}`, () => platform.securityStatus(), {
    enabled: !initializing && isAdmin,
  });

  /* Fetch one audit page — `replace` resets the list (refresh), otherwise appends. */
  const fetchPage = useCallback(async (offset: number, replace: boolean) => {
    setAuditLoading(true);
    setAuditError(null);
    try {
      const res = await platform.auditLog(PAGE_SIZE, offset);
      setTotal(res.total);
      setEntries((prev) => {
        if (replace) return res.data;
        const seen = new Set(prev.map((e) => e.id));
        return [...prev, ...res.data.filter((e) => !seen.has(e.id))];
      });
    } catch (e) {
      setAuditError(e instanceof Error ? e.message : 'Failed to load audit log');
    } finally {
      setAuditLoading(false);
    }
  }, []);

  /* Initial load (deferred so setState never runs synchronously in the effect). */
  useEffect(() => {
    if (initializing || !isAdmin) return undefined;
    const timer = setTimeout(() => {
      void fetchPage(0, true);
    }, 0);
    return () => clearTimeout(timer);
  }, [isAdmin, initializing, fetchPage]);

  const locked =
    !initializing &&
    (!isAdmin ||
      isForbidden(status.error) ||
      (auditError != null && entries.length === 0 && isForbidden(auditError)));
  if (locked) return <LockCard />;

  const grandTotal = total || status.data?.auditTotal || 0;
  const canLoadMore = entries.length < grandTotal;

  function handleRefresh() {
    void fetchPage(0, true);
    void status.refetch();
  }

  const brute = status.data?.bruteForce ?? {};
  const lockedNow = brute.lockedNow ?? 0;

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-zinc-500">Brute-force lockouts, rate-limit buckets and the audit trail.</p>
        <Button
          variant="outline"
          size="sm"
          className="border-white/15 bg-white/5 font-semibold hover:bg-white/10"
          onClick={handleRefresh}
        >
          <RefreshCw aria-hidden /> Refresh
        </Button>
      </div>

      {status.loading && !status.data ? (
        <div className="space-y-4">
          <Skeleton className="h-32 rounded-xl" />
          <Skeleton className="h-48 rounded-xl" />
        </div>
      ) : status.error && !status.data ? (
        <ErrorState message={status.error} onRetry={status.refetch} compact />
      ) : status.data ? (
        <>
          {/* Brute force */}
          <Card className="border-white/10 bg-white/[0.03]">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <ShieldAlert className="h-4 w-4 text-rose-400" aria-hidden />
                Brute-force protection
              </CardTitle>
              <CardDescription>
                Login attempts are tracked per account+IP and locked after too many failures.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Chip label="Tracked" value={brute.tracked ?? 0} />
              <Chip label="Locked now" value={lockedNow} tone={lockedNow > 0 ? 'rose' : 'zinc'} />
              <Chip label="Max fails" value={brute.maxFails ?? 0} />
              <Chip label="Window" value={formatWindow(brute.windowMs ?? 0)} />
            </CardContent>
          </Card>

          {/* Rate-limit buckets */}
          <Card className="border-white/10 bg-white/[0.03]">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <ShieldCheck className="h-4 w-4 text-teal-400" aria-hidden />
                Rate-limit buckets
              </CardTitle>
              <CardDescription>Per-IP sliding windows enforced by the backend.</CardDescription>
            </CardHeader>
            <CardContent>
              {status.data.buckets.length === 0 ? (
                <p className="text-sm text-zinc-500">No buckets are currently tracking clients.</p>
              ) : (
                <div className="custom-scrollbar overflow-x-auto rounded-xl border border-white/10 bg-white/[0.02]">
                  <Table className="min-w-[560px]">
                    <TableHeader>
                      <TableRow className="border-white/10 hover:bg-transparent">
                        <TableHead className="text-zinc-400">Bucket</TableHead>
                        <TableHead className="text-zinc-400">Limit</TableHead>
                        <TableHead className="text-zinc-400">Window</TableHead>
                        <TableHead className="text-zinc-400">Tracked clients</TableHead>
                        <TableHead className="text-zinc-400">Limited</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {status.data.buckets.map((b) => (
                        <TableRow key={b.key} className="border-white/5">
                          <TableCell className="font-mono text-xs font-semibold text-zinc-200">{b.key}</TableCell>
                          <TableCell className="text-zinc-300">{b.max} req</TableCell>
                          <TableCell className="text-zinc-400">{formatWindow(b.windowMs)}</TableCell>
                          <TableCell className="text-zinc-300">{b.trackedClients}</TableCell>
                          <TableCell>
                            <span
                              className={cn(
                                'font-semibold',
                                b.totalLimited > 0 ? 'text-amber-300' : 'text-zinc-500',
                              )}
                            >
                              {b.totalLimited}
                            </span>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      ) : null}

      {/* Audit log */}
      <Card className="border-white/10 bg-white/[0.03]">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <History className="h-4 w-4 text-fuchsia-400" aria-hidden />
            Audit log
            <span className="rounded-full border border-white/10 bg-white/[0.05] px-2 py-0.5 text-[10px] font-bold text-zinc-400">
              {grandTotal} events
            </span>
          </CardTitle>
          <CardDescription>Every sensitive action recorded by the backend, newest first.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {auditLoading && entries.length === 0 ? (
            <div className="space-y-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-11 w-full rounded-xl" />
              ))}
            </div>
          ) : auditError && entries.length === 0 ? (
            <ErrorState message={auditError} onRetry={handleRefresh} compact />
          ) : entries.length === 0 ? (
            <EmptyState title="No audit events" message="Sensitive actions will be recorded here." />
          ) : (
            <>
              <div className="custom-scrollbar max-h-96 overflow-y-auto rounded-xl border border-white/10 bg-white/[0.02]">
                <Table className="min-w-[760px]">
                  <TableHeader className="sticky top-0 z-10 bg-[#16161f]">
                    <TableRow className="border-white/10 hover:bg-transparent">
                      <TableHead className="w-24 text-zinc-400">Time</TableHead>
                      <TableHead className="text-zinc-400">Action</TableHead>
                      <TableHead className="text-zinc-400">User</TableHead>
                      <TableHead className="text-zinc-400">IP</TableHead>
                      <TableHead className="text-zinc-400">Meta</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {entries.map((e) => {
                      const meta = Object.keys(e.meta ?? {}).length > 0 ? JSON.stringify(e.meta) : '—';
                      const metaTruncated = meta.length > 42 ? `${meta.slice(0, 42)}…` : meta;
                      return (
                        <TableRow key={e.id} className="border-white/5">
                          <TableCell className="whitespace-nowrap">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="cursor-help text-xs text-zinc-400">{timeAgo(e.createdat)}</span>
                              </TooltipTrigger>
                              <TooltipContent
                                side="bottom"
                                className="border-white/10 bg-[#1a1a24] text-xs text-zinc-200"
                              >
                                {absoluteTime(e.createdat)}
                              </TooltipContent>
                            </Tooltip>
                          </TableCell>
                          <TableCell>
                            <ActionBadge action={e.action} />
                          </TableCell>
                          <TableCell className="max-w-[160px]">
                            {e.user ? (
                              <span className="block truncate text-sm text-zinc-200">{e.user.username}</span>
                            ) : (
                              <span className="text-zinc-600">—</span>
                            )}
                          </TableCell>
                          <TableCell className="font-mono text-xs text-zinc-500">{e.ip ?? '—'}</TableCell>
                          <TableCell className="max-w-[220px]">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="block cursor-help truncate font-mono text-xs text-zinc-500">
                                  {metaTruncated}
                                </span>
                              </TooltipTrigger>
                              <TooltipContent
                                side="bottom"
                                className="max-w-sm break-all border-white/10 bg-[#1a1a24] font-mono text-xs text-zinc-200"
                              >
                                {meta}
                              </TooltipContent>
                            </Tooltip>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
              {canLoadMore && (
                <div className="flex justify-center">
                  <Button
                    variant="outline"
                    className="border-white/15 bg-white/5 font-semibold hover:bg-white/10"
                    disabled={auditLoading}
                    onClick={() => void fetchPage(entries.length, false)}
                  >
                    {auditLoading ? <RefreshCw className="animate-spin" aria-hidden /> : <History aria-hidden />}
                    Load more ({entries.length}/{grandTotal})
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
