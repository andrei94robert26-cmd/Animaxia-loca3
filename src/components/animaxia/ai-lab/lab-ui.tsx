'use client';

/**
 * ai-lab/lab-ui.tsx — FAZA 35 (PLAN 100X · WS5): atomi UI comuni pentru
 * cele 8 panouri AI Lab. Stilul urmează AI SUITE (FAZA 32): dark, card-uri
 * rounded-xl border-white/10, etichetare onestă a providerilor (z-ai real
 * vs determinist fallback). Zero culori albastru/indigo.
 */

import { useEffect, useRef, useState } from 'react';
import { Loader2, LogIn, Search, Star, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/animaxia/api';
import { navigate } from '@/lib/animaxia/router';
import type { AiLabItem } from '@/lib/animaxia/types';
import { BrandPlaceholder, TypeBadge } from '../states';
import { cn } from '@/lib/utils';

/* ------------------------- provider badge (onest) ------------------------- */

/** FAZA 35 — etichetare onestă: 'z-ai' = AI real, 'heuristic' = determinist
 *  (fallback). Orice alt provider primește un chip neutru cu numele brut. */
export function LabProviderBadge({ provider }: { provider: string }) {
  if (provider === 'z-ai') {
    return (
      <span
        title="Răspuns generat de modelul AI real (z-ai)"
        className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold text-emerald-300"
      >
        🤖 AI real
      </span>
    );
  }
  if (provider === 'heuristic' || provider === 'deterministic') {
    return (
      <span
        title="Răspuns determinist local (fallback) — nu un model AI"
        className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold text-amber-300"
      >
        ⚙️ determinist (fallback)
      </span>
    );
  }
  return (
    <span
      title={`Provider: ${provider}`}
      className="inline-flex items-center rounded-full border border-white/15 bg-white/5 px-2 py-0.5 font-mono text-[10px] font-bold text-zinc-300"
    >
      {provider}
    </span>
  );
}

/* ------------------------------ section card ------------------------------ */

export function LabCard({
  title,
  hint,
  action,
  children,
  className,
}: {
  title?: string;
  hint?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('min-w-0 rounded-xl border border-white/10 bg-white/[0.02] p-4', className)}>
      {title || action ? (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            {title ? (
              <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-500">{title}</p>
            ) : null}
            {hint ? <p className="mt-0.5 text-[11px] leading-tight text-zinc-500">{hint}</p> : null}
          </div>
          {action}
        </div>
      ) : null}
      {children}
    </div>
  );
}

/** Notă explicativă mică (ghidaj în panouri). */
export function LabNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-xl border border-white/10 bg-white/[0.02] px-3.5 py-2.5 text-[11px] leading-relaxed text-zinc-500">
      {children}
    </p>
  );
}

/* ------------------------------- AI narrative ------------------------------ */

/** Card de narațiune AI (recap, mood, note de curation). */
export function LabAiDigest({
  text,
  provider,
  label = 'Narațiune AI',
}: {
  text: string | null | undefined;
  provider?: string;
  label?: string;
}) {
  if (!text) return null;
  return (
    <div className="min-w-0 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.06] p-4">
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <span className="text-base leading-none" aria-hidden>
          ✨
        </span>
        <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-emerald-300/90">{label}</span>
        {provider ? <LabProviderBadge provider={provider} /> : null}
      </div>
      <p className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-200">{text}</p>
    </div>
  );
}

/* ----------------------------- panel skeleton ----------------------------- */

export function LabPanelSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-3" aria-busy="true">
      <Skeleton className="h-11 w-full rounded-xl" />
      <Skeleton className="h-28 rounded-xl" />
      {Array.from({ length: rows - 1 }).map((_, i) => (
        <Skeleton key={i} className="h-16 rounded-xl" />
      ))}
    </div>
  );
}

/* ------------------------------ login prompt ------------------------------ */

/** Prompt de conectare pentru capacitățile care necesită cont (recap, editor). */
export function LabLoginPrompt({
  title = 'Ai nevoie de un cont',
  message,
}: {
  title?: string;
  message: string;
}) {
  return (
    <div className="rounded-xl border border-amber-500/25 bg-amber-500/[0.06] p-4">
      <p className="text-sm font-bold text-amber-200">🔐 {title}</p>
      <p className="mt-1 text-xs leading-relaxed text-zinc-400">{message}</p>
      <Button
        onClick={() => navigate('/auth')}
        className="mt-3 h-11 bg-rose-600 text-sm font-bold hover:bg-rose-500"
      >
        <LogIn className="mr-1.5 h-4 w-4" aria-hidden />
        Conectează-te
      </Button>
    </div>
  );
}

