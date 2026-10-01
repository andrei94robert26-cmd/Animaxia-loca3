'use client';

/**
 * admin-shards-tab.tsx — FAZA 13 Shard Console: live topology of the Neon
 * sharding model (logical vs physical), per-shard branch pools with pg pool
 * counters, the FTS search cluster + pgvector cluster node health and the
 * cluster ops strip (queries / coalesced / upserts / errors with p50/p95).
 * Read-only public data (GET /api/shards — no auth by design); auto-refreshes
 * every 15 s while visible. Deep-linked via #/admin/shards.
 */

import { Fragment, useEffect, useMemo } from 'react';
import {
  AlertTriangle,
  Boxes,
  GitBranch,
  Network,
  RefreshCw,
  Search,
  Server,
  Waypoints,
} from 'lucide-react';
import {
  fetchShards,
  shardStatusLabel,
  type ClusterHealth,
  type ClusterNodeInfo,
  type ClusterOps,
  type ShardsStatus,
} from '@/lib/animaxia/sharding';
import { useApi } from '@/lib/animaxia/hooks';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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

/** Auto-refresh cadence while the tab is visible (workers tab polls 5 s). */
const POLL_MS = 15_000;

function fmtNum(v: number | null | undefined): string {
  return Number(v ?? 0).toLocaleString('en-US');
}

/** FAZA 14 — Romanian-locale separator for the logical address-space chip. */
const RO_NUMBER = new Intl.NumberFormat('ro-RO');

function fmtRoNum(v: number | null | undefined): string {
  return RO_NUMBER.format(Number(v ?? 0));
}

function fmtMs(v: number | null | undefined): string {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n > 0 ? `${Math.round(n).toLocaleString('en-US')}ms` : '—';
}

/* House chip tones: healthy mirrors the tenant-status emerald chip; degraded
   merges the muted zinc family with the codebase's amber warning signal;
   down follows the FAZA 13 red-5xx mandate. */
const STATUS_CHIP: Record<'healthy' | 'degraded' | 'down', string> = {
  healthy: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  degraded: 'border-zinc-500/30 bg-zinc-500/10 text-amber-300',
  down: 'border-red-500/30 bg-red-500/10 text-red-300',
};

function StatusChip({ status }: { status: 'healthy' | 'degraded' | 'down' }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider',
        STATUS_CHIP[status],
      )}
    >
      <span
        className={cn(
          'h-1.5 w-1.5 rounded-full',
          status === 'healthy' ? 'bg-emerald-400' : status === 'degraded' ? 'bg-amber-400' : 'bg-red-400',
        )}
        aria-hidden
      />
      {status}
    </span>
  );
}

/** Healthy/unhealthy dot for a search or vector cluster node. */
function NodeDot({ healthy }: { healthy: boolean }) {
  return (
    <span
      className={cn('inline-block h-1.5 w-1.5 shrink-0 rounded-full', healthy ? 'bg-emerald-400' : 'bg-red-400')}
      aria-hidden
    />
  );
}

/** One rendered table row: the shard's pool entry joined with its cluster nodes. */
interface ShardRow {
  shardid: number;
  branch: string;
  mode: string;
  urlConfigured: boolean;
  connected: boolean;
  pool: { total: number; idle: number; waiting: number } | null;
  queries: number;
  errors: number;
  searchNode: ClusterNodeInfo | undefined;
  vectorNode: ClusterNodeInfo | undefined;
  lastError: string | null;
  status: 'healthy' | 'degraded' | 'down';
}

