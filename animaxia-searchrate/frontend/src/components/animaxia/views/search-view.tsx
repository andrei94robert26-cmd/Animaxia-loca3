'use client';

/**
 * search-view.tsx — Căutare universală Animaxia (FAZA 16).
 *
 *  - Tab-ul „Bibliotecă” rulează pe motorul Neon FTS (animaxia-neon-fts):
 *    bară de filtre avansate (nume, an, gen, categorie, actor cu autocomplete,
 *    studio, sortare, notă minimă), badge live „⚡ Neon FTS · Xms · N rezultate
 *    · p95 Yms”, chips cu filtrele active, paginare 24/pagină și panoul
 *    „Verifică link înainte de adăugare” (registru anti-duplicat Neon).
 *  - Tab-urile externe (Anime / Filme & TV) rămân pe sursele live Jikan/TMDB.
 *  - Căsuța mare are debounce 400ms și autocomplete prefix+trigram din Neon.
 *
 * FAZA 16 (Search Rate Management): UI-ul onorează ritmul impus de backend —
 * după fiecare rezultat primit butonul „Caută” se dezactivează pe durata
 * cooldown-ului (countdown live), apăsările repetate de ENTER (≥3 în <200ms)
 * declanșează mesajul „Așteaptă un moment…” local, iar răspunsurile 429
 * (rate_limited / cooldown_active / spam_blocked, cu retryInMs) sunt
 * tratate elegant: rezultatele anterioare rămân vizibile și căutarea se
 * reîncearcă automat când fereastra de ritm expiră. Căutările în sine rămân
 * 100% reale — UI-ul doar respectă pauza, nu o simulează.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  Hourglass,
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
import { api, animeToItem, dbToItem, mediaToItem, ApiError } from '@/lib/animaxia/api';
import { useApi, type UseApiResult } from '@/lib/animaxia/hooks';
import { navigate, type AppRoute } from '@/lib/animaxia/router';
import type { IngestCheckResponse, NormalizedItem, SearchRatePacingInfo } from '@/lib/animaxia/types';
import { ContentCard } from '../content-card';
import { Container, PageHeader } from '../section';
import { EmptyState, ErrorState, LoadingCards, RatingBadge, TypeBadge } from '../states';
import { Pagination } from '../pagination';
import { cn } from '@/lib/utils';

type SearchTab = 'library' | 'anime' | 'media';

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
}

const PAGE_LIMIT = 24;

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

/* ---------------------- FAZA 16: search pacing state ----------------------- */

/** Why the ENTER affordance is paused (mirrors the backend 429 codes). */
type PaceReason = 'cooldown' | 'rate_limited' | 'spam_blocked';

const PACE_REASON_LABEL: Record<PaceReason, string> = {
  cooldown: 'cooldown după rezultat',
  rate_limited: 'limită per utilizator',
  spam_blocked: 'protecție anti-spam',
};

/** Local anti-spam ring: ≥3 ENTER presses within 200ms = flood (FAZA 16
 *  mirrors the backend rule client-side so the feedback is instant). */
const ENTER_SPAM_WINDOW_MS = 200;
const ENTER_SPAM_THRESHOLD = 3;
const ENTER_SPAM_BLOCK_MS = 1000;

/* --------------------------------- the view -------------------------------- */

