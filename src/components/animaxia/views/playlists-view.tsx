'use client';

/**
 * playlists-view.tsx — FAZA 21 (#/playlists): real user playlists.
 * Grid of playlist cards + create dialog; clicking a card opens an in-view
 * detail state (editable title, delete with confirm, dense re-numbered items,
 * honest "play from the first title" — the player has no playlist engine yet)
 * plus a debounced search section that adds any library title to the list.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Layers,
  ListVideo,
  Loader2,
  Pencil,
  Play,
  Plus,
  Search as SearchIcon,
  Trash2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/animaxia/api';
import { useApi } from '@/lib/animaxia/hooks';
import { navigate } from '@/lib/animaxia/router';
import { useAuth } from '@/components/animaxia/auth-provider';
import type { DbContent, Playlist, PlaylistItem, PlaylistSummary } from '@/lib/animaxia/types';
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { Container, PageHeader } from '../section';
import { EmptyState, ErrorState, RatingBadge, TypeBadge } from '../states';

/* ------------------------------- helpers --------------------------------- */

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('ro-RO', { year: 'numeric', month: 'short', day: 'numeric' });
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : 'Cererea a eșuat';
}

/* ------------------------------ login prompt ------------------------------ */

function LoginPrompt() {
  return (
    <Container className="py-16 sm:py-24">
      <div className="mx-auto max-w-md">
        <EmptyState
          icon={<ListVideo className="h-6 w-6" aria-hidden />}
          title="Conectează-te pentru playlist-urile tale"
          message="Playlist-urile sunt colecții personale legate de contul tău — creează-le, adaugă titluri și continuă exact de unde ai rămas."
          action={
            <Button className="bg-rose-600 font-bold hover:bg-rose-500" onClick={() => navigate('/auth?next=/playlists')}>
              Conectează-te
            </Button>
          }
        />
      </div>
    </Container>
  );
}

/* --------------------------- create / edit dialog -------------------------- */

