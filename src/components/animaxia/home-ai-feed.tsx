'use client';

/**
 * home-ai-feed.tsx — "AI Flux Infinit" section (FAZA 15 centerpiece).
 *
 * The AI engine (/api/ai/home/feed) serves numbered pages of exactly 20
 * posters: the Neon library first, then interleaved live TMDB + Jikan feeds.
 * This section keeps per-page boundaries in the DOM (data-ai-feed-page) so
 * the numbered page bar can smooth-scroll to any page, loads the next page
 * automatically via IntersectionObserver while "Scroll infinit" is ON, and
 * exposes the four AI Home toggles bound to the settings context.
 *
 * FAZA 17 — DOM guard for the infinite feed: every loaded page stays in state
 * (numbering, chips and jumps keep working), but only the pages around
 * `current` plus the last two loaded pages are actually rendered (≈8+2 pages
 * ≈ 200 posters in the DOM at any moment). Hidden contiguous groups collapse
 * into one height-preserving placeholder each, and a MAX_LOADED_PAGES memory
 * cap evicts the oldest pages from state when exceeded (with a discreet
 * notice) so hours of scrolling can never grow the DOM or the heap without
 * bound.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { api, feedToItem } from '@/lib/animaxia/api';
import type { AiFeedItem } from '@/lib/animaxia/types';
import { useAiHomeSettings } from './ai-home-settings';
import { ContentGrid } from './content-grid';
import { Section } from './section';
import { ErrorState, LoadingCards } from './states';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 20;
/** Max pages fetched at once when jumping to a far page chip. */
const CHIP_LOAD_CAP = 5;

/* ------------------------- FAZA 17 — DOM guard ------------------------- */

/** Rendered window around `current`: [current - 4, current + 3]. */
const WINDOW_BACK = 4;
const WINDOW_FWD = 3;
/** The last N loaded pages always stay rendered (sentinel anchor). */
const TAIL_RENDER = 2;
/** Memory cap: max pages kept in state (200 × 20 = 4000 items). */
const MAX_LOADED_PAGES = 200;
/** Approximate rendered height of one 20-poster grid page. */
const PAGE_APPROX_HEIGHT_PX = 880;

interface AiFeedPage {
  n: number;
  items: AiFeedItem[];
  sourceMode: string;
}

/** Compact page window (1 … n) with ellipsis — same idea as pagination.tsx. */
function pageWindow(current: number, total: number): (number | '…')[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages = new Set<number>([1, total, current, current - 1, current + 1]);
  const sorted = [...pages].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b);
  const out: (number | '…')[] = [];
  let prev = 0;
  for (const p of sorted) {
    if (p - prev > 1) out.push('…');
    out.push(p);
    prev = p;
  }
  return out;
}

/** Placeholder for a contiguous group of loaded-but-hidden pages: keeps
 *  approximately the group's real height so the scrollbar never jumps, and
 *  offers quick jump chips (1 / middle / last) into the scroll-to-page flow. */
function PageWindowPlaceholder({ from, to, onJump }: { from: number; to: number; onJump: (n: number) => void }) {
  const count = to - from + 1;
  const mid = Math.round((from + to) / 2);
  const targets = [...new Set([1, mid, to])].sort((a, b) => a - b);
  return (
    <div
      aria-label={`Paginile ${from}–${to} sunt încărcate`}
      className="flex min-h-[880px] flex-col items-center justify-center gap-4 rounded-2xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-10 text-center"
      style={{ minHeight: `${count * PAGE_APPROX_HEIGHT_PX}px` }}
    >
      <p className="text-sm text-zinc-400">
        Paginile <span className="font-bold text-zinc-200">{from}–{to}</span> sunt încărcate · derulează sau sari la o
        pagină
      </p>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {targets.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => onJump(t)}
            aria-label={`Sari la pagina ${t}`}
            className="h-9 min-w-9 rounded-lg border border-white/10 bg-white/5 px-2.5 text-sm font-semibold text-zinc-300 transition hover:border-rose-500/40 hover:bg-rose-500/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60"
          >
            {t}
          </button>
        ))}
      </div>
      <p className="text-[11px] text-zinc-600">
        {count} pagini · {(count * PAGE_SIZE).toLocaleString('ro-RO')} postere păstrate în memorie — se randează când
        ajungi la ele
      </p>
    </div>
  );
}