export function SearchView({ route }: { route: AppRoute }) {
  const q = route.query.get('q')?.trim() || '';
  const [input, setInput] = useState(q);
  const [activeTab, setActiveTab] = useState<SearchTab>('library');

  /* FAZA 16: pacing state — cooldown after a result, 429 retryInMs from the
     backend, or a local ENTER flood. One ticking clock drives the countdown. */
  const [pace, setPace] = useState<{ until: number; reason: PaceReason } | null>(null);
  const [, setNowTick] = useState(0);
  const enterTimesRef = useRef<number[]>([]);

  /* Countdown ticker — re-renders every 200ms while a pace block is live and
     clears it the moment it expires. */
  useEffect(() => {
    if (!pace) return undefined;
    const timer = setInterval(() => {
      setNowTick(Date.now());
      if (Date.now() >= pace.until) setPace(null);
    }, 200);
    return () => clearInterval(timer);
  }, [pace]);

  const paceActive = pace != null && pace.until > Date.now();
  const paceLeftMs = pace ? Math.max(0, pace.until - Date.now()) : 0;

  /** Register one ENTER press; returns true when it constitutes spam. */
  const registerEnterPress = useCallback(() => {
    const now = Date.now();
    const ring = enterTimesRef.current;
    while (ring.length > 0 && ring[0] <= now - ENTER_SPAM_WINDOW_MS) ring.shift();
    ring.push(now);
    return ring.length >= ENTER_SPAM_THRESHOLD;
  }, []);

  /* Callbacks from the library panel: a real result arrived (start the
     cooldown affordance) / a 429 arrived (honor retryInMs). */
  const handleSearchResult = useCallback((rate?: SearchRatePacingInfo) => {
    const cooldownMs = Number(rate?.cooldownMs);
    if (Number.isFinite(cooldownMs) && cooldownMs > 0) {
      setPace((prev) => (prev && prev.until > Date.now() + cooldownMs ? prev : { until: Date.now() + cooldownMs, reason: 'cooldown' }));
    }
  }, []);

  const handleSearchPaced = useCallback((body: { error?: string; retryInMs?: number }) => {
    const reason: PaceReason =
      body?.error === 'cooldown_active'
        ? 'cooldown'
        : body?.error === 'spam_blocked'
          ? 'spam_blocked'
          : 'rate_limited';
    const retryInMs = Number(body?.retryInMs) > 0 ? Number(body.retryInMs) : 600;
    setPace((prev) => (prev && prev.until > Date.now() + retryInMs ? prev : { until: Date.now() + retryInMs + 60, reason }));
  }, []);

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
    /* FAZA 16: local anti-spam first — ≥3 ENTER presses within 200ms show the
       message immediately and pause the button (the backend blocks the
       requests anyway; this keeps the UI honest and instant). */
    if (registerEnterPress()) {
      setPace({ until: Date.now() + ENTER_SPAM_BLOCK_MS, reason: 'spam_blocked' });
      return;
    }
    if (paceActive) return; // cooldown — the button is disabled; guard anyway
    const trimmed = input.trim();
    navigate(trimmed ? `/search?q=${encodeURIComponent(trimmed)}` : '/search');
  };

  /* ----------------------------- autocomplete ----------------------------- */

  const searchBoxRef = useRef<HTMLDivElement>(null);
  const [acOpen, setAcOpen] = useState(false);
  const [acItems, setAcItems] = useState<Suggestion[]>([]);
  const [acLoading, setAcLoading] = useState(false);
  const [acHighlight, setAcHighlight] = useState(-1);

  /* Debounced autocomplete fetch while the dropdown is open (Neon prefix+trigram). */
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
        const res = await api.searchAutocomplete(query);
        if (!cancelled) setAcItems(res.suggestions);
      } catch {
        if (!cancelled) setAcItems([]);
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
    setInput('');
    setAcOpen(false);
    setAcItems([]);
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
      setAcHighlight((h) => (h + 1) % acItems.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setAcHighlight((h) => (h <= 0 ? acItems.length - 1 : h - 1));
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
                    onMouseEnter={() => setAcHighlight(i)}
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
                    {s.rating != null ? <RatingBadge value={s.rating} /> : null}
                    <TypeBadge type={s.type} />
                  </button>
                ))
              )}
            </div>
          )}
        </div>
        <Button
          type="submit"
          disabled={paceActive}
          aria-disabled={paceActive}
          className="h-12 rounded-xl bg-rose-600 px-7 text-base font-bold text-white hover:bg-rose-500 disabled:pointer-events-none"
        >
          {paceActive ? (
            <>
              <Hourglass className="h-4 w-4 animate-pulse" aria-hidden />
              Așteaptă {(paceLeftMs / 1000).toFixed(1)}s
            </>
          ) : (
            'Caută'
          )}
        </Button>
      </form>

      {/* FAZA 16: pacing message — the exact „Așteaptă un moment…” affordance */}
      {paceActive ? (
        <p
          role="status"
          aria-live="polite"
          className="flex items-center gap-2 rounded-xl border border-amber-500/25 bg-amber-500/[0.07] px-4 py-2.5 text-sm font-medium text-amber-200"
        >
          <Hourglass className="h-4 w-4 shrink-0 animate-pulse" aria-hidden />
          Așteaptă un moment… {(paceLeftMs / 1000).toFixed(1)}s
          <span className="font-normal text-amber-200/70">— {PACE_REASON_LABEL[pace?.reason ?? 'rate_limited']}</span>
        </p>
      ) : null}

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
          <LibrarySearchPanel
            q={q}
            paceUntil={paceActive ? pace?.until ?? 0 : null}
            onPaced={handleSearchPaced}
            onResult={handleSearchResult}
          />
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

/* ------------------- Library tab — Neon FTS advanced search ------------------ */

