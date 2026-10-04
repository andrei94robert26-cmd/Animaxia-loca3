'use client';

/**
 * category-panels.tsx — Dedicated panels behind the special sidebar entries:
 *
 *   MyListPanel        "Lista Mea" — the signed-in user's Neon watchlist
 *   CollectionsPanel   "Colecțiile Mele" — client-side collections + picker
 *   ManagePanel        "Gestionare & Duplicate" — library overview, duplicate
 *                      detection, admin delete
 */

import { useMemo, useState } from 'react';
import {
  Bookmark,
  Copy,
  Layers,
  Lock,
  Plus,
  Search,
  Settings2,
  Trash2,
  Tv,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { api, dbToItem } from '@/lib/animaxia/api';
import { useApi } from '@/lib/animaxia/hooks';
import { navigate } from '@/lib/animaxia/router';
import { platform } from '@/lib/animaxia/platform';
import type { DbContent } from '@/lib/animaxia/types';
import { collectionsStore, useCollections } from '@/lib/animaxia/collections';
import { useAuth } from './auth-provider';
import { ContentGrid } from './content-grid';
import { AddContentDialog } from './home-panels';
import { EmptyState, ErrorState } from './states';

/* ------------------------------- Lista Mea -------------------------------- */

export function MyListPanel() {
  const { user, initializing } = useAuth();

  const listRes = useApi(
    'my-list',
    () => platform.watchlist(),
    { enabled: Boolean(user) },
  );

  if (initializing) {
    return <Skeleton className="h-48 w-full rounded-xl" />;
  }

  if (!user) {
    return (
      <div className="flex flex-col items-center gap-4 rounded-xl border border-white/10 bg-white/[0.02] p-10 text-center">
        <span className="grid h-14 w-14 place-items-center rounded-2xl border border-rose-500/20 bg-rose-500/10 text-rose-400">
          <Lock className="h-7 w-7" aria-hidden />
        </span>
        <div>
          <h3 className="text-lg font-bold text-white">Conectează-te pentru a salva favoritele și progresul</h3>
          <p className="mx-auto mt-1 max-w-md text-sm text-zinc-500">
            Lista Mea trăiește în Neon — orice titlu salvat te urmărește pe toate dispozitivele, cu progresul
            păstrat automat.
          </p>
        </div>
        <Button onClick={() => navigate('/auth')} className="bg-rose-600 font-bold hover:bg-rose-500">
          Conectare
        </Button>
      </div>
    );
  }

  const entries = listRes.data?.data ?? [];
  const items = entries.map((e) => dbToItem(e.content));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge className="border-rose-500/30 bg-rose-500/10 text-rose-200 hover:bg-rose-500/10">
          <Bookmark className="mr-1.5 h-3.5 w-3.5" aria-hidden />
          {entries.length} {entries.length === 1 ? 'titlu' : 'titluri'} salvate
        </Badge>
        <Badge variant="outline" className="border-white/15 bg-transparent text-zinc-400">
          Sincronizat din Neon
        </Badge>
      </div>
      {listRes.error && !listRes.loading && !listRes.data ? (
        <ErrorState message={listRes.error} onRetry={listRes.refetch} />
      ) : (
        <ContentGrid
          items={items}
          loading={listRes.loading}
          skeletonCount={8}
          emptyTitle="Lista Mea e goală"
          emptyMessage="Deschide orice titlu și apasă „Adaugă în Lista Mea” — apare aici instant."
        />
      )}
    </div>
  );
}

/* --------------------------- Colecțiile Mele ------------------------------ */

