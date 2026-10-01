'use client';

/**
 * admin-view.tsx — Operations panel: system/database/cache/rate-limit stats
 * plus Content (library CRUD), Miner (URL mining + upsert), Analytics, Workers,
 * Security, Providers, AI Cloud (Phase-4 LLM/vector/assistant telemetry),
 * Shards (FAZA 13 Neon sharding/search/vector cluster console) and
 * About (download ZIP, seed, API reference) tabs, plus the FAZA 21
 * Player Hub console (deep-link: #/admin/playerhub).
 */

import { useState } from 'react';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Bot,
  Building2,
  Brain,
  Cloud,
  CloudDownload,
  Code2,
  Cpu,
  Database,
  DatabaseZap,
  DollarSign,
  Download,
  FileVideo,
  Film,
  Gauge,
  Layers,
  Loader2,
  Lock,
  MonitorPlay,
  Network,
  Pickaxe,
  Radio,
  RefreshCw,
  Rocket,
  Server,
  ShieldAlert,
  Sparkles,
  Timer,
  Trash2,
  Waves,
  Wrench,
  Youtube,
  Zap,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/animaxia/api';
import { platform } from '@/lib/animaxia/platform';
import { useApi } from '@/lib/animaxia/hooks';
import { navigate, useRoute } from '@/lib/animaxia/router';
import { useAuth } from '@/components/animaxia/auth-provider';
import type { DbContent, HealthResponse, MinerExtraction } from '@/lib/animaxia/types';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
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
import { AdminAnalyticsTab } from '../admin/admin-analytics-tab';
import { AdminSecurityTab } from '../admin/admin-security-tab';
import { AdminWorkersTab } from '../admin/admin-workers-tab';
import { AdminTenantsTab } from '../admin/admin-tenants-tab'; // FAZA 11 multi-tenant
import { AdminMinerTab } from '../admin/admin-miner-tab'; // FAZA 12 miner ingest + indexing
import { AdminShardsTab } from '../admin/admin-shards-tab'; // FAZA 13 shard console
import { AdminSearchFlowTab } from '../admin/admin-search-flow-tab'; // FAZA 15 search flow console
import { AdminSearchRateTab } from '../admin/admin-search-rate-tab'; // FAZA 16 search rate console
import { AdminSearchOptTab } from '../admin/admin-search-opt-tab'; // FAZA 17 search optimization console
import { AdminSearchFullTab } from '../admin/admin-search-full-tab'; // FAZA 18 full integration + stress console
import { AdminPlayerHubTab } from '../admin/admin-playerhub-tab'; // FAZA 21 Player Hub console
import { Container, PageHeader } from '../section';
import { EmptyState, ErrorState, TypeBadge } from '../states';
import { Pagination } from '../pagination';

/* ------------------------------- helpers ------------------------------- */

function formatUptime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatBytes(b?: number): string {
  if (!b || b <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = b;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function formatMs(ms?: number): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatDate(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function getErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : 'Request failed';
}

/** True when an endpoint error means the caller is not an admin (403/401). */
function isForbidden(message: string | null): boolean {
  return Boolean(message && /admin access required|forbidden|status 40[13]/i.test(message));
}

/* ------------------------------ stat cards ------------------------------ */

function StatCard({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="border-white/10 bg-white/[0.03]">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-zinc-400">
          {icon}
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">{children}</CardContent>
    </Card>
  );
}

function StatsSection({
  health,
  loading,
  error,
  onRetry,
}: {
  health: HealthResponse | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  if (loading && !health) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-40 rounded-xl" />
        ))}
      </div>
    );
  }
  if (error && !health) {
    return <ErrorState message={error} onRetry={onRetry} compact />;
  }
  if (!health) return null;

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {/* System */}
      <StatCard icon={<Server className="h-4 w-4 text-rose-400" aria-hidden />} title="System">
        <p className="font-semibold text-zinc-100">
          {health.service} <span className="text-zinc-500">v{health.version}</span>
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 font-mono text-[11px] text-zinc-300">
            {health.env}
          </span>
          <span className="text-xs text-zinc-500">up {formatUptime(health.uptimeSec)}</span>
        </div>
        <p className="text-[11px] text-zinc-600">status: {health.status}</p>
      </StatCard>

      {/* Database */}
      <StatCard icon={<Database className="h-4 w-4 text-amber-400" aria-hidden />} title="Database">
        {health.db.driver === 'postgres' ? (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-semibold text-emerald-300">
            Neon PostgreSQL connected
          </span>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex cursor-help items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-[11px] font-semibold text-amber-300">
                Local fallback
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-xs break-words border-white/10 bg-[#1a1a24] text-zinc-200">
              {health.db.lastError || 'PostgreSQL unreachable — serving from the local JSON store.'}
            </TooltipContent>
          </Tooltip>
        )}
        <p className="text-3xl font-black text-white">{health.db.totalItems}</p>
        <p className="text-[11px] text-zinc-500">total items in library</p>
      </StatCard>

      {/* Cache */}
      <StatCard icon={<Zap className="h-4 w-4 text-fuchsia-400" aria-hidden />} title="Cache">
        <p className="text-3xl font-black text-white">{Math.round(health.cache.hitRate * 100)}%</p>
        <p className="text-xs text-zinc-400">
          hit rate · {health.cache.keys} keys · {health.cache.ttlMs / 1000}s TTL
        </p>
        <p className="text-[11px] text-zinc-500">
          hits {health.cache.hits} · misses {health.cache.misses}
        </p>
      </StatCard>

      {/* Rate limit */}
      <StatCard icon={<Gauge className="h-4 w-4 text-teal-400" aria-hidden />} title="Rate limit">
        <p className="text-xl font-black text-white">
          {health.rateLimit.max} req / {health.rateLimit.windowMs / 1000}s
        </p>
        <p className="text-xs text-zinc-400">{health.rateLimit.trackedClients} tracked clients</p>
        <p className="text-[11px] text-zinc-500">{health.rateLimit.totalLimited} limited requests</p>
      </StatCard>
    </div>
  );
}

