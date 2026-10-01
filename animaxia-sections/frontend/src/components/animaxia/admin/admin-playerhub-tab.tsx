'use client';

/**
 * admin-playerhub-tab.tsx — FAZA 21 (task 21-2): Player Hub admin console.
 *
 * Live view over the FAZA 19 Player Hub API (/api/playerhub): the hub
 * contract header (version + features), 4 auto-refreshing gauges (5s, paused
 * while the tab is hidden) from /stats, the admin-only 7-day activity
 * counter, the platform's top continue-watching titles, WebVTT subtitle
 * management (attach / list / detach — admin-gated + audit-logged server
 * side) and the admin's own continue-watching history.
 *
 * Everything is REAL data from Neon — no mocks.
 */

import { useEffect, useState } from 'react';
import {
  Activity,
  Captions,
  Film,
  History,
  Layers,
  Loader2,
  Lock,
  MonitorPlay,
  PlayCircle,
  RefreshCw,
  Server,
  Trash2,
  TrendingUp,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/animaxia/api';
import { useApi } from '@/lib/animaxia/hooks';
import { navigate } from '@/lib/animaxia/router';
import { useAuth } from '../auth-provider';
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { EmptyState, ErrorState, TypeBadge } from '../states';

/* ------------------------------- helpers ------------------------------- */

/** True when an endpoint error means the caller is not an admin (403/401). */
function isForbidden(message: string | null): boolean {
  return Boolean(message && /admin access required|authentication required|forbidden|status 40[13]/i.test(message));
}

/** seconds → „mm:ss" (the unified FAZA 19 progress clock). */
function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function parseId(raw: string): number | null {
  const n = Number(raw.trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

const LANG_RE = /^[a-zA-Z-]{2,10}$/;

/* ------------------------------ lock card ------------------------------ */

function LockCard() {
  return (
    <Card className="border-rose-500/20 bg-white/[0.03]">
      <CardContent className="flex flex-col items-center gap-4 p-10 text-center">
        <div className="grid h-14 w-14 place-items-center rounded-2xl bg-rose-500/10">
          <Lock className="h-6 w-6 text-rose-400" aria-hidden />
        </div>
        <div>
          <p className="font-semibold text-zinc-100">Acces administrator necesar</p>
          <p className="mt-1 max-w-md text-sm text-zinc-400">
            Conectează-te ca administrator pentru a opera consola Player Hub.
          </p>
        </div>
        <Button className="bg-rose-600 font-bold hover:bg-rose-500" onClick={() => navigate('/auth')}>
          Conectare
        </Button>
      </CardContent>
    </Card>
  );
}

/* ------------------------------- gauges -------------------------------- */

function GaugeCard({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  hint?: string;
}) {
  return (
    <Card className="min-w-0 border-white/10 bg-white/[0.03]">
      <CardContent className="flex items-center gap-3 p-4">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-white/10 bg-white/[0.04]">
          {icon}
        </span>
        <div className="min-w-0">
          <p className="truncate text-2xl font-black leading-tight text-white">{value}</p>
          <p className="truncate text-[11px] font-semibold uppercase tracking-widest text-zinc-500">{label}</p>
          {hint ? <p className="truncate text-[11px] text-zinc-600">{hint}</p> : null}
        </div>
      </CardContent>
    </Card>
  );
}

/* --------------------------- subtitle manager -------------------------- */

function SubtitleManager() {
  /* — attach form — */
  const [attachId, setAttachId] = useState('');
  const [label, setLabel] = useState('');
  const [lang, setLang] = useState('ro');
  const [vtt, setVtt] = useState('');
  const [attaching, setAttaching] = useState(false);

  /* — listing — */
  const [listId, setListId] = useState('');
  const [tracks, setTracks] = useState<{ id: number; label: string; lang: string }[] | null>(null);
  const [listing, setListing] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  async function handleAttach(e: React.FormEvent) {
    e.preventDefault();
    const contentId = parseId(attachId);
    if (!contentId) {
      toast.error('ID-ul conținutului trebuie să fie un număr întreg pozitiv.');
      return;
    }
    if (!label.trim()) {
      toast.error('Eticheta trackului este obligatorie (1–120 caractere).');
      return;
    }
    if (!LANG_RE.test(lang.trim())) {
      toast.error('Limba trebuie să aibă 2–10 caractere (litere și cratime), ex. „ro" sau „en-US".');
      return;
    }
    if (!vtt.trimStart().startsWith('WEBVTT')) {
      toast.error('Corpul VTT trebuie să înceapă cu antetul „WEBVTT".');
      return;
    }
    setAttaching(true);
    try {
      const res = await api.playerHubAttachSubtitle(contentId, {
        label: label.trim(),
        lang: lang.trim(),
        vtt,
      });
      toast.success(`Trackul „${res.track.label}" a fost atașat pe contentul ${contentId}.`);
      setVtt('');
      // dacă listarea e deschisă pe același content, reîmprospătează-o
      if (parseId(listId) === contentId) {
        try {
          const fresh = await api.playerHubSubtitles(contentId);
          setTracks(fresh.data);
        } catch {
          /* listarea se reîmprospătează la următorul „Listează" */
        }
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Atașarea trackului a eșuat.');
    } finally {
      setAttaching(false);
    }
  }

  async function handleList() {
    const contentId = parseId(listId);
    if (!contentId) {
      toast.error('ID-ul conținutului trebuie să fie un număr întreg pozitiv.');
      return;
    }
    setListing(true);
    try {
      const res = await api.playerHubSubtitles(contentId);
      setTracks(res.data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Listarea trackurilor a eșuat.');
    } finally {
      setListing(false);
    }
  }

  async function handleDelete(trackId: number, trackLabel: string) {
    const contentId = parseId(listId);
    if (!contentId) return;
    setDeletingId(trackId);
    try {
      await api.playerHubDeleteSubtitle(contentId, trackId);
      toast.success(`Trackul „${trackLabel}" a fost șters de pe contentul ${contentId}.`);
      setTracks((prev) => (prev ? prev.filter((t) => t.id !== trackId) : prev));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Ștergerea trackului a eșuat.');
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <Card className="border-white/10 bg-white/[0.03]">
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <Captions className="h-4 w-4 text-rose-400" aria-hidden />
          Gestionare subtitrări
          <Badge variant="outline" className="border-rose-500/30 bg-rose-500/10 text-[10px] font-bold text-rose-300">
            ADMIN
          </Badge>
        </CardTitle>
        <CardDescription>
          Atașează trackuri WebVTT pe orice conținut (max. 8 / content) și dezlipește-le. Acțiunile sunt
          înregistrate în auditul platformei.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Attach form */}
        <form onSubmit={handleAttach} className="space-y-3" aria-label="Atașează track de subtitrare">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="ph-sub-content" className="text-xs text-zinc-400">
                ID conținut
              </Label>
              <Input
                id="ph-sub-content"
                inputMode="numeric"
                placeholder="ex. 2"
                value={attachId}
                onChange={(e) => setAttachId(e.target.value)}
                className="border-white/10 bg-white/[0.04]"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ph-sub-label" className="text-xs text-zinc-400">
                Etichetă
              </Label>
              <Input
                id="ph-sub-label"
                placeholder="ex. Română"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                className="border-white/10 bg-white/[0.04]"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ph-sub-lang" className="text-xs text-zinc-400">
                Limbă
              </Label>
              <Input
                id="ph-sub-lang"
                placeholder="ro"
                value={lang}
                onChange={(e) => setLang(e.target.value)}
                className="border-white/10 bg-white/[0.04]"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ph-sub-vtt" className="text-xs text-zinc-400">
              Corp WebVTT
            </Label>
            <Textarea
              id="ph-sub-vtt"
              rows={5}
              placeholder={'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nText subtitrare'}
              value={vtt}
              onChange={(e) => setVtt(e.target.value)}
              className="resize-y border-white/10 bg-white/[0.04] font-mono text-xs"
            />
            <p className="text-[11px] text-zinc-600">
              Fișierul trebuie să înceapă cu „WEBVTT" — este validat și pe client, și pe server.
            </p>
          </div>
          <Button
            type="submit"
            disabled={attaching}
            className="bg-rose-600 font-bold hover:bg-rose-500 disabled:opacity-60"
          >
            {attaching ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <PlayCircle aria-hidden />}
            {attaching ? 'Se atașează…' : 'Atașează track'}
          </Button>
        </form>

        {/* Listing */}
        <div className="space-y-3 border-t border-white/5 pt-4">
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1 space-y-1.5 sm:max-w-[220px]">
              <Label htmlFor="ph-list-content" className="text-xs text-zinc-400">
                Trackuri pe contentul…
              </Label>
              <Input
                id="ph-list-content"
                inputMode="numeric"
                placeholder="ex. 2"
                value={listId}
                onChange={(e) => setListId(e.target.value)}
                className="border-white/10 bg-white/[0.04]"
              />
            </div>
            <Button
              type="button"
              variant="outline"
              disabled={listing}
              onClick={() => void handleList()}
              className="border-white/15 bg-white/5 font-semibold hover:bg-white/10 disabled:opacity-60"
            >
              {listing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
              {listing ? 'Se listează…' : 'Listează'}
            </Button>
          </div>

          {tracks === null ? (
            <p className="text-sm text-zinc-600">
              Introdu un ID și apasă „Listează" pentru a vedea trackurile de subtitrări ale acelui conținut
              (listare publică).
            </p>
          ) : listing ? (
            <div className="space-y-2" aria-busy="true">
              {Array.from({ length: 2 }).map((_, i) => (
                <Skeleton key={i} className="h-12 rounded-xl" />
              ))}
            </div>
          ) : tracks.length === 0 ? (
            <EmptyState
              title="Niciun track"
              message="Acest conținut nu are subtitrări atașate — atașează prima mai sus."
            />
          ) : (
            <ul className="max-h-96 divide-y divide-white/5 overflow-y-auto rounded-xl border border-white/10 bg-white/[0.02]">
              {tracks.map((t) => (
                <li key={t.id} className="flex items-center gap-3 p-3">
                  <Captions className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-zinc-100">{t.label}</span>
                    <span className="block font-mono text-[11px] text-zinc-500">
                      lang: {t.lang} · id: {t.id}
                    </span>
                  </span>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={deletingId === t.id}
                        className="h-9 shrink-0 border-red-500/30 bg-red-500/10 font-semibold text-red-300 hover:bg-red-500/20 hover:text-red-200 disabled:opacity-60"
                      >
                        {deletingId === t.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                        ) : (
                          <Trash2 className="h-3.5 w-3.5" aria-hidden />
                        )}
                        Șterge
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Ștergi trackul „{t.label}"?</AlertDialogTitle>
                        <AlertDialogDescription>
                          Trackul {t.id} (limba {t.lang}) va fi dezlipit definitiv de pe contentul{' '}
                          {parseId(listId) ?? '—'}. Acțiunea este înregistrată în audit.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Anulează</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={(e) => {
                            e.preventDefault(); // ține dialogul deschis până se termină DELETE-ul
                            void handleDelete(t.id, t.label);
                          }}
                          className="bg-rose-600 font-bold text-white hover:bg-rose-500"
                        >
                          {deletingId === t.id ? (
                            <>
                              <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Se șterge…
                            </>
                          ) : (
                            'Șterge definitiv'
                          )}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/* -------------------------------- tab ---------------------------------- */

export function AdminPlayerHubTab() {
  const { isAdmin, initializing } = useAuth();

  const status = useApi(`admin:playerhub:status:${isAdmin}`, () => api.playerHubStatus(), {
    enabled: !initializing && isAdmin,
  });
  const stats = useApi(`admin:playerhub:stats:${isAdmin}`, () => api.playerHubStats(), {
    enabled: !initializing && isAdmin,
  });
  const continueWatching = useApi(
    `admin:playerhub:continue:${isAdmin}`,
    () => api.playerHubContinueWatching(),
    { enabled: !initializing && isAdmin },
  );

  /* Poll /stats every 5s while mounted (pause when the tab is hidden). */
  useEffect(() => {
    if (!isAdmin) return undefined;
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void stats.refetch();
    }, 5000);
    return () => clearInterval(timer);
  }, [isAdmin, stats.refetch]);

  const locked =
    !initializing &&
    (!isAdmin ||
      isForbidden(status.error) ||
      isForbidden(stats.error) ||
      isForbidden(continueWatching.error));
  if (locked) return <LockCard />;

  const loadingFirst = (status.loading && !status.data) || (stats.loading && !stats.data);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <MonitorPlay className="h-5 w-5 shrink-0 text-rose-400" aria-hidden />
          <h3 className="text-base font-bold text-zinc-100">Player Hub — FAZA 19</h3>
          {status.data ? (
            <Badge
              variant="outline"
              className="border-rose-500/30 bg-rose-500/10 font-mono text-[11px] font-bold text-rose-300"
            >
              v{status.data.version}
            </Badge>
          ) : null}
          {status.data ? (
            <span className="text-xs text-zinc-500">
              {status.data.features.length} funcționalități
            </span>
          ) : null}
          <span className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 font-mono text-[10px] text-zinc-400">
            <Server className="h-3 w-3" aria-hidden />
            API: /api/playerhub
          </span>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="border-white/15 bg-white/5 font-semibold hover:bg-white/10"
          onClick={() => {
            void status.refetch();
            void stats.refetch();
            void continueWatching.refetch();
          }}
        >
          <RefreshCw aria-hidden /> Reîmprospătează
        </Button>
      </div>

      {/* Feature chips */}
      {status.data ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {status.data.features.map((f) => (
            <span
              key={f}
              className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 font-mono text-[11px] text-zinc-400"
            >
              {f}
            </span>
          ))}
          <span className="ml-1 text-[11px] text-zinc-600">auto-refresh la 5s</span>
        </div>
      ) : null}

      {/* Gauges */}
      {loadingFirst ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-xl" />
          ))}
        </div>
      ) : stats.error && !stats.data ? (
        <ErrorState message={stats.error} onRetry={stats.refetch} compact />
      ) : stats.data ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <GaugeCard
            icon={<Layers className="h-5 w-5 text-rose-400" aria-hidden />}
            label="Playlist-uri"
            value={stats.data.totals.playlists}
            hint="tabelul playlists"
          />
          <GaugeCard
            icon={<PlayCircle className="h-5 w-5 text-amber-400" aria-hidden />}
            label="Itemuri în playlist-uri"
            value={stats.data.totals.playlistItems}
            hint="tabelul playlistitems"
          />
          <GaugeCard
            icon={<Captions className="h-5 w-5 text-teal-400" aria-hidden />}
            label="Trackuri subtitrări"
            value={stats.data.totals.subtitleTracks}
            hint="tabelul subtitletracks"
          />
          <GaugeCard
            icon={<History className="h-5 w-5 text-fuchsia-400" aria-hidden />}
            label="Intrări istoric"
            value={stats.data.totals.watchEntries}
            hint="watchhistory (unificat)"
          />
        </div>
      ) : null}

      {/* Admin 7-day activity + top continue-watching */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="min-w-0 border-white/10 bg-white/[0.03]">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Activity className="h-4 w-4 text-rose-400" aria-hidden />
              Activitate 7 zile
            </CardTitle>
            <CardDescription>Secțiune exclusiv admin din /api/playerhub/stats.</CardDescription>
          </CardHeader>
          <CardContent>
            {stats.data?.admin ? (
              <div className="flex items-center gap-4">
                <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl border border-rose-500/30 bg-rose-500/10">
                  <TrendingUp className="h-5 w-5 text-rose-400" aria-hidden />
                </span>
                <div className="min-w-0">
                  <p className="text-3xl font-black leading-none text-white">
                    {stats.data.admin.activePlaylistsLast7d}
                  </p>
                  <p className="mt-1 text-xs font-semibold uppercase tracking-widest text-zinc-500">
                    utilizatori cu playlist-uri active
                  </p>
                </div>
              </div>
            ) : (
              <p className="text-sm text-zinc-500">
                {stats.loading
                  ? 'Se încarcă…'
                  : 'Secțiunea admin nu a fost returnată — tokenul curent nu are rol de administrator.'}
              </p>
            )}
          </CardContent>
        </Card>

        <Card className="min-w-0 border-white/10 bg-white/[0.03] lg:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <TrendingUp className="h-4 w-4 text-amber-400" aria-hidden />
              Top continue-watching
            </CardTitle>
            <CardDescription>
              Cele mai urmărite titluri de utilizatorii platformei (top 5, după vizitatori distincți).
            </CardDescription>
          </CardHeader>
          <CardContent>
            {stats.data && stats.data.topContinueWatching.length > 0 ? (
              <ul className="space-y-2">
                {stats.data.topContinueWatching.map((c, i) => (
                  <li key={c.id}>
                    <button
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
                        <span className="block truncate text-sm font-semibold text-zinc-100">
                          {c.title ?? `Content #${c.id}`}
                        </span>
                        {c.type ? <TypeBadge type={c.type} /> : null}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState
                title="Nicio vizionare înregistrată"
                message="Topul va apărea imediat ce utilizatorii încep să vadă conținut."
              />
            )}
          </CardContent>
        </Card>
      </div>

      {/* Subtitle management (admin active) */}
      <SubtitleManager />

      {/* My playback history */}
      <Card className="min-w-0 border-white/10 bg-white/[0.03]">
        <CardHeader className="pb-3">
          <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
            <span className="flex items-center gap-2">
              <History className="h-4 w-4 text-teal-400" aria-hidden />
              Istoricul meu de redare
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-8 border-white/15 bg-white/5 font-semibold hover:bg-white/10"
              onClick={() => navigate('/history')}
            >
              Vezi tot
            </Button>
          </CardTitle>
          <CardDescription>
            Continue-watching pentru contul admin (progres unificat cu istoricul de vizionare).
          </CardDescription>
        </CardHeader>
        <CardContent>
          {continueWatching.loading && !continueWatching.data ? (
            <div className="space-y-2" aria-busy="true">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-14 rounded-xl" />
              ))}
            </div>
          ) : continueWatching.error && !continueWatching.data ? (
            <ErrorState message={continueWatching.error} onRetry={continueWatching.refetch} compact />
          ) : continueWatching.data && continueWatching.data.data.length > 0 ? (
            <ul className="max-h-96 space-y-2 overflow-y-auto pr-1">
              {continueWatching.data.data.slice(0, 8).map((entry) => (
                <li key={entry.content.id}>
                  <button
                    type="button"
                    onClick={() => navigate(`/player/${entry.content.id}`)}
                    className="flex w-full items-center gap-3 rounded-xl border border-white/5 bg-white/[0.02] p-2 text-left transition hover:border-rose-500/30 hover:bg-white/[0.05]"
                  >
                    {entry.content.thumbnail ? (
                      <img
                        src={entry.content.thumbnail}
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
                      <span className="block truncate text-sm font-semibold text-zinc-100">
                        {entry.content.title ?? `Content #${entry.content.id}`}
                      </span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-[11px] text-zinc-500">
                          progress: {formatClock(entry.progress)}
                        </span>
                        {entry.content.type ? <TypeBadge type={entry.content.type} /> : null}
                        {entry.hasResume ? (
                          <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">
                            Resume disponibil
                          </span>
                        ) : null}
                      </span>
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-zinc-600">
                      {entry.sourcesCount} {entry.sourcesCount === 1 ? 'sursă' : 'surse'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              title="Istoric gol"
              message="Nu ai nicio intrare în istoricul de redare — pornind o redare, progresul apare aici."
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