const SOURCE_MODES: Record<string, { label: string; className: string }> = {
  library: { label: 'Bibliotecă Neon', className: 'border-zinc-500/30 bg-zinc-500/10 text-zinc-300' },
  'library+external': { label: 'Bibliotecă + extern', className: 'border-fuchsia-500/30 bg-fuchsia-500/10 text-fuchsia-300' },
  external: { label: 'Extern live', className: 'border-rose-500/30 bg-rose-500/10 text-rose-300' },
};

function SourceModeBadge({ mode }: { mode: string }) {
  const m = SOURCE_MODES[mode] ?? SOURCE_MODES.library;
  return (
    <span className={cn('rounded-full border px-2 py-0.5 text-[10px] font-semibold', m.className)}>{m.label}</span>
  );
}

function SettingSwitch({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <Label className="cursor-pointer select-none items-center gap-2.5">
      <Switch
        checked={checked}
        onCheckedChange={onChange}
        aria-label={label}
        className="data-[state=checked]:bg-rose-600"
      />
      <span className="text-sm font-medium text-zinc-300">{label}</span>
      <span
        className={cn(
          'text-[10px] font-bold uppercase tracking-wider',
          checked ? 'text-rose-400' : 'text-zinc-600',
        )}
      >
        {checked ? 'ON' : 'OFF'}
      </span>
    </Label>
  );
}

