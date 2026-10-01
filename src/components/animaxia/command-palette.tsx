'use client';

/**
 * command-palette.tsx — FAZA 33 (PLAN 100X · WS3): paleta globală de comandă
 * ⌘K / Ctrl+K — „caut și văd instant".
 *
 * Strat NOU de experiență peste motorul protejat (FAZA 18 + accel 29-P):
 *  • Navigare rapidă: toate view-urile platformei (din MENU_GROUPS — sursă
 *    unică de adevăr, zero duplicare).
 *  • Acțiuni: „Repetă ultima căutare", „Caută «q» în tot catalogul".
 *  • Căutări recente: localStorage partajat cu search-view (TS2b).
 *  • Trending anonimizat: /api/searchux/trending (plan WS3).
 *  • Conținut live: AR10M (/api/ar10m/suggest — catalog fuzionat real) cu
 *    fallback pe /api/searchux/suggest (thumbnail + „Ați vrut…?" — fuzzy pe
 *    stratul UX, NU în motor).
 *
 * Zero atingeri ale componentelor protejate: paleta doar CONSUMĂ API-uri
 * existente + searchux. Mount global în page.tsx (funcționează pe orice view).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, CornerDownLeft, History, Search, Sparkles, TrendingUp } from 'lucide-react';
import { api } from '@/lib/animaxia/api';
import { navigate } from '@/lib/animaxia/router';
import { MENU_GROUPS } from '@/lib/animaxia/menu';
import type { SearchUxTrending } from '@/lib/animaxia/types';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { TypeBadge } from './states';
import { cn } from '@/lib/utils';

/* --------------------------- shared local storage --------------------------- */

const RECENT_KEY = 'animaxia:recent-searches'; // identic cu search-view (TS2b)
const PALETTE_STATS_KEY = 'animaxia:palette-stats';

/** Sugestie în paletă: AR10M (id, titlu, an) sau legacy searchux (tip/rating). */
interface PaletteSuggestItem {
  id: number;
  title: string;
  type: string;
  thumbnail: string | null;
  rating: number | null;
  catalog?: 'ar10m' | 'legacy';
  year?: number | null;
}

/** Răspunsul de sugestii al paletei — AR10M (fără timing) sau searchux complet. */
interface PaletteSuggest {
  _q: string;
  suggestions: PaletteSuggestItem[];
  didYouMean?: { q: string; distance: number; count: number }[];
  took?: number;
  cache?: 'hit' | 'miss';
  engine?: string;
}

function readRecent(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(list)) return [];
    return list.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).slice(0, 8);
  } catch {
    return [];
  }
}

function bumpAdoption() {
  try {
    const raw = window.localStorage.getItem(PALETTE_STATS_KEY);
    const stats = raw ? (JSON.parse(raw) as { opens?: number }) : {};
    const opens = (typeof stats.opens === 'number' ? stats.opens : 0) + 1;
    window.localStorage.setItem(PALETTE_STATS_KEY, JSON.stringify({ opens, lastOpenAt: Date.now() }));
  } catch {
    /* private mode — statistica nu persistă */
  }
}

/* ------------------------- navigation item registry ------------------------- */

interface NavItem {
  id: string;
  label: string;
  href: string;
  emoji?: string;
  group: string;
}

/** Navigare plată din MENU_GROUPS (sursă unică; fără duplicare). */
const NAV_ITEMS: NavItem[] = MENU_GROUPS.flatMap((group) =>
  group.entries
    .filter((entry) => !('metaDim' in entry) || entry.metaDim === undefined)
    .map((entry) => ({
      id: entry.id,
      label: entry.label,
      href: entry.href,
      emoji: entry.emoji,
      group: group.label,
    })),
);