function buildRows(data: ShardsStatus | null): ShardRow[] {
  if (!data) return [];
  const pools = data.pools ?? [];
  const searchNodes = data.searchCluster?.nodes ?? [];
  const vectorNodes = data.vectorCluster?.nodes ?? [];
  const base = pools.length
    ? pools.map((p) => ({
        shardid: p.shardid,
        branch: p.branch,
        mode: p.mode,
        urlConfigured: Boolean(p.urlConfigured),
      }))
    : (data.model?.shards ?? []).map((s) => ({
        shardid: s.shardid,
        branch: s.branch,
        mode: 'main',
        urlConfigured: Boolean(s.urlConfigured),
      }));
  return base
    .map((b) => {
      const pool = pools.find((p) => p.shardid === b.shardid);
      const searchNode = searchNodes.find((n) => n.shardid === b.shardid);
      const vectorNode = vectorNodes.find((n) => n.shardid === b.shardid);
      const nodes = [searchNode, vectorNode].filter((n): n is ClusterNodeInfo => Boolean(n));
      return {
        ...b,
        connected: pool?.connected ?? false,
        pool: pool?.pool ?? null,
        queries: pool?.stats?.queries ?? 0,
        errors: pool?.stats?.errors ?? 0,
        searchNode,
        vectorNode,
        lastError: pool?.lastError ?? searchNode?.lastError ?? vectorNode?.lastError ?? null,
        status: shardStatusLabel(pool, nodes),
      };
    })
    .sort((a, b) => a.shardid - b.shardid);
}

/* ----------------------------- summary cards ------------------------------ */

function SummaryCards({ data }: { data: ShardsStatus | null }) {
  const mode = data?.model?.mode ?? 'logical';
  const shardCount = data?.model?.shardcount ?? 0;
  const schema = data?.schema;
  const schemaBits: { label: string; on: boolean | undefined }[] = [
    { label: 'content', on: schema?.content },
    { label: 'searchdocs', on: schema?.searchdocs },
    { label: 'vectorembeddings', on: schema?.vectorembeddings },
  ];

  const search = data?.searchCluster ?? null;
  const searchOps = data?.ops?.search ?? null;
  const vector = data?.vectorCluster ?? null;
  const vectorOps = data?.ops?.vector ?? null;

  const clusterLine = (cluster: ClusterHealth | null, ops: ClusterOps | null, label: string) => {
    if (!cluster?.enabled) return `${label} cluster disabled — Neon direct + edge KV fallback`;
    const healthy = ops?.nodesHealthy ?? cluster.nodes.filter((n) => n.healthy).length;
    const total = ops?.nodesTotal ?? cluster.nodes.length;
    const p95 = ops?.latencyP95Ms;
    return `${healthy}/${total} nodes healthy · ${cluster.mode ?? mode} · p95 ${fmtMs(p95)}`;
  };

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Card className="border-white/10 bg-white/[0.03]">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm text-zinc-200">
            <GitBranch className="h-4 w-4 text-rose-400" aria-hidden /> Sharding mode
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-lg font-black capitalize leading-tight text-white">{mode}</p>
          <p className="mt-1 text-[11px] leading-snug text-zinc-500">
            {mode === 'physical'
              ? 'Dedicated Neon branch pool per shard (SHARDnURL configured).'
              : 'One shared Neon pool — per-shard routing, metrics and health are real; dedicated branch URLs activate physical isolation.'}
          </p>
        </CardContent>
      </Card>
      <Card className="border-white/10 bg-white/[0.03]">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm text-zinc-200">
            <Boxes className="h-4 w-4 text-rose-400" aria-hidden /> Shards
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-lg font-black leading-tight text-white">{fmtNum(shardCount)}</p>
          <p className="mt-1 text-[11px] leading-snug text-zinc-500">
            shardid columns:{' '}
            {schemaBits.map((s, i) => (
              <Fragment key={s.label}>
                {i > 0 && ' · '}
                <span className={s.on ? 'text-emerald-400' : 'text-zinc-500'}>
                  {s.label} {s.on ? '✓' : '—'}
                </span>
              </Fragment>
            ))}
          </p>
        </CardContent>
      </Card>
      <Card
        className={cn(
          'border-white/10 bg-white/[0.03]',
          search?.enabled && (search.healthy === false || (searchOps?.nodesHealthy ?? 0) < (searchOps?.nodesTotal ?? 1)) && 'border-amber-500/30',
        )}
      >
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm text-zinc-200">
            <Search className="h-4 w-4 text-rose-400" aria-hidden /> Search cluster
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-lg font-black leading-tight text-white">
            {search?.enabled ? 'Enabled' : 'Disabled'}
          </p>
          <p className="mt-1 text-[11px] leading-snug text-zinc-500">{clusterLine(search, searchOps, 'FTS')}</p>
        </CardContent>
      </Card>
      <Card
        className={cn(
          'border-white/10 bg-white/[0.03]',
          vector?.enabled && (vector.healthy === false || (vectorOps?.nodesHealthy ?? 0) < (vectorOps?.nodesTotal ?? 1)) && 'border-amber-500/30',
        )}
      >
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm text-zinc-200">
            <Waypoints className="h-4 w-4 text-rose-400" aria-hidden /> Vector cluster
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-lg font-black leading-tight text-white">
            {vector?.enabled ? 'Enabled' : 'Disabled'}
          </p>
          <p className="mt-1 text-[11px] leading-snug text-zinc-500">{clusterLine(vector, vectorOps, 'pgvector')}</p>
        </CardContent>
      </Card>
    </div>
  );
}