/* ----------------------------- content tab ----------------------------- */

const CONTENT_TYPES = ['all', 'movie', 'tv', 'anime', 'news', 'sports', 'mined', 'featured'] as const;

function ContentTab({ onMutated }: { onMutated: () => void }) {
  const [type, setType] = useState<string>('all');
  const [page, setPage] = useState(1);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const list = useApi(`admin-content-${type}-${page}`, () =>
    api.all({ type: type === 'all' ? undefined : type, page, limit: 10 }),
  );

  async function handleDelete(c: DbContent) {
    setDeletingId(c.id);
    try {
      await api.deleteContent(c.id);
      toast.success(`Deleted "${c.title}"`);
      await list.refetch();
      onMutated();
    } catch (e) {
      toast.error(getErrorMessage(e));
    } finally {
      setDeletingId(null);
    }
  }

  const rows = list.data?.data || [];

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <Label htmlFor="admin-type-filter" className="sr-only">
            Filter by type
          </Label>
          <Select
            value={type}
            onValueChange={(v) => {
              setType(v);
              setPage(1);
            }}
          >
            <SelectTrigger id="admin-type-filter" className="w-[150px] border-white/10 bg-black/40">
              <SelectValue placeholder="Type" />
            </SelectTrigger>
            <SelectContent className="border-white/10 bg-[#12121a]">
              {CONTENT_TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {t === 'all' ? 'All types' : t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button
          variant="outline"
          className="border-white/10 bg-white/5 hover:bg-white/10"
          onClick={() => list.refetch()}
        >
          <RefreshCw aria-hidden /> Refresh
        </Button>
        {list.data && (
          <span className="ml-auto text-xs font-semibold text-zinc-500">
            {list.data.total} {list.data.total === 1 ? 'title' : 'titles'} in library
          </span>
        )}
      </div>

      {/* Table */}
      {list.loading && rows.length === 0 ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full rounded-xl" />
          ))}
        </div>
      ) : list.error && rows.length === 0 ? (
        <ErrorState message={list.error} onRetry={list.refetch} compact />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No titles"
          message={`No ${type === 'all' ? '' : `${type} `}titles are stored in the library yet.`}
        />
      ) : (
        <div
          className={cn(
            'custom-scrollbar overflow-x-auto rounded-xl border border-white/10 bg-white/[0.02] transition-opacity',
            list.loading && 'pointer-events-none opacity-50',
          )}
        >
          <Table className="min-w-[680px]">
            <TableHeader>
              <TableRow className="border-white/10 hover:bg-transparent">
                <TableHead className="w-16 text-zinc-400">Poster</TableHead>
                <TableHead className="text-zinc-400">Title</TableHead>
                <TableHead className="text-zinc-400">Type</TableHead>
                <TableHead className="text-zinc-400">Added</TableHead>
                <TableHead className="w-14 text-right text-zinc-400">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((c) => (
                <TableRow key={c.id} className="border-white/5">
                  <TableCell>
                    {c.thumbnail ? (
                      <img
                        src={c.thumbnail}
                        alt={`${c.title} poster`}
                        loading="lazy"
                        className="h-12 w-8 rounded object-cover"
                      />
                    ) : (
                      <div className="grid h-12 w-8 place-items-center rounded bg-gradient-to-br from-white/10 to-white/[0.03]">
                        <Film className="h-3.5 w-3.5 text-zinc-600" aria-hidden />
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="max-w-[220px]">
                    <p className="truncate font-medium text-zinc-100">{c.title}</p>
                    <p className="truncate text-[11px] text-zinc-500" title={c.externalid}>
                      {c.externalid}
                    </p>
                  </TableCell>
                  <TableCell>
                    <TypeBadge type={c.type} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-zinc-400">{formatDate(c.createdat)}</TableCell>
                  <TableCell className="text-right">
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Delete ${c.title}`}
                          className="text-rose-400 hover:bg-rose-500/10 hover:text-rose-300"
                        >
                          <Trash2 aria-hidden />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent className="border-white/10 bg-[#12121a]">
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete this title?</AlertDialogTitle>
                          <AlertDialogDescription>
                            This permanently removes &quot;{c.title}&quot; (id {c.id}) from the library. This action
                            cannot be undone.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel className="border-white/10 bg-white/5 hover:bg-white/10">
                            Cancel
                          </AlertDialogCancel>
                          <AlertDialogAction
                            className="bg-rose-600 font-bold hover:bg-rose-500"
                            onClick={() => handleDelete(c)}
                          >
                            {deletingId === c.id ? (
                              <Loader2 className="animate-spin" aria-hidden />
                            ) : (
                              <Trash2 aria-hidden />
                            )}
                            Delete
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Pagination
        page={list.data?.page ?? page}
        totalPages={list.data?.totalPages ?? 1}
        onPage={setPage}
      />
    </div>
  );
}

/* ------------------------------ miner tab ------------------------------ */

const MINER_TYPES = ['mined', 'movie', 'tv', 'anime', 'news', 'sports', 'featured'] as const;

interface MinerResult {
  extraction: MinerExtraction;
  record: DbContent;
}

const SOURCE_GROUPS: { key: 'mp4' | 'm3u8' | 'iframe' | 'youtube'; icon: React.ReactNode }[] = [
  { key: 'mp4', icon: <FileVideo className="h-3 w-3" aria-hidden /> },
  { key: 'm3u8', icon: <Radio className="h-3 w-3" aria-hidden /> },
  { key: 'iframe', icon: <Code2 className="h-3 w-3" aria-hidden /> },
  { key: 'youtube', icon: <Youtube className="h-3 w-3" aria-hidden /> },
];

function MinerTab({ onMutated }: { onMutated: () => void }) {
  const [url, setUrl] = useState('');
  const [type, setType] = useState<string>('mined');
  const [externalId, setExternalId] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<MinerResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleMine(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.miner({
        url: url.trim(),
        type,
        ...(externalId.trim() ? { externalId: externalId.trim() } : {}),
      });
      setResult(res);
      toast.success(`Mined "${res.record.title}"`);
      onMutated();
    } catch (e2) {
      const message = getErrorMessage(e2);
      setError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <Card className="border-white/10 bg-white/[0.03]">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Pickaxe className="h-4 w-4 text-rose-400" aria-hidden />
            Mine a page or stream
          </CardTitle>
          <CardDescription>
            Fetch any URL, extract its metadata and media sources (mp4, m3u8, iframe, YouTube) and upsert the result
            into the library.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <form className="space-y-4" onSubmit={handleMine}>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="miner-url">URL</Label>
                <Input
                  id="miner-url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://example.com/page-or-stream"
                  className="border-white/10 bg-black/40"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="miner-type">Type</Label>
                <Select value={type} onValueChange={setType}>
                  <SelectTrigger id="miner-type" className="w-full border-white/10 bg-black/40">
                    <SelectValue placeholder="Type" />
                  </SelectTrigger>
                  <SelectContent className="border-white/10 bg-[#12121a]">
                    {MINER_TYPES.map((t) => (
                      <SelectItem key={t} value={t}>
                        {t}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="miner-external-id">External ID (optional)</Label>
                <Input
                  id="miner-external-id"
                  value={externalId}
                  onChange={(e) => setExternalId(e.target.value)}
                  placeholder="Optional — defaults to the URL"
                  className="border-white/10 bg-black/40"
                />
              </div>
            </div>
            <Button
              type="submit"
              disabled={busy || !url.trim()}
              className="bg-rose-600 font-bold hover:bg-rose-500"
            >
              {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Pickaxe aria-hidden />}
              Mine &amp; UPSERT
            </Button>
          </form>

          {error && <ErrorState message={error} compact />}
        </CardContent>
      </Card>

      {result && (
        <div className="space-y-4">
          <Card className="border-white/10 bg-white/[0.03]">
            <CardHeader>
              <CardTitle className="text-base">Extraction result</CardTitle>
              <CardDescription>
                Upserted as record #{result.record.id} ({result.record.type})
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {result.extraction.thumbnail && (
                <img
                  src={result.extraction.thumbnail}
                  alt={`${result.extraction.title || 'Mined page'} thumbnail`}
                  className="max-h-48 w-full rounded-xl bg-black/30 object-contain"
                />
              )}
              <div>
                <h3 className="text-lg font-bold text-white">{result.extraction.title || result.record.title}</h3>
                {result.extraction.description && (
                  <p className="mt-1 line-clamp-3 text-sm text-zinc-400">{result.extraction.description}</p>
                )}
                <p className="mt-2 text-[11px] font-medium uppercase tracking-wider text-zinc-500">
                  {[result.extraction.siteName, formatBytes(result.extraction.bytesRead ?? result.extraction.bytes), formatMs(result.extraction.elapsedMs ?? result.extraction.ms)]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </div>

              <div className="space-y-2">
                {SOURCE_GROUPS.map(({ key, icon }) => {
                  const urls = result.extraction[key] || [];
                  if (urls.length === 0) return null;
                  return (
                    <div key={key} className="flex flex-wrap items-center gap-1.5">
                      {urls.map((u) => (
                        <span
                          key={`${key}-${u}`}
                          title={u}
                          className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-zinc-300"
                        >
                          {icon}
                          <span className="max-w-[240px] truncate font-mono text-[11px]">{u}</span>
                        </span>
                      ))}
                    </div>
                  );
                })}
                {SOURCE_GROUPS.every(({ key }) => (result.extraction[key] || []).length === 0) && (
                  <p className="text-sm text-zinc-500">No media sources were found on this page.</p>
                )}
              </div>

              <Button
                className="bg-rose-600 font-bold hover:bg-rose-500"
                onClick={() => navigate(`/content/${result.record.id}`)}
              >
                Open in library
              </Button>
            </CardContent>
          </Card>

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-zinc-500">Raw extraction</p>
            <pre className="custom-scrollbar max-h-96 overflow-auto rounded-xl border border-white/10 bg-black/40 p-4 font-mono text-xs text-zinc-300">
              {JSON.stringify(result.extraction, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------------------- providers tab ---------------------------- */

const NOT_ROUTED = [
  'OpenSubtitles',
  'BallDontLie',
  'OpenLigaDB',
  'TheSportsDB',
  'OpenDota',
  'PokeAPI',
  'Steam',
  'iTunes',
  'Lyrics.ovh',
  'MusicBrainz',
  'OpenLibrary',
  'Wikipedia',
  'Wikidata',
  'Wiktionary',
  'REST Countries',
  'GeoDB',
  'Open-Meteo',
  'NASA',
  'Giphy',
  'Unsplash',
  'Pexels',
  'Trivia',
  'JokeAPI',
  'Quotable',
  'RandomFox',
  'Shibe',
];

function ProviderStateBadge({ state }: { state: string }) {
  if (state === 'closed') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-300">
        healthy
      </span>
    );
  }
  if (state === 'open') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-rose-500/30 bg-rose-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-rose-300">
        circuit open
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-amber-300">
      half-open
    </span>
  );
}

function ProvidersTab({ providers, loading }: { providers: HealthResponse['providers'] | undefined; loading: boolean }) {
  return (
    <Card className="border-white/10 bg-white/[0.03]">
      <CardHeader>
        <CardTitle className="text-base">Routed providers</CardTitle>
        <CardDescription>
          Live circuit-breaker state for every upstream API the backend routes to.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-8">
        {loading && !providers ? (
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        ) : !providers || providers.length === 0 ? (
          <EmptyState title="No providers" message="Provider health is not available right now." />
        ) : (
          <div>
            {providers.map((p) => (
              <div
                key={p.name}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-white/5 py-2.5 last:border-0"
              >
                <div className="flex items-center gap-3">
                  <span className="font-mono font-semibold text-zinc-100">{p.name}</span>
                  <ProviderStateBadge state={p.state} />
                </div>
                <div className="flex min-w-0 items-center gap-4 text-xs text-zinc-500">
                  <span className="shrink-0">{p.failures} failures</span>
                  {p.lastError && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="max-w-md cursor-help truncate text-zinc-500">{p.lastError}</span>
                      </TooltipTrigger>
                      <TooltipContent
                        side="bottom"
                        className="max-w-sm break-words border-white/10 bg-[#1a1a24] text-zinc-200"
                      >
                        {p.lastError}
                      </TooltipContent>
                    </Tooltip>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="space-y-2">
          <h3 className="text-xs font-bold uppercase tracking-widest text-zinc-500">
            Also configured (not routed yet)
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {NOT_ROUTED.map((name) => (
              <span
                key={name}
                className="rounded-full border border-white/5 bg-white/[0.03] px-2.5 py-1 text-[11px] text-zinc-500"
              >
                {name}
              </span>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/* ------------------------------ about tab ------------------------------ */

const API_ROUTES: { method: string; path: string }[] = [
  { method: 'GET', path: '/api/all' },
  { method: 'GET', path: '/api/content/:id' },
  { method: 'GET', path: '/api/content/:id/player' },
  { method: 'POST', path: '/api/content' },
  { method: 'DELETE', path: '/api/content/:id' },
  { method: 'POST|GET', path: '/api/miner' },
  { method: 'GET', path: '/api/health' },
  { method: 'POST', path: '/api/admin/seed' },
  { method: 'GET', path: '/api/anime/*' },
  { method: 'GET', path: '/api/movies/*' },
  { method: 'GET', path: '/api/tv/*' },
  { method: 'GET', path: '/api/news' },
  { method: 'GET', path: '/api/sports/football/*' },
  { method: 'GET', path: '/api/sports/f1/*' },
];

function methodClass(method: string): string {
  if (method === 'GET') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300';
  if (method === 'DELETE') return 'border-rose-500/30 bg-rose-500/10 text-rose-300';
  if (method.includes('POST')) return 'border-amber-500/30 bg-amber-500/10 text-amber-300';
  return 'border-white/10 bg-white/5 text-zinc-300';
}

function AboutTab({ onSeeded }: { onSeeded: () => void }) {
  const [seeding, setSeeding] = useState(false);

  async function handleSeed() {
    if (seeding) return;
    setSeeding(true);
    try {
      const res = await api.seed();
      toast.success(`Seeded: ${res.added.movie} movies, ${res.added.tv} TV, ${res.added.anime} anime`);
      onSeeded();
    } catch (e) {
      toast.error(getErrorMessage(e));
    } finally {
      setSeeding(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Download CTA */}
      <Card className="border-rose-500/20 bg-gradient-to-br from-rose-500/[0.08] via-white/[0.03] to-white/[0.02]">
        <CardContent className="flex flex-col items-start gap-5 p-6 sm:flex-row sm:items-center">
          <div className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-rose-500 to-fuchsia-600 shadow-lg shadow-rose-900/40">
            <Download className="h-6 w-6 text-white" aria-hidden />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-lg font-black text-white">Download the full Animaxia platform</h3>
            <p className="mt-1 text-sm text-zinc-400">
              The complete stack — Express backend (Neon PostgreSQL, stream miner, auth, premium, social, AI,
              analytics, search engine, workers, security, mobile API) plus the Next.js frontend, ready to run
              anywhere.
            </p>
          </div>
          <div className="flex shrink-0 flex-col gap-2 sm:flex-row">
            <a href="/animaxia-platform.zip" download>
              <Button size="lg" className="bg-rose-600 font-bold text-white hover:bg-rose-500">
                <Download aria-hidden /> Platform ZIP
              </Button>
            </a>
            <a href="/animaxia-backend.zip" download>
              <Button size="lg" variant="outline" className="border-white/10 bg-transparent text-zinc-300 hover:bg-white/5 hover:text-white">
                <Download aria-hidden /> Backend only
              </Button>
            </a>
          </div>
        </CardContent>
      </Card>

      {/* Cloud (Phase 3) */}
      <Card className="border-fuchsia-500/25 bg-gradient-to-br from-fuchsia-500/[0.08] via-white/[0.03] to-white/[0.02]">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Cloud className="h-4 w-4 text-fuchsia-400" aria-hidden />
            Animaxia Cloud — Phase 3 (microservices &amp; enterprise)
          </CardTitle>
          <CardDescription>
            The platform re-architected as 10 microservices (API gateway + auth, content, AI, analytics, search,
            premium, social, mobile, queue) with Docker + Kubernetes + Helm, CI/CD with auto-rollback, full
            observability (Prometheus / Grafana / Loki / Tempo tracing), Cloudflare edge (WAF, KV, R2) and a
            disaster-recovery program.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {[
              { name: 'gateway', desc: ':8080 · routing, edge cache, breakers' },
              { name: 'auth', desc: ':4001 · users, JWT, security' },
              { name: 'content', desc: ':4002 · library, miner, providers' },
              { name: 'ai', desc: ':4003 · recommendations, chat' },
              { name: 'analytics', desc: ':4004 · views, trending' },
              { name: 'search', desc: ':4005 · advanced, fuzzy, index' },
              { name: 'premium', desc: ':4006 · plans, Stripe' },
              { name: 'social', desc: ':4007 · comments, feeds' },
              { name: 'mobile', desc: ':4008 · mobile app API' },
              { name: 'queue', desc: ':4009 · PG jobs, cron, workers' },
            ].map((s) => (
              <div key={s.name} className="rounded-lg border border-white/10 bg-black/30 px-3 py-2">
                <p className="font-mono text-xs font-bold text-fuchsia-300">{s.name}-service</p>
                <p className="text-[11px] text-zinc-500">{s.desc}</p>
              </div>
            ))}
          </div>
          <a href="/animaxia-cloud.zip" download>
            <Button size="lg" className="w-full bg-fuchsia-600 font-bold text-white hover:bg-fuchsia-500">
              <CloudDownload aria-hidden /> Download Animaxia Cloud ZIP
            </Button>
          </a>
        </CardContent>
      </Card>

      {/* Seed */}
      <Card className="border-white/10 bg-white/[0.03]">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <DatabaseZap className="h-4 w-4 text-rose-400" aria-hidden />
            Trending content
          </CardTitle>
          <CardDescription>
            Refreshes TMDB and Jikan trending content into the library — safe to run at any time, existing records
            are upserted.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            variant="outline"
            className="border-white/15 bg-white/5 font-semibold hover:bg-white/10"
            onClick={handleSeed}
            disabled={seeding}
          >
            {seeding ? <Loader2 className="animate-spin" aria-hidden /> : <DatabaseZap aria-hidden />}
            Re-sync trending content
          </Button>
        </CardContent>
      </Card>

      {/* API reference */}
      <Card className="border-white/10 bg-white/[0.03]">
        <CardHeader>
          <CardTitle className="text-base">API reference</CardTitle>
          <CardDescription>Every route the backend exposes on port 4000.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="custom-scrollbar overflow-x-auto rounded-xl border border-white/10 bg-black/40">
            <div className="min-w-[420px] divide-y divide-white/5 font-mono text-xs">
              {API_ROUTES.map((r) => (
                <div key={r.path + r.method} className="flex items-center gap-3 px-4 py-2.5">
                  <span
                    className={`inline-flex w-[92px] shrink-0 justify-center rounded-full border px-2 py-0.5 text-[10px] font-bold ${methodClass(r.method)}`}
                  >
                    {r.method}
                  </span>
                  <span className="text-zinc-300">{r.path}</span>
                </div>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      <p className="text-center text-xs text-zinc-600">
        Backend port 4000 · accessed via gateway ?XTransformPort=4000
      </p>
    </div>
  );
}

/* ----------------------------- ai cloud tab ----------------------------- */

function AiCloudLockCard() {
  return (
    <Card className="border-rose-500/20 bg-white/[0.03]">
      <CardContent className="flex flex-col items-center gap-4 p-10 text-center">
        <div className="grid h-14 w-14 place-items-center rounded-2xl bg-rose-500/10">
          <Lock className="h-6 w-6 text-rose-400" aria-hidden />
        </div>
        <div>
          <p className="font-semibold text-zinc-100">Admin access required</p>
          <p className="mt-1 max-w-md text-sm text-zinc-400">
            Sign in as an administrator to view AI Cloud telemetry — LLM usage, vector index and the assistant.
          </p>
        </div>
        <Button className="bg-rose-600 font-bold hover:bg-rose-500" onClick={() => navigate('/auth')}>
          Sign in
        </Button>
      </CardContent>
    </Card>
  );
}

function AiMetricCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: React.ReactNode }) {
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

function AiCloudTab() {
  const { isAdmin, initializing } = useAuth();

  const stats = useApi(`admin-ai-stats-${isAdmin}`, () => platform.aiAdminStats(), {
    enabled: !initializing && isAdmin,
  });
  const prompts = useApi(`admin-ai-prompts-${isAdmin}`, () => platform.aiAdminPrompts(8), {
    enabled: !initializing && isAdmin,
  });
  const errors = useApi(`admin-ai-errors-${isAdmin}`, () => platform.aiAdminErrors(8), {
    enabled: !initializing && isAdmin,
  });

  /* A 403 means the session is not admin — surface the lock card (same
     pattern as the Analytics / Workers tabs). */
  const locked =
    !initializing &&
    (!isAdmin || isForbidden(stats.error) || isForbidden(prompts.error) || isForbidden(errors.error));
  if (locked) return <AiCloudLockCard />;

  if (stats.loading && !stats.data) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-xl" />
          ))}
        </div>
        <div className="grid gap-4 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-40 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-48 rounded-xl" />
      </div>
    );
  }

  if (stats.error && !stats.data) {
    return <ErrorState message={stats.error} onRetry={stats.refetch} compact />;
  }

  const s = stats.data;
  if (!s) return null;

  const usage = s.usage;

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-zinc-500">
          Phase-4 AI Cloud — LLM usage, vector index and the Animaxia Assistant, live from the usage ring.
        </p>
        <Button
          variant="outline"
          size="sm"
          className="border-white/15 bg-white/5 font-semibold hover:bg-white/10"
          onClick={() => {
            void stats.refetch();
            void prompts.refetch();
            void errors.refetch();
          }}
        >
          <RefreshCw aria-hidden /> Refresh
        </Button>
      </div>

      {/* Usage metrics */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <AiMetricCard
          icon={<Activity className="h-5 w-5 text-rose-400" aria-hidden />}
          label="Calls today"
          value={usage.callsToday}
        />
        <AiMetricCard
          icon={<BarChart3 className="h-5 w-5 text-amber-400" aria-hidden />}
          label="Total calls"
          value={usage.totalCalls}
        />
        <AiMetricCard
          icon={<AlertTriangle className="h-5 w-5 text-teal-400" aria-hidden />}
          label="Error rate"
          value={`${(usage.errorRate * 100).toFixed(1)}%`}
        />
        <AiMetricCard
          icon={<Timer className="h-5 w-5 text-fuchsia-400" aria-hidden />}
          label="Latency p50 / p95"
          value={`${usage.latency.p50} / ${usage.latency.p95}ms`}
        />
        <AiMetricCard
          icon={<DollarSign className="h-5 w-5 text-lime-400" aria-hidden />}
          label="Token cost"
          value={`$${usage.costUsd.toFixed(2)}`}
        />
        <AiMetricCard
          icon={<Zap className="h-5 w-5 text-orange-400" aria-hidden />}
          label="Degraded calls"
          value={usage.degradedCalls}
        />
      </div>

      {/* Provider / vector / assistant */}
      <div className="grid gap-4 lg:grid-cols-3">
        <StatCard icon={<Sparkles className="h-4 w-4 text-rose-400" aria-hidden />} title="LLM provider">
          <p className="font-semibold text-zinc-100">
            {s.provider.provider} <span className="font-mono text-xs text-zinc-500">{s.provider.model}</span>
          </p>
          {s.provider.available ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-semibold text-emerald-300">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden /> available
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-[11px] font-semibold text-amber-300">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400" aria-hidden /> degraded
            </span>
          )}
          <p className="font-mono text-[11px] text-zinc-500">
            tokens: {usage.tokens.prompt.toLocaleString()} in / {usage.tokens.completion.toLocaleString()} out
          </p>
        </StatCard>

        <StatCard icon={<Database className="h-4 w-4 text-fuchsia-400" aria-hidden />} title="Vector index">
          <p className="font-semibold text-zinc-100">
            {s.vector.backend} <span className="font-mono text-xs text-zinc-500">{s.vector.dims}d</span>
          </p>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(s.vector.counts).map(([kind, count]) => (
              <span
                key={kind}
                className="rounded-full border border-fuchsia-500/25 bg-fuchsia-500/10 px-2 py-0.5 font-mono text-[10px] font-semibold text-fuchsia-300"
              >
                {kind}: {count}
              </span>
            ))}
          </div>
        </StatCard>

        <StatCard icon={<Bot className="h-4 w-4 text-teal-400" aria-hidden />} title="Assistant">
          <p className="font-semibold text-zinc-100">{s.assistant.tools} tools</p>
          <div className="flex flex-wrap gap-1.5">
            {s.assistant.toolNames.map((name) => (
              <span
                key={name}
                className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 font-mono text-[10px] text-zinc-300"
              >
                <Wrench className="h-2.5 w-2.5 text-teal-400" aria-hidden />
                {name}
              </span>
            ))}
          </div>
        </StatCard>
      </div>

      {/* Top prompts + recent calls */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="border-white/10 bg-white/[0.03]">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Brain className="h-4 w-4 text-rose-400" aria-hidden /> Top prompts
            </CardTitle>
            <CardDescription>Aggregated by feature and mode from the persisted usage logs.</CardDescription>
          </CardHeader>
          <CardContent>
            {prompts.loading && !prompts.data ? (
              <div className="space-y-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-9 w-full" />
                ))}
              </div>
            ) : prompts.error && !prompts.data ? (
              <ErrorState compact message={prompts.error} onRetry={prompts.refetch} />
            ) : (prompts.data?.topPrompts ?? []).length === 0 ? (
              <p className="py-6 text-center text-sm text-zinc-500">No prompts logged yet.</p>
            ) : (
              <div className="custom-scrollbar max-h-72 overflow-y-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="border-white/10 hover:bg-transparent">
                      <TableHead className="text-zinc-400">Feature</TableHead>
                      <TableHead className="text-zinc-400">Prompt</TableHead>
                      <TableHead className="text-right text-zinc-400">Count</TableHead>
                      <TableHead className="text-right text-zinc-400">Tokens</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(prompts.data?.topPrompts ?? []).map((p, i) => (
                      <TableRow key={`${p.feature}-${i}`} className="border-white/5">
                        <TableCell className="font-mono text-[11px] text-rose-300">
                          {p.feature}
                          {p.mode ? <span className="text-zinc-600">/{p.mode}</span> : null}
                        </TableCell>
                        <TableCell className="max-w-[220px] truncate text-xs text-zinc-300" title={p.snippet}>
                          {p.snippet}
                        </TableCell>
                        <TableCell className="text-right text-xs font-bold text-zinc-100">{p.count}</TableCell>
                        <TableCell className="text-right font-mono text-[11px] text-zinc-400">{p.tokens}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-white/10 bg-white/[0.03]">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Activity className="h-4 w-4 text-amber-400" aria-hidden /> Recent calls
            </CardTitle>
            <CardDescription>
              Latest {prompts.data?.recent.length ?? 0} LLM invocations from the in-memory ring.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {prompts.loading && !prompts.data ? (
              <div className="space-y-2">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-8 w-full" />
                ))}
              </div>
            ) : prompts.error && !prompts.data ? null : (prompts.data?.recent ?? []).length === 0 ? (
              <p className="py-6 text-center text-sm text-zinc-500">No calls recorded yet.</p>
            ) : (
              <ul className="custom-scrollbar max-h-72 space-y-1.5 overflow-y-auto pr-1">
                {(prompts.data?.recent ?? []).map((r, i) => (
                  <li
                    key={`${r.traceid}-${i}`}
                    className="flex items-center gap-2.5 rounded-lg border border-white/5 bg-white/[0.02] px-2.5 py-2"
                  >
                    <span
                      className={cn(
                        'h-2 w-2 shrink-0 rounded-full',
                        r.status === 'ok' || r.status === 'success' ? 'bg-emerald-400' : 'bg-rose-400',
                      )}
                      aria-label={r.status}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-[11px] text-zinc-300">
                        {r.feature}
                        {r.mode ? <span className="text-zinc-600">/{r.mode}</span> : null} · {r.provider}
                      </span>
                      <span className="block truncate text-[11px] text-zinc-600" title={r.snippet}>
                        {r.snippet}
                      </span>
                    </span>
                    {r.degraded && (
                      <span className="shrink-0 rounded-full border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase text-amber-300">
                        degraded
                      </span>
                    )}
                    <span className="shrink-0 text-right font-mono text-[10px] text-zinc-500">
                      <span className="block">{r.tokens} tok</span>
                      <span className="block">{formatMs(r.latencyms)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Recent errors */}
      <Card className="border-white/10 bg-white/[0.03]">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <AlertTriangle className="h-4 w-4 text-rose-400" aria-hidden /> Recent AI errors
          </CardTitle>
          <CardDescription>
            {errors.data ? `${errors.data.total} total · ${(errors.data.errorRate * 100).toFixed(1)}% error rate` : '—'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {errors.loading && !errors.data ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : errors.error && !errors.data ? (
            <ErrorState compact message={errors.error} onRetry={errors.refetch} />
          ) : (errors.data?.recent ?? []).length === 0 ? (
            <p className="flex items-center justify-center gap-2 py-6 text-center text-sm text-emerald-300">
              <Sparkles className="h-4 w-4" aria-hidden /> No errors — smooth sailing.
            </p>
          ) : (
            <ul className="divide-y divide-white/5">
              {(errors.data?.recent ?? []).map((e, i) => (
                <li key={`${e.traceid}-${i}`} className="flex items-start justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-zinc-200">{e.message || e.snippet}</p>
                    <p className="font-mono text-[11px] text-zinc-600">
                      {e.provider} · {e.feature}
                    </p>
                  </div>
                  <span className="shrink-0 text-xs text-zinc-500">
                    {new Date(e.createdat).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/* ------------------------------ main view ------------------------------ */

export function AdminView() {
  const health = useApi('admin-health', () => api.health());
  // FAZA 11: #/admin/tenants deep-links straight to the Tenants tab
  // (route.params[0] === 'tenants'); every other sub-path defaults to content.
  // Controlled Tabs: `tab` is null until the user clicks, so the route-derived
  // target keeps driving the selection across the null→object route transition
  // (useRoute is null on the very first render).
  const route = useRoute();
  const [tabOverride, setTabOverride] = useState<string | null>(null);
  const routeTab =
    route?.view === 'admin' && route.params[0] === 'tenants'
      ? 'tenants'
      : route?.view === 'admin' && route.params[0] === 'ingest'
        ? 'ingest' // FAZA 12: #/admin/ingest deep-links to the miner console
        : route?.view === 'admin' && route.params[0] === 'shards'
          ? 'shards' // FAZA 13: #/admin/shards deep-links to the shard console
          : route?.view === 'admin' && route.params[0] === 'search-flow'
            ? 'search-flow' // FAZA 15: #/admin/search-flow deep-links to the search flow console
            : route?.view === 'admin' && route.params[0] === 'search-rate'
              ? 'search-rate' // FAZA 16: #/admin/search-rate deep-links to the search rate console
              : route?.view === 'admin' && route.params[0] === 'search-opt'
                ? 'search-opt' // FAZA 17: #/admin/search-opt deep-links to the search optimization console
                : route?.view === 'admin' && route.params[0] === 'search-full'
                  ? 'search-full' // FAZA 18: #/admin/search-full deep-links to the full integration + stress console
                  : route?.view === 'admin' && route.params[0] === 'playerhub'
                    ? 'playerhub' // FAZA 21: #/admin/playerhub deep-links to the Player Hub console
                    : 'content';
  const activeTab = tabOverride ?? routeTab;

  return (
    <Container className="space-y-6 py-8 sm:py-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <PageHeader
          title="Admin panel"
          subtitle="Operate the Animaxia backend — library, miner, providers and system health."
        />
        <Button
          variant="outline"
          className="border-white/15 bg-white/5 font-semibold hover:bg-white/10"
          onClick={() => health.refetch()}
        >
          <RefreshCw aria-hidden /> Refresh
        </Button>
      </div>

      <StatsSection health={health.data} loading={health.loading} error={health.error} onRetry={health.refetch} />

      <Tabs value={activeTab} onValueChange={setTabOverride} className="gap-4">
        <TabsList className="w-full flex-wrap justify-start border border-white/10 bg-white/[0.03] sm:w-fit">
          <TabsTrigger value="content">Content</TabsTrigger>
          <TabsTrigger value="miner">Miner</TabsTrigger>
          <TabsTrigger value="analytics">
            <BarChart3 className="h-3.5 w-3.5" aria-hidden /> Analytics
          </TabsTrigger>
          <TabsTrigger value="workers">
            <Cpu className="h-3.5 w-3.5" aria-hidden /> Workers
          </TabsTrigger>
          <TabsTrigger value="security">
            <ShieldAlert className="h-3.5 w-3.5" aria-hidden /> Security
          </TabsTrigger>
          <TabsTrigger value="tenants">
            <Building2 className="h-3.5 w-3.5" aria-hidden /> Tenants
          </TabsTrigger>
          <TabsTrigger value="ingest">
            <DatabaseZap className="h-3.5 w-3.5" aria-hidden /> Ingest
          </TabsTrigger>
          <TabsTrigger value="shards">
            <Network className="h-3.5 w-3.5" aria-hidden /> Shards
          </TabsTrigger>
          <TabsTrigger value="search-flow">
            <Waves className="h-3.5 w-3.5" aria-hidden /> Search Flow
          </TabsTrigger>
          <TabsTrigger value="search-rate">
            <Timer className="h-3.5 w-3.5" aria-hidden /> Search Rate
          </TabsTrigger>
          <TabsTrigger value="search-opt">
            <Layers className="h-3.5 w-3.5" aria-hidden /> Search Opt
          </TabsTrigger>
          <TabsTrigger value="search-full">
            <Rocket className="h-3.5 w-3.5" aria-hidden /> Search Full
          </TabsTrigger>
          <TabsTrigger value="playerhub">
            <MonitorPlay className="h-3.5 w-3.5" aria-hidden /> Player Hub
          </TabsTrigger>
          <TabsTrigger value="providers">Providers</TabsTrigger>
          <TabsTrigger value="ai">
            <Bot className="h-3.5 w-3.5" aria-hidden /> AI Cloud
          </TabsTrigger>
          <TabsTrigger value="about">About</TabsTrigger>
        </TabsList>
        <TabsContent value="content">
          <ContentTab onMutated={() => health.refetch()} />
        </TabsContent>
        <TabsContent value="miner">
          <MinerTab onMutated={() => health.refetch()} />
        </TabsContent>
        <TabsContent value="analytics">
          <AdminAnalyticsTab />
        </TabsContent>
        <TabsContent value="workers">
          <AdminWorkersTab />
        </TabsContent>
        <TabsContent value="security">
          <AdminSecurityTab />
        </TabsContent>
        <TabsContent value="tenants">
          <AdminTenantsTab />
        </TabsContent>
        <TabsContent value="ingest">
          <AdminMinerTab />
        </TabsContent>
        <TabsContent value="shards">
          <AdminShardsTab />
        </TabsContent>
        <TabsContent value="search-flow">
          <AdminSearchFlowTab />
        </TabsContent>
        <TabsContent value="search-rate">
          <AdminSearchRateTab />
        </TabsContent>
        <TabsContent value="search-opt">
          <AdminSearchOptTab />
        </TabsContent>
        <TabsContent value="search-full">
          <AdminSearchFullTab />
        </TabsContent>
        <TabsContent value="playerhub">
          <AdminPlayerHubTab />
        </TabsContent>
        <TabsContent value="providers">
          <ProvidersTab providers={health.data?.providers} loading={health.loading} />
        </TabsContent>
        <TabsContent value="ai">
          <AiCloudTab />
        </TabsContent>
        <TabsContent value="about">
          <AboutTab onSeeded={() => health.refetch()} />
        </TabsContent>
      </Tabs>
    </Container>
  );
}