function PlaylistFormDialog({
  open,
  onOpenChange,
  initial,
  onSubmit,
  submitting,
  mode,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial?: Playlist | null;
  onSubmit: (title: string, description: string) => Promise<void>;
  submitting: boolean;
  mode: 'create' | 'edit';
}) {
  /* Radix unmounts DialogContent while closed, so these run fresh on every
     open — no re-seed effect needed. */
  const [title, setTitle] = useState(initial?.title ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');

  const valid = title.trim().length >= 1 && title.trim().length <= 120;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-white/10 bg-[#12121c] sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-lg font-black tracking-tight text-white">
            {mode === 'create' ? 'Playlist nou' : 'Redenumește playlist-ul'}
          </DialogTitle>
          <DialogDescription>
            {mode === 'create'
              ? 'Dă-i un nume și o descriere — apar imediat în colecția ta.'
              : 'Schimbă titlul sau descrierea playlist-ului.'}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!valid || submitting) return;
            await onSubmit(title.trim(), description.trim());
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="playlist-title" className="text-xs font-semibold text-zinc-400">
              Titlu (1–120 caractere)
            </Label>
            <Input
              id="playlist-title"
              value={title}
              maxLength={120}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="ex. Seriale de seară"
              className="border-white/15 bg-black/40"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="playlist-description" className="text-xs font-semibold text-zinc-400">
              Descriere (opțional)
            </Label>
            <Textarea
              id="playlist-description"
              value={description}
              maxLength={2000}
              rows={3}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="La ce e bun acest playlist?"
              className="border-white/15 bg-black/40"
            />
          </div>
          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              className="border-white/15 bg-white/5 font-semibold hover:bg-white/10"
              onClick={() => onOpenChange(false)}
            >
              Anulează
            </Button>
            <Button type="submit" disabled={!valid || submitting} className="bg-rose-600 font-bold hover:bg-rose-500">
              {submitting ? <Loader2 className="animate-spin" aria-hidden /> : mode === 'create' ? <Plus aria-hidden /> : <Pencil aria-hidden />}
              {mode === 'create' ? 'Creează' : 'Salvează'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------ playlist card ------------------------------ */

function PlaylistCard({ playlist, onOpen }: { playlist: PlaylistSummary; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex flex-col overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03] text-left transition hover:border-rose-500/40 hover:bg-white/[0.05] focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60"
    >
      <div className="relative aspect-video w-full overflow-hidden border-b border-white/10 bg-black/40">
        {playlist.firstThumbnail ? (
          <img
            src={playlist.firstThumbnail}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover opacity-90 transition group-hover:opacity-100"
          />
        ) : (
          <span className="grid h-full w-full place-items-center bg-gradient-to-br from-fuchsia-500/10 to-white/[0.02]">
            <Layers className="h-10 w-10 text-zinc-600" aria-hidden />
          </span>
        )}
        <span className="absolute right-2 top-2 rounded-full border border-white/10 bg-black/70 px-2.5 py-0.5 text-[11px] font-bold text-zinc-200 backdrop-blur-sm">
          {playlist.itemCount} {playlist.itemCount === 1 ? 'titlu' : 'titluri'}
        </span>
      </div>
      <div className="flex flex-1 flex-col gap-1 p-4">
        <p className="line-clamp-1 text-sm font-bold text-zinc-100 group-hover:text-rose-300">{playlist.title}</p>
        {playlist.description ? (
          <p className="line-clamp-2 text-xs leading-relaxed text-zinc-500">{playlist.description}</p>
        ) : (
          <p className="line-clamp-1 text-xs text-zinc-600">
            {playlist.firstTitle ? `Începe cu „${playlist.firstTitle}”` : 'Gol — adaugă primul titlu'}
          </p>
        )}
        <p className="mt-auto pt-2 text-[11px] text-zinc-600">Actualizat {formatDate(playlist.updatedat)}</p>
      </div>
    </button>
  );
}

/* ----------------------------- add-item search ----------------------------- */

function AddItemSection({ playlistId, onAdded }: { playlistId: number; onAdded: () => void }) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [results, setResults] = useState<DbContent[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [addingId, setAddingId] = useState<number | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* Debounce 500ms, then hit the real FTS endpoint. No synchronous setState
     in the effect body — clearing is handled by the render-time gate below. */
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    if (q.length < 2) return undefined;
    debounceRef.current = setTimeout(() => setDebounced(q), 500);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  /* Derived display gate: results only make sense for a live >=2-char query. */
  const q = query.trim();

  useEffect(() => {
    if (!debounced) return undefined;
    let cancelled = false;

    queueMicrotask(() => {
      if (cancelled) return;
      setSearching(true);
      setSearchError(null);
    });
    api
      .searchAdvanced({ q: debounced, limit: 8 })
      .then((res) => {
        if (!cancelled) setResults(res.data);
      })
      .catch((e) => {
        if (!cancelled) setSearchError(errorMessage(e));
      })
      .finally(() => {
        if (!cancelled) setSearching(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debounced]);

  const add = async (row: DbContent) => {
    setAddingId(row.id);
    try {
      const res = await api.playlists.addItem(playlistId, row.id);
      if (res.added) {
        toast.success(`„${row.title}” adăugat în playlist`);
        onAdded();
      } else {
        toast.info(`„${row.title}” este deja în playlist`);
      }
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setAddingId(null);
    }
  };

  return (
    <section className="space-y-3 rounded-2xl border border-white/10 bg-white/[0.02] p-4 sm:p-5" aria-label="Adaugă în playlist">
      <div className="flex items-center gap-2">
        <SearchIcon className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden />
        <h3 className="text-sm font-bold text-zinc-100">Adaugă în playlist</h3>
        <span className="text-[11px] text-zinc-600">cautare FTS reală · debounce 500ms</span>
      </div>
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Caută un titlu din bibliotecă (min. 2 caractere)…"
        className="border-white/15 bg-black/40"
        aria-label="Caută titluri de adăugat în playlist"
      />
      {searching ? (
        <div className="flex items-center gap-2 py-2 text-xs text-zinc-500">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Caut…
        </div>
      ) : searchError ? (
        <p className="py-2 text-xs text-rose-300">{searchError}</p>
      ) : q.length >= 2 && debounced && results.length === 0 ? (
        <p className="py-2 text-xs text-zinc-500">Niciun rezultat pentru „{debounced}”.</p>
      ) : q.length >= 2 ? (
        <ul className="divide-y divide-white/5">
          {results.map((row) => (
            <li key={row.id} className="flex items-center gap-3 py-2.5">
              {row.thumbnail ? (
                <img src={row.thumbnail} alt="" loading="lazy" className="h-12 w-8 shrink-0 rounded object-cover border border-white/10" />
              ) : (
                <span className="grid h-12 w-8 shrink-0 place-items-center rounded border border-white/10 bg-white/[0.04]">
                  <Layers className="h-3.5 w-3.5 text-zinc-600" aria-hidden />
                </span>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-zinc-200">{row.title}</p>
                <div className="mt-0.5 flex items-center gap-2">
                  <TypeBadge type={row.type} />
                  {typeof row.metadata?.rating === 'number' && <RatingBadge value={row.metadata.rating} />}
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="h-8 shrink-0 border-rose-500/30 bg-rose-500/10 font-semibold text-rose-200 hover:bg-rose-500/20 hover:text-white"
                disabled={addingId === row.id}
                onClick={() => void add(row)}
              >
                {addingId === row.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Plus className="h-3.5 w-3.5" aria-hidden />}
                Adaugă
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/* ------------------------------ detail state ------------------------------ */

function PlaylistDetail({ playlistId, onBack }: { playlistId: number; onBack: () => void }) {
  const detail = useApi(`faza21-playlist-${playlistId}`, () => api.playlists.get(playlistId));
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [removingItem, setRemovingItem] = useState<number | null>(null);

  const data = detail.data;
  const items: PlaylistItem[] = useMemo(() => data?.items ?? [], [data]);
  const playlist = data?.playlist ?? null;

  const refresh = () => void detail.refetch();

  const saveEdit = async (title: string, description: string) => {
    setSubmitting(true);
    try {
      await api.playlists.patch(playlistId, { title, description });
      toast.success('Playlist actualizat');
      setEditOpen(false);
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  };

  const removePlaylist = async () => {
    setSubmitting(true);
    try {
      await api.playlists.remove(playlistId);
      toast.success('Playlist șters');
      setDeleteOpen(false);
      onBack();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  };

  const removeItem = async (item: PlaylistItem) => {
    setRemovingItem(item.contentId);
    try {
      await api.playlists.removeItem(playlistId, item.contentId);
      toast.success(`„${item.title}” scos din playlist`);
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setRemovingItem(null);
    }
  };

  if (detail.loading && !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-24 w-full rounded-2xl" />
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full rounded-xl" />
        ))}
      </div>
    );
  }

  if (detail.error && !data) {
    return (
      <div className="space-y-4">
        <Button
          variant="outline"
          className="border-white/15 bg-white/5 font-semibold hover:bg-white/10"
          onClick={onBack}
        >
          <ArrowLeft aria-hidden /> Înapoi la playlist-uri
        </Button>
        <ErrorState message={detail.error} onRetry={refresh} />
      </div>
    );
  }

  if (!playlist) return null;

  return (
    <div className="space-y-6">
      <Button
        variant="outline"
        className="border-white/15 bg-white/5 font-semibold hover:bg-white/10"
        onClick={onBack}
      >
        <ArrowLeft aria-hidden /> Înapoi la playlist-uri
      </Button>

      {/* header */}
      <div className="flex flex-wrap items-start justify-between gap-4 rounded-2xl border border-white/10 bg-white/[0.03] p-4 sm:p-5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-xl font-black tracking-tight text-white">{playlist.title}</h2>
            <span className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-0.5 text-[11px] font-semibold text-zinc-400">
              {items.length} {items.length === 1 ? 'titlu' : 'titluri'}
            </span>
          </div>
          {playlist.description ? (
            <p className="mt-1.5 max-w-xl text-sm text-zinc-400">{playlist.description}</p>
          ) : null}
          <p className="mt-1 text-[11px] text-zinc-600">Creat {formatDate(playlist.createdat)} · Actualizat {formatDate(playlist.updatedat)}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            className="bg-rose-600 font-bold hover:bg-rose-500"
            disabled={items.length === 0}
            title={items.length === 0 ? 'Playlist gol' : 'Deschide primul titlu din listă'}
            onClick={() => {
              const first = items[0];
              if (first) navigate(`/player/${first.contentId}?list=${playlistId}`);
            }}
          >
            <Play className="h-4 w-4 fill-white" aria-hidden /> Redă playlist
          </Button>
          <Button
            variant="outline"
            size="icon"
            aria-label="Redenumește playlist-ul"
            className="h-10 w-10 border-white/15 bg-white/5 hover:bg-white/10"
            onClick={() => setEditOpen(true)}
          >
            <Pencil className="h-4 w-4" aria-hidden />
          </Button>
          <Button
            variant="outline"
            size="icon"
            aria-label="Șterge playlist-ul"
            className="h-10 w-10 border-rose-500/30 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20"
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2 className="h-4 w-4" aria-hidden />
          </Button>
        </div>
      </div>

      {items.length > 0 && (
        <p className="text-[11px] leading-relaxed text-zinc-600">
          „Redă playlist” deschide primul titlu (fără auto-advance încă — playerul nu are motor de listă); navighezi manual la următorul din această listă.
        </p>
      )}

      {/* items */}
      {items.length === 0 ? (
        <EmptyState
          icon={<Layers className="h-6 w-6" aria-hidden />}
          title="Playlist gol"
          message="Caută un titlu mai jos și apasă „Adaugă” — apare instant în listă."
        />
      ) : (
        <ol className="space-y-2">
          {items.map((item, idx) => (
            <li
              key={`${item.contentId}-${item.position}`}
              className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-3 transition hover:border-rose-500/25"
            >
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-white/10 bg-black/40 font-mono text-xs font-bold text-zinc-400">
                {idx + 1}
              </span>
              {item.thumbnail ? (
                <img src={item.thumbnail} alt="" loading="lazy" className="h-14 w-10 shrink-0 rounded-md border border-white/10 object-cover" />
              ) : (
                <span className="grid h-14 w-10 shrink-0 place-items-center rounded-md border border-white/10 bg-white/[0.04]">
                  <Layers className="h-4 w-4 text-zinc-600" aria-hidden />
                </span>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <button
                    type="button"
                    onClick={() => navigate(`/content/${item.contentId}`)}
                    className="truncate text-left text-sm font-bold text-zinc-100 transition hover:text-rose-300"
                  >
                    {item.title}
                  </button>
                  <TypeBadge type={item.type} />
                  {item.rating != null && <RatingBadge value={item.rating} />}
                </div>
                <p className="mt-0.5 text-[11px] text-zinc-600">
                  {item.year ? `Anul ${item.year}` : 'Fără an'} · adăugat {formatDate(item.addedat)}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 border-white/15 bg-white/5 font-semibold hover:bg-white/10"
                  onClick={() => navigate(`/player/${item.contentId}`)}
                >
                  <Play className="h-3.5 w-3.5 fill-current" aria-hidden /> Redă
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  aria-label={`Scoate „${item.title}” din playlist`}
                  disabled={removingItem === item.contentId}
                  className="h-8 w-8 border-rose-500/30 bg-rose-500/10 p-0 text-rose-300 hover:bg-rose-500/20 hover:text-white"
                  onClick={() => void removeItem(item)}
                >
                  {removingItem === item.contentId ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  ) : (
                    <X className="h-3.5 w-3.5" aria-hidden />
                  )}
                </Button>
              </div>
            </li>
          ))}
        </ol>
      )}

      <AddItemSection playlistId={playlistId} onAdded={refresh} />

      <PlaylistFormDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        initial={playlist}
        mode="edit"
        submitting={submitting}
        onSubmit={saveEdit}
      />

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent className="border-white/10 bg-[#12121c]">
          <AlertDialogHeader>
            <AlertDialogTitle>Ștergi playlist-ul „{playlist.title}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Toate cele {items.length} {items.length === 1 ? 'titlu' : 'titluri'} vor fi scoase din listă. Acțiunea este definitivă.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-white/15 bg-white/5 hover:bg-white/10">Anulează</AlertDialogCancel>
            <AlertDialogAction
              className="bg-rose-600 font-bold hover:bg-rose-500"
              disabled={submitting}
              onClick={(e) => {
                e.preventDefault();
                void removePlaylist();
              }}
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Trash2 className="h-4 w-4" aria-hidden />}
              Șterge definitiv
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/* -------------------------------- the view -------------------------------- */

export function PlaylistsView() {
  const { user, initializing } = useAuth();
  const playlists = useApi('faza21-playlists', () => api.playlists.list(), { enabled: Boolean(user) });
  const [openId, setOpenId] = useState<number | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  const create = async (t: string, d: string) => {
    setCreating(true);
    try {
      const res = await api.playlists.create({ title: t, description: d });
      toast.success(`Playlist-ul „${res.playlist.title}” a fost creat`);
      setCreateOpen(false);
      await playlists.refetch();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setCreating(false);
    }
  };

  if (initializing) {
    return (
      <Container className="py-8 sm:py-12">
        <Skeleton className="h-10 w-56" />
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-56 rounded-2xl" />
          ))}
        </div>
      </Container>
    );
  }

  if (!user) return <LoginPrompt />;

  /* Detail state: same view, back button returns to the grid. The list is
     refetched on every back-navigation so itemCount/firstThumbnail/title
     reflect any mutation made inside the detail (rename, delete, items). */
  if (openId != null) {
    return (
      <Container className="py-8 sm:py-10">
        <PlaylistDetail
          playlistId={openId}
          onBack={() => {
            setOpenId(null);
            void playlists.refetch();
          }}
        />
      </Container>
    );
  }

  const loading = playlists.loading && !playlists.data;
  const list = playlists.data?.data ?? [];

  return (
    <Container className="space-y-8 py-8 sm:py-10">
      <PageHeader
        title="Playlist-urile mele"
        subtitle="Colecții personale reale — creează liste, adaugă orice titlu din bibliotecă și redă-le în ordinea ta."
      />

      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-56 rounded-2xl" />
          ))}
        </div>
      ) : playlists.error && !playlists.data ? (
        <ErrorState message={playlists.error} onRetry={() => void playlists.refetch()} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((p) => (
            <PlaylistCard key={p.id} playlist={p} onOpen={() => setOpenId(p.id)} />
          ))}

          {/* dashed "new playlist" card */}
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="flex min-h-[220px] flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-white/15 bg-white/[0.02] p-6 text-zinc-400 transition hover:border-rose-500/50 hover:bg-rose-500/[0.04] hover:text-rose-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60"
          >
            <span className="grid h-12 w-12 place-items-center rounded-2xl border border-white/10 bg-white/[0.04]">
              <Plus className="h-6 w-6" aria-hidden />
            </span>
            <span className="text-sm font-bold">Playlist nou</span>
            <span className="text-[11px] text-zinc-600">Titlu + descriere, gata în 5 secunde</span>
          </button>
        </div>
      )}

      <PlaylistFormDialog
        key="create-playlist"
        open={createOpen}
        onOpenChange={setCreateOpen}
        mode="create"
        submitting={creating}
        onSubmit={create}
      />
    </Container>
  );
}