export function AiInfiniteFeedSection() {
  const { settings, setToggle } = useAiHomeSettings();

  const [pages, setPages] = useState<AiFeedPage[]>([]);
  const [current, setCurrent] = useState(1);
  const [loading, setLoading] = useState(true); // first page
  const [loadingMore, setLoadingMore] = useState(false); // appended pages
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState({ totalPages: 50, hasNextPage: true, totalItems: 1000 });
  /* FAZA 17 — shown once the memory cap has evicted old pages. */
  const [memoryTrimmed, setMemoryTrimmed] = useState(false);

  /* Refs mirroring state so the observer + async loops always read fresh data. */
  const pagesRef = useRef<AiFeedPage[]>([]);
  const metaRef = useRef(meta);
  const errorRef = useRef<string | null>(null);
  const loadingRef = useRef(false);
  useEffect(() => {
    pagesRef.current = pages;
  }, [pages]);
  useEffect(() => {
    metaRef.current = meta;
  }, [meta]);
  useEffect(() => {
    errorRef.current = error;
  }, [error]);

  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const sentinelRef = useRef<HTMLDivElement>(null);

  /** Smooth-scroll to a page wrapper; double rAF lets fresh pages commit first. */
  const scrollToPage = useCallback((n: number) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        pageRefs.current.get(n)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
  }, []);

  const fetchPage = useCallback(async (n: number): Promise<AiFeedPage | null> => {
    setError(null);
    try {
      const res = await api.aiHome.feed(n, PAGE_SIZE);
      setMeta({ totalPages: res.totalPages, hasNextPage: res.hasNextPage, totalItems: res.totalItems });
      return { n, items: res.items, sourceMode: res.sourceMode };
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Fluxul AI nu a putut fi încărcat.');
      return null;
    }
  }, []);

  /** Append a page while enforcing the MAX_LOADED_PAGES memory cap: the
   *  oldest pages (smallest n, never the fresh one) are evicted from state —
   *  they stay refetchable via the page chips — a discreet notice appears and
   *  `current` is clamped to the surviving range so nothing crashes. */
  const appendPage = useCallback((p: AiFeedPage) => {
    let next = [...pagesRef.current.filter((x) => x.n !== p.n), p].sort((a, b) => a.n - b.n);
    if (next.length > MAX_LOADED_PAGES) {
      let trimmed = false;
      while (next.length > MAX_LOADED_PAGES) {
        const idx = next.findIndex((pg) => pg.n !== p.n);
        if (idx < 0) break;
        next = next.filter((_, i) => i !== idx);
        trimmed = true;
      }
      if (trimmed) setMemoryTrimmed(true);
    }
    /* Keep the ref fresh immediately — rapid sequential appends (chip jumps)
       must never read a stale list. */
    pagesRef.current = next;
    setPages(next);
    const minN = next.length > 0 ? next[0].n : 1;
    const maxN = next.length > 0 ? next[next.length - 1].n : 1;
    setCurrent((c) => Math.min(Math.max(c, minN), maxN));
  }, []);

  /* First load — page 1 on mount (deferred, unmount-safe). */
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      loadingRef.current = true;
      void (async () => {
        if (!cancelled) setLoading(true);
        const p = await fetchPage(1);
        loadingRef.current = false;
        if (cancelled) return;
        if (p) {
          appendPage(p);
          setCurrent(1);
        }
        setLoading(false);
      })();
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [fetchPage, appendPage]);

  /** Load page lastLoaded+1. Returns the page number, or null when it couldn't. */
  const loadNext = useCallback(async (): Promise<number | null> => {
    if (loadingRef.current) return null;
    const last = pagesRef.current.length > 0 ? pagesRef.current[pagesRef.current.length - 1].n : 0;
    const next = last + 1;
    if (next > metaRef.current.totalPages || !metaRef.current.hasNextPage) return null;
    loadingRef.current = true;
    setLoadingMore(true);
    const p = await fetchPage(next);
    loadingRef.current = false;
    setLoadingMore(false);
    if (!p) return null;
    appendPage(p);
    setCurrent(next);
    return next;
  }, [fetchPage, appendPage]);

  /** Chip click: scroll when loaded; otherwise fetch missing pages (capped) then scroll. */
  const gotoPage = useCallback(
    async (target: number) => {
      if (loadingRef.current) return;
      const have = new Set(pagesRef.current.map((p) => p.n));
      if (have.has(target)) {
        setCurrent(target);
        scrollToPage(target);
        return;
      }
      const missing: number[] = [];
      for (let n = 1; n <= target; n += 1) {
        if (!have.has(n)) missing.push(n);
      }
      const batch = missing.slice(0, CHIP_LOAD_CAP);
      loadingRef.current = true;
      setLoadingMore(true);
      let lastLoaded = pagesRef.current.length > 0 ? pagesRef.current[pagesRef.current.length - 1].n : 0;
      for (const n of batch) {
        const p = await fetchPage(n);
        if (!p) break;
        appendPage(p);
        lastLoaded = n;
      }
      loadingRef.current = false;
      setLoadingMore(false);
      const destination = Math.min(target, lastLoaded);
      setCurrent(destination);
      scrollToPage(destination);
    },
    [fetchPage, appendPage, scrollToPage],
  );

  const retryFirst = useCallback(() => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    void (async () => {
      const p = await fetchPage(1);
      loadingRef.current = false;
      if (p) {
        appendPage(p);
        setCurrent(1);
      }
      setLoading(false);
    })();
  }, [fetchPage, appendPage]);

  /* Infinite scroll — the sentinel loads the next page while approaching view.
     The effect re-runs once the sentinel actually mounts (after page 1 lands). */
  const sentinelActive = settings.infiniteScroll && pages.length > 0;
  useEffect(() => {
    if (!sentinelActive) return undefined;
    const el = sentinelRef.current;
    if (!el) return undefined;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && !loadingRef.current && !errorRef.current) {
          void loadNext();
        }
      },
      { rootMargin: '600px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [sentinelActive, loadNext]);

  /* Normalize once per page. Within-page duplicates (the external stream can
     occasionally repeat an item inside one page) are dropped so React keys
     stay unique — cross-page repeats live in different grids and are left to
     the backend feed contract. */
  const normalizedPages = useMemo(
    () =>
      pages.map((p) => {
        const seen = new Set<string>();
        const items = p.items.map(feedToItem).filter((it) => {
          if (seen.has(it.key)) return false;
          seen.add(it.key);
          return true;
        });
        return { ...p, items };
      }),
    [pages],
  );
  const loadedItems = useMemo(() => pages.reduce((acc, p) => acc + p.items.length, 0), [pages]);
  const loadedSet = useMemo(() => new Set(pages.map((p) => p.n)), [pages]);

  /* FAZA 17 — which loaded pages are actually rendered: the window around
     `current` plus the last TAIL_RENDER loaded pages. Max 8 + 2 pages ≈ 200
     posters in the DOM at any time, no matter how many pages are loaded. */
  const maxLoadedN = pages.length > 0 ? pages[pages.length - 1].n : 0;
  const winStart = Math.max(1, current - WINDOW_BACK);
  const winEnd = Math.min(maxLoadedN, current + WINDOW_FWD);
  const visibleSet = useMemo(() => {
    const tail = pages.slice(-TAIL_RENDER).map((p) => p.n);
    return new Set(
      pages.filter((p) => (p.n >= winStart && p.n <= winEnd) || tail.includes(p.n)).map((p) => p.n),
    );
  }, [pages, winStart, winEnd]);

  /* Render plan: visible pages interleaved with one placeholder per
     contiguous group of hidden pages (height-preserving). */
  const renderedSegments = useMemo(() => {
    const segments: Array<
      { kind: 'page'; page: (typeof normalizedPages)[number] } | { kind: 'placeholder'; from: number; to: number }
    > = [];
    let runStart: number | null = null;
    let runEnd = 0;
    const flush = () => {
      if (runStart == null) return;
      segments.push({ kind: 'placeholder', from: runStart, to: runEnd });
      runStart = null;
    };
    for (const p of normalizedPages) {
      if (visibleSet.has(p.n)) {
        flush();
        segments.push({ kind: 'page', page: p });
      } else if (runStart == null || p.n !== runEnd + 1) {
        flush();
        runStart = p.n;
        runEnd = p.n;
      } else {
        runEnd = p.n;
      }
    }
    flush();
    return segments;
  }, [normalizedPages, visibleSet]);

  const onPrev = () => {
    const target = Math.max(1, current - 1);
    setCurrent(target);
    scrollToPage(target);
  };

  const onNext = async () => {
    if (current + 1 > meta.totalPages) return;
    if (loadedSet.has(current + 1)) {
      setCurrent(current + 1);
      scrollToPage(current + 1);
    } else {
      const loaded = await loadNext();
      if (loaded) scrollToPage(loaded);
    }
  };

  return (
    <Section
      title="🧠 AI Flux Infinit — 20 de postere pe pagină"
      subtitle="Pagini numerotate create automat · next / prev · scroll infinit activat de AI"
      action={
        <span className="hidden items-center gap-1.5 text-xs text-zinc-500 sm:flex">
          <span className="relative flex h-2 w-2" aria-hidden>
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-400 opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-rose-400" />
          </span>
          {meta.totalPages} pagini · {meta.totalItems.toLocaleString('ro-RO')} postere
        </span>
      }
    >
      <div className="space-y-5">
        {/* AI Home toggles */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl border border-white/10 bg-white/[0.03] p-4">
          <SettingSwitch
            label="Scroll infinit"
            checked={settings.infiniteScroll}
            onChange={(v) => setToggle('infiniteScroll', v)}
          />
          <SettingSwitch
            label="Cursor AI"
            checked={settings.aiCursor}
            onChange={(v) => setToggle('aiCursor', v)}
          />
          <SettingSwitch
            label="Trailere la hover"
            checked={settings.autoTrailers}
            onChange={(v) => setToggle('autoTrailers', v)}
          />
          <SettingSwitch
            label="Taxonomie auto"
            checked={settings.autoTaxonomy}
            onChange={(v) => setToggle('autoTaxonomy', v)}
          />
        </div>

        {loading && pages.length === 0 ? (
          <LoadingCards count={20} />
        ) : error && pages.length === 0 ? (
          <ErrorState message={error} onRetry={retryFirst} />
        ) : (
          <div className="space-y-6">
            {/* FAZA 17 — windowed rendering: one wrapper per *rendered* page
                (chips scroll straight to these via pageRefs) plus a compact
                height-preserving placeholder per contiguous group of hidden
                loaded pages. All pages stay in state either way. */}
            {renderedSegments.map((seg) =>
              seg.kind === 'placeholder' ? (
                <PageWindowPlaceholder
                  key={`ph-${seg.from}-${seg.to}`}
                  from={seg.from}
                  to={seg.to}
                  onJump={(n) => void gotoPage(n)}
                />
              ) : (
                <div
                  key={seg.page.n}
                  ref={(el) => {
                    if (el) pageRefs.current.set(seg.page.n, el);
                    else pageRefs.current.delete(seg.page.n);
                  }}
                  data-ai-feed-page={seg.page.n}
                  className="scroll-mt-24 space-y-3"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold uppercase tracking-[0.18em] text-zinc-500">
                      Pagina {seg.page.n}
                    </span>
                    <SourceModeBadge mode={seg.page.sourceMode} />
                    <span className="text-xs text-zinc-600">· {seg.page.items.length} postere</span>
                  </div>
                  <ContentGrid
                    items={seg.page.items}
                    emptyTitle="Pagină goală"
                    emptyMessage="AI nu a returnat postere pentru această pagină."
                  />
                </div>
              ),
            )}

            {/* Slim loading row for appended pages */}
            {loadingMore && (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-xs text-zinc-500">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-rose-400" aria-hidden />
                  AI încarcă pagina următoare de 20 de postere…
                </div>
                <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <Skeleton key={i} className="aspect-[2/3] w-full rounded-xl opacity-50" />
                  ))}
                </div>
              </div>
            )}

            {error && pages.length > 0 && <ErrorState compact message={error} onRetry={() => void loadNext()} />}

            {settings.infiniteScroll ? (
              <div ref={sentinelRef} className="h-4 w-full" aria-hidden />
            ) : (
              <div className="flex justify-center">
                <Button
                  variant="outline"
                  onClick={() => void loadNext()}
                  disabled={!meta.hasNextPage || loadingMore || loading}
                  className="h-10 border-white/15 bg-white/5 px-4 text-sm font-semibold text-zinc-200 hover:bg-white/10 hover:text-white"
                >
                  {loadingMore ? (
                    <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden />
                  ) : (
                    <ChevronRight className="mr-1.5 h-4 w-4" aria-hidden />
                  )}
                  Încarcă pagina următoare
                </Button>
              </div>
            )}

            {!meta.hasNextPage && pages.length > 0 && (
              <p className="text-center text-xs text-zinc-500">
                Ai ajuns la finalul fluxului AI — {loadedItems.toLocaleString('ro-RO')} postere încărcate.
              </p>
            )}
          </div>
        )}

        {/* Numbered page bar — always visible below the grid */}
        {pages.length > 0 && (
          <div className="flex flex-col gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2.5">
                <p className="text-sm text-zinc-400">
                  Pagina <span className="font-bold text-white">{current}</span> din {meta.totalPages} ·{' '}
                  {loadedItems.toLocaleString('ro-RO')} postere încărcate
                </p>
                {/* FAZA 17 — discreet notice once the memory cap kicked in. */}
                {memoryTrimmed && (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-0.5 text-[10px] font-semibold text-amber-300">
                    Memorie optimizată — paginile vechi au fost eliberate
                  </span>
                )}
              </div>
              <span className="text-xs text-zinc-600">
                {settings.infiniteScroll
                  ? 'scroll infinit activ — pagina următoare se încarcă singură'
                  : 'scroll infinit oprit — folosește butoanele'}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                variant="outline"
                size="sm"
                onClick={onPrev}
                disabled={current <= 1}
                className="h-9 border-white/10 bg-white/5 px-3 text-sm font-semibold hover:bg-white/10"
              >
                <ChevronLeft className="mr-1 h-4 w-4" aria-hidden /> Anterior
              </Button>
              {pageWindow(current, meta.totalPages).map((p, i) =>
                p === '…' ? (
                  <span key={`gap-${i}`} className="px-1 text-sm text-zinc-600" aria-hidden>
                    …
                  </span>
                ) : (
                  <button
                    key={p}
                    type="button"
                    onClick={() => void gotoPage(p)}
                    aria-label={`Pagina ${p}`}
                    aria-current={p === current ? 'page' : undefined}
                    className={cn(
                      'h-9 min-w-9 rounded-lg px-2 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60',
                      p === current
                        ? 'bg-rose-600 text-white'
                        : loadedSet.has(p)
                          ? 'border border-rose-500/30 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20'
                          : 'border border-white/10 bg-white/5 text-zinc-300 hover:bg-white/10 hover:text-white',
                    )}
                  >
                    {p}
                  </button>
                ),
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => void onNext()}
                disabled={current >= meta.totalPages || loadingMore}
                className="h-9 border-white/10 bg-white/5 px-3 text-sm font-semibold hover:bg-white/10"
              >
                Următor <ChevronRight className="ml-1 h-4 w-4" aria-hidden />
              </Button>
            </div>
          </div>
        )}
      </div>
    </Section>
  );
}
