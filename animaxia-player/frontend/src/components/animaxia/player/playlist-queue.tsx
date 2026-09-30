'use client';

/**
 * playlist-queue.tsx — FAZA 19 (task 19-3b): mod playlist în player.
 *
 * Piese:
 *  - `usePlaylistContext(contentId)` — fetch REAL al playlist-urilor proprii prin
 *    /api/playerhub/playlists (Neon), detectează cozile care conțin titlul curent
 *    și expune navigație next/prev plus mutații (add / create / remove).
 *  - `PlaylistQueue` — cardul „Coadă de redare” (selector de coadă, itemuri cu
 *    badge „ACUM”, next/prev, eliminare item).
 *  - `AddToPlaylistCard` — cardul discret „Adaugă la playlist” (sau cerere de
 *    login pentru vizitatori neautentificați).
 *  - `NextUpCountdownOverlay` — overlay „Următorul în X secunde” deasupra
 *    playerului (countdown 5s, framer-motion), parte din auto-play next.
 *
 * NOTĂ ONESTĂ (despre numărul de requesturi): listarea playlist-urilor NU spune
 * ce titluri conțin, așa că hook-ul descarcă detaliile DOAR pentru primele
 * `PLAYLIST_DETAIL_CAP` playlist-uri (cele mai recent modificate — backend-ul
 * face bump pe `updatedat` la orice add/remove/reorder, deci playlist-ul abia
 * modificat e mereu printre primele). Un user poate avea max 20 de playlist-uri;
 * capacul ține requesturile la maximum 6 GETuri paralele în loc de N. Efect:
 * un titlu aflat într-un playlist din afara topului 6 (recent neatinse) nu
 * generează coadă până când acel playlist nu e modificat la rândul lui — cardul
 * „Adaugă la playlist” rămâne disponibil cu listarea COMPLETĂ a playlist-urilor.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ListMusic, Loader2, LogIn, Plus, SkipBack, SkipForward, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/animaxia/api';
import { navigate } from '@/lib/animaxia/router';
import type { PlayerHubPlaylistSummary } from '@/lib/animaxia/types';
import { useAuth } from '@/components/animaxia/auth-provider';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { BrandPlaceholder, TypeBadge } from '@/components/animaxia/states';
import { cn } from '@/lib/utils';

/* ---------------------------------- date ---------------------------------- */

/** Un item dintr-o coadă de redare (plat, extras din detaliul playlist-ului). */
export interface QueueItem {
  contentId: number;
  position: number;
  title: string;
  type: string;
  thumbnail: string | null;
}

/** O coadă = un playlist care conține titlul curent. */
export interface PlaylistQueueData {
  id: number;
  title: string;
  items: QueueItem[];
}

/** Câte detaliile de playlist se descarcă per încărcare (vezi nota de sus). */
const PLAYLIST_DETAIL_CAP = 6;

export interface PlaylistContextValue {
  loading: boolean;
  error: string | null;
  /** Toate playlist-urile userului (sumar — pentru cardul „Adaugă”). */
  allPlaylists: PlayerHubPlaylistSummary[];
  /** Playlist-urile care CONȚIN titlul curent. */
  queues: PlaylistQueueData[];
  activeQueue: PlaylistQueueData | null;
  setActiveQueue: (id: number) => void;
  /** Itemul curent (dacă coada activă îl conține). */
  current: QueueItem | null;
  /** Următorul / anteriorul item față de poziția curentă în coada activă. */
  next: QueueItem | null;
  prev: QueueItem | null;
  addToPlaylist: (playlistId: number) => Promise<boolean>;
  createAndAdd: (title: string) => Promise<boolean>;
  removeItem: (contentId: number) => Promise<void>;
  reload: () => Promise<void>;
}

