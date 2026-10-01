'use client';

/**
 * search-ux-panels.tsx — FAZA 33 (PLAN 100X · WS3): extensiile additive ale
 * view-ului de căutare (componente-copil NOI; search-view doar le randează).
 *
 *  1. QueryFacetsBar — fațete dinamice PER CĂUTARE (tip / gen / an / sursă cu
 *     numărători) de la /api/searchux/facets — calculate pe un eșantion din
 *     motorul protejat prin accel 29-P. Click pe fațetă ⇒ aplică filtrul
 *     existent (parametrii deja suportați de /api/search/advanced).
 *  2. SavedSearchesBar — căutări salvate local (q + filtre complete) cu
 *     aplicare într-un click + ștergere; stocare localStorage (max 12).
 *  3. GroupedResults — „rezultate bogate": grupare Filme/Seriale/Anime/Altele,
 *     termeni căutați evidențiați (highlight), scor relevanță vizual (bară),
 *     carduri compacte proprii (ContentCard existent rămâne pentru gridul
 *     clasic — comutabil, zero regresie).
 *
 * ZERO atingeri ale componentelor protejate — doar consumă API-uri existente.
 */

import { useEffect, useMemo, useState } from 'react';
import { Bookmark, BookmarkCheck, ChevronDown, Film, Layers, LayoutGrid, Sparkles, Tv, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/animaxia/api';
import { navigate } from '@/lib/animaxia/router';
import type { DbContent, SearchUxFacets } from '@/lib/animaxia/types';
import { useApi } from '@/lib/animaxia/hooks';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { RatingBadge, TypeBadge } from './states';
import { cn } from '@/lib/utils';

/* ============================ 1. Query facets bar ============================ */

/** Forma filtrelor din search-view (LibraryFilters e local acolo — îl oglim aici
 *  doar prin cheile folosite; keep it structural). */
export interface FacetFilterView {
  year: string;
  genre: string;
  category: string;
  actor: string;
  studio: string;
  minRating: string;
}

const TYPE_LABELS: Record<string, string> = {
  movie: 'Filme',
  tv: 'Seriale',
  anime: 'Anime',
};

export function QueryFacetsBar({
  q,
  filters,
  onApply,
}: {
  q: string;
  filters: FacetFilterView;
  onApply: <K extends keyof FacetFilterView>(key: K, value: FacetFilterView[K]) => void;
}) {
  const enabled = Boolean(q) || Object.values(filters).some((v) => v && v !== 'any');
  const key = `searchux-facets:${q}|${filters.year}|${filters.genre}|${filters.category}|${filters.minRating}|${filters.actor}|${filters.studio}`;
  const res = useApi(
    key,
    () =>
      api.searchuxFacets({
        q: q || undefined,
        year: filters.year !== 'any' ? filters.year : undefined,
        genre: filters.genre !== 'any' ? filters.genre : undefined,
        category: filters.category !== 'any' ? filters.category : undefined,
        minRating: filters.minRating !== 'any' ? Number(filters.minRating) : undefined,
        actor: filters.actor.trim() || undefined,
        studio: filters.studio.trim() || undefined,
      }),
    { enabled },
  );

  const facets: SearchUxFacets['facets'] | null = res.data?.facets ?? null;
  if (!enabled || !facets) return null;

  /* Facet-urile tip (types) comută `category` (parametrul existent al motorului);
   * genurile și anii au filtre proprii deja; sursele sunt doar informative
   * (motorul protejat nu are filtru de sursă — nu inventăm parametri). */
  const hasAny =
    facets.types.length > 0 || facets.genres.length > 0 || facets.years.length > 0 || facets.sources.length > 0;
  if (!hasAny) return null;

  return (
    <section
      aria-label="Fațete dinamice per căutare"
      className="rounded-xl border border-white/10 bg-white/[0.03] p-3.5 sm:p-4"
    >
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-[0.14em] text-zinc-400">
          <Layers className="h-3.5 w-3.5 text-rose-400" aria-hidden />
          Fațete · contextul căutării
        </h3>
        <span className="text-[10px] text-zinc-600" title={`Eșantion ${res.data?.sampled ?? 0} din ${res.data?.total ?? 0} rezultate · cache ${res.data?.cache === 'hit' ? 'hit' : 'proaspăt'}`}>
          {res.data ? `${res.data.sampled}/${res.data.total} eșantion · ${res.data.cache === 'hit' ? 'cache' : `${res.data.took}ms`}` : '…'}
        </span>
      </div>
      <div className="space-y-2.5">
        {facets.types.length > 1 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="w-16 shrink-0 text-[11px] font-semibold text-zinc-500">Tip</span>
            {facets.types.map((t) => {
              const active = filters.category === t.value;
              return (
                <button
                  key={t.value}
                  type="button"
                  onClick={() => onApply('category', active ? 'any' : t.value)}
                  aria-pressed={active}
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition',
                    active
                      ? 'border-rose-500/50 bg-rose-500/15 text-rose-300'
                      : 'border-white/10 bg-white/[0.04] text-zinc-300 hover:border-rose-500/40 hover:text-rose-300',
                  )}
                >
                  {TYPE_LABELS[t.value] ?? t.value}
                  <span className="text-[10px] font-semibold text-zinc-500">{t.count}</span>
                </button>
              );
            })}
          </div>
        )}
        {facets.genres.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="w-16 shrink-0 text-[11px] font-semibold text-zinc-500">Genuri</span>
            {facets.genres.slice(0, 8).map((g) => {
              const active = filters.genre === g.value;
              return (
                <button
                  key={g.value}
                  type="button"
                  onClick={() => onApply('genre', active ? 'any' : g.value)}
                  aria-pressed={active}
                  className={cn(
                    'inline-flex max-w-[220px] items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition',
                    active
                      ? 'border-rose-500/50 bg-rose-500/15 text-rose-300'
                      : 'border-white/10 bg-white/[0.04] text-zinc-300 hover:border-rose-500/40 hover:text-rose-300',
                  )}
                >
                  <span className="truncate">{g.value}</span>
                  <span className="text-[10px] font-semibold text-zinc-500">{g.count}</span>
                </button>
              );
            })}
          </div>
        )}
        {facets.years.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="w-16 shrink-0 text-[11px] font-semibold text-zinc-500">Ani</span>
            {facets.years.slice(0, 8).map((y) => {
              const active = filters.year === y.value;
              return (
                <button
                  key={y.value}
                  type="button"
                  onClick={() => onApply('year', active ? 'any' : y.value)}
                  aria-pressed={active}
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition',
                    active
                      ? 'border-rose-500/50 bg-rose-500/15 text-rose-300'
                      : 'border-white/10 bg-white/[0.04] text-zinc-300 hover:border-rose-500/40 hover:text-rose-300',
                  )}
                >
                  {y.value}
                  <span className="text-[10px] font-semibold text-zinc-500">{y.count}</span>
                </button>
              );
            })}
          </div>
        )}
        {facets.sources.length > 1 && (
          <div className="flex flex-wrap items-center gap-1.5" title="Surse informative — motorul protejat nu filtrează pe sursă (nu inventăm parametri)">
            <span className="w-16 shrink-0 text-[11px] font-semibold text-zinc-500">Surse</span>
            {facets.sources.slice(0, 5).map((s) => (
              <span
                key={s.value}
                className="inline-flex items-center gap-1 rounded-full border border-white/[0.07] bg-white/[0.02] px-2.5 py-1 text-xs text-zinc-500"
              >
                <span className="truncate">{s.value.replace('catalog-', '')}</span>
                <span className="text-[10px] font-semibold text-zinc-600">{s.count}</span>
              </span>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/* ============================ 2. Saved searches ============================= */

const SAVED_KEY = 'animaxia:saved-searches';
const SAVED_MAX = 12;

export interface SavedSearch {
  q: string;
  filters: FacetFilterView;
  savedAt: number;
}

function readSaved(): SavedSearch[] {
  try {
    const raw = window.localStorage.getItem(SAVED_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(list)) return [];
    return list
      .filter(
        (x): x is SavedSearch =>
          typeof x === 'object' &&
          x !== null &&
          typeof (x as SavedSearch).q === 'string' &&
          typeof (x as SavedSearch).savedAt === 'number',
      )
      .slice(0, SAVED_MAX);
  } catch {
    return [];
  }
}

function writeSaved(list: SavedSearch[]): void {
  try {
    window.localStorage.setItem(SAVED_KEY, JSON.stringify(list.slice(0, SAVED_MAX)));
  } catch {
    /* private mode */
  }
}

export function savedSearchLabel(q: string, filters: FacetFilterView): string {
  const parts: string[] = [];
  if (q.trim()) parts.push(`„${q.trim()}"`);
  if (filters.genre !== 'any') parts.push(filters.genre);
  if (filters.year !== 'any') parts.push(filters.year);
  if (filters.category !== 'any') parts.push(TYPE_LABELS[filters.category] ?? filters.category);
  if (filters.minRating !== 'any') parts.push(`★${filters.minRating}+`);
  if (filters.actor.trim()) parts.push(filters.actor.trim());
  if (filters.studio.trim()) parts.push(filters.studio.trim());
  return parts.length > 0 ? parts.join(' · ') : 'Bibliotecă (fără filtre)';
}

export function SavedSearchesBar({
  q,
  filters,
  onApply,
}: {
  q: string;
  filters: FacetFilterView;
  onApply: (q: string, filters: FacetFilterView) => void;
}) {
  const [saved, setSaved] = useState<SavedSearch[]>([]);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setSaved(readSaved());
      setMounted(true);
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  const hasSurface = Boolean(q.trim()) || Object.values(filters).some((v) => v && v !== 'any');
  const alreadySaved =
    mounted &&
    saved.some(
      (s) => s.q.trim().toLowerCase() === q.trim().toLowerCase() && JSON.stringify(s.filters) === JSON.stringify(filters),
    );

  function toggleSave() {
    if (!hasSurface) return;
    if (alreadySaved) {
      const next = saved.filter(
        (s) => !(s.q.trim().toLowerCase() === q.trim().toLowerCase() && JSON.stringify(s.filters) === JSON.stringify(filters)),
      );
      setSaved(next);
      writeSaved(next);
      toast.success('Căutarea a fost eliminată din salvate');
      return;
    }
    const entry: SavedSearch = { q: q.trim(), filters: { ...filters }, savedAt: Date.now() };
    const next = [entry, ...saved].slice(0, SAVED_MAX);
    setSaved(next);
    writeSaved(next);
    toast.success(`Salvat: ${savedSearchLabel(q, filters)}`);
  }

  function removeSaved(entry: SavedSearch) {
    const next = saved.filter((s) => s !== entry);
    setSaved(next);
    writeSaved(next);
  }

  if (!mounted || (saved.length === 0 && !hasSurface)) return null;

  return (
    <section aria-label="Căutări salvate" className="space-y-2.5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-bold text-zinc-300">
          <Bookmark className="h-4 w-4 text-rose-400" aria-hidden />
          Căutări salvate
          {hasSurface && (
            <button
              type="button"
              onClick={toggleSave}
              className={cn(
                'ml-1 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold transition',
                alreadySaved
                  ? 'border-rose-500/50 bg-rose-500/15 text-rose-300'
                  : 'border-white/15 bg-white/5 text-zinc-300 hover:border-rose-500/40 hover:text-rose-300',
              )}
            >
              {alreadySaved ? <BookmarkCheck className="h-3.5 w-3.5" aria-hidden /> : <Bookmark className="h-3.5 w-3.5" aria-hidden />}
              {alreadySaved ? 'Salvată' : 'Salvează căutarea curentă'}
            </button>
          )}
        </h2>
      </div>
      {saved.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {saved.map((entry) => (
            <span
              key={`${entry.q}|${JSON.stringify(entry.filters)}`}
              className="inline-flex h-9 max-w-full items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] pl-3.5 pr-1.5 text-sm text-zinc-300"
            >
              <button
                type="button"
                onClick={() => {
                  /* termenul în bară + filtrele, într-un singur click */
                  onApply(entry.q, entry.filters);
                  if (entry.q.trim()) navigate(`/search?q=${encodeURIComponent(entry.q.trim())}`);
                }}
                className="truncate font-medium transition hover:text-rose-300"
                title={savedSearchLabel(entry.q, entry.filters)}
              >
                {savedSearchLabel(entry.q, entry.filters)}
              </button>
              <button
                type="button"
                onClick={() => removeSaved(entry)}
                aria-label="Elimină căutarea salvată"
                className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-zinc-500 transition hover:bg-rose-500/20 hover:text-rose-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60"
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </button>
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

/* ============================ 3. Grouped results ============================ */

type ScoredRow = DbContent & { _score: number };

function highlight(title: string, terms: string[]): React.ReactNode {
  if (terms.length === 0) return title;
  const escaped = terms
    .filter((t) => t.length >= 2)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .filter(Boolean);
  if (escaped.length === 0) return title;
  const regex = new RegExp(`(${escaped.join('|')})`, 'gi');
  const parts = title.split(regex);
  return parts.map((part, i) =>
    regex.test(part) && i % 2 === 1 ? (
      <mark key={i} className="rounded bg-rose-500/25 px-0.5 text-rose-200">
        {part}
      </mark>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

function RichCard({ row, terms, maxScore }: { row: ScoredRow; terms: string[]; maxScore: number }) {
  const meta = (row.metadata ?? {}) as { year?: string; rating?: number };
  const scorePct = maxScore > 0 ? Math.min(100, Math.round((row._score / maxScore) * 100)) : 0;
  return (
    <button
      type="button"
      onClick={() => navigate(`/content/${row.id}`)}
      className="group flex w-full items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-2.5 text-left transition hover:border-rose-500/40 hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60"
    >
      {row.thumbnail ? (
        <img
          src={row.thumbnail}
          alt=""
          loading="lazy"
          className="h-16 w-11 shrink-0 rounded-md object-cover"
        />
      ) : (
        <span className="grid h-16 w-11 shrink-0 place-items-center rounded-md bg-gradient-to-br from-white/10 to-white/[0.03]">
          <Film className="h-4 w-4 text-zinc-600" aria-hidden />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-zinc-100 group-hover:text-rose-200">
            {highlight(row.title, terms)}
          </span>
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-1.5">
          <TypeBadge type={row.type} />
          {meta.year ? <span className="text-[11px] text-zinc-500">{meta.year}</span> : null}
          {typeof meta.rating === 'number' && meta.rating > 0 ? <RatingBadge value={meta.rating} /> : null}
        </span>
        <span className="mt-1.5 flex min-w-0 items-center gap-2" title={`Scor relevanță ${row._score.toFixed(2)}`}>
          <span className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-white/10">
            <span
              className="block h-full rounded-full bg-gradient-to-r from-rose-500 to-fuchsia-500"
              style={{ width: `${scorePct}%` }}
            />
          </span>
          <span className="inline-flex shrink-0 items-center gap-0.5 text-[10px] font-bold text-rose-300/80">
            <Sparkles className="h-2.5 w-2.5" aria-hidden />
            {row._score.toFixed(1)}
          </span>
        </span>
      </span>
    </button>
  );
}

export function GroupedResults({ rows, q }: { rows: ScoredRow[]; q: string }) {
  const terms = useMemo(
    () =>
      q
        .trim()
        .split(/\s+/)
        .map((t) => t.trim())
        .filter(Boolean),
    [q],
  );
  const maxScore = useMemo(() => Math.max(0, ...rows.map((r) => r._score)), [rows]);

  const groups = useMemo(() => {
    const map = new Map<string, ScoredRow[]>();
    for (const row of rows) {
      const type = typeof row.type === 'string' && row.type ? row.type : 'other';
      const list = map.get(type) ?? [];
      list.push(row);
      map.set(type, list);
    }
    const order = ['movie', 'tv', 'anime'];
    return [...map.entries()].sort((a, b) => {
      const ai = order.indexOf(a[0]);
      const bi = order.indexOf(b[0]);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });
  }, [rows]);

  return (
    <div className="space-y-3">
      {groups.map(([type, list]) => (
        <Collapsible key={type} defaultOpen>
          <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-lg px-1 py-1.5 text-left">
            <ChevronDown className="h-4 w-4 text-zinc-500 transition group-data-[state=closed]:-rotate-90" aria-hidden />
            {type === 'tv' ? (
              <Tv className="h-4 w-4 text-fuchsia-400" aria-hidden />
            ) : (
              <Film className="h-4 w-4 text-rose-400" aria-hidden />
            )}
            <span className="text-sm font-bold text-zinc-200">{TYPE_LABELS[type] ?? (type === 'other' ? 'Altele' : type)}</span>
            <span className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-semibold text-zinc-400">{list.length}</span>
          </CollapsibleTrigger>
          <CollapsibleContent className="grid gap-2 pt-1 sm:grid-cols-2">
            {list.map((row) => (
              <RichCard key={`rich-${row.id}`} row={row} terms={terms} maxScore={maxScore} />
            ))}
          </CollapsibleContent>
        </Collapsible>
      ))}
    </div>
  );
}

/** Comutator Grilă ⇄ Rezultate bogate (grupate + highlight + scor vizual). */
export function ResultModeToggle({ grouped, onChange }: { grouped: boolean; onChange: (v: boolean) => void }) {
  return (
    <div
      role="group"
      aria-label="Mod afișare rezultate"
      className="inline-flex overflow-hidden rounded-lg border border-white/10"
    >
      <button
        type="button"
        onClick={() => onChange(false)}
        aria-pressed={!grouped}
        className={cn(
          'inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold transition',
          !grouped ? 'bg-rose-600 text-white' : 'bg-white/[0.04] text-zinc-400 hover:text-zinc-100',
        )}
      >
        <LayoutGrid className="h-3.5 w-3.5" aria-hidden />
        Grilă
      </button>
      <button
        type="button"
        onClick={() => onChange(true)}
        aria-pressed={grouped}
        className={cn(
          'inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold transition',
          grouped ? 'bg-rose-600 text-white' : 'bg-white/[0.04] text-zinc-400 hover:text-zinc-100',
        )}
      >
        <Layers className="h-3.5 w-3.5" aria-hidden />
        Grupate + highlight
      </button>
    </div>
  );
}