/* --------------------------- compact poster card --------------------------- */

/** Card compact de item AI (mood/editor): poster, titlu, an, rating, genuri.
 *  Link intern către #/content/:id (id = DB content id). */
export function LabItemCard({ item }: { item: AiLabItem }) {
  const [imgError, setImgError] = useState(false);
  const showImage = Boolean(item.posterPath) && !imgError;
  return (
    <button
      type="button"
      onClick={() => navigate(`/content/${item.id}`)}
      className="group block min-w-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0a10]"
      aria-label={`Deschide ${item.title}`}
    >
      <div className="relative aspect-[2/3] w-full overflow-hidden rounded-xl border border-white/10 bg-white/[0.03] transition-colors duration-300 group-hover:border-rose-500/40">
        {showImage ? (
          <img
            src={item.posterPath as string}
            alt={item.title}
            loading="lazy"
            decoding="async"
            onError={() => setImgError(true)}
            className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
          />
        ) : (
          <BrandPlaceholder title={item.title} />
        )}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/80 via-black/10 to-transparent opacity-90" />
        <div className="absolute left-1.5 top-1.5">
          <TypeBadge type={item.type} />
        </div>
        {item.rating != null ? (
          <span className="absolute right-1.5 top-1.5 inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-black/60 px-1.5 py-0.5 text-[10px] font-bold text-amber-300 backdrop-blur-sm">
            <Star className="h-2.5 w-2.5 fill-amber-300" aria-hidden />
            {Number(item.rating).toFixed(1)}
          </span>
        ) : null}
        <div className="absolute inset-x-0 bottom-0 p-2">
          <p className="line-clamp-2 text-xs font-semibold leading-tight text-white drop-shadow">{item.title}</p>
          <p className="mt-0.5 text-[10px] text-zinc-400">{item.year ?? '—'}</p>
        </div>
      </div>
      {item.genres.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {item.genres.slice(0, 2).map((g) => (
            <span
              key={g}
              className="truncate rounded-full border border-white/10 bg-white/[0.03] px-1.5 py-0.5 text-[9px] font-medium text-zinc-400"
            >
              {g}
            </span>
          ))}
        </div>
      ) : null}
    </button>
  );
}

/** Grilă responsive de itemi AI (min-w-0 pe copii — fără overflow la 390px). */
export function LabItemGrid({ items, empty }: { items: AiLabItem[]; empty?: string }) {
  if (items.length === 0) {
    return <p className="rounded-xl border border-white/10 bg-white/[0.02] px-4 py-6 text-center text-sm text-zinc-500">{empty ?? 'Niciun item găsit.'}</p>;
  }
  return (
    <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-4 md:grid-cols-6">
      {items.map((it) => (
        <div key={it.id} className="min-w-0">
          <LabItemCard item={it} />
        </div>
      ))}
    </div>
  );
}

/* ----------------------------- content picker ----------------------------- */

export interface PickedContent {
  id: number;
  title: string;
  type: string;
  thumbnail: string | null;
  rating: number | null;
}

/** Combobox de căutare titlu cu debounce 300ms pe /api/search/autocomplete
 *  (reutilizat de companion / recap / curation / shield). `types` filtrează
 *  client-side sugestiile (ex. doar tv+anime pentru recap). */