export function usePlaylistContext(contentId: number | null): PlaylistContextValue {
  const { user } = useAuth();
  const enabled = user != null && contentId != null;

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [allPlaylists, setAllPlaylists] = useState<PlayerHubPlaylistSummary[]>([]);
  const [queues, setQueues] = useState<PlaylistQueueData[]>([]);
  const [activeQueueId, setActiveQueueId] = useState<number | null>(null);

  const reload = useCallback(async () => {
    if (!enabled || contentId == null) {
      setAllPlaylists([]);
      setQueues([]);
      setActiveQueueId(null);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const list = await api.playerHubPlaylists();
      setAllPlaylists(list.data);
      /* Detalii DOAR pentru primele PLAYLIST_DETAIL_CAP playlist-uri (cele mai
         recent modificate — vezi nota ONESTĂ din header-ul fișierului). */
      const capped = list.data.slice(0, PLAYLIST_DETAIL_CAP);
      const details = await Promise.all(
        capped.map((p) => api.playerHubPlaylistDetail(p.id).catch(() => null)),
      );
      const containing: PlaylistQueueData[] = [];
      for (const d of details) {
        if (!d) continue;
        const items: QueueItem[] = d.items
          .filter((it) => it.content != null && it.content.id != null)
          .map((it) => ({
            contentId: it.content.id,
            position: it.position,
            title: it.content.title ?? `#${it.content.id}`,
            type: it.content.type ?? 'unknown',
            thumbnail: it.content.thumbnail,
          }));
        if (items.some((i) => i.contentId === contentId)) {
          containing.push({ id: d.playlist.id, title: d.playlist.title, items });
        }
      }
      setQueues(containing);
      setActiveQueueId((prev) => {
        if (prev != null && containing.some((q) => q.id === prev)) return prev;
        return containing[0]?.id ?? null;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Nu am putut încărca playlist-urile.');
    } finally {
      setLoading(false);
    }
  }, [enabled, contentId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const activeQueue = useMemo(
    () => queues.find((q) => q.id === activeQueueId) ?? null,
    [queues, activeQueueId],
  );

  const { current, next, prev } = useMemo(() => {
    if (!activeQueue || contentId == null) {
      return { current: null, next: null, prev: null };
    }
    const idx = activeQueue.items.findIndex((i) => i.contentId === contentId);
    if (idx < 0) return { current: null, next: null, prev: null };
    return {
      current: activeQueue.items[idx],
      next: idx + 1 < activeQueue.items.length ? activeQueue.items[idx + 1] : null,
      prev: idx > 0 ? activeQueue.items[idx - 1] : null,
    };
  }, [activeQueue, contentId]);

  const addToPlaylist = useCallback(
    async (playlistId: number): Promise<boolean> => {
      if (contentId == null) return false;
      try {
        const res = await api.playerHubAddPlaylistItem(playlistId, contentId);
        if (res.duplicate) {
          toast.info('Titlul era deja în acest playlist.');
        } else {
          toast.success('Adăugat la playlist.');
        }
        await reload();
        return true;
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Nu am putut adăuga la playlist.');
        return false;
      }
    },
    [contentId, reload],
  );

  const createAndAdd = useCallback(
    async (title: string): Promise<boolean> => {
      if (contentId == null) return false;
      const clean = title.trim();
      if (clean.length < 2) {
        toast.error('Numele playlist-ului trebuie să aibă cel puțin 2 caractere.');
        return false;
      }
      try {
        const created = await api.playerHubCreatePlaylist(clean);
        await api.playerHubAddPlaylistItem(created.playlist.id, contentId);
        toast.success(`Playlist-ul „${clean}” a fost creat.`);
        await reload();
        return true;
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Nu am putut crea playlist-ul.');
        return false;
      }
    },
    [contentId, reload],
  );

  const removeItem = useCallback(
    async (cid: number): Promise<void> => {
      if (!activeQueue) return;
      try {
        await api.playerHubRemovePlaylistItem(activeQueue.id, cid);
        toast.success('Eliminat din playlist.');
        await reload();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Nu am putut elimina titlul.');
      }
    },
    [activeQueue, reload],
  );

  return {
    loading,
    error,
    allPlaylists,
    queues,
    activeQueue,
    setActiveQueue: setActiveQueueId,
    current,
    next,
    prev,
    addToPlaylist,
    createAndAdd,
    removeItem,
    reload,
  };
}

/* ---------------------------- coada de redare ----------------------------- */

export function PlaylistQueue({ ctx }: { ctx: PlaylistContextValue }) {
  const { activeQueue, queues, setActiveQueue, current, next, prev, removeItem, loading } = ctx;

  if (loading && !activeQueue) {
    return (
      <Card className="border-white/10 bg-white/[0.03]" aria-busy="true" aria-label="Se încarcă coada de redare">
        <CardContent className="space-y-3 p-4">
          <Skeleton className="h-5 w-36" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </CardContent>
      </Card>
    );
  }
  if (!activeQueue) return null;

  return (
    <Card className="border-white/10 bg-white/[0.03]">
      <CardHeader className="gap-2 p-4 pb-2 sm:p-4">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm font-bold uppercase tracking-widest text-zinc-400">
            <ListMusic className="h-4 w-4 text-rose-400" aria-hidden />
            Coadă de redare
          </CardTitle>
          <div className="flex items-center gap-1.5">
            {/* prev / next față de poziția curentă din coadă */}
            <Button
              variant="outline"
              size="icon"
              className="h-7 w-7 border-white/15 bg-white/5 hover:bg-white/10"
              disabled={!prev}
              title={prev ? `Anteriorul: ${prev.title}` : 'Nu există un item anterior'}
              aria-label="Itemul anterior din coadă"
              onClick={() => prev && navigate(`/player/${prev.contentId}`)}
            >
              <SkipBack className="h-3.5 w-3.5" aria-hidden />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="h-7 w-7 border-white/15 bg-white/5 hover:bg-white/10"
              disabled={!next}
              title={next ? `Următorul: ${next.title}` : 'Ești la ultimul item'}
              aria-label="Itemul următor din coadă"
              onClick={() => next && navigate(`/player/${next.contentId}`)}
            >
              <SkipForward className="h-3.5 w-3.5" aria-hidden />
            </Button>
          </div>
        </div>
        {/* Selector de coadă — doar când titlul e în mai multe playlist-uri. */}
        {queues.length > 1 ? (
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Alege playlist-ul">
            {queues.map((q) => (
              <button
                key={q.id}
                type="button"
                aria-pressed={q.id === activeQueue.id}
                onClick={() => setActiveQueue(q.id)}
                className={cn(
                  'rounded-full border px-2.5 py-1 text-[11px] font-semibold transition',
                  q.id === activeQueue.id
                    ? 'border-rose-500/60 bg-rose-600 text-white'
                    : 'border-white/10 bg-white/[0.04] text-zinc-300 hover:border-white/25 hover:bg-white/10',
                )}
              >
                {q.title} · {q.items.length}
              </button>
            ))}
          </div>
        ) : (
          <p className="truncate text-xs font-semibold text-zinc-300" title={activeQueue.title}>
            {activeQueue.title} · {activeQueue.items.length} titluri
          </p>
        )}
      </CardHeader>
      <CardContent className="p-4 pt-2">
        <ul
          className="custom-scrollbar max-h-[70vh] space-y-1.5 overflow-y-auto pr-1"
          aria-label="Itemurile din coada de redare"
        >
          {activeQueue.items.map((item) => {
            const isCurrent = current != null && item.contentId === current.contentId;
            return (
              <li key={item.contentId} className="group/row relative">
                <button
                  type="button"
                  onClick={() => navigate(`/player/${item.contentId}`)}
                  aria-current={isCurrent ? 'true' : undefined}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-xl border p-2 text-left transition',
                    isCurrent
                      ? 'border-rose-500/50 bg-rose-500/[0.10]'
                      : 'border-white/10 bg-white/[0.02] hover:border-white/25 hover:bg-white/[0.06]',
                  )}
                >
                  <span className="h-11 w-[74px] shrink-0 overflow-hidden rounded-lg border border-white/10 bg-white/5">
                    {item.thumbnail ? (
                      <img
                        src={item.thumbnail}
                        alt=""
                        loading="lazy"
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <BrandPlaceholder title={item.title} />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span
                        className={cn(
                          'line-clamp-1 text-xs font-semibold',
                          isCurrent ? 'text-white' : 'text-zinc-200',
                        )}
                      >
                        {item.title}
                      </span>
                      {isCurrent && (
                        <span className="shrink-0 rounded-full bg-rose-600 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-white">
                          Acum
                        </span>
                      )}
                    </span>
                    <span className="mt-1 flex items-center gap-1.5">
                      <TypeBadge type={item.type} />
                      <span className="text-[10px] text-zinc-500">
                        #{item.position + 1} în coadă
                      </span>
                    </span>
                  </span>
                </button>
                {/* Elimină itemul din playlist (hover pe rând). */}
                <button
                  type="button"
                  title="Elimină din playlist"
                  aria-label={`Elimină ${item.title} din playlist`}
                  onClick={() => void removeItem(item.contentId)}
                  className="absolute right-1.5 top-1.5 hidden rounded-md border border-white/15 bg-black/70 p-1 text-zinc-400 transition hover:border-rose-500/50 hover:text-rose-300 group-hover/row:block focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60"
                >
                  <X className="h-3 w-3" aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

/* -------------------------- adaugă la playlist ---------------------------- */

export function AddToPlaylistCard({ ctx }: { ctx: PlaylistContextValue }) {
  const { user } = useAuth();
  const { allPlaylists, loading, error, addToPlaylist, createAndAdd, reload } = ctx;
  const [open, setOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [busy, setBusy] = useState<'add' | 'create' | null>(null);

  /* Neautentificați: cardul cere login. */
  if (!user) {
    return (
      <Card className="border-white/10 bg-white/[0.02]">
        <CardContent className="flex items-center gap-3 p-4">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-white/10 bg-white/5">
            <LogIn className="h-4 w-4 text-rose-400" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-white">Coadă de redare</p>
            <p className="text-xs leading-relaxed text-zinc-400">
              Autentifică-te ca să-ți construiești playlist-uri și să redai în coadă.
            </p>
          </div>
          <Button
            size="sm"
            className="shrink-0 bg-rose-600 font-bold hover:bg-rose-500"
            onClick={() => navigate('/auth')}
          >
            <LogIn className="h-4 w-4" aria-hidden /> Login
          </Button>
        </CardContent>
      </Card>
    );
  }

  const onPick = async (playlistId: number) => {
    setBusy('add');
    try {
      await addToPlaylist(playlistId);
    } finally {
      setBusy(null);
    }
  };

  const onCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim() || busy) return;
    setBusy('create');
    try {
      const ok = await createAndAdd(newTitle);
      if (ok) {
        setNewTitle('');
        setOpen(false);
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="border-white/10 bg-white/[0.02]">
      <CardContent className="space-y-3 p-4">
        <button
          type="button"
          onClick={() => (open ? setOpen(false) : (setOpen(true), void reload()))}
          aria-expanded={open}
          className="flex w-full items-center gap-3 rounded-xl border border-dashed border-white/15 bg-white/[0.02] p-3 text-left transition hover:border-rose-500/40 hover:bg-rose-500/[0.05] focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60"
        >
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-white/10 bg-white/5">
            <Plus className="h-4 w-4 text-rose-400" aria-hidden />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-white">Adaugă la playlist</span>
            <span className="block text-xs text-zinc-400">
              Titlul nu e în niciun playlist — adaugă-l ca să ai o coadă de redare.
            </span>
          </span>
        </button>

        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              key="add-panel"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
              className="overflow-hidden"
            >
              <div className="space-y-2.5 pt-1">
                {loading ? (
                  <p className="flex items-center gap-2 px-1 text-xs text-zinc-400">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Se încarcă…
                  </p>
                ) : error ? (
                  <p className="px-1 text-xs text-rose-300" role="alert">
                    {error}
                  </p>
                ) : (
                  <>
                    {allPlaylists.length > 0 && (
                      <div className="space-y-1.5">
                        <p className="px-1 text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
                          Playlist-uri existente
                        </p>
                        <ul className="custom-scrollbar max-h-44 space-y-1 overflow-y-auto pr-1">
                          {allPlaylists.map((p) => (
                            <li key={p.id}>
                              <button
                                type="button"
                                disabled={busy != null}
                                onClick={() => void onPick(p.id)}
                                className="flex w-full items-center justify-between gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-2 text-left text-xs font-semibold text-zinc-200 transition hover:border-rose-500/40 hover:bg-rose-500/[0.07] disabled:opacity-50"
                              >
                                <span className="truncate">{p.title}</span>
                                <span className="shrink-0 text-[10px] font-normal text-zinc-500">
                                  {p.itemsCount} titluri
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    <form className="flex flex-col gap-2 sm:flex-row" onSubmit={onCreate}>
                      <label htmlFor="playlist-new-title" className="sr-only">
                        Playlist nou
                      </label>
                      <Input
                        id="playlist-new-title"
                        value={newTitle}
                        onChange={(e) => setNewTitle(e.target.value)}
                        placeholder="Playlist nou…"
                        maxLength={120}
                        className="h-9 border-white/10 bg-black/40 text-xs"
                      />
                      <Button
                        type="submit"
                        disabled={busy != null || newTitle.trim().length < 2}
                        className="h-9 bg-rose-600 font-bold hover:bg-rose-500"
                      >
                        {busy === 'create' ? (
                          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                        ) : (
                          <Plus className="h-4 w-4" aria-hidden />
                        )}
                        Creează
                      </Button>
                    </form>
                  </>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </CardContent>
    </Card>
  );
}

/* ---------------------- overlay countdown „Următorul” --------------------- */

export function NextUpCountdownOverlay({
  next,
  seconds = 5,
  onPlayNow,
  onCancel,
}: {
  next: QueueItem;
  seconds?: number;
  onPlayNow: () => void;
  onCancel: () => void;
}) {
  const [remaining, setRemaining] = useState(seconds);
  const firedRef = useRef(false);

  useEffect(() => {
    const t = setInterval(() => setRemaining((r) => r - 1), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (remaining > 0 || firedRef.current) return;
    firedRef.current = true;
    onPlayNow();
  }, [remaining, onPlayNow]);

  return (
    <motion.div
      role="status"
      aria-label={`Următorul în ${Math.max(remaining, 0)} secunde: ${next.title}`}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="absolute inset-0 z-30 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
    >
      <motion.div
        initial={{ scale: 0.95, y: 8 }}
        animate={{ scale: 1, y: 0 }}
        transition={{ duration: 0.22, ease: 'easeOut' }}
        className="w-full max-w-sm overflow-hidden rounded-2xl border border-white/15 bg-[#12121a] shadow-2xl shadow-black/60"
      >
        <div className="relative aspect-video w-full bg-white/5">
          {next.thumbnail ? (
            <img
              src={next.thumbnail}
              alt=""
              className="h-full w-full object-cover opacity-90"
            />
          ) : (
            <BrandPlaceholder title={next.title} />
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-black/80 to-transparent" />
          <span className="absolute left-3 top-3 rounded-full bg-rose-600 px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest text-white">
            Următorul în {Math.max(remaining, 0)} secunde
          </span>
          <p className="absolute inset-x-3 bottom-2.5 line-clamp-2 text-sm font-bold text-white drop-shadow">
            {next.title}
          </p>
          {/* bară de progres countdown (secundă cu secundă) */}
          <div className="absolute inset-x-0 bottom-0 h-1 bg-white/10">
            <motion.div
              className="h-full bg-rose-500"
              animate={{ width: `${(Math.max(remaining, 0) / seconds) * 100}%` }}
              transition={{ duration: 1, ease: 'linear' }}
            />
          </div>
        </div>
        <div className="flex gap-2 p-3">
          <Button
            className="flex-1 bg-rose-600 font-bold hover:bg-rose-500"
            onClick={() => {
              if (!firedRef.current) {
                firedRef.current = true;
                onPlayNow();
              }
            }}
          >
            <SkipForward className="h-4 w-4" aria-hidden /> Redă acum
          </Button>
          <Button
            variant="outline"
            className="flex-1 border-white/15 bg-white/5 font-semibold hover:bg-white/10"
            onClick={() => {
              firedRef.current = true;
              onCancel();
            }}
          >
            Anulează
          </Button>
        </div>
      </motion.div>
    </motion.div>
  );
}
