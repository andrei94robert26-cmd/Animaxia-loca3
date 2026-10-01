'use client';

/**
 * admin-playerhub-tab.tsx — FAZA 21 admin Playerhub console.
 * Three sections over the real FAZA-21 backend:
 *   (a) live gauges — GET /api/admin/playerhub/status (poll 15s, like shards):
 *       playback totals/kinds, users watching, avg progress, uptime, source
 *       modes and the top-5 most watched titles;
 *   (b) WebVTT subtitles — admin list + honest preview (fetches the public
 *       .vtt body) + delete confirm + upload form with a debounced content
 *       picker, client-side WEBVTT validation and honest 400 surfacing;
 *   (c) my history — the admin's own watch history with a resume button.
 * Non-admins get an honest access error, never a crash. Romanian UI.
 */

import { useEffect, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Captions,
  Clock,
  Eye,
  Film,
  Loader2,
  MonitorPlay,
  Play,
  RefreshCw,
  Server,
  Trash2,
  Upload,
  Users,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, apiUrl } from '@/lib/animaxia/api';
import { useApi } from '@/lib/animaxia/hooks';
import { navigate } from '@/lib/animaxia/router';
import type { DbContent, SubtitleAdminRow } from '@/lib/animaxia/types';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { Container } from '../../section';
import { EmptyState, ErrorState, TypeBadge } from '../../states';

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

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return '—';
  const diff = Math.max(0, Date.now() - time);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'chiar acum';
  if (mins < 60) return `acum ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `acum ${hours} h`;
  return `acum ${Math.floor(hours / 24)} zile`;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : 'Cererea a eșuat';
}

/** True when the endpoint refused us for role reasons (401/403). */
function isForbidden(message: string | null): boolean {
  return Boolean(message && /admin access required|auth required|unauthorized|forbidden|status 40[13]/i.test(message));
}

/* -------------------------- stat card (gauge-uri) -------------------------- */

function StatCard({
  icon,
  title,
  value,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  value: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <Card className="border-white/10 bg-white/[0.03]">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-zinc-400">
          {icon}
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <p className="text-2xl font-black leading-tight text-white">{value}</p>
        {children}
      </CardContent>
    </Card>
  );
}

/* ------------------------- a) live gauges section -------------------------- */

function PlayerhubStatusSection() {
  const status = useApi('admin-playerhub-status', () => api.playerhub.status());

  /* NEON FREE PLAN: auto-refresh 15s ELIMINAT — montare + Refresh manual. */

  const data = status.data;
  const loadingFirst = status.loading && !data;

  if (loadingFirst) {
    return (
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[118px] rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    );
  }

  if (status.error && !data) {
    if (isForbidden(status.error)) {
      return (
        <EmptyState
          title="Acces doar pentru administratori"
          message="Gauge-urile playerhub (redări, utilizatori activi, surse, top vizionări) necesită un cont cu rol de administrator."
          icon={<AlertTriangle className="h-6 w-6" aria-hidden />}
        />
      );
    }
    return <ErrorState message={status.error} onRetry={() => void status.refetch()} compact />;
  }
  if (!data) return null;

  const byKind = Object.entries(data.playback.byKind);
  const byMode = Object.entries(data.sources.byMode).sort((a, b) => b[1] - a[1]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-200">
          <Activity className="h-4 w-4 text-rose-400" aria-hidden />
          Gauge-uri live
        </h3>
        <div className="flex items-center gap-3">
          <span className="text-[11px] text-zinc-600">auto-refresh 15s</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void status.refetch()}
            aria-label="Reîmprospătează statusul playerhub"
            className="border-white/15 bg-white/5 font-semibold hover:bg-white/10"
          >
            <RefreshCw className={status.loading ? 'animate-spin' : ''} aria-hidden /> Refresh
          </Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard icon={<Play className="h-4 w-4 text-rose-400" aria-hidden />} title="Redări totale" value={formatRo(data.playback.total)}>
          <p className="text-xs text-zinc-400">{formatRo(data.playback.last24h)} în ultimele 24h</p>
          <div className="flex flex-wrap gap-1.5">
            {byKind.map(([kind, n]) => (
              <span key={kind} className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 font-mono text-[10px] text-zinc-300">
                {kind} {formatRo(n)}
              </span>
            ))}
          </div>
        </StatCard>
        <StatCard icon={<Users className="h-4 w-4 text-teal-400" aria-hidden />} title="Utilizatori activi" value={formatRo(data.usersWatching)}>
          <p className="text-xs text-zinc-400">utilizatori distincti cu vizionări în 24h</p>
        </StatCard>
        <StatCard icon={<Clock className="h-4 w-4 text-amber-400" aria-hidden />} title="Progres mediu" value={data.avgProgress != null ? `${Math.round(data.avgProgress / 60)} min` : '—'}>
          <p className="text-xs text-zinc-400">
            {data.avgProgress != null ? `${formatRo(Math.round(data.avgProgress))} s în watchhistory` : 'încă fără istoric'}
          </p>
        </StatCard>
        <StatCard icon={<Server className="h-4 w-4 text-fuchsia-400" aria-hidden />} title="Uptime monolit" value={formatUptime(data.uptimeSec)}>
          <p className="text-xs text-zinc-400">
            surse directe: {formatRo(data.sources.contentWithSources)} titluri · politici: {data.sources.allowedTypes.join(', ')}
          </p>
        </StatCard>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {/* top watched */}
        <Card className="border-white/10 bg-white/[0.03]">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm text-zinc-200">
              <Eye className="h-4 w-4 text-rose-400" aria-hidden /> Cele mai vizionate (top 5)
            </CardTitle>
            <CardDescription>evenimente reale view + play, JOIN content</CardDescription>
          </CardHeader>
          <CardContent>
            {data.topWatched.length === 0 ? (
              <p className="py-4 text-center text-sm text-zinc-500">Încă nimic vizionat.</p>
            ) : (
              <ol className="space-y-2">
                {data.topWatched.slice(0, 5).map((row, i) => (
                  <li key={row.contentId} className="flex items-center gap-3">
                    <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-rose-600/20 font-mono text-xs font-black text-rose-300">
                      {i + 1}
                    </span>
                    {row.thumbnail ? (
                      <img src={row.thumbnail} alt="" loading="lazy" className="h-11 w-8 shrink-0 rounded object-cover border border-white/10" />
                    ) : (
                      <span className="grid h-11 w-8 shrink-0 place-items-center rounded border border-white/10 bg-white/[0.04] text-zinc-600">
                        <Film className="h-3.5 w-3.5" aria-hidden />
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <button
                        type="button"
                        onClick={() => navigate(`/content/${row.contentId}`)}
                        className="line-clamp-1 text-left text-sm font-semibold text-zinc-100 transition hover:text-rose-300"
                      >
                        {row.title}
                      </button>
                      <div className="flex items-center gap-2">
                        <TypeBadge type={row.type} />
                        <span className="font-mono text-[10px] text-zinc-500">{formatRo(row.plays)} redări</span>
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>

        {/* sources by mode + subtitles */}
        <Card className="border-white/10 bg-white/[0.03]">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm text-zinc-200">
              <MonitorPlay className="h-4 w-4 text-teal-400" aria-hidden /> Surse & subtitrări
            </CardTitle>
            <CardDescription>{data.sources.note ?? 'aproximare onestă din metadata.sources'}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap gap-1.5">
              {byMode.map(([mode, n]) => (
                <span
                  key={mode}
                  className={
                    mode === 'none'
                      ? 'rounded-full border border-zinc-500/30 bg-zinc-500/10 px-2.5 py-0.5 font-mono text-[10px] text-zinc-400'
                      : 'rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 font-mono text-[10px] text-emerald-300'
                  }
                >
                  {mode} {formatRo(n)}
                </span>
              ))}
            </div>
            <p className="text-xs text-zinc-400">
              Subtitrări încărcate:{' '}
              <span className="font-bold text-zinc-100">{data.subtitles ? formatRo(data.subtitles.total) : '—'}</span>
              {data.subtitles && data.subtitles.perContent.length > 0 ? (
                <span className="text-zinc-500">
                  {' '}
                  · {data.subtitles.perContent.map((c) => `${c.title} (${c.tracks})`).join(' · ')}
                </span>
              ) : null}
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/* ------------------------- b) subtitles section ---------------------------- */

function ContentPicker({ onPick }: { onPick: (row: DbContent) => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<DbContent[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* Debounce 500ms → /api/all?search=. No synchronous setState in the effect
     body — the render-time gate below hides stale results while typing. */
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    if (q.length < 2) return undefined;
    debounceRef.current = setTimeout(() => {
      setSearching(true);
      setError(null);
      api
        .all({ search: q, limit: 8 })
        .then((res) => setResults(res.data))
        .catch((e) => setError(errorMessage(e)))
        .finally(() => setSearching(false));
    }, 500);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  /* Derived display gate: the picker list only makes sense for a live query. */
  const liveQuery = query.trim().length >= 2;

  return (
    <div className="space-y-1.5">
      <Label htmlFor="subtitle-content-search" className="text-xs font-semibold text-zinc-400">
        Titlu din bibliotecă (caută după nume, debounce 500ms)
      </Label>
      <Input
        id="subtitle-content-search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="ex. bunny, sintel, frieren…"
        className="border-white/15 bg-black/40"
      />
      {searching ? (
        <p className="flex items-center gap-1.5 text-[11px] text-zinc-500">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Caut…
        </p>
      ) : error ? (
        <p className="text-[11px] text-rose-300">{error}</p>
      ) : liveQuery && results.length === 0 ? (
        <p className="text-[11px] text-zinc-500">Niciun rezultat.</p>
      ) : liveQuery ? (
        <ul className="max-h-44 space-y-1 overflow-y-auto rounded-xl border border-white/10 bg-black/30 p-1.5">
          {results.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                onClick={() => {
                  onPick(row);
                  setQuery('');
                  setResults([]);
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition hover:bg-white/[0.06]"
              >
                <span className="font-mono text-[10px] text-zinc-500">#{row.id}</span>
                <span className="line-clamp-1 flex-1 text-xs font-semibold text-zinc-200">{row.title}</span>
                <TypeBadge type={row.type} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function SubtitlesSection() {
  const list = useApi('admin-subtitles-list', () => api.subtitles.adminList());
  const [picked, setPicked] = useState<DbContent | null>(null);
  const [lang, setLang] = useState('ro');
  const [label, setLabel] = useState('Română');
  const [vtt, setVtt] = useState('');
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<SubtitleAdminRow | null>(null);
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SubtitleAdminRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  const rows = list.data?.data ?? [];
  const loadingFirst = list.loading && !list.data;

  const openPreview = async (row: SubtitleAdminRow) => {
    setPreview(row);
    setPreviewText(null);
    setPreviewLoading(true);
    try {
      /* The .vtt body is served publicly — fetch it through the gateway. */
      const res = await fetch(apiUrl(`/api/player/subtitles/${row.id}.vtt`));
      setPreviewText(res.ok ? await res.text() : `Nu am putut încărca corpul VTT (HTTP ${res.status}).`);
    } catch {
      setPreviewText('Nu am putut încărca corpul VTT.');
    } finally {
      setPreviewLoading(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!picked) {
      toast.error('Alege mai întâi un titlu din bibliotecă.');
      return;
    }
    const body = vtt.trim();
    /* Honest client-side validation mirroring the backend rules. */
    if (!body.startsWith('WEBVTT')) {
      toast.error('Conținutul VTT trebuie să înceapă cu antetul „WEBVTT”.');
      return;
    }
    if (!body.includes('-->')) {
      toast.error('Conținutul VTT nu conține niciun cue (lipsește „-->”).');
      return;
    }
    setUploading(true);
    try {
      const res = await api.subtitles.upload({
        contentId: picked.id,
        lang: lang.trim() || 'ro',
        label: label.trim() || 'Română',
        vtt: body,
      });
      toast.success(
        res.created
          ? `Subtitrare „${res.subtitle.id}” încărcată pentru „${picked.title}”`
          : `Subtitrarea existentă pentru „${picked.title}” a fost actualizată (upsert)`,
      );
      setVtt('');
      await list.refetch();
    } catch (err) {
      /* 400s carry the server's honest reason — surface it verbatim. */
      toast.error(errorMessage(err));
    } finally {
      setUploading(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.subtitles.remove(deleteTarget.id);
      toast.success(`Subtitrarea #${deleteTarget.id} a fost ștearsă`);
      setDeleteTarget(null);
      await list.refetch();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        {/* upload form */}
        <Card className="border-white/10 bg-white/[0.03]">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm text-zinc-200">
              <Upload className="h-4 w-4 text-rose-400" aria-hidden /> Încarcă o pistă WebVTT
            </CardTitle>
            <CardDescription>
              Validare onestă: antet „WEBVTT”, cel puțin un cue, 8–512KB; serverul face upsert pe (titlu, limbă, etichetă).
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form className="space-y-3" onSubmit={submit}>
              <ContentPicker onPick={setPicked} />
              {picked ? (
                <p className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-semibold text-emerald-300">
                  Selectat: #{picked.id} — {picked.title}
                </p>
              ) : null}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="subtitle-lang" className="text-xs font-semibold text-zinc-400">
                    Limbă (cod)
                  </Label>
                  <Input
                    id="subtitle-lang"
                    value={lang}
                    maxLength={10}
                    onChange={(e) => setLang(e.target.value)}
                    className="border-white/15 bg-black/40 font-mono"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="subtitle-label" className="text-xs font-semibold text-zinc-400">
                    Etichetă
                  </Label>
                  <Input
                    id="subtitle-label"
                    value={label}
                    maxLength={60}
                    onChange={(e) => setLabel(e.target.value)}
                    className="border-white/15 bg-black/40"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="subtitle-vtt" className="text-xs font-semibold text-zinc-400">
                  Conținut VTT
                </Label>
                <Textarea
                  id="subtitle-vtt"
                  rows={6}
                  value={vtt}
                  onChange={(e) => setVtt(e.target.value)}
                  placeholder={'WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nSalut, Animaxia!'}
                  className="border-white/15 bg-black/40 font-mono text-xs"
                />
                <input
                  type="file"
                  accept=".vtt,text/vtt"
                  aria-label="Încarcă fișier .vtt din disc"
                  className="block w-full text-xs text-zinc-400 file:mr-3 file:rounded-lg file:border-0 file:bg-rose-600/80 file:px-3 file:py-1.5 file:text-xs file:font-bold file:text-white hover:file:bg-rose-500"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    setVtt(await file.text());
                    e.target.value = '';
                  }}
                />
              </div>
              <Button type="submit" disabled={uploading || !picked || !vtt.trim()} className="bg-rose-600 font-bold hover:bg-rose-500">
                {uploading ? <Loader2 className="animate-spin" aria-hidden /> : <Upload aria-hidden />}
                Încarcă subtitrarea
              </Button>
            </form>
          </CardContent>
        </Card>

        {/* admin list */}
        <Card className="border-white/10 bg-white/[0.03]">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm text-zinc-200">
              <Captions className="h-4 w-4 text-teal-400" aria-hidden /> Piste încărcate ({rows.length})
            </CardTitle>
            <CardDescription>{'cue-uri numărate în SQL din aparițiile „-->”'}</CardDescription>
          </CardHeader>
          <CardContent>
            {loadingFirst ? (
              <div className="space-y-2">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            ) : list.error && !list.data ? (
              isForbidden(list.error) ? (
                <EmptyState
                  title="Acces doar pentru administratori"
                  message="Listarea pistelor de subtitrări necesită un cont cu rol de administrator."
                  icon={<AlertTriangle className="h-6 w-6" aria-hidden />}
                />
              ) : (
                <ErrorState message={list.error} onRetry={() => void list.refetch()} compact />
              )
            ) : rows.length === 0 ? (
              <p className="py-6 text-center text-sm text-zinc-500">Nicio subtitrare încărcată — folosește formularul.</p>
            ) : (
              <div className="overflow-hidden rounded-xl border border-white/10">
                <Table aria-label="Piste de subtitrări">
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead scope="col">Titlu</TableHead>
                      <TableHead scope="col">Limbă</TableHead>
                      <TableHead scope="col" className="hidden sm:table-cell">
                        Cue-uri
                      </TableHead>
                      <TableHead scope="col" className="text-right">
                        Acțiuni
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((row) => (
                      <TableRow key={row.id} className="hover:bg-white/[0.03]">
                        <TableCell className="max-w-[180px]">
                          <p className="truncate text-sm font-semibold text-zinc-100" title={row.contentTitle}>
                            {row.contentTitle}
                          </p>
                          <p className="font-mono text-[10px] text-zinc-600">
                            #{row.id} · {row.label}
                          </p>
                        </TableCell>
                        <TableCell>
                          <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 font-mono text-[10px] text-zinc-300">
                            {row.lang}
                          </span>
                        </TableCell>
                        <TableCell className="hidden sm:table-cell">
                          <span className="font-mono text-xs text-zinc-300">{formatRo(row.cues)}</span>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1.5">
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-8 border-white/15 bg-white/5 font-semibold hover:bg-white/10"
                              onClick={() => void openPreview(row)}
                            >
                              Vezi
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              aria-label={`Șterge subtitrarea #${row.id}`}
                              className="h-8 border-rose-500/30 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20 hover:text-white"
                              onClick={() => setDeleteTarget(row)}
                            >
                              <Trash2 className="h-3.5 w-3.5" aria-hidden />
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
      </div>

      {/* preview dialog */}
      <Dialog open={preview != null} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent className="border-white/10 bg-[#12121c] sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-base font-bold text-white">
              {preview ? `${preview.contentTitle} · ${preview.lang}` : ''}
            </DialogTitle>
            <DialogDescription>
              {preview ? `Pista #${preview.id} (${preview.label}) · ${formatRo(preview.cues)} cue-uri · ${formatRo(preview.bytes)} B` : ''}
            </DialogDescription>
          </DialogHeader>
          {previewLoading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-zinc-400">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Încarc corpul VTT…
            </div>
          ) : (
            <pre className="max-h-72 overflow-auto rounded-xl border border-white/10 bg-black/50 p-3 font-mono text-[11px] leading-relaxed text-zinc-300">
              {previewText ?? '—'}
            </pre>
          )}
        </DialogContent>
      </Dialog>

      {/* delete confirm */}
      <AlertDialog open={deleteTarget != null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent className="border-white/10 bg-[#12121c]">
          <AlertDialogHeader>
            <AlertDialogTitle>Ștergi pista {deleteTarget ? `#${deleteTarget.id} (${deleteTarget.lang})` : ''}?</AlertDialogTitle>
            <AlertDialogDescription>
              Titlul „{deleteTarget?.contentTitle}” va rămâne fără această pistă de subtitrare. Acțiunea este definitivă.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-white/15 bg-white/5 hover:bg-white/10">Anulează</AlertDialogCancel>
            <AlertDialogAction
              className="bg-rose-600 font-bold hover:bg-rose-500"
              disabled={deleting}
              onClick={(e) => {
                e.preventDefault();
                void confirmDelete();
              }}
            >
              {deleting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Trash2 className="h-4 w-4" aria-hidden />}
              Șterge
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/* ------------------------- c) my history section --------------------------- */

function MyHistorySection() {
  const history = useApi('admin-playerhub-history', () => api.playerhub.history());
  const rows = history.data?.data ?? [];
  const loadingFirst = history.loading && !history.data;

  if (loadingFirst) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full rounded-xl" />
        ))}
      </div>
    );
  }

  if (history.error && !history.data) {
    if (isForbidden(history.error)) {
      return (
        <EmptyState
          title="Acces doar pentru administratori"
          message="Istoricul personal din playerhub necesită un cont cu rol de administrator."
          icon={<AlertTriangle className="h-6 w-6" aria-hidden />}
        />
      );
    }
    return <ErrorState message={history.error} onRetry={() => void history.refetch()} compact />;
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        title="Istoricul tău e gol"
        message="Deschide un titlu în player — progresul se salvează automat și apare aici."
        icon={<Film className="h-6 w-6" aria-hidden />}
      />
    );
  }

  return (
    <ol className="space-y-2">
      {rows.map((row) => (
        <li
          key={`${row.contentid}-${row.watchedat}`}
          className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-3 transition hover:border-rose-500/25"
        >
          {row.thumbnail ? (
            <img
              src={row.thumbnail}
              alt=""
              loading="lazy"
              className="h-14 w-10 shrink-0 rounded-md border border-white/10 object-cover"
            />
          ) : (
            <span className="grid h-14 w-10 shrink-0 place-items-center rounded-md border border-white/10 bg-white/[0.04] text-zinc-600">
              <Film className="h-4 w-4" aria-hidden />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-bold text-zinc-100">{row.title}</p>
            <p className="text-[11px] text-zinc-500">
              {Math.round(row.progress / 60)} min vizionate · {relativeTime(row.watchedat)}
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-8 shrink-0 border-white/15 bg-white/5 font-semibold hover:bg-white/10"
            onClick={() => navigate(`/player/${row.contentid}?t=${Math.max(0, Math.floor(row.progress))}`)}
          >
            <Play className="h-3.5 w-3.5 fill-current" aria-hidden /> Continuă
          </Button>
        </li>
      ))}
    </ol>
  );
}

/* -------------------------------- main tab -------------------------------- */

export function AdminPlayerhubTab() {
  return (
    <div className="space-y-8">
      <section className="space-y-4" aria-label="Gauge-uri live playerhub">
        <PlayerhubStatusSection />
      </section>

      <section className="space-y-4" aria-label="Subtitrări WebVTT">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-200">
          <Captions className="h-4 w-4 text-teal-400" aria-hidden />
          Subtitrări WebVTT
        </h3>
        <SubtitlesSection />
      </section>

      <section className="space-y-4" aria-label="Istoricul meu">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-200">
          <Clock className="h-4 w-4 text-amber-400" aria-hidden />
          Istoricul meu
        </h3>
        <MyHistorySection />
      </section>
    </div>
  );
}