export function CollectionsPanel() {
  const collections = useCollections();
  const [name, setName] = useState('');
  const [addOpen, setAddOpen] = useState(false);

  const create = (e: React.FormEvent) => {
    e.preventDefault();
    const created = collectionsStore.create(name);
    if (created) {
      toast.success(`Colecția „${created.name}” a fost creată`);
      setName('');
    }
  };

  const totalItems = collections.reduce((sum, c) => sum + c.items.length, 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <Badge className="border-fuchsia-500/30 bg-fuchsia-500/10 text-fuchsia-200 hover:bg-fuchsia-500/10">
          <Layers className="mr-1.5 h-3.5 w-3.5" aria-hidden />
          {collections.length} {collections.length === 1 ? 'colecție' : 'colecții'}
        </Badge>
        <Badge variant="outline" className="border-white/15 bg-transparent text-zinc-400">
          {totalItems} {totalItems === 1 ? 'titlu' : 'titluri'} în total
        </Badge>
        <Badge variant="outline" className="border-white/15 bg-transparent text-zinc-400">
          Salvate pe acest dispozitiv
        </Badge>
      </div>

      <form onSubmit={create} className="flex flex-col gap-2 rounded-xl border border-white/10 bg-white/[0.03] p-4 sm:flex-row">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Numele colecției noi — ex. „Anime de vazut”, „Filme de familie”…"
          aria-label="Nume colecție"
          className="h-10 border-white/10 bg-white/5 text-sm"
        />
        <Button type="submit" disabled={!name.trim()} className="h-10 bg-rose-600 font-bold hover:bg-rose-500">
          <Plus className="mr-1.5 h-4 w-4" aria-hidden />
          Creează colecție
        </Button>
      </form>

      {collections.length === 0 ? (
        <EmptyState
          title="Încă nicio colecție"
          message="Creează prima colecție, apoi adaugă titluri din bibliotecă — perfect pentru maratoane tematice."
        />
      ) : (
        <div className="space-y-4">
          {collections.map((collection) => (
            <CollectionCard key={collection.id} id={collection.id} />
          ))}
        </div>
      )}

      <AddContentDialog open={addOpen} onOpenChange={setAddOpen} />
      {/* Button kept reachable for a11y flows that focus it via keyboard. */}
      <button type="button" className="sr-only" onClick={() => setAddOpen(true)}>
        Adaugă conținut
      </button>
    </div>
  );
}