/* ------------------------------- the component ------------------------------ */

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [recent, setRecent] = useState<string[]>([]);
  const [trending, setTrending] = useState<SearchUxTrending['top']>([]);
  const [suggest, setSuggest] = useState<PaletteSuggest | null>(null);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* ⌘K / Ctrl+K + evenimentul butonului din navbar — ascultători globali. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    const onOpenRequest = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('animaxia:palette-open', onOpenRequest);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('animaxia:palette-open', onOpenRequest);
    };
  }, []);

  /* La deschidere: recents proaspete + trending + adopție (KPI WS3).
   * setState prin setTimeout(0) — pattern-ul codebase-ului pentru efecte
   * sincrone la montare/deschidere (fără set-state-in-effect). */
  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    const timer = setTimeout(() => {
      bumpAdoption();
      setQuery('');
      setSuggest(null);
      setRecent(readRecent());
    }, 0);
    api
      .searchuxTrending(6)
      .then((res) => {
        if (!cancelled) setTrending(res.top);
      })
      .catch(() => {
        if (!cancelled) setTrending([]);
      });
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open]);

  /* Conținut live: debounce 150ms — calea principală AR10M (catalog fuzionat
   * real), fallback transparent pe stratul searchux (motorul protejat FAZA 18).
   * ZERO setState sincron în corpul efectului — starea „vizibilă" e derivată
   * (visibleSuggest mai jos); fetch-urile au loc doar în callback-ul timer-ului. */
  useEffect(() => {
    if (!open) return undefined;
    const trimmed = query.trim();
    if (trimmed.length < 2) return undefined;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setSuggestLoading(true);
      let payload: PaletteSuggest | null = null;
      try {
        /* Sugestiile reale AR10M — id, titlu, an (fără thumbnail în contract). */
        const res = await api.ar10mSuggest(trimmed);
        payload = {
          _q: trimmed,
          engine: 'ar10m',
          suggestions: res.suggestions.slice(0, 6).map((s) => ({
            id: s.id,
            title: s.title,
            type: 'titlu',
            thumbnail: null,
            rating: null,
            catalog: 'ar10m' as const,
            year: s.year,
          })),
        };
      } catch {
        /* Fallback onest: searchux (thumbnail + did-you-mean). */
        try {
          const res = await api.searchuxSuggest(trimmed, 6);
          payload = { ...res, _q: trimmed };
        } catch {
          payload = null;
        }
      }
      /* răspunsul poate ajunge după o tastare nouă — se aplică doar dacă
       * query-ul nu s-a schimbat între timp */
      setSuggest((prev) => (prev && prev._q !== trimmed ? prev : payload));
      setSuggestLoading(false);
    }, 150);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, open]);

  const go = useCallback((href: string) => {
    setOpen(false);
    navigate(href);
  }, []);

  const runSearch = useCallback(
    (term: string) => {
      const trimmed = term.trim();
      if (!trimmed) return;
      /* track anonimizat (trending platformă — plan WS3, zero identitate). */
      void api.searchuxTrack(trimmed);
      go(`/search?q=${encodeURIComponent(trimmed)}`);
    },
    [go],
  );

  /* Filtrare proprie (shouldFilter=false la Command): static local + server
   * results netestate (trigram suggestions nu conțin neapărat query-ul literal). */
  const normQuery = query.trim().toLowerCase();
  const navMatches = useMemo(
    () =>
      (normQuery
        ? NAV_ITEMS.filter(
            (item) =>
              item.label.toLowerCase().includes(normQuery) || item.group.toLowerCase().includes(normQuery),
          )
        : NAV_ITEMS.slice(0, 12)),
    [normQuery],
  );
  const recentMatches = useMemo(
    () => (normQuery ? recent.filter((r) => r.toLowerCase().includes(normQuery)) : recent.slice(0, 5)),
    [recent, normQuery],
  );
  const trendingMatches = useMemo(
    () => (normQuery ? trending.filter((t) => t.q.includes(normQuery)) : trending),
    [trending, normQuery],
  );
  /* Stare derivată: sugestiile sunt vizibile doar pentru query-ul curent
   * (≥2 caractere) — zero setState de reset în efect. */
  const visibleSuggest = query.trim().length >= 2 && suggest && suggest._q === query.trim() ? suggest : null;
  const suggestions = visibleSuggest?.suggestions ?? [];
  const didYouMean = visibleSuggest?.didYouMean ?? [];
  const hasServerResults = suggestions.length > 0 || didYouMean.length > 0;
  const trimmedQuery = query.trim();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="overflow-hidden border-white/10 bg-[#12121c]/95 p-0 shadow-2xl shadow-black/70 backdrop-blur-xl sm:max-w-xl"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">Paletă de comandă ⌘K</DialogTitle>
        <DialogDescription className="sr-only">
          Caută titluri în catalog, navighează rapid între secțiunile platformei sau rulează acțiuni.
        </DialogDescription>
        <Command shouldFilter={false} className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-bold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.14em] [&_[cmdk-group-heading]]:text-zinc-500">
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder="Caută titluri, navighează, rulează o acțiune…"
            className="text-base"
          />
          <CommandList className="custom-scrollbar max-h-[60vh]">
        <CommandEmpty>
          {suggestLoading ? 'Caut în catalog…' : 'Nimic găsit — Enter caută în tot catalogul.'}
        </CommandEmpty>

        {/* Conținut live (motorul protejat prin searchux, debounce 150ms) */}
        {trimmedQuery.length >= 2 && (
          <CommandGroup
            heading={
              <span className="flex items-center gap-1.5">
                <Sparkles className="h-3 w-3 text-rose-400" aria-hidden /> Conținut
                {visibleSuggest?.engine ? (
                  <span className="ml-1 text-[10px] font-normal text-zinc-500">
                    {visibleSuggest.took != null
                      ? ` · ${visibleSuggest.cache === 'hit' ? 'instant (cache)' : `${visibleSuggest.took}ms`} · ${visibleSuggest.engine}`
                      : ` · ${visibleSuggest.engine}`}
                  </span>
                ) : null}
              </span>
            }
          >
            {suggestions.map((s) => (
              <CommandItem
                key={`content-${s.id}`}
                value={`content-${s.id}`}
                onSelect={() =>
                  /* Sugestiile AR10M nu se mapează garantat pe ruta legacy
                   * /content/:id — deschidem rezultatele căutării. */
                  s.catalog === 'ar10m' ? runSearch(s.title) : go(`/content/${s.id}`)
                }
                className="gap-3 py-2.5"
              >
                {s.catalog !== 'ar10m' && s.thumbnail ? (
                  <img
                    src={s.thumbnail}
                    alt=""
                    loading="lazy"
                    className="h-10 w-8 shrink-0 rounded object-cover"
                  />
                ) : (
                  <span className="grid h-10 w-8 shrink-0 place-items-center rounded bg-white/[0.06]">
                    <Search className="h-3.5 w-3.5 text-zinc-500" aria-hidden />
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-zinc-100">{s.title}</span>
                  {s.catalog === 'ar10m' ? (
                    <span className="text-[11px] text-zinc-500">{s.year != null ? String(s.year) : 'catalog fuzionat'}</span>
                  ) : (
                    s.rating != null && <span className="text-[11px] text-amber-300/80">★ {s.rating.toFixed(1)}</span>
                  )}
                </span>
                {s.catalog === 'ar10m' ? (
                  <span className="rounded-full border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-[9px] font-black uppercase tracking-wider text-rose-300">
                    AR10M
                  </span>
                ) : (
                  <TypeBadge type={s.type} />
                )}
              </CommandItem>
            ))}
            {suggestions.length === 0 && didYouMean.length > 0 && (
              <CommandItem
                value="dym-first"
                onSelect={() => runSearch(didYouMean[0].q)}
                className="gap-2 py-2.5"
              >
                <Search className="h-4 w-4 text-rose-400" aria-hidden />
                <span className="text-sm text-zinc-300">
                  Ați vrut <b className="text-rose-300">«{didYouMean[0].q}»</b>?
                </span>
                <ArrowRight className="ml-auto h-3.5 w-3.5 text-zinc-500" aria-hidden />
              </CommandItem>
            )}
            {/* Căutare completă — ultimul resort (merge pe pagina /search) */}
            <CommandItem
              value={`search-${trimmedQuery}`}
              onSelect={() => runSearch(trimmedQuery)}
              className="gap-2 py-2.5"
            >
              <Search className="h-4 w-4 text-zinc-400" aria-hidden />
              <span className="text-sm text-zinc-200">
                Caută <b>«{trimmedQuery}»</b> în tot catalogul
              </span>
              <CornerDownLeft className="ml-auto h-3.5 w-3.5 text-zinc-500" aria-hidden />
            </CommandItem>
          </CommandGroup>
        )}

        {/* Acțiuni rapide */}
        {recent.length > 0 && (
          <CommandGroup heading="Acțiuni rapide">
            <CommandItem value="action-repeat" onSelect={() => runSearch(recent[0])} className="gap-2">
              <History className="h-4 w-4 text-zinc-400" aria-hidden />
              <span className="text-sm text-zinc-200">
                Repetă ultima căutare: <b className="text-rose-300">{recent[0]}</b>
              </span>
            </CommandItem>
          </CommandGroup>
        )}

        {/* Căutări recente (localStorage partajat cu search-view) */}
        {recentMatches.length > 0 && (
          <CommandGroup heading="Căutări recente">
            {recentMatches.map((term) => (
              <CommandItem key={`recent-${term}`} value={`recent-${term}`} onSelect={() => runSearch(term)} className="gap-2">
                <History className="h-4 w-4 text-zinc-500" aria-hidden />
                <span className="truncate text-sm text-zinc-300">{term}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {/* Trending anonimizat (doar fără query — nu concura cu rezultatele) */}
        {trimmedQuery.length === 0 && trendingMatches.length > 0 && (
          <CommandGroup heading="Trending acum (anonimizat)">
            {trendingMatches.map((t) => (
              <CommandItem key={`trend-${t.q}`} value={`trend-${t.q}`} onSelect={() => runSearch(t.q)} className="gap-2">
                <TrendingUp className="h-4 w-4 text-rose-400" aria-hidden />
                <span className="truncate text-sm text-zinc-200">{t.q}</span>
                <span className="ml-auto text-[11px] text-zinc-500">{t.count}×</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {/* Navigare rapidă (MENU_GROUPS — sursă unică) */}
        {navMatches.length > 0 && (
          <>
            {(recentMatches.length > 0 || trendingMatches.length > 0) && <CommandSeparator className="bg-white/10" />}
            <CommandGroup heading="Navigare rapidă">
              {navMatches.slice(0, 14).map((item) => (
                <CommandItem key={item.id} value={`nav-${item.id}`} onSelect={() => go(item.href)} className="gap-2.5">
                  {item.emoji ? (
                    <span className="text-base leading-none" aria-hidden>
                      {item.emoji}
                    </span>
                  ) : (
                    <ArrowRight className="h-4 w-4 text-zinc-500" aria-hidden />
                  )}
                  <span className="truncate text-sm text-zinc-200">{item.label}</span>
                  <span className="ml-auto text-[10px] uppercase tracking-wider text-zinc-600">{item.group}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
          </CommandList>
          <div className="flex items-center justify-between border-t border-white/10 px-3 py-2 text-[11px] text-zinc-500">
            <span className="flex items-center gap-3">
              <span className="flex items-center gap-1">
                <kbd className="rounded border border-white/15 bg-white/5 px-1.5 py-0.5 font-mono text-[10px]">↑↓</kbd>
                navighează
              </span>
              <span className="flex items-center gap-1">
                <kbd className="rounded border border-white/15 bg-white/5 px-1.5 py-0.5 font-mono text-[10px]">↵</kbd>
                selectează
              </span>
              <span className="flex items-center gap-1">
                <kbd className="rounded border border-white/15 bg-white/5 px-1.5 py-0.5 font-mono text-[10px]">esc</kbd>
                închide
              </span>
            </span>
            <span className={cn('font-semibold', hasServerResults ? 'text-rose-400' : 'text-zinc-600')}>
              ⌘K · FAZA 33
            </span>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

/** Buton mic „⌘K" pentru navbar (declanșează paleta prin eveniment custom —
 *  zero prop-drilling: paleta ascultă evenimentul global). */
export function CommandKButton() {
  return (
    <button
      type="button"
      aria-label="Căutare rapidă (⌘K)"
      title="Căutare rapidă (⌘K)"
      onClick={() => window.dispatchEvent(new CustomEvent('animaxia:palette-open'))}
      className="hidden items-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-xs text-zinc-400 transition hover:border-rose-500/40 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60 md:inline-flex"
    >
      <Search className="h-3.5 w-3.5" aria-hidden />
      <span className="hidden lg:inline">Caută rapid</span>
      <kbd className="rounded border border-white/15 bg-white/5 px-1.5 py-0.5 font-mono text-[10px]">⌘K</kbd>
    </button>
  );
}
