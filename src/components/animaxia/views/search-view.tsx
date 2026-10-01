'use client';

/**
 * search-view.tsx — Căutare universală Animaxia.
 *
 *  - Tab-ul „Bibliotecă” rulează ÎNTÂI pe motorul real AR10M (catalog fuzionat
 *    AR10M + legacy prin gateway, /api/ar10m/search): rezultate cu badge de
 *    sursă, shard și catalog, paginare reală prin cursor („Încarcă mai
 *    multe”). Dacă endpoint-ul AR10M nu răspunde (404 până la montaj / 5xx),
 *    căderea este transparentă spre motorul legacy Neon FTS.
 *  - Filtrele avansate neacceptate de AR10M (gen, categorie, actor, studio,
 *    notă, sortare) trec automat pe motorul legacy Neon FTS
 *    (animaxia-neon-fts), cu badge live „Neon FTS · Xms · N rezultate”.
 *  - Tab-urile externe (Anime / Filme & TV) rămân pe sursele live Jikan/TMDB.
 *  - Căsuța mare are debounce 400ms și autocomplete AR10M cu fallback legacy.
 */

import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  History,
  Link2,
  Loader2,
  Search,
  SearchX,
  ShieldCheck,
  Sparkles,
  X,
  Zap,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ApiError, api, animeToItem, dbToItem, mediaToItem } from '@/lib/animaxia/api';
import { useApi, type UseApiResult } from '@/lib/animaxia/hooks';
import { navigate, type AppRoute } from '@/lib/animaxia/router';
import type {
  Ar10mSearchItem,
  IngestCheckResponse,
  NormalizedItem,
  SearchAdvancedResponse,
} from '@/lib/animaxia/types';
import { ContentCard } from '../content-card';
import { Container, PageHeader } from '../section';
import { EmptyState, ErrorState, LoadingCards, RatingBadge, TypeBadge } from '../states';
import { Pagination } from '../pagination';
/* FAZA 33 (PLAN 100X · WS3): extensii additive — componente-copil NOI (fațete
 * dinamice per căutare, căutări salvate, rezultate bogate grupate cu highlight).
 * View-ul existent doar LE RANDEAZĂ; zero logică existentă modificată. */
import {
  GroupedResults,
  QueryFacetsBar,
  ResultModeToggle,
  SavedSearchesBar,
  type FacetFilterView,
} from '../search-ux-panels';
import { cn } from '@/lib/utils';

type SearchTab = 'library' | 'anime' | 'media';

/* ------------------ TS2b: căutări recente (localStorage) ------------------ */

const RECENT_SEARCHES_KEY = 'animaxia:recent-searches';
const RECENT_SEARCHES_MAX = 8;

function readRecentSearches(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_SEARCHES_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(list)) return [];
    return list
      .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      .slice(0, RECENT_SEARCHES_MAX);
  } catch {
    return [];
  }
}

function writeRecentSearches(list: string[]): void {
  try {
    window.localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(list.slice(0, RECENT_SEARCHES_MAX)));
  } catch {
    /* private mode — istoricul nu persistă */
  }
}

function rememberRecentSearch(current: string[], term: string): string[] {
  const trimmed = term.trim();
  if (!trimmed) return current;
  return [trimmed, ...current.filter((r) => r.toLowerCase() !== trimmed.toLowerCase())].slice(
    0,
    RECENT_SEARCHES_MAX,
  );
}

const TAB_LABELS: Record<SearchTab, string> = {
  library: 'Bibliotecă',
  anime: 'Anime',
  media: 'Filme & TV',
};

interface Suggestion {
  id: number;
  title: string;
  type: string;
  thumbnail: string | null;
  rating: number | null;
  /** AR10M — sugestie din motorul real fuzionat (fără thumbnail/rating). */
  catalog?: 'ar10m' | 'legacy';
  year?: number | null;
}

const PAGE_LIMIT = 24;

/** Dimensiunea paginii pentru căutarea AR10M (cursor keyset real). */
const AR10M_PAGE = 12;

/* --------------------------- library filter state --------------------------- */

interface LibraryFilters {
  year: string; // 'any' | '2024' | …
  genre: string; // 'any' | 'Action' | …
  category: string; // 'any' | 'movie' | …
  actor: string; // free text
  studio: string; // free text
  sort: 'score' | 'year' | 'rating' | 'title';
  minRating: string; // 'any' | '6' | '7' | '8' | '9'
}

const EMPTY_FILTERS: LibraryFilters = {
  year: 'any',
  genre: 'any',
  category: 'any',
  actor: '',
  studio: '',
  sort: 'score',
  minRating: 'any',
};

const MIN_RATINGS = [
  { value: 'any', label: 'Orice notă' },
  { value: '6', label: '6+' },
  { value: '7', label: '7+' },
  { value: '8', label: '8+' },
  { value: '9', label: '9+' },
] as const;

const SORTS = [
  { value: 'score', label: 'Relevanță' },
  { value: 'year', label: 'An' },
  { value: 'rating', label: 'Notă' },
  { value: 'title', label: 'Titlu' },
] as const;

function activeFilterChips(filters: LibraryFilters): { key: keyof LibraryFilters; label: string }[] {
  const chips: { key: keyof LibraryFilters; label: string }[] = [];
  if (filters.year !== 'any') chips.push({ key: 'year', label: `An: ${filters.year}` });
  if (filters.genre !== 'any') chips.push({ key: 'genre', label: `Gen: ${filters.genre}` });
  if (filters.category !== 'any') chips.push({ key: 'category', label: `Categorie: ${filters.category}` });
  if (filters.actor.trim()) chips.push({ key: 'actor', label: `Actor: ${filters.actor.trim()}` });
  if (filters.studio.trim()) chips.push({ key: 'studio', label: `Studio: ${filters.studio.trim()}` });
  if (filters.minRating !== 'any') chips.push({ key: 'minRating', label: `Notă ≥ ${filters.minRating}` });
  return chips;
}

/* --------------------------------- the view -------------------------------- */