/* -------------------------------- main tab -------------------------------- */

export function AdminShardsTab() {
  const shards = useApi('admin-shards-status', () => fetchShards());

  /* Auto-refresh every 15 s while mounted (pause when the tab is hidden). */
  useEffect(() => {
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void shards.refetch();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [shards.refetch]);

  const data = shards.data;
  const rows = useMemo(() => buildRows(data), [data]);
  const loadingFirst = shards.loading && !data;
  const searchOps = data?.ops?.search ?? null;
  const vectorOps = data?.ops?.vector ?? null;

  return (
    <div className="space-y-5">
      {data && data.ok === false && (
        <p className="flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-200">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
          Partial status — at least one section of /api/shards reported an error; the rest is shown below.
        </p>
      )}

      {loadingFirst ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[104px] rounded-xl" />
          ))}
        </div>
      ) : shards.error && !data ? (
        <ErrorState message={shards.error} onRetry={shards.refetch} />
      ) : (
        <SummaryCards data={data} />
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-zinc-200">
          <Network className="h-4 w-4 text-rose-400" aria-hidden />
          Shard topology ({rows.length})
          {data?.logical ? (
            <span
              title={`computeShardIdFromContentId = floor(id / 10⁹) % ${data.logical.shardcount} — shardul s acoperă [s × 1 miliard, (s+1) × 1 miliard − 1]`}
              className="rounded-full border border-white/10 bg-white/5 px-2.5 py-0.5 font-mono text-[10px] font-semibold text-zinc-400"
            >
              {fmtNum(data.logical.shardcount)} × 1 miliard ID-uri · spațiu logic {fmtRoNum(data.logical.addressSpace)}
            </span>
          ) : null}
        </h3>
        <div className="flex items-center gap-3">
          <span className="text-[11px] text-zinc-600">auto-refresh 15s</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => shards.refetch()}
            aria-label="Refresh shard status"
            className="border-white/15 bg-white/5 font-semibold hover:bg-white/10"
          >
            {loadingFirst || shards.loading ? (
              <RefreshCw className="animate-spin" aria-hidden />
            ) : (
              <RefreshCw aria-hidden />
            )}{' '}
            Refresh
          </Button>
        </div>
      </div>

      {loadingFirst ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full rounded-xl" />
          ))}
        </div>
      ) : shards.error && !data ? (
        <ErrorState message={shards.error} onRetry={shards.refetch} compact />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No shards"
          message="The backend reported a shard count of 0 — set SHARDCOUNT in the monolith environment to bring up shard pools."
        />
      ) : (
        /* FAZA 14 — with 30 shards the table gets long: the house scroll
           container keeps it compact (sticky-safe header, custom scrollbar). */
        <div className="custom-scrollbar max-h-[32rem] overflow-y-auto rounded-xl border border-white/10">
          <Table aria-label="Shard topology — one row per Neon branch pool">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead scope="col">Shard</TableHead>
                <TableHead scope="col">Status</TableHead>
                <TableHead scope="col">Pool</TableHead>
                <TableHead scope="col">Search</TableHead>
                <TableHead scope="col">Vector</TableHead>
                <TableHead scope="col" className="hidden sm:table-cell">Mode</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <Fragment key={row.shardid}>
                  <TableRow className="hover:bg-white/[0.03]">
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Server className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden />
                        <div>
                          <p className="font-mono text-sm font-medium text-zinc-100">#{row.shardid}</p>
                          <p className="font-mono text-[11px] text-zinc-500">{row.branch}</p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <StatusChip status={row.status} />
                    </TableCell>
                    <TableCell>
                      <p className="font-mono text-xs text-zinc-300">
                        {row.pool ? `${row.pool.total} / ${row.pool.idle} / ${row.pool.waiting}` : '—'}
                      </p>
                      <p className="font-mono text-[11px] text-zinc-600">
                        {fmtNum(row.queries)} queries · {fmtNum(row.errors)} errors
                      </p>
                    </TableCell>
                    <TableCell>
                      {row.searchNode ? (
                        <>
                          <p className="flex items-center gap-1.5 font-mono text-xs text-zinc-300">
                            <NodeDot healthy={row.searchNode.healthy} />
                            {fmtNum(row.searchNode.docs)} docs
                          </p>
                          <p className="font-mono text-[11px] text-zinc-600">{fmtMs(row.searchNode.latencyMs)}</p>
                        </>
                      ) : (
                        <p className="font-mono text-xs text-zinc-600">—</p>
                      )}
                    </TableCell>
                    <TableCell>
                      {row.vectorNode ? (
                        <>
                          <p className="flex items-center gap-1.5 font-mono text-xs text-zinc-300">
                            <NodeDot healthy={row.vectorNode.healthy} />
                            {fmtNum(row.vectorNode.docs)} docs
                          </p>
                          <p className="font-mono text-[11px] text-zinc-600">{fmtMs(row.vectorNode.latencyMs)}</p>
                        </>
                      ) : (
                        <p className="font-mono text-xs text-zinc-600">—</p>
                      )}
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 font-mono text-[10px] text-zinc-400">
                        {row.mode}
                      </span>
                      <span
                        className={cn(
                          'ml-2 font-mono text-[10px]',
                          row.urlConfigured ? 'text-emerald-400' : 'text-zinc-600',
                        )}
                      >
                        {row.urlConfigured ? 'own URL' : 'main pool'}
                      </span>
                    </TableCell>
                  </TableRow>
                  {row.lastError && (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={6} className="bg-black/20 px-4 py-2">
                        <p className="flex items-center gap-2 font-mono text-[11px] text-rose-300/90">
                          <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden />
                          <span className="break-all">last error: {row.lastError}</span>
                        </p>
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {(searchOps || vectorOps) && (
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1.5 rounded-xl border border-white/10 bg-white/[0.02] px-4 py-2.5">
          {searchOps && (
            <>
              <span className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">Search cluster</span>
              <span className="font-mono text-[11px] text-zinc-300">
                {fmtNum(searchOps.queries)} <span className="text-zinc-600">queries</span>
              </span>
              <span className="font-mono text-[11px] text-zinc-300">
                {fmtNum(searchOps.coalesced ?? 0)} <span className="text-zinc-600">coalesced</span>
              </span>
              <span className={cn('font-mono text-[11px]', searchOps.errors > 0 ? 'text-rose-300' : 'text-zinc-300')}>
                {fmtNum(searchOps.errors)} <span className="text-zinc-600">errors</span>
              </span>
            </>
          )}
          {searchOps && vectorOps && <span className="hidden text-white/10 sm:inline" aria-hidden>|</span>}
          {vectorOps && (
            <>
              <span className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">Vector cluster</span>
              <span className="font-mono text-[11px] text-zinc-300">
                {fmtNum(vectorOps.queries)} <span className="text-zinc-600">queries</span>
              </span>
              <span className="font-mono text-[11px] text-zinc-300">
                {fmtNum(vectorOps.upserts ?? 0)} <span className="text-zinc-600">upserts</span>
              </span>
              <span className={cn('font-mono text-[11px]', vectorOps.errors > 0 ? 'text-rose-300' : 'text-zinc-300')}>
                {fmtNum(vectorOps.errors)} <span className="text-zinc-600">errors</span>
              </span>
            </>
          )}
          {data?.generatedAt && (
            <span className="ml-auto font-mono text-[10px] text-zinc-600">
              updated {new Date(data.generatedAt).toLocaleTimeString('en-US')}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
