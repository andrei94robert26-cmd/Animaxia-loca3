'use client';

/**
 * playlists-view.tsx — #/playlists „Playlist-urile Mele" (FAZA 21, task 21-1).
 *
 * Auth-only: vizitatorii neconectați primesc EmptyState cu buton de
 * conectare. Datele sunt 100% reale din /api/playerhub/playlists (FAZA 19):
 * listare cu itemsCount + firstItemThumbnail, detaliu la extindere (itemi
 * ordonați cu poziție), „Redă primul" → /player/:id, ștergere cu confirmare
 * (AlertDialog). Fiecare card se extinde INLINE — nu există pagină de
 * detaliu separată.
 */

import { useState } from 'react';
import {
  ChevronDown,
  Compass,
  ListMusic,
  Loader2,
  LogIn,
  Play,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/components/animaxia/auth-provider';
import { api } from '@/lib/animaxia/api';
import { useApi } from '@/lib/animaxia/hooks';
import { navigate } from '@/lib/animaxia/router';
import type { PlayerHubPlaylistSummary } from '@/lib/animaxia/types';
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
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { Container, PageHeader } from '../section';
import { EmptyState, ErrorState, TypeBadge } from '../states';

/* ------------------------------- formatting -------------------------------- */

function relativeTimeRo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return '—';
  const diff = Math.max(0, Date.now() - time);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'chiar acum';
  if (mins < 60) return `acum ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `acum ${hours} ${hours === 1 ? 'oră' : 'ore'}`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `acum ${days} ${days === 1 ? 'zi' : 'zile'}`;
  const months = Math.floor(days / 30);
  if (months < 12) return `acum ${months} ${months === 1 ? 'lună' : 'luni'}`;
  const years = Math.floor(months / 12);
  return `acum ${years} ${years === 1 ? 'an' : 'ani'}`;
}

/* ------------------------------ playlist card ------------------------------ */

function PlaylistCard({
  playlist,
  onDeleted,
}: {
  playlist: PlayerHubPlaylistSummary;
  onDeleted: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  /** Detaliul se fetch-uiește DOAR la prima extindere (lazy). */
  const detail = useApi(
    `faza21-playlist-${playlist.id}`,
    () => api.playerHubPlaylistDetail(playlist.id),
    { enabled: open },
  );

  const items = detail.data?.items ?? [];
  const firstItem = items[0]?.content ?? null;

  async function onDelete() {
    if (deleting) return;
    setDeleting(true);
    try {
      await api.playerHubDeletePlaylist(playlist.id);
      toast.success('Playlist șters', {
        description: `„${playlist.title}" și cele ${playlist.itemsCount} intrări au fost eliminate din Neon.`,
      });
      onDeleted();
    } catch (e) {
      toast.error('Ștergerea a eșuat', {
        description: e instanceof Error ? e.message : 'Încearcă din nou.',
      });
      setDeleting(false);
    }
  }

  return (
    <div
      className={cn(
        'flex min-w-0 flex-col overflow-hidden rounded-2xl border bg-white/[0.03] transition',
        open ? 'border-rose-500/40' : 'border-white/10',
      )}
    >
      {/* ---------------------------- header card ---------------------------- */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`${open ? 'Restrânge' : 'Extinde'} playlistul ${playlist.title}`}
        className="group flex w-full items-center gap-3 p-3 text-left transition hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60 sm:gap-4 sm:p-4"
      >
        <span className="relative block h-20 w-20 shrink-0 overflow-hidden rounded-xl border border-white/10 bg-black/40 sm:h-24 sm:w-24">
          {playlist.firstItemThumbnail ? (
            <img
              src={playlist.firstItemThumbnail}
              alt=""
              loading="lazy"
              className="h-full w-full object-cover"
            />
          ) : (
            <span className="grid h-full w-full place-items-center bg-gradient-to-br from-rose-500/15 to-fuchsia-600/10 text-rose-300/70">
              <ListMusic className="h-8 w-8" aria-hidden />
            </span>
          )}
          <span aria-hidden className="absolute inset-x-0 bottom-0 h-1 bg-black/60">
            <span
              className="block h-full bg-rose-500"
              style={{ width: `${Math.min(100, playlist.itemsCount * 10)}%` }}
            />
          </span>
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-bold text-zinc-100 transition group-hover:text-rose-300 sm:text-base">
            {playlist.title}
          </span>
          <span className="mt-1 block text-xs text-zinc-500">
            {playlist.itemsCount} {playlist.itemsCount === 1 ? 'titlu' : 'titluri'} · actualizat{' '}
            {relativeTimeRo(playlist.updatedat)}
          </span>
        </span>
        <ChevronDown
          aria-hidden
          className={cn('h-4 w-4 shrink-0 text-zinc-500 transition', open && 'rotate-180 text-rose-300')}
        />
      </button>

      {/* ------------------------- lista extinsă inline ------------------------- */}
      {open ? (
        <div className="border-t border-white/10 p-3 sm:p-4">
          {detail.loading && !detail.data ? (
            <div className="space-y-2" aria-busy="true" aria-label="Se încarcă playlistul">
              {Array.from({ length: Math.min(3, Math.max(1, playlist.itemsCount)) }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full rounded-lg" />
              ))}
            </div>
          ) : detail.error && !detail.data ? (
            <ErrorState compact message={detail.error} onRetry={() => void detail.refetch()} />
          ) : items.length === 0 ? (
            <p className="rounded-xl border border-white/10 bg-white/[0.02] p-3 text-center text-xs text-zinc-500">
              Playlist gol — adaugă titluri din pagina oricărui player („Adaugă la playlist").
            </p>
          ) : (
            <>
              <ul className="custom-scrollbar max-h-64 space-y-1.5 overflow-y-auto pr-1">
                {items.map((item) => (
                  <li key={`${item.position}-${item.content.id}`}>
                    <button
                      type="button"
                      onClick={() => navigate(`/content/${item.content.id}`)}
                      className="flex w-full items-center gap-3 rounded-lg border border-transparent bg-black/30 px-2.5 py-2 text-left transition hover:border-rose-500/30 hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60"
                    >
                      <span className="w-4 shrink-0 text-center text-[10px] font-black text-zinc-600">
                        {item.position + 1}
                      </span>
                      <span className="h-10 w-7 shrink-0 overflow-hidden rounded border border-white/10 bg-black/40">
                        {item.content.thumbnail ? (
                          <img src={item.content.thumbnail} alt="" loading="lazy" className="h-full w-full object-cover" />
                        ) : null}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-xs font-semibold text-zinc-200">
                        {item.content.title}
                      </span>
                      <TypeBadge type={item.content.type ?? 'content'} />
                    </button>
                  </li>
                ))}
              </ul>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  disabled={!firstItem}
                  onClick={() => firstItem && navigate(`/player/${firstItem.id}`)}
                  className="h-9 bg-rose-600 font-bold text-white hover:bg-rose-500"
                >
                  <Play className="h-3.5 w-3.5 fill-white" aria-hidden />
                  Redă primul
                  {firstItem && firstItem.title
                    ? `: ${firstItem.title.slice(0, 18)}${firstItem.title.length > 18 ? '…' : ''}`
                    : ''}
                </Button>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-9 border-red-500/30 bg-red-500/10 font-semibold text-red-300 hover:bg-red-500/20 hover:text-red-200"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                      Șterge
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Ștergi playlistul „{playlist.title}"?</AlertDialogTitle>
                      <AlertDialogDescription>
                        Cele {playlist.itemsCount} {playlist.itemsCount === 1 ? 'intrare va fi ștearsă' : 'intrări vor fi șterse'}{' '}
                        definitiv din Neon. Acțiunea nu poate fi anulată.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Anulează</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={(e) => {
                          e.preventDefault(); // ține dialogul deschis până se termină DELETE-ul
                          void onDelete();
                        }}
                        className="bg-rose-600 font-bold text-white hover:bg-rose-500"
                      >
                        {deleting ? (
                          <>
                            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
                            Se șterge…
                          </>
                        ) : (
                          'Șterge definitiv'
                        )}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

/* ---------------------------------- view ---------------------------------- */

export function PlaylistsView() {
  const { user, initializing } = useAuth();
  const playlists = useApi(
    `faza21-playlists-${user ? user.id : 'anon'}`,
    () => api.playerHubPlaylists(),
    { enabled: !!user },
  );

  /* ---- stări de auth ---- */
  if (initializing) {
    return (
      <Container className="space-y-6 py-10">
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-5 w-96 max-w-full" />
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-32 w-full rounded-2xl" />
          ))}
        </div>
      </Container>
    );
  }

  if (!user) {
    return (
      <Container className="py-12">
        <PageHeader
          title="Playlist-urile Mele"
          subtitle="Playlist-urile sunt legate de contul tău — conectează-te pentru a le vedea."
        />
        <div className="mt-8">
          <EmptyState
            icon={<ListMusic className="h-6 w-6" aria-hidden />}
            title="Conectează-te pentru playlist-urile tale"
            message="Pe contul tău găsești coada de redare salvată în FAZA 19 — până la 20 de playlist-uri, fiecare cu titlurile lui, 100% în Neon."
            action={
              <Button onClick={() => navigate('/auth')} className="bg-rose-600 font-bold hover:bg-rose-500">
                <LogIn className="mr-2 h-4 w-4" aria-hidden />
                Conectează-te
              </Button>
            }
          />
        </div>
      </Container>
    );
  }

  /* ---- stări de date ---- */
  if (playlists.loading && !playlists.data) {
    return (
      <Container className="space-y-6 py-10">
        <PageHeader title="Playlist-urile Mele" subtitle="Cozile tale de redare, salvate în Neon." />
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-32 w-full rounded-2xl" />
          ))}
        </div>
      </Container>
    );
  }

  if (playlists.error && !playlists.data) {
    return (
      <Container className="py-10">
        <PageHeader title="Playlist-urile Mele" subtitle="Cozile tale de redare, salvate în Neon." />
        <div className="mt-6">
          <ErrorState message={playlists.error} onRetry={() => void playlists.refetch()} />
        </div>
      </Container>
    );
  }

  const list = playlists.data?.data ?? [];

  return (
    <Container className="space-y-8 py-8 sm:py-10">
      <PageHeader
        title="Playlist-urile Mele"
        subtitle="Cozile tale de redare din Player Hub — extinde un card pentru titlurile din el."
      >
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Badge variant="outline" className="border-rose-500/30 bg-rose-500/10 text-rose-300 hover:bg-rose-500/10">
            <ListMusic className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            Max 20 playlist-uri · salvate în Neon
          </Badge>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void playlists.refetch()}
            disabled={playlists.loading}
            className="h-8 border-white/15 bg-white/5 text-zinc-200 hover:bg-white/10 hover:text-white"
          >
            <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', playlists.loading && 'animate-spin')} aria-hidden />
            Reîmprospătează
          </Button>
        </div>
      </PageHeader>

      {list.length === 0 ? (
        <EmptyState
          icon={<ListMusic className="h-6 w-6" aria-hidden />}
          title="Nu ai niciun playlist"
          message={'Adaugă titluri din pagina oricărui player — butonul „Adaugă la playlist” din panoul cozii de redare.'}
          action={
            <Button onClick={() => navigate('/home')} className="bg-rose-600 font-bold hover:bg-rose-500">
              <Compass className="mr-2 h-4 w-4" aria-hidden />
              Explorează biblioteca
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {list.map((pl) => (
            <PlaylistCard
              key={pl.id}
              playlist={pl}
              onDeleted={() => void playlists.refetch()}
            />
          ))}
        </div>
      )}
    </Container>
  );
}