export function ContentPicker({
  label,
  placeholder = 'Caută un titlu…',
  types,
  picked,
  onPick,
  onClear,
}: {
  label: string;
  placeholder?: string;
  types?: string[];
  picked: PickedContent | null;
  onPick: (c: PickedContent) => void;
  onClear: () => void;
}) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState<PickedContent[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* Ref pentru filtrul de tipuri (evită re-rulare pe schimbarea identității). */
  const typesRef = useRef(types);
  useEffect(() => {
    typesRef.current = types;
  });

  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) {
      setItems([]);
      setOpen(false);
      setError(null);
      return undefined;
    }
    const t = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        let s: PickedContent[] = [];
        try {
          /* Calea principală: autocomplete instant (pipeline protejat FAZA 18). */
          const r = await api.searchAutocomplete(query);
          s = r.suggestions.map((x) => ({
            id: x.id,
            title: x.title,
            type: x.type,
            thumbnail: x.thumbnail,
            rating: x.rating,
          }));
        } catch {
          /* Fallback onest: căutare directă în bibliotecă (/api/all). */
          const a = await api.all({ search: query, limit: 8 });
          s = a.data.map((c) => ({
            id: c.id,
            title: c.title,
            type: c.type,
            thumbnail: c.thumbnail,
            rating: typeof c.metadata?.rating === 'number' ? c.metadata.rating : null,
          }));
        }
        const wanted = typesRef.current;
        if (wanted && wanted.length > 0) s = s.filter((x) => wanted.includes(x.type));
        setItems(s);
        setOpen(true);
        if (s.length === 0) setError(null);
      } catch {
        setError('Căutarea a eșuat — reîncearcă.');
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  const pick = (c: PickedContent) => {
    onPick(c);
    setQ('');
    setItems([]);
    setOpen(false);
  };

  return (
    <div className="min-w-0">
      <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-500" htmlFor={`picker-${label}`}>
        {label}
      </label>
      {picked ? (
        <div className="flex items-center gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/[0.06] p-2.5">
          {picked.thumbnail ? (
            <img
              src={picked.thumbnail}
              alt=""
              loading="lazy"
              className="h-11 w-8 shrink-0 rounded-md border border-white/10 object-cover"
            />
          ) : (
            <span className="grid h-11 w-8 shrink-0 place-items-center rounded-md border border-white/10 bg-white/5 text-base" aria-hidden>
              🎬
            </span>
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-bold text-zinc-100">{picked.title}</p>
            <p className="text-[11px] text-zinc-500">
              #{picked.id} · {picked.type}
              {picked.rating != null ? ` · ⭐ ${Number(picked.rating).toFixed(1)}` : ''}
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => {
              onClear();
              setQ('');
              setItems([]);
            }}
            className="h-11 w-11 shrink-0 text-zinc-400 hover:bg-white/10 hover:text-white"
            aria-label="Deselectează titlul"
          >
            <X className="h-4 w-4" aria-hidden />
          </Button>
        </div>
      ) : (
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" aria-hidden />
          <Input
            id={`picker-${label}`}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={placeholder}
            autoComplete="off"
            className="h-11 pl-9"
            aria-autocomplete="list"
          />
          {loading ? (
            <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-zinc-500" aria-hidden />
          ) : null}
          {open && items.length > 0 ? (
            <>
              <button
                type="button"
                aria-hidden
                tabIndex={-1}
                className="fixed inset-0 z-10 cursor-default"
                onClick={() => setOpen(false)}
              />
              <ul
                role="listbox"
                aria-label="Rezultate căutare titlu"
                className="custom-scrollbar absolute z-20 mt-1 max-h-72 w-full overflow-y-auto rounded-xl border border-white/15 bg-[#12121a] p-1 shadow-2xl shadow-black/60"
              >
                {items.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={false}
                      onClick={() => pick(c)}
                      className="flex min-h-11 w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition hover:bg-white/10 focus-visible:bg-white/10 focus-visible:outline-none"
                    >
                      {c.thumbnail ? (
                        <img
                          src={c.thumbnail}
                          alt=""
                          loading="lazy"
                          className="h-10 w-7 shrink-0 rounded border border-white/10 object-cover"
                        />
                      ) : (
                        <span className="grid h-10 w-7 shrink-0 place-items-center rounded border border-white/10 bg-white/5 text-sm" aria-hidden>
                          🎬
                        </span>
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-zinc-100">{c.title}</span>
                        <span className="block text-[10px] text-zinc-500">
                          #{c.id} · {c.type}
                        </span>
                      </span>
                      {c.rating != null ? (
                        <Badge className="shrink-0 border-amber-500/30 bg-amber-500/10 text-[10px] text-amber-300">
                          ⭐ {Number(c.rating).toFixed(1)}
                        </Badge>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {!loading && !open && q.trim().length >= 2 && error ? (
            <p className="mt-1 text-[11px] text-rose-300">{error}</p>
          ) : null}
          {!loading && !open && q.trim().length >= 2 && !error && items.length === 0 ? (
            <p className="mt-1 text-[11px] text-zinc-500">Niciun titlu găsit.</p>
          ) : null}
        </div>
      )}
    </div>
  );
}