function LibrarySearchPanel({
  q,
  paceUntil,
  onPaced,
  onResult,
}: {
  q: string;
  /** FAZA 16 — epoch ms until which searching is paced (null when free).
   *  Primitive on purpose: a stable identity keeps the auto-retry effect
   *  from re-running on every countdown tick. */
  paceUntil: number | null;
  /** FAZA 16 — a 429 arrived from /advanced (rate_limited / cooldown_active / spam_blocked). */
  onPaced: (body: { error?: string; retryInMs?: number }) => void;
  /** FAZA 16 — a real result arrived (starts the cooldown affordance). */
  onResult: (rate?: SearchRatePacingInfo) => void;
}) {
  const [filters, setFilters] = useState<LibraryFilters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);

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

  /* Facets for the filter bar + empty-state genre suggestions. */
  const facetsRes = useApi('search-filters-options', () => api.searchFilters());
  const facets = facetsRes.data;

  /* The search itself — every filter change triggers a fresh query.
     FAZA 16: a 200 result reports its pacing block (cooldown affordance); a
     429 reports retryInMs — both bubble up to the view's pace state. */
  const searchKey = `neon-search:${filterKey}:${page}`;
  const results = useApi(
    searchKey,
    async () => {
      try {
        const res = await api.searchAdvanced({
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
        });
        onResult(res.rate);
        return res;
      } catch (e) {
        if (e instanceof ApiError && e.status === 429 && e.body) {
          onPaced(e.body as { error?: string; retryInMs?: number });
        }
        throw e;
      }
    },
    { enabled },
  );

  /* FAZA 16: a paced (429) error is NOT a failure state — the backend answered
     explicitly with retryInMs. Detect it by the pinned error strings. */
  const paced =
    results.error === 'rate_limited' || results.error === 'cooldown_active' || results.error === 'spam_blocked';

  /* Auto-retry once per (searchKey, pace window): when the rhythm allows it
     again, re-run the CURRENT query so the user gets the real results without
     pressing anything. The timer is intentionally NOT cleared on re-render —
     the 200ms countdown ticks (and the pace expiring) would otherwise cancel
     it; useApi's refetch is safe on unmounted/changed keys by design. Guarded
     per (key, window) and capped at 3 consecutive retries per key. */
  const autoRetryRef = useRef<{ key: string; count: number }>({ key: '', count: 0 });
  useEffect(() => {
    if (!paced || paceUntil == null) return;
    const guardKey = `${searchKey}@${paceUntil}`;
    if (autoRetryRef.current.key === guardKey || autoRetryRef.current.count >= 3) return;
    autoRetryRef.current = { key: guardKey, count: autoRetryRef.current.count + 1 };
    const delay = Math.max(150, paceUntil - Date.now() + 150);
    setTimeout(() => {
      void results.refetch();
    }, delay);
  }, [paced, paceUntil, searchKey, results.refetch]);
  useEffect(() => {
    if (!paced && autoRetryRef.current.count > 0 && !results.loading && results.data) {
      autoRetryRef.current = { key: '', count: 0 };
    }
  }, [paced, results.loading, results.data]);

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
        </div>
      )}

      {/* ------------------------------ results ------------------------------ */}
      {!enabled ? (
        <EmptyState
          icon={<SearchX className="h-6 w-6" aria-hidden />}
          title="Caută în biblioteca ta Neon"
          message="Scrie un nume mai sus sau alege un filtru — motorul FTS caută în titluri, genuri și descrieri."
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
      ) : paced && !results.loading && !results.data ? (
        /* FAZA 16: a 429 is an explicit „wait” answer, not an error — the
           auto-retry above will run the real query the moment it is allowed. */
        <div className="flex flex-col items-center gap-3 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-6 py-12 text-center">
          <span className="grid h-12 w-12 place-items-center rounded-full border border-amber-500/30 bg-amber-500/10" aria-hidden>
            <Hourglass className="h-6 w-6 animate-pulse text-amber-300" />
          </span>
          <p className="text-base font-bold text-amber-200">Așteaptă un moment…</p>
          <p className="max-w-md text-xs leading-relaxed text-zinc-500">
            Ritmul de căutare este protejat (FAZA 16 — limită per utilizator, cooldown și anti-spam).
            Reîncercăm automat imediat ce fereastra se deschide; căutarea rămâne 100% reală.
          </p>
        </div>
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
          {paced && !results.loading ? (
            <p className="flex items-center gap-2 rounded-xl border border-amber-500/25 bg-amber-500/[0.07] px-4 py-2 text-xs font-medium text-amber-200" role="status">
              <Hourglass className="h-3.5 w-3.5 shrink-0 animate-pulse" aria-hidden />
              Așteaptă un moment… reîncercăm automat — rezultatele de mai jos rămân cele reale anterioare.
            </p>
          ) : null}
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
