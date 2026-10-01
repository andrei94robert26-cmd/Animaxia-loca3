'use client';

/**
 * admin-shards-tab.tsx — Consola AR10M (#/admin/shards): registrul REAL de
 * 15 sloturi de sharduri al arhitecturii „ANIMAXIA REAL 10M” (GET
 * /api/ar10m/shards prin gateway) — stare, pooluri, latențe, rânduri și
 * distribuția reală per shard. Zero simulări: ce nu raportează backendul
 * apare ca „—”.
 *
 * FĂRĂ auto-refresh (regulă utilizator pentru dashboard-urile admin):
 * datele se încarcă la montare și exclusiv la apăsarea butonului Refresh,
 * cu marcatorul „ultima actualizare HH:MM:SS”.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Database,
  Network,
  RefreshCw,
  Server,
  Timer,
} from 'lucide-react';
import { api } from '@/lib/animaxia/api';
import { useApi } from '@/lib/animaxia/hooks';
import type { Ar10mShardInfo } from '@/lib/animaxia/types';
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

function fmtNum(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return Number(v).toLocaleString('ro-RO');
}

function fmtMs(v: number | null | undefined): string {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n > 0 ? `${Math.round(n).toLocaleString('ro-RO')}ms` : '—';
}

function fmtBytes(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v) || v < 0) return '—';
  if (v === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = v;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toLocaleString('ro-RO', { maximumFractionDigits: 1 })} ${units[unit]}`;
}

function fmtStamp(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('ro-RO', { dateStyle: 'short', timeStyle: 'medium' });
}

/** State chip tones mapped from the REAL shard registry state. */
function stateChipClass(state: string | null | undefined): { cls: string; dot: string } {
  const s = (state ?? '').toLowerCase();
  /* Stările registrului AR10M (circuit breaker): closed = sănătos, open = indisponibil,
   * half-open = probă, inactive = fără pool. */
  if (s === 'closed' || s === 'active' || s === 'online' || s === 'healthy') {
    return { cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300', dot: 'bg-emerald-400' };
  }
  if (s === 'half-open' || s === 'degraded' || s === 'warning' || s === 'draining') {
    return { cls: 'border-amber-500/30 bg-amber-500/10 text-amber-300', dot: 'bg-amber-400' };
  }
  if (s === 'open') {
    return { cls: 'border-rose-500/30 bg-rose-500/10 text-rose-300', dot: 'bg-rose-400' };
  }
  return { cls: 'border-zinc-500/30 bg-zinc-500/10 text-zinc-400', dot: 'bg-zinc-500' };
}

/* ----------------------------- summary cards ------------------------------ */

function SummaryCards({
  shards,
  distribution,
}: {
  shards: Ar10mShardInfo[];
  distribution: { shardId: number; rows: number; pct: number }[];
}) {
  const configured = shards.filter((s) => s.configured).length;
  const active = shards.filter((s) => {
    const st = (s.state ?? '').toLowerCase();
    return st === 'closed' || st === 'active' || st === 'online' || st === 'healthy';
  }).length;
  const poolsActive = shards.filter((s) => s.poolActive).length;
  const totalRows = distribution.reduce((acc, d) => acc + (Number.isFinite(d.rows) ? d.rows : 0), 0);
  const lats = shards
    .map((s) => s.lastLatencyMs)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0);
  const avgLatency = lats.length > 0 ? lats.reduce((a, b) => a + b, 0) / lats.length : null;

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Card className="border-white/10 bg-white/[0.03]">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm text-zinc-200">
            <Network className="h-4 w-4 text-rose-400" aria-hidden /> Sharduri configurate
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-lg font-black leading-tight text-white">{fmtNum(configured)}</p>
          <p className="mt-1 text-[11px] leading-snug text-zinc-500">
            din {fmtNum(shards.length)} sloturi în registrul AR10M (arhitectura hash)
          </p>
        </CardContent>
      </Card>
      <Card className="border-white/10 bg-white/[0.03]">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm text-zinc-200">
            <Server className="h-4 w-4 text-rose-400" aria-hidden /> Stare activă
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-lg font-black leading-tight text-white">
            {fmtNum(active)} <span className="text-sm font-bold text-zinc-500">active</span>
          </p>
          <p className="mt-1 text-[11px] leading-snug text-zinc-500">
            {fmtNum(poolsActive)} pooluri cu conexiuni deschise acum
          </p>
        </CardContent>
      </Card>
      <Card className="border-white/10 bg-white/[0.03]">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm text-zinc-200">
            <Database className="h-4 w-4 text-rose-400" aria-hidden /> Rânduri reale
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-lg font-black leading-tight text-white">{fmtNum(totalRows)}</p>
          <p className="mt-1 text-[11px] leading-snug text-zinc-500">
            suma distribuției reale raportate de registru
          </p>
        </CardContent>
      </Card>
      <Card className="border-white/10 bg-white/[0.03]">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm text-zinc-200">
            <Timer className="h-4 w-4 text-rose-400" aria-hidden /> Latență medie
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-lg font-black leading-tight text-white">{fmtMs(avgLatency)}</p>
          <p className="mt-1 text-[11px] leading-snug text-zinc-500">
            media ultimelor latențe măsurate per shard
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

/* -------------------------------- main tab -------------------------------- */

export function AdminShardsTab() {
  const shards = useApi('admin-ar10m-shards', () => api.ar10mShards());

  /* FĂRĂ auto-refresh (regulă admin): montare + Refresh manual. */
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);

  const data = shards.data;
  const distribution = useMemo(() => data?.distribution ?? [], [data]);
  const distBySlot = useMemo(
    () => new Map(distribution.map((d) => [d.shardId, d])),
    [distribution],
  );
  const loadingFirst = shards.loading && !data;
  const down = Boolean(shards.error && !data);

  /* „ultima actualizare” se scrie când ciclul curent se încheie. */
  useEffect(() => {
    if (shards.loading) return undefined;
    const t = setTimeout(
      () => setUpdatedAt(new Date().toLocaleTimeString('ro-RO', { hour12: false })),
      0,
    );
    return () => clearTimeout(t);
  }, [shards.loading]);

  const refresh = () => void shards.refetch();

  return (
    <div className="space-y-5">
      {down && (
        <p className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs leading-relaxed text-amber-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          Date indisponibile — endpoint AR10M neactiv. Registrul real de sharduri apare după montarea
          modulului backend /api/ar10m/shards; până atunci nu se afișează nicio valoare simulată.
        </p>
      )}

      {loadingFirst ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[104px] rounded-xl" />
          ))}
        </div>
      ) : down ? (
        <ErrorState message="Registrul AR10M este indisponibil" onRetry={refresh} />
      ) : data ? (
        <SummaryCards shards={data.shards} distribution={distribution} />
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-200">
          <Network className="h-4 w-4 text-rose-400" aria-hidden />
          Registrul de sharduri AR10M ({data ? data.shards.length : 0})
        </h3>
        <div className="flex items-center gap-3">
          <span className="text-[11px] text-zinc-600">
            {updatedAt ? `ultima actualizare ${updatedAt}` : 'actualizare manuală'}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={refresh}
            aria-label="Reîmprospătează registrul de sharduri"
            className="border-white/15 bg-white/5 font-semibold hover:bg-white/10"
          >
            <RefreshCw className={cn(shards.loading && 'animate-spin')} aria-hidden /> Refresh
          </Button>
        </div>
      </div>

      {loadingFirst ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full rounded-xl" />
          ))}
        </div>
      ) : down ? null : data && data.shards.length === 0 ? (
        <EmptyState
          title="Registrul este gol"
          message="Modulul AR10M nu a raportat niciun slot — verifică montarea modulului backend înainte de a reîncerca."
        />
      ) : data ? (
        <div className="overflow-hidden rounded-xl border border-white/10">
          <Table aria-label="Registrul AR10M — un rând per slot de shard">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead scope="col">Slot</TableHead>
                <TableHead scope="col">Stare</TableHead>
                <TableHead scope="col">Pool</TableHead>
                <TableHead scope="col">Rânduri</TableHead>
                <TableHead scope="col" className="hidden sm:table-cell">Latență</TableHead>
                <TableHead scope="col" className="hidden md:table-cell">Spațiu</TableHead>
                <TableHead scope="col" className="hidden lg:table-cell">Ultima folosire</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.shards.map((shard) => {
                const chip = stateChipClass(shard.state);
                const dist = distBySlot.get(shard.slot);
                return (
                  <TableRow key={shard.slot} className="hover:bg-white/[0.03]">
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Server className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden />
                        <div>
                          <p className="font-mono text-sm font-medium text-zinc-100">#{shard.slot}</p>
                          <p className="max-w-[140px] truncate font-mono text-[11px] text-zinc-500" title={shard.hostMasked ?? undefined}>
                            {shard.name}
                          </p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <span
                        className={cn(
                          'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider',
                          chip.cls,
                        )}
                      >
                        <span aria-hidden className={cn('h-1.5 w-1.5 rounded-full', chip.dot)} />
                        {shard.state ?? 'inactiv'}
                      </span>
                      {!shard.configured ? (
                        <p className="mt-1 font-mono text-[10px] text-zinc-600">neconfigurat</p>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <p className="font-mono text-xs text-zinc-300">
                        {shard.poolActive ? `${fmtNum(shard.openConnections)} conexiuni` : 'inactiv'}
                      </p>
                      <p className="font-mono text-[11px] text-zinc-600">{shard.mode}</p>
                    </TableCell>
                    <TableCell>
                      <p className="font-mono text-xs text-zinc-300">{fmtNum(dist?.rows)}</p>
                      <p className="font-mono text-[11px] text-zinc-600">
                        {dist?.pct != null
                          ? `${dist.pct.toLocaleString('ro-RO', { maximumFractionDigits: 1 })}%`
                          : '—'}
                      </p>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <p className="font-mono text-xs text-zinc-300">{fmtMs(shard.lastLatencyMs)}</p>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <p className="font-mono text-xs text-zinc-300">{fmtBytes(shard.lastSpaceBytes)}</p>
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      <p className="font-mono text-xs text-zinc-300">{fmtStamp(shard.lastUsedAt)}</p>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      ) : null}

      {data ? (
        <p className="text-[11px] leading-relaxed text-zinc-600">
          Sursă: /api/ar10m/shards — registru real, 15 sloturi pe arhitectura hash. Valorile „—” înseamnă
          că shardul nu a raportat încă măsurători; nu se estimează nimic.
        </p>
      ) : null}
    </div>
  );
}