export function SearchView({ route }: { route: AppRoute }) {
  const q = route.query.get('q')?.trim() || '';
  const [input, setInput] = useState(q);
  const [activeTab, setActiveTab] = useState<SearchTab>('library');

  /* TS2b: căutări recente — încărcate după montare (localStorage e doar client). */
  const [recentSearches, setRecentSearches] = useState<string[]>([]);

  useEffect(() => {
    const timer = setTimeout(() => setRecentSearches(readRecentSearches()), 0);
    return () => clearTimeout(timer);
  }, []);

  /* Every executed search (URL q — submit, debounce sau navbar) is recorded. */
  useEffect(() => {
    if (!q) return;
    const timer = setTimeout(() => {
      setRecentSearches((prev) => {
        const next = rememberRecentSearch(prev, q);
        writeRecentSearches(next);
        return next;
      });
    }, 0);
    return () => clearTimeout(timer);
  }, [q]);

  function removeRecentSearch(term: string) {
    setRecentSearches((prev) => {
      const next = prev.filter((r) => r !== term);
      writeRecentSearches(next);
      return next;
    });
  }

  function clearRecentSearches() {
    setRecentSearches([]);
    writeRecentSearches([]);
  }

  /* Keep the box in sync when the URL query changes. */
  useEffect(() => {
    setInput(q);
  }, [q]);

  /* Live search: debounce 400 ms, navigate only when the query really changed. */
  useEffect(() => {
    const trimmed = input.trim();
    if (trimmed === q) return;
    const timer = setTimeout(() => {
      navigate(trimmed ? `/search?q=${encodeURIComponent(trimmed)}` : '/search');
    }, 400);
    return () => clearTimeout(timer);
  }, [input, q]);

  /* External tabs still search live providers with the URL query. */
  const externalRes = useApi(
    `search-${activeTab}-${q}`,
    async (): Promise<{ items: NormalizedItem[]; total: number }> => {
      if (activeTab === 'anime') {
        const res = await api.animeSearch(q);
        return { items: res.data.map(animeToItem), total: res.data.length };
      }
      const res = await api.moviesSearch(q);
      return { items: res.data.map(mediaToItem), total: res.data.length };
    },
    { enabled: q.length > 0 && activeTab !== 'library' },
  );

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = input.trim();
    if (trimmed) {
      /* TS2b: înregistrează căutarea și la submit direct (acoperă re-căutarea
         aceluiași termen, când q din URL nu se schimbă și efectul nu rulează). */
      setRecentSearches((prev) => {
        const next = rememberRecentSearch(prev, trimmed);
        writeRecentSearches(next);
        return next;
      });
    }
    navigate(trimmed ? `/search?q=${encodeURIComponent(trimmed)}` : '/search');
  };

  /* ----------------------------- autocomplete ----------------------------- */

  const searchBoxRef = useRef<HTMLDivElement>(null);
  const [acOpen, setAcOpen] = useState(false);
  const [acItems, setAcItems] = useState<Suggestion[]>([]);
  const [acLoading, setAcLoading] = useState(false);
  const [acHighlight, setAcHighlight] = useState(-1);

  /* Debounced autocomplete fetch while the dropdown is open: motorul AR10M
   * (catalog fuzionat) cu fallback transparent pe autocomplete-ul legacy
   * Neon prefix+trigram când endpoint-ul AR10M nu e disponibil. */
  const prefetchedRef = useRef<Set<string>>(new Set()); // FAZA 29-P: hover-prefetch (o singură dată per titlu)

  /* FAZA 29-P: la hover pe o sugestie, încălzim în fundal căutarea completă —
   * la click rezultatul vine din cache accel în ~2ms în loc de ~600ms. */
  const prefetchSuggestion = (title: string) => {
    if (!title || prefetchedRef.current.has(title)) return;
    prefetchedRef.current.add(title);
    /* Semnătura EXACTĂ pe care o va cere fallback-ul legacy la click
     * (sort=score, limit=24, page=1). */
    void api.searchPrefetch({ q: title, sort: 'score', limit: PAGE_LIMIT, page: 1 });
  };

  useEffect(() => {
    const query = input.trim();
    if (!acOpen || query.length < 1) {
      setAcItems([]);
      setAcLoading(false);
      setAcHighlight(-1);
      return;
    }
    setAcLoading(true);
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        /* Calea principală: sugestiile reale AR10M (id, titlu, an). */
        const res = await api.ar10mSuggest(query);
        if (!cancelled) {
          setAcItems(
            res.suggestions.slice(0, 8).map((s) => ({
              id: s.id,
              title: s.title,
              type: 'titlu',
              thumbnail: null,
              rating: null,
              catalog: 'ar10m' as const,
              year: s.year,
            })),
          );
        }
      } catch {
        /* Fallback onest: autocomplete legacy Neon (thumbnail + rating). */
        try {
          const legacy = await api.searchAutocomplete(query);
          if (!cancelled) setAcItems(legacy.suggestions);
        } catch {
          if (!cancelled) setAcItems([]);
        }
      } finally {
        if (!cancelled) setAcLoading(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [input, acOpen]);

  /* Close on click-outside. */
  useEffect(() => {
    if (!acOpen) return undefined;
    const onDown = (e: MouseEvent) => {
      if (searchBoxRef.current && !searchBoxRef.current.contains(e.target as Node)) {
        setAcOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [acOpen]);

  function pickSuggestion(s: Suggestion) {
    /* TS2b: și click-ul pe un rezultat înregistrează interogarea căutată. */
    const term = s.title || input.trim();
    if (term) {
      setRecentSearches((prev) => {
        const next = rememberRecentSearch(prev, term);
        writeRecentSearches(next);
        return next;
      });
    }
    setInput('');
    setAcOpen(false);
    setAcItems([]);
    /* Sugestiile AR10M vin din catalogul fuzionat — id-ul nu se mapează
     * garantat pe ruta legacy /content/:id, așa că deschidem rezultatele
     * căutării pentru titlul respectiv. Cele legacy rămân link direct. */
    if (s.catalog === 'ar10m') {
      navigate(`/search?q=${encodeURIComponent(term)}`);
      return;
    }
    navigate(`/content/${s.id}`);
  }

  function handleAcKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!acOpen) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      setAcOpen(false);
      return;
    }
    if (!acItems.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = (acHighlight + 1) % acItems.length;
      setAcHighlight(next);
      prefetchSuggestion(acItems[next]?.title ?? ''); // FAZA 29-P: warming predictiv și la tastatură
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const next = acHighlight <= 0 ? acItems.length - 1 : acHighlight - 1;
      setAcHighlight(next);
      prefetchSuggestion(acItems[next]?.title ?? ''); // FAZA 29-P: warming predictiv și la tastatură
    } else if (e.key === 'Enter' && acHighlight >= 0 && acItems[acHighlight]) {
      e.preventDefault();
      pickSuggestion(acItems[acHighlight]);
    }
  }

  const showDropdown = acOpen && input.trim().length >= 1;

  return (
    <Container className="space-y-8 py-8 sm:py-10">
      <PageHeader
        title="Căutare"
        subtitle="O căsuță, toate sursele — biblioteca ta Neon (motor FTS), MyAnimeList și TMDB."
      />

      <form onSubmit={submit} role="search" aria-label="Caută pe Animaxia" className="flex flex-col gap-3 sm:flex-row">
        <div className="relative flex-1" ref={searchBoxRef}>
          <Search
            className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-zinc-500"
            aria-hidden
          />
          <Input
            value={input}
            onChange={(event) => {
              setInput(event.target.value);
              setAcOpen(true);
              setAcHighlight(-1);
            }}
            onFocus={() => setAcOpen(true)}
            onKeyDown={handleAcKeyDown}
            placeholder="Caută anime, filme, seriale…"
            aria-label="Text de căutat"
            aria-autocomplete="list"
            aria-expanded={showDropdown}
            aria-controls={showDropdown ? 'search-suggestions' : undefined}
            className="h-12 rounded-xl border-white/10 bg-white/[0.04] pl-12 pr-11 text-base text-zinc-100 placeholder:text-zinc-500 focus-visible:border-rose-500/50 focus-visible:ring-rose-500/30"
          />
          {input ? (
            <button
              type="button"
              onClick={() => setInput('')}
              aria-label="Golește căutarea"
              className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-1.5 text-zinc-500 transition hover:bg-white/10 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          ) : null}

          {/* Autocomplete dropdown (Neon prefix + trigram) */}
          {showDropdown && (
            <div
              id="search-suggestions"
              role="listbox"
              aria-label="Sugestii de căutare"
              className="custom-scrollbar absolute inset-x-0 top-full z-20 mt-2 max-h-80 overflow-y-auto rounded-xl border border-white/10 bg-[#12121c] shadow-2xl shadow-black/60"
            >
              {acLoading ? (
                <div className="flex items-center gap-2 px-4 py-3 text-sm text-zinc-500">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Caut…
                </div>
              ) : acItems.length === 0 ? (
                <p className="px-4 py-3 text-sm text-zinc-500">Nicio sugestie</p>
              ) : (
                acItems.map((s, i) => (
                  <button
                    key={s.id}
                    type="button"
                    role="option"
                    aria-selected={acHighlight === i}
                    onMouseEnter={() => {
                      setAcHighlight(i);
                    }}
                    onMouseOver={() => {
                      prefetchSuggestion(s.title); // FAZA 29-P: predictive warming (mouseover = delegat fiabil)
                    }}
                    onFocus={() => {
                      prefetchSuggestion(s.title); // FAZA 29-P: și la navigarea cu tastatura
                    }}
                    onClick={() => pickSuggestion(s)}
                    className={cn(
                      'flex w-full items-center gap-3 px-3 py-2.5 text-left transition',
                      acHighlight === i ? 'bg-white/[0.06]' : 'hover:bg-white/[0.06]',
                    )}
                  >
                    {s.thumbnail ? (
                      <img
                        src={s.thumbnail}
                        alt=""
                        loading="lazy"
                        className="h-10 w-8 shrink-0 rounded object-cover"
                      />
                    ) : (
                      <span className="grid h-10 w-8 shrink-0 place-items-center rounded bg-gradient-to-br from-white/10 to-white/[0.03]">
                        <Search className="h-3.5 w-3.5 text-zinc-600" aria-hidden />
                      </span>
                    )}
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-200">{s.title}</span>
                    {s.catalog === 'ar10m' ? (
                      <span className="flex shrink-0 items-center gap-1.5">
                        {s.year != null ? (
                          <span className="rounded-full border border-white/10 bg-white/[0.05] px-2 py-0.5 font-mono text-[10px] text-zinc-400">
                            {s.year}
                          </span>
                        ) : null}
                        <span className="rounded-full border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-[9px] font-black uppercase tracking-wider text-rose-300">
                          AR10M
                        </span>
                      </span>
                    ) : (
                      <span className="flex shrink-0 items-center gap-1.5">
                        {s.rating != null ? <RatingBadge value={s.rating} /> : null}
                        <TypeBadge type={s.type} />
                      </span>
                    )}
                  </button>
                ))
              )}
            </div>
          )}
        </div>
        <Button
          type="submit"
          className="h-12 rounded-xl bg-rose-600 px-7 text-base font-bold text-white hover:bg-rose-500"
        >
          Caută
        </Button>
      </form>

      {/* TS2b: căutări recente — doar când nu există niciun termen activ. */}
      {!q && input.trim() === '' && recentSearches.length > 0 && (
        <section aria-label="Căutări recente" className="space-y-2.5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="flex items-center gap-2 text-sm font-bold text-zinc-300">
              <History className="h-4 w-4 text-rose-400" aria-hidden />
              Căutări recente
            </h2>
            <button
              type="button"
              onClick={clearRecentSearches}
              className="text-xs font-semibold text-zinc-500 transition hover:text-rose-300"
            >
              Golește istoricul
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {recentSearches.map((term) => (
              <span
                key={term}
                className="inline-flex h-9 items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] pl-3.5 pr-1.5 text-sm text-zinc-300"
              >
                <button
                  type="button"
                  onClick={() => navigate(`/search?q=${encodeURIComponent(term)}`)}
                  className="font-medium transition hover:text-rose-300"
                >
                  {term}
                </button>
                <button
                  type="button"
                  onClick={() => removeRecentSearch(term)}
                  aria-label={`Elimină „${term}” din istoric`}
                  className="grid h-6 w-6 place-items-center rounded-full text-zinc-500 transition hover:bg-rose-500/20 hover:text-rose-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60"
                >
                  <X className="h-3.5 w-3.5" aria-hidden />
                </button>
              </span>
            ))}
          </div>
        </section>
      )}

      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as SearchTab)}>
        <TabsList className="h-10 w-full justify-start gap-1 rounded-xl border border-white/10 bg-white/[0.03] p-1 sm:w-auto">
          {(['library', 'anime', 'media'] as const).map((tab) => (
            <TabsTrigger
              key={tab}
              value={tab}
              className="px-4 text-zinc-400 hover:text-zinc-100 data-[state=active]:bg-rose-600 data-[state=active]:text-white data-[state=active]:shadow-rose-900/40 sm:px-5"
            >
              {TAB_LABELS[tab]}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="library" className="pt-6">
          <LibrarySearchPanel q={q} />
        </TabsContent>

        {(['anime', 'media'] as const).map((tab) => (
          <TabsContent key={tab} value={tab} className="pt-6">
            {q ? (
              <ResultsBlock label={TAB_LABELS[tab]} q={q} res={externalRes} />
            ) : (
              <EmptyState
                icon={<SearchX className="h-6 w-6" aria-hidden />}
                title="Caută pe Animaxia"
                message="Scrie un titlu mai sus — căutăm live pe MyAnimeList și TMDB."
              />
            )}
          </TabsContent>
        ))}
      </Tabs>
    </Container>
  );
}

/* ----------------------------- local helpers ------------------------------ */

function ResultsBlock({
  label,
  q,
  res,
}: {
  label: string;
  q: string;
  res: UseApiResult<{ items: NormalizedItem[]; total: number }>;
}) {
  if (res.error && !res.loading && !res.data) {
    return <ErrorState message={res.error} onRetry={res.refetch} />;
  }
  const items = res.data?.items ?? [];
  const total = res.data?.total ?? 0;
  return (
    <div className="space-y-4">
      {!res.loading && res.data ? (
        <p className="text-sm text-zinc-500">
          <span className="font-semibold text-zinc-200">
            {total > items.length ? `${items.length} din ${total}` : items.length}
          </span>{' '}
          {items.length === 1 && total <= 1 ? 'rezultat' : 'rezultate'} pentru{' '}
          <span className="font-semibold text-zinc-200">„{q}”</span> în {label}
        </p>
      ) : null}
      {res.loading ? (
        <LoadingCards count={12} />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {items.map((item) => (
            <ContentCard key={item.key} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------ AR10M results — badges + real keyset list ------------------ */

/** Etichete RO pentru tipurile de sursă din contractul AR10M. */
const AR10M_SOURCE_LABELS: Record<string, string> = {
  direct_url: 'link direct',
  youtube: 'youtube',
  rumble: 'rumble',
  hls: 'hls',
  iframe: 'iframe',
  embed: 'embed',
};

function SourceBadge({ sourceType }: { sourceType: string | null }) {
  if (!sourceType) return null;
  const label = AR10M_SOURCE_LABELS[sourceType] ?? sourceType;
  return (
    <span
      title={`Sursă: ${sourceType}`}
      className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider text-amber-300"
    >
      {label}
    </span>
  );
}

function ShardBadge({ shardId }: { shardId: number | null }) {
  if (shardId == null) return null;
  return (
    <span
      title={`Shardul real #${shardId} (arhitectura hash)`}
      className="rounded-full border border-white/10 bg-white/[0.05] px-2 py-0.5 font-mono text-[9px] font-bold text-zinc-400"
    >
      S{shardId}
    </span>
  );
}

function CatalogBadge({ catalog }: { catalog: 'ar10m' | 'legacy' }) {
  return catalog === 'ar10m' ? (
    <span className="rounded-full border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-[9px] font-black uppercase tracking-wider text-rose-300">
      AR10M
    </span>
  ) : (
    <span className="rounded-full border border-fuchsia-500/30 bg-fuchsia-500/10 px-2 py-0.5 text-[9px] font-black uppercase tracking-wider text-fuchsia-300">
      LEGACY
    </span>
  );
}

function Ar10mResultRow({ item }: { item: Ar10mSearchItem }) {
  const isLegacy = item.catalog === 'legacy';
  const content = (
    <>
      <span className="grid h-10 w-8 shrink-0 place-items-center rounded bg-gradient-to-br from-white/10 to-white/[0.03]">
        <Search className="h-3.5 w-3.5 text-zinc-600" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-zinc-100" title={item.title}>
          {item.title}
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-1.5">
          {item.year != null ? (
            <span className="font-mono text-[10px] text-zinc-500">{item.year}</span>
          ) : null}
          <SourceBadge sourceType={item.sourceType} />
          <ShardBadge shardId={item.shardId} />
          <CatalogBadge catalog={item.catalog} />
        </span>
      </span>
    </>
  );

  /* Intrările legacy au id-uri Neon → pagină de detaliu reală; cele AR10M
     deschid sursa directă când există, altfel rămân informativ-neutre. */
  if (isLegacy) {
    return (
      <button
        type="button"
        onClick={() => navigate(`/content/${item.id}`)}
        className="flex w-full items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-3 text-left transition hover:border-white/25 hover:bg-white/[0.05]"
      >
        {content}
      </button>
    );
  }
  if (item.sourceUrl) {
    return (
      <a
        href={item.sourceUrl}
        target="_blank"
        rel="noreferrer"
        className="flex w-full items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-3 text-left transition hover:border-white/25 hover:bg-white/[0.05]"
      >
        {content}
        <ExternalLink className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden />
      </a>
    );
  }
  return <div className="flex w-full items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-3">{content}</div>;
}

function Ar10mResultsList({
  items,
  hasMore,
  loadingMore,
  onLoadMore,
}: {
  items: Ar10mSearchItem[];
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  return (
    <div className="space-y-3">
      <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
        {items.map((item) => (
          <Ar10mResultRow key={`${item.catalog}-${item.id}`} item={item} />
        ))}
      </div>
      {hasMore ? (
        <div className="flex justify-center pt-1">
          <Button
            type="button"
            variant="outline"
            onClick={onLoadMore}
            disabled={loadingMore}
            className="h-10 border-white/15 bg-white/5 font-semibold text-zinc-200 hover:bg-white/10 hover:text-white"
          >
            {loadingMore ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden /> : null}
            Încarcă mai multe
          </Button>
        </div>
      ) : (
        <p className="text-center text-[11px] text-zinc-600">
          Toate rezultatele relevante au fost încărcate — paginare keyset reală, fără listă infinită simulată.
        </p>
      )}
    </div>
  );
}

function Ar10mListSkeleton() {
  return (
    <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="h-16 animate-pulse rounded-xl border border-white/10 bg-white/[0.03]" />
      ))}
    </div>
  );
}

/* ------------------- Library tab — Neon FTS advanced search ------------------ */

function LibrarySearchPanel({ q }: { q: string }) {
  const [filters, setFilters] = useState<LibraryFilters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  /* FAZA 33: mod de afișare — grilă clasică (implicit, zero regresie) sau
   * rezultate bogate (grupate pe tip + highlight + scor vizual). */
  const [grouped, setGrouped] = useState(false);

  const filterKey = `${q}|${JSON.stringify(filters)}`;
  const [lastKey, setLastKey] = useState(filterKey);
  if (lastKey !== filterKey) {
    setLastKey(filterKey);
    setPage(1);
  }

  const hasFilters =
    filters.year !== 'any' ||
    filters.genre !== 'any' ||
    filters.category !== 'any' ||
    filters.actor.trim() !== '' ||
    filters.studio.trim() !== '' ||
    filters.minRating !== 'any';
  const enabled = Boolean(q) || hasFilters;

  /* -------------------------- AR10M (motorul real) -------------------------- */

  /* AR10M rulează doar cu interogare liberă + an (singurele filtre suportate
   * de contractul /api/ar10m/search) și sortare implicită; orice filtru
   * avansat trece automat pe motorul legacy Neon FTS. */
  const ar10mCompatible =
    Boolean(q) &&
    filters.genre === 'any' &&
    filters.category === 'any' &&
    filters.actor.trim() === '' &&
    filters.studio.trim() === '' &&
    filters.minRating === 'any' &&
    filters.sort === 'score';

  const ar10mYear = filters.year !== 'any' ? filters.year : undefined;
  const ar10mRes = useApi(
    `ar10m-search:${q}|${filters.year}`,
    () => api.ar10mSearch(q, { year: ar10mYear, limit: AR10M_PAGE }),
    { enabled: ar10mCompatible },
  );

  /* Paginare keyset reală: lista acumulată + cursor pentru „Încarcă mai multe”. */
  const [ar10mItems, setAr10mItems] = useState<Ar10mSearchItem[]>([]);
  const [ar10mCursor, setAr10mCursor] = useState<string | null>(null);
  const [ar10mMore, setAr10mMore] = useState(false);

  useEffect(() => {
    const data = ar10mRes.data;
    if (!data) return;
    setAr10mItems(data.results);
    setAr10mCursor(data.nextCursor);
  }, [ar10mRes.data]);

  const loadMoreAr10m = async () => {
    if (!ar10mCursor || ar10mMore) return;
    setAr10mMore(true);
    try {
      const res = await api.ar10mSearch(q, { year: ar10mYear, limit: AR10M_PAGE, cursor: ar10mCursor });
      setAr10mItems((prev) => [...prev, ...res.results]);
      setAr10mCursor(res.nextCursor);
    } catch {
      /* silent — butonul rămâne disponibil pentru reîncercare */
    } finally {
      setAr10mMore(false);
    }
  };

  /* AR10M servește rezultatele cât timp e compatibil și NU a eșuat; orice
   * eroare (404 până la montaj, 5xx, rețea) → fallback transparent legacy. */
  const ar10mActive = ar10mCompatible && !ar10mRes.error;
  const legacyEnabled = enabled && !ar10mActive;

  /* Facets for the filter bar + empty-state genre suggestions. */
  const facetsRes = useApi('search-filters-options', () => api.searchFilters());
  const facets = facetsRes.data;

  /* Motorul legacy Neon FTS — rulează doar când AR10M nu poate servi (filtre
   * avansate neacceptate sau endpoint AR10M indisponibil).
   * FAZA 29-P: accel-first — stratul de cache/warming (identic ca răspuns);
   * fallback transparent pe searchAdvanced doar dacă accel lipsește (404/502
   * sau rețea). Erorile legitime ale pipeline-ului (429/503/504) trec mai departe
   * ca înainte — NU se face double-request pe rate-limit. */
  const searchKey = `neon-search:${filterKey}:${page}`;
  const results = useApi(
    searchKey,
    () => {
      const accelFilters = {
        q: q || undefined,
        year: filters.year !== 'any' ? filters.year : undefined,
        genre: filters.genre !== 'any' ? filters.genre : undefined,
        category: filters.category !== 'any' ? filters.category : undefined,
        actor: filters.actor.trim() || undefined,
        studio: filters.studio.trim() || undefined,
        minRating: filters.minRating !== 'any' ? Number(filters.minRating) : undefined,
        sort: filters.sort,
        limit: PAGE_LIMIT,
        page,
      };
      return api.searchAccelLookup(accelFilters).catch((err: unknown) => {
        const status = err instanceof ApiError ? err.status : 0;
        if (status === 0 || status === 404 || status === 502) {
          /* fallback transparent — accel indisponibil; răspuns identic, fără accel */
          return api.searchAdvanced(accelFilters) as Promise<
            SearchAdvancedResponse & { accel?: 'hit' | 'miss'; originTook?: number }
          >;
        }
        throw err;
      });
    },
    { enabled: legacyEnabled },
  );

  /* Engine status — fetched on mount and refreshed on every new search. */
  const engine = useApi(`search-engine-status:${searchKey}`, () => api.searchStatus());

  const chips = activeFilterChips(filters);
  const total = results.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_LIMIT));
  const rows = results.data?.data ?? [];

  const setFilter = <K extends keyof LibraryFilters>(key: K, value: LibraryFilters[K]) =>
    setFilters((prev) => ({ ...prev, [key]: value }));

  const genreSuggestions = (facets?.genres ?? []).slice(0, 8);

  return (
    <div className="space-y-5">
      {/* FAZA 33: căutări salvate (q + filtre complete, aplicare într-un click) */}
      <SavedSearchesBar
        q={q}
        filters={filters}
        onApply={(nextQ, nextFilters) => {
          setFilters({ ...EMPTY_FILTERS, ...nextFilters });
          navigate(nextQ.trim() ? `/search?q=${encodeURIComponent(nextQ.trim())}` : '/search');
        }}
      />

      {/* ------------------------ advanced filter bar ------------------------ */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          /* Search is live (debounce + filters) — the button simply confirms the
             current name input immediately. */
          const trimmed = q;
          navigate(trimmed ? `/search?q=${encodeURIComponent(trimmed)}` : '/search');
        }}
        aria-label="Filtre avansate bibliotecă"
        className="space-y-4 rounded-xl border border-white/10 bg-white/[0.03] p-4 sm:p-5"
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-2">
            <Label htmlFor="flt-year">An</Label>
            <Select value={filters.year} onValueChange={(v) => setFilter('year', v)}>
              <SelectTrigger id="flt-year" className="w-full border-white/10 bg-black/40">
                <SelectValue placeholder="Orice an" />
              </SelectTrigger>
              <SelectContent className="max-h-72 border-white/10 bg-[#12121a]">
                <SelectItem value="any">Orice an</SelectItem>
                {(facets?.years ?? []).map((y) => (
                  <SelectItem key={y} value={String(y)}>
                    {y}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="flt-genre">Gen</Label>
            <Select value={filters.genre} onValueChange={(v) => setFilter('genre', v)}>
              <SelectTrigger id="flt-genre" className="w-full border-white/10 bg-black/40">
                <SelectValue placeholder="Orice gen" />
              </SelectTrigger>
              <SelectContent className="max-h-72 border-white/10 bg-[#12121a]">
                <SelectItem value="any">Orice gen</SelectItem>
                {(facets?.genres ?? []).map((g) => (
                  <SelectItem key={g.value} value={g.value}>
                    {g.value} · {g.count}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="flt-category">Categorie</Label>
            <Select value={filters.category} onValueChange={(v) => setFilter('category', v)}>
              <SelectTrigger id="flt-category" className="w-full border-white/10 bg-black/40">
                <SelectValue placeholder="Orice categorie" />
              </SelectTrigger>
              <SelectContent className="max-h-72 border-white/10 bg-[#12121a]">
                <SelectItem value="any">Orice categorie</SelectItem>
                {(facets?.categories ?? []).map((c) => (
                  <SelectItem key={c.value} value={c.value}>
                    {c.value} · {c.count}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="flt-sort">Sortare</Label>
            <Select value={filters.sort} onValueChange={(v) => setFilter('sort', v as LibraryFilters['sort'])}>
              <SelectTrigger id="flt-sort" className="w-full border-white/10 bg-black/40">
                <SelectValue placeholder="Relevanță" />
              </SelectTrigger>
              <SelectContent className="border-white/10 bg-[#12121a]">
                {SORTS.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <ActorInput
            actors={facets?.actors ?? []}
            value={filters.actor}
            onChange={(v) => setFilter('actor', v)}
          />
          <div className="space-y-2">
            <Label htmlFor="flt-studio">Studio</Label>
            <Input
              id="flt-studio"
              value={filters.studio}
              onChange={(e) => setFilter('studio', e.target.value)}
              placeholder="ex. Walt Disney"
              className="border-white/10 bg-black/40"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="flt-rating">Notă minimă</Label>
            <Select value={filters.minRating} onValueChange={(v) => setFilter('minRating', v)}>
              <SelectTrigger id="flt-rating" className="w-full border-white/10 bg-black/40">
                <SelectValue placeholder="Orice notă" />
              </SelectTrigger>
              <SelectContent className="border-white/10 bg-[#12121a]">
                {MIN_RATINGS.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-end gap-2">
            <Button type="submit" className="h-10 flex-1 bg-rose-600 font-bold hover:bg-rose-500">
              <Search className="h-4 w-4" aria-hidden /> Caută
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setFilters(EMPTY_FILTERS)}
              disabled={!hasFilters}
              className="h-10 flex-1 border-white/15 bg-white/5 font-semibold text-zinc-200 hover:bg-white/10 hover:text-white"
            >
              <X className="h-4 w-4" aria-hidden /> Resetează filtrele
            </Button>
          </div>
        </div>
      </form>

      {/* -------------------- "verify link before adding" -------------------- */}
      <DedupCheckPanel />

      {/* ------------------------- engine + meta line ------------------------ */}
      {enabled && (
        <div className="flex flex-wrap items-center gap-2">
          {ar10mActive && ar10mRes.data ? (
            <>
              <span
                title={`Motor real AR10M — catalog fuzionat AR10M + legacy prin gateway · ${ar10mRes.data.shards.queried} sharduri interogate${ar10mRes.data.shards.failed > 0 ? `, ${ar10mRes.data.shards.failed} eșuate` : ''}`}
                className="inline-flex items-center gap-1.5 rounded-full border border-rose-500/30 bg-rose-500/10 px-3 py-1 text-xs font-bold text-rose-300"
              >
                <Zap className="h-3.5 w-3.5" aria-hidden />
                AR10M · {ar10mRes.data.elapsedMs}ms
                {` · ${ar10mItems.length} ${ar10mItems.length === 1 ? 'rezultat' : 'rezultate'}`}
                {ar10mRes.data.shards.failed > 0 ? ` · ${ar10mRes.data.shards.failed} sharduri eșuate` : ''}
              </span>
              {ar10mRes.data.cached ? (
                <span
                  title="Servit din cache-ul real al gateway-ului AR10M"
                  className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-bold text-emerald-300"
                >
                  <Zap className="h-3.5 w-3.5" aria-hidden />
                  cache
                </span>
              ) : null}
            </>
          ) : (
            <span
              title={`Motor: ${results.data?.engine ?? engine.data?.engine ?? 'animaxia-neon-fts'}`}
              className="inline-flex items-center gap-1.5 rounded-full border border-fuchsia-500/30 bg-fuchsia-500/10 px-3 py-1 text-xs font-bold text-fuchsia-300"
            >
              <Zap className="h-3.5 w-3.5" aria-hidden />
              Neon FTS
              {results.data ? ` · ${results.data.took}ms` : ''}
              {results.data ? ` · ${results.data.total} ${results.data.total === 1 ? 'rezultat' : 'rezultate'}` : ''}
              {engine.data ? ` · p95 ${engine.data.latency.p95Ms}ms` : ''}
            </span>
          )}
          {results.data?.accel === 'hit' ? (
            <span
              title={`Servit din cache-ul accel FAZA 29-P în ${results.data.took}ms (execuția originală pipeline: ${results.data.originTook ?? '?'}ms)`}
              className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-bold text-emerald-300"
            >
              <Zap className="h-3.5 w-3.5" aria-hidden />
              Accel · {(results.data.took ?? 0) < 5 ? 'instant' : `${results.data.took}ms`}
            </span>
          ) : null}
          {chips.map((chip) => (
            <button
              key={chip.key}
              type="button"
              onClick={() => {
                if (chip.key === 'actor' || chip.key === 'studio') setFilter(chip.key, '');
                else setFilter(chip.key, 'any');
              }}
              className="group inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.05] px-2.5 py-1 text-[11px] font-semibold text-zinc-300 transition hover:border-rose-500/40 hover:text-rose-300"
              aria-label={`Elimină filtrul ${chip.label}`}
            >
              {chip.label}
              <X className="h-3 w-3 text-zinc-500 transition group-hover:text-rose-400" aria-hidden />
            </button>
          ))}
          {/* FAZA 33: comutator grilă ⇄ rezultate bogate (grupate + highlight) */}
          {rows.length > 0 ? <span className="ml-auto"><ResultModeToggle grouped={grouped} onChange={setGrouped} /></span> : null}
        </div>
      )}

      {/* FAZA 33: fațete dinamice per căutare (tip/gen/ani/surse cu numărători,
          calculate prin searchux pe eșantion din motorul protejat) */}
      <QueryFacetsBar q={q} filters={filters as FacetFilterView} onApply={setFilter} />

      {/* ------------------------------ results ------------------------------ */}
      {!enabled ? (
        <EmptyState
          icon={<SearchX className="h-6 w-6" aria-hidden />}
          title="Caută în catalogul real"
          message="Scrie un nume mai sus sau alege un filtru — motorul AR10M caută în catalogul fuzionat, legacy Neon FTS în biblioteca indexată."
          action={
            genreSuggestions.length > 0 ? (
              <div className="flex max-w-lg flex-wrap justify-center gap-1.5">
                {genreSuggestions.map((g) => (
                  <button
                    key={g.value}
                    type="button"
                    onClick={() => setFilter('genre', g.value)}
                    className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-xs font-medium text-zinc-300 transition hover:border-rose-500/40 hover:bg-rose-500/10 hover:text-rose-300"
                  >
                    {g.value}
                    <span className="ml-1 text-[10px] font-semibold text-zinc-500">{g.count}</span>
                  </button>
                ))}
              </div>
            ) : undefined
          }
        />
      ) : ar10mActive ? (
        ar10mRes.loading && ar10mItems.length === 0 ? (
          <Ar10mListSkeleton />
        ) : ar10mItems.length === 0 ? (
          <EmptyState
            icon={<SearchX className="h-6 w-6" aria-hidden />}
            title={`Nimic găsit pentru „${q}”`}
            message="Încearcă alt cuvânt — sau dezactivează filtrul de an pentru a căuta în tot catalogul fuzionat."
          />
        ) : (
          <Ar10mResultsList
            items={ar10mItems}
            hasMore={ar10mCursor != null}
            loadingMore={ar10mMore}
            onLoadMore={() => void loadMoreAr10m()}
          />
        )
      ) : results.error && !results.loading && !results.data ? (
        <ErrorState message={results.error} onRetry={results.refetch} />
      ) : results.loading && !results.data ? (
        <LoadingCards count={12} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<SearchX className="h-6 w-6" aria-hidden />}
          title={q ? `Nimic găsit pentru „${q}”` : 'Niciun rezultat pentru aceste filtre'}
          message="Încearcă alt cuvânt, dezactivează un filtru — sau pornește de la un gen popular:"
          action={
            genreSuggestions.length > 0 ? (
              <div className="flex max-w-lg flex-wrap justify-center gap-1.5">
                {genreSuggestions.map((g) => (
                  <button
                    key={g.value}
                    type="button"
                    onClick={() => setFilter('genre', g.value)}
                    className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-xs font-medium text-zinc-300 transition hover:border-rose-500/40 hover:bg-rose-500/10 hover:text-rose-300"
                  >
                    {g.value}
                    <span className="ml-1 text-[10px] font-semibold text-zinc-500">{g.count}</span>
                  </button>
                ))}
              </div>
            ) : undefined
          }
        />
      ) : (
        <>
          {/* FAZA 33: rezultate bogate — grupate Filme/Seriale/Anime cu highlight
              de termeni și scor de relevanță vizual (comutabil, implicit grila
              clasică — zero regresie). */}
          {grouped && q ? (
            <GroupedResults rows={rows} q={q} />
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
              {rows.map((row) => (
                <div key={`neon-${row.id}`} className="relative">
                  <ContentCard item={dbToItem(row)} />
                  {q && row._score > 0 ? (
                    <span
                      title={`Scor relevanță ${row._score.toFixed(2)}`}
                      className="absolute right-2 top-9 z-10 inline-flex items-center gap-1 rounded-full border border-rose-500/40 bg-black/70 px-2 py-0.5 text-[10px] font-bold text-rose-300 backdrop-blur"
                    >
                      <Sparkles className="h-2.5 w-2.5" aria-hidden />
                      {row._score.toFixed(1)}
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          )}
          <Pagination page={page} totalPages={totalPages} onPage={setPage} />
        </>
      )}
    </div>
  );
}

/* ------------------------- actor input w/ autocomplete ---------------------- */

function ActorInput({
  actors,
  value,
  onChange,
}: {
  actors: { value: string; count: number }[];
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const query = value.trim().toLowerCase();
  const matches = query
    ? actors.filter((a) => a.value.toLowerCase().includes(query)).slice(0, 6)
    : actors.slice(0, 6);

  return (
    <div className="space-y-2" ref={wrapRef}>
      <Label htmlFor="flt-actor">Actor</Label>
      <div className="relative">
        <Input
          id="flt-actor"
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder="ex. Dwayne Johnson"
          className="border-white/10 bg-black/40"
          aria-autocomplete="list"
          aria-expanded={open && matches.length > 0}
        />
        {open && matches.length > 0 ? (
          <div className="custom-scrollbar absolute inset-x-0 top-full z-20 mt-1 max-h-48 overflow-y-auto rounded-xl border border-white/10 bg-[#12121c] shadow-2xl shadow-black/60">
            {matches.map((a) => (
              <button
                key={a.value}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange(a.value);
                  setOpen(false);
                }}
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm text-zinc-300 transition hover:bg-white/[0.06] hover:text-zinc-100"
              >
                <span className="truncate">{a.value}</span>
                <span className="shrink-0 text-[10px] font-semibold text-zinc-600">{a.count}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------- dedup panel: verify link before adding ------------------ */

function DedupCheckPanel() {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [checking, setChecking] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [result, setResult] = useState<IngestCheckResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const check = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed) return;
    setChecking(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.ingestCheck(trimmed);
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verificarea a eșuat');
    } finally {
      setChecking(false);
    }
  };

  const register = async () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    setRegistering(true);
    try {
      const res = await api.ingestRegister({ url: trimmed, addedBy: 'manual' });
      if (res.registered) {
        toast.success('Link înregistrat în Neon', { description: res.source.url });
      } else {
        toast.warning('Linkul există deja în registru', { description: `${res.source.hits} accesări înregistrate.` });
      }
      setResult({ ok: true, exists: true, duplicate: true, source: res.source, content: null });
    } catch (err) {
      toast.error('Înregistrarea a eșuat', {
        description: err instanceof Error ? err.message : 'Încearcă din nou peste un minut.',
      });
    } finally {
      setRegistering(false);
    }
  };

  const fmtDate = (iso: string) => {
    try {
      return new Date(iso).toLocaleDateString('ro-RO', { day: 'numeric', month: 'short', year: 'numeric' });
    } catch {
      return iso;
    }
  };

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-xl border border-white/10 bg-white/[0.02]">
      <CollapsibleTrigger className="flex w-full items-center gap-2.5 px-4 py-3 text-left text-sm font-semibold text-zinc-300 transition hover:bg-white/[0.04] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60">
        <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-400" aria-hidden />
        <span className="flex-1">Ai un link de adăugat? Verifică duplicat</span>
        <span className="hidden text-xs font-normal text-zinc-500 sm:inline">registru global Neon · anti-duplicat</span>
        <ChevronDown className={cn('h-4 w-4 shrink-0 text-zinc-500 transition-transform duration-200', open && 'rotate-180')} aria-hidden />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-3 border-t border-white/10 px-4 py-4">
          <form onSubmit={check} className="flex flex-col gap-2 sm:flex-row">
            <div className="relative flex-1">
              <Link2 className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" aria-hidden />
              <Input
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  setResult(null);
                  setError(null);
                }}
                placeholder="Lipește linkul: YouTube, MP4, HLS, DASH, embed…"
                aria-label="Link de verificat"
                className="h-10 border-white/10 bg-black/40 pl-9 text-sm"
              />
            </div>
            <Button
              type="submit"
              disabled={!url.trim() || checking}
              className="h-10 bg-rose-600 font-bold hover:bg-rose-500"
            >
              {checking ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden /> : <Search className="mr-1.5 h-4 w-4" aria-hidden />}
              Verifică
            </Button>
          </form>

          {error ? (
            <div className="flex items-start gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200" role="alert">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>{error}</span>
            </div>
          ) : null}

          {result?.exists && result.source ? (
            <div className="flex flex-col gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 sm:flex-row sm:items-center">
              <div className="flex items-start gap-2 text-sm text-amber-200">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                <span>
                  <span className="font-bold">Link deja în Neon</span>
                  {' — '}
                  {result.source.kind} · adăugat {fmtDate(result.source.createdat)} · {result.source.hits}{' '}
                  {result.source.hits === 1 ? 'accesare' : 'accesări'}
                  <span className="block break-all font-mono text-[11px] text-amber-300/70">{result.source.url}</span>
                </span>
              </div>
              <div className="flex shrink-0 gap-2 sm:ml-auto">
                {result.source.contentid != null ? (
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => navigate(`/content/${result.source?.contentid}`)}
                    className="h-8 bg-amber-600 text-xs font-bold text-white hover:bg-amber-500"
                  >
                    <ExternalLink className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                    Deschide conținutul
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}

          {result && !result.exists ? (
            <div className="flex flex-col gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 sm:flex-row sm:items-center">
              <div className="flex items-start gap-2 text-sm text-emerald-200">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                <span>
                  <span className="font-bold">Link nou</span> — poate fi adăugat fără duplicat.
                  <span className="block text-[11px] text-emerald-300/70">Nu există în registru Neon · urlhash unic</span>
                </span>
              </div>
              <Button
                type="button"
                size="sm"
                onClick={() => void register()}
                disabled={registering}
                className="h-8 bg-emerald-600 text-xs font-bold text-white hover:bg-emerald-500 sm:ml-auto"
              >
                {registering ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
                Înregistrează în Neon
              </Button>
            </div>
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