function CollectionCard({ id }: { id: string }) {
  const collections = useCollections();
  const collection = collections.find((c) => c.id === id);
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState(collection?.name ?? '');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState('');

  /* Hook order must be stable — called before any early return. */
  const searchRes = useApiSafe(
    `collection-picker-${pickerQuery}`,
    () => api.all({ search: pickerQuery || undefined, limit: 12 }),
    pickerOpen,
  );

  if (!collection) return null;

  const saveRename = () => {
    collectionsStore.rename(collection.id, newName);
    setRenaming(false);
    toast.success('Colecție redenumită');
  };

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
      <div className="flex flex-wrap items-center gap-2">
        {renaming ? (
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              aria-label="Nume nou colecție"
              className="h-9 border-white/10 bg-white/5 text-sm"
            />
            <Button size="sm" onClick={saveRename} className="h-9 bg-rose-600 font-bold hover:bg-rose-500">
              Salvează
            </Button>
          </div>
        ) : (
          <h3 className="min-w-0 flex-1 truncate text-base font-bold text-white">{collection.name}</h3>
        )}
        <span className="text-xs text-zinc-500">{collection.items.length} titluri</span>
        {!renaming && (
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setNewName(collection.name);
                setRenaming(true);
              }}
              className="h-8 px-2.5 text-xs text-zinc-400 hover:bg-white/5 hover:text-white"
            >
              Redenumește
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPickerOpen((v) => !v)}
              className="h-8 px-2.5 text-xs text-rose-300 hover:bg-rose-500/10 hover:text-rose-200"
            >
              <Plus className="mr-1 h-3.5 w-3.5" aria-hidden />
              Adaugă titluri
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                collectionsStore.remove(collection.id);
                toast.success(`Colecția „${collection.name}” a fost ștearsă`);
              }}
              className="h-8 px-2.5 text-xs text-zinc-500 hover:bg-rose-500/10 hover:text-rose-300"
              aria-label={`Șterge colecția ${collection.name}`}
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden />
            </Button>
          </>
        )}
      </div>

      {pickerOpen && (
        <div className="mt-3 rounded-lg border border-white/10 bg-black/30 p-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" aria-hidden />
            <Input
              value={pickerQuery}
              onChange={(e) => setPickerQuery(e.target.value)}
              placeholder="Caută în bibliotecă…"
              aria-label="Caută titluri pentru colecție"
              className="h-9 border-white/10 bg-white/5 pl-9 text-sm"
            />
          </div>
          <div className="custom-scrollbar mt-2 max-h-56 overflow-y-auto">
            {searchRes.loading ? (
              <div className="space-y-2 p-1">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-10 w-full rounded-md" />
                ))}
              </div>
            ) : (searchRes.data?.data ?? []).length === 0 ? (
              <p className="p-2 text-xs text-zinc-500">Niciun rezultat — încearcă alt termen.</p>
            ) : (
              <ul className="space-y-1">
                {(searchRes.data?.data ?? []).map((row: DbContent) => {
                  const already = collection.items.some((i) => i.contentId === row.id);
                  return (
                    <li key={row.id}>
                      <button
                        type="button"
                        onClick={() => {
                          if (already) {
                            collectionsStore.removeItem(collection.id, row.id);
                          } else {
                            collectionsStore.add(collection.id, {
                              contentId: row.id,
                              title: row.title,
                              thumbnail: row.thumbnail,
                              type: row.type,
                            });
                            toast.success(`„${row.title}” adăugat în ${collection.name}`);
                          }
                        }}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm text-zinc-300 transition hover:bg-white/5"
                      >
                        {row.thumbnail ? (
                          <img src={row.thumbnail} alt="" aria-hidden loading="lazy" className="h-9 w-7 shrink-0 rounded object-cover" />
                        ) : (
                          <span className="h-9 w-7 shrink-0 rounded bg-white/10" aria-hidden />
                        )}
                        <span className="min-w-0 flex-1 truncate">{row.title}</span>
                        <span className="shrink-0 text-xs font-semibold text-rose-300">
                          {already ? 'Scoate' : 'Adaugă'}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}

      {collection.items.length === 0 ? (
        <p className="mt-3 text-xs text-zinc-500">
          Colecție goală — apasă „Adaugă titluri” și alege din biblioteca locală.
        </p>
      ) : (
        <div className="mt-3 grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6">
          {collection.items.map((item) => (
            <div key={item.contentId} className="group relative">
              <button
                type="button"
                onClick={() => navigate(`/content/${item.contentId}`)}
                className="block w-full overflow-hidden rounded-lg border border-white/10 bg-white/5 text-left transition hover:border-rose-500/50"
              >
                {item.thumbnail ? (
                  <img src={item.thumbnail} alt={item.title} loading="lazy" className="aspect-[2/3] w-full object-cover" />
                ) : (
                  <span className="grid aspect-[2/3] w-full place-items-center bg-white/5 text-zinc-600" aria-hidden>
                    <Tv className="h-6 w-6" />
                  </span>
                )}
                <span className="block truncate px-2 py-1.5 text-xs font-medium text-zinc-300">{item.title}</span>
              </button>
              <button
                type="button"
                onClick={() => collectionsStore.removeItem(collection.id, item.contentId)}
                aria-label={`Scoate ${item.title} din colecție`}
                className="absolute right-1.5 top-1.5 hidden rounded-full bg-black/70 p-1.5 text-zinc-300 transition hover:bg-rose-600 hover:text-white group-hover:block"
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------ Gestionare & Duplicate --------------------------- */

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\(.*?\)/g, '')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

export function ManagePanel() {
  const { isAdmin, initializing } = useAuth();
  const [addOpen, setAddOpen] = useState(false);
  const listRes = useApi('manage-all', () => api.all({ limit: 100, sort: 'newest' }));
  const rows = listRes.data?.data ?? [];

  const duplicates = useMemo(() => {
    const groups = new Map<string, DbContent[]>();
    for (const row of rows) {
      const key = normalizeTitle(row.title);
      if (!key) continue;
      const group = groups.get(key) ?? [];
      group.push(row);
      groups.set(key, group);
    }
    return [...groups.values()].filter((g) => g.length > 1);
  }, [rows]);

  const remove = async (row: DbContent) => {
    try {
      await api.deleteContent(row.id);
      toast.success(`„${row.title}” șters din Neon`);
      await listRes.refetch();
    } catch (err) {
      toast.error('Ștergerea a eșuat', { description: err instanceof Error ? err.message : undefined });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <Badge className="border-amber-500/30 bg-amber-500/10 text-amber-200 hover:bg-amber-500/10">
          <Settings2 className="mr-1.5 h-3.5 w-3.5" aria-hidden />
          {rows.length} titluri în bibliotecă
        </Badge>
        <Badge variant="outline" className={duplicates.length > 0 ? 'border-rose-500/40 bg-rose-500/10 text-rose-300' : 'border-white/15 bg-transparent text-zinc-400'}>
          <Copy className="mr-1.5 h-3.5 w-3.5" aria-hidden />
          {duplicates.length} {duplicates.length === 1 ? 'grup de duplicate' : 'grupuri de duplicate'}
        </Badge>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setAddOpen(true)}
          className="ml-auto h-8 border-rose-500/30 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20 hover:text-rose-100"
        >
          <Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden />
          Adaugă conținut
        </Button>
      </div>

      {!initializing && !isAdmin && (
        <p className="rounded-lg border border-white/10 bg-white/[0.03] px-4 py-3 text-xs text-zinc-500">
          Vezi biblioteca și duplicatele detectate automat. Conectează-te ca admin pentru a șterge titluri.
        </p>
      )}

      {listRes.error && !listRes.loading && !listRes.data ? (
        <ErrorState message={listRes.error} onRetry={listRes.refetch} />
      ) : (
        <>
          {duplicates.length > 0 && (
            <section aria-labelledby="manage-duplicates" className="space-y-3">
              <h3 id="manage-duplicates" className="text-sm font-bold uppercase tracking-wider text-zinc-400">
                Duplicate detectate
              </h3>
              <div className="space-y-2">
                {duplicates.map((group) => (
                  <div key={normalizeTitle(group[0].title)} className="rounded-xl border border-rose-500/20 bg-rose-500/[0.04] p-3">
                    <p className="mb-2 text-sm font-semibold text-rose-200">
                      {group.length} intrări pentru „{group[0].title}”
                    </p>
                    <ul className="space-y-1.5">
                      {group.map((row) => (
                        <ManageRow key={row.id} row={row} isAdmin={isAdmin} onRemove={() => remove(row)} />
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section aria-labelledby="manage-library" className="space-y-3">
            <h3 id="manage-library" className="text-sm font-bold uppercase tracking-wider text-zinc-400">
              Bibliotecă completă
            </h3>
            {listRes.loading ? (
              <div className="space-y-2">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full rounded-lg" />
                ))}
              </div>
            ) : rows.length === 0 ? (
              <EmptyState title="Biblioteca e goală" message="Adaugă conținut din orice sursă — apare aici instant." />
            ) : (
              <ul className="custom-scrollbar max-h-96 space-y-1.5 overflow-y-auto pr-1">
                {rows.map((row) => (
                  <ManageRow key={row.id} row={row} isAdmin={isAdmin} onRemove={() => remove(row)} inList />
                ))}
              </ul>
            )}
          </section>
        </>
      )}
      <AddContentDialog open={addOpen} onOpenChange={setAddOpen} />
    </div>
  );
}

function ManageRow({ row, isAdmin, onRemove, inList }: { row: DbContent; isAdmin: boolean; onRemove: () => void; inList?: boolean }) {
  return (
    <li className={`flex items-center gap-3 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 ${inList ? '' : ''}`}>
      {row.thumbnail ? (
        <img src={row.thumbnail} alt="" aria-hidden loading="lazy" className="h-10 w-7 shrink-0 rounded object-cover" />
      ) : (
        <span className="h-10 w-7 shrink-0 rounded bg-white/10" aria-hidden />
      )}
      <button
        type="button"
        onClick={() => navigate(`/content/${row.id}`)}
        className="min-w-0 flex-1 truncate text-left text-sm font-medium text-zinc-200 hover:text-rose-300"
      >
        {row.title}
      </button>
      <Badge variant="outline" className="shrink-0 border-white/10 bg-transparent text-[10px] uppercase text-zinc-500">
        {row.type}
      </Badge>
      <span className="hidden shrink-0 text-xs text-zinc-600 sm:block" title={row.externalid}>
        #{row.id}
      </span>
      {isAdmin && (
        <Button
          variant="ghost"
          size="icon"
          onClick={onRemove}
          aria-label={`Șterge ${row.title}`}
          className="h-8 w-8 shrink-0 text-zinc-500 hover:bg-rose-500/10 hover:text-rose-300"
        >
          <Trash2 className="h-4 w-4" aria-hidden />
        </Button>
      )}
    </li>
  );
}

/* ------------------------------- helpers ---------------------------------- */

/** useApi with a lazy "enabled" flag that never blocks render. */
function useApiSafe<T>(key: string, fetcher: () => Promise<T>, enabled: boolean) {
  return useApi(key, fetcher, { enabled });
}
