'use client';

/**
 * ai-suite/panels-intelligence.tsx — FAZA 32: panouri pentru motoarele de
 * inteligență — AI Recommendation Engine (complet, explicabil), AI Franchise
 * Engine (complet), AI Taxonomy Generator, AI Infinite Scroll Engine (scroll
 * infinit REAL cu IntersectionObserver + cursor server-side).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Play } from 'lucide-react';
import { api } from '@/lib/animaxia/api';
import { useApi } from '@/lib/animaxia/hooks';
import { navigate } from '@/lib/animaxia/router';
import type {
  AiSuiteFranchiseData,
  AiSuiteInfiniteFeedResponse,
  AiSuiteRecommendationsData,
  AiSuiteTaxonomyData,
} from '@/lib/animaxia/types';
import { ErrorState, TypeBadge } from '../states';
import {
  AiDigest,
  CountBar,
  KeyValueRow,
  NoteStrip,
  PanelSkeleton,
  ProviderChip,
  StatCard,
} from './suite-ui';

/* ------------------------ AI Recommendation Engine --------------------------- */

export function RecommendationsPanel() {
  const res = useApi('ai-suite-recommendations', () => api.aiSuiteRecommendations(12));
  if (res.loading) return <PanelSkeleton />;
  if (res.error) return <ErrorState message={res.error} onRetry={() => void res.refetch()} />;
  const d = res.data as AiSuiteRecommendationsData;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Recomandări" value={d.recommendations.length} />
        <StatCard label="Personalizat" value={d.personalized ? 'Da' : 'Global'} hint={d.personalized ? 'din istoricul tău' : 'conectează-te pentru personalizare'} tone={d.personalized ? 'good' : 'default'} />
        <StatCard label="Semnale active" value={`${d.signals.filter((s) => s.active).length}/${d.signals.length}`} />
        <StatCard label="Trend acum" value={d.trendingNow.length} hint="top vizionări 7 zile" />
      </div>

      {d.affinity ? (
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
          <p className="mb-3 text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-500">
            Afinitate detectată (ultimele {d.affinity.fromHistory} titluri urmărite)
          </p>
          <div className="space-y-2.5">
            {d.affinity.topGenres.map((g) => (
              <CountBar key={g.genre} label={g.genre} count={g.n} max={Math.max(...d.affinity!.topGenres.map((x) => x.n), 1)} />
            ))}
          </div>
        </div>
      ) : null}

      <div className="rounded-xl border border-rose-500/25 bg-rose-500/[0.05] p-4">
        <p className="mb-3 text-[10px] font-bold uppercase tracking-[0.16em] text-rose-300/90">🎯 Recomandări explicabile</p>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {d.recommendations.map((r) => (
            <button
              key={r.contentId}
              type="button"
              onClick={() => navigate(`/content/${r.contentId}`)}
              className="group rounded-lg border border-white/10 bg-black/20 p-3 text-left transition hover:border-rose-500/40 hover:bg-rose-500/[0.08]"
            >
              <div className="flex items-center gap-2">
                <p className="min-w-0 flex-1 truncate text-sm font-bold text-zinc-100">{r.title}</p>
                <TypeBadge type={r.type} />
              </div>
              <p className="mt-0.5 text-[11px] text-zinc-500">⭐ {r.rating} · scor AI {r.score} · {r.genres.join(', ')}</p>
              <p className="mt-1.5 text-[11px] leading-snug text-rose-300/80">{r.reason}</p>
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
        <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-500">Semnalele motorului</p>
        {d.signals.map((s) => (
          <KeyValueRow key={s.signal} k={`${s.active ? '🟢' : '⚪'} ${s.signal}`} v={`pondere ${s.weight}`} />
        ))}
      </div>
      <NoteStrip>{d.note}</NoteStrip>
      <ProviderChip provider={d.provider} />
    </div>
  );
}

/* --------------------------- AI Franchise Engine ----------------------------- */

export function FranchisePanel() {
  const res = useApi('ai-suite-franchise', () => api.aiSuiteFranchise());
  if (res.loading) return <PanelSkeleton />;
  if (res.error) return <ErrorState message={res.error} onRetry={() => void res.refetch()} />;
  const d = res.data as AiSuiteFranchiseData;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Francize detectate" value={d.total} />
        <StatCard label="Cea mai mare" value={d.franchises[0]?.size ?? 0} hint={d.franchises[0]?.name ?? '—'} />
        <StatCard label="Scor AI maxim" value={d.franchises[0]?.aiScore ?? 0} />
        <StatCard label="Provider" value="FAZA 14 + AI" hint="hub protejat, doar consumat" />
      </div>

      <AiDigest text={d.aiNarrative} provider={d.aiProvider} />

      <div className="grid gap-3 lg:grid-cols-2">
        {d.franchises.map((f) => (
          <div key={f.name} className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
            <div className="flex items-baseline justify-between gap-2">
              <p className="truncate text-sm font-black text-zinc-100">{f.name}</p>
              <span className="shrink-0 rounded-full border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 font-mono text-[10px] font-bold text-rose-300">
                scor {f.aiScore}
              </span>
            </div>
            <p className="mt-0.5 text-[11px] text-zinc-500">
              {f.size} titluri · ⭐ {f.avgRating ?? '—'} · {f.firstYear ?? '?'}–{f.lastYear ?? '?'}
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {f.items.map((it, i) => (
                <span key={i} className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] text-zinc-400">
                  {it.title} {it.year ? `(${it.year})` : ''}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
      <NoteStrip>{d.note}</NoteStrip>
      <ProviderChip provider={d.provider} />
    </div>
  );
}

/* --------------------------- AI Taxonomy Generator --------------------------- */

export function TaxonomyPanel() {
  const res = useApi('ai-suite-taxonomy', () => api.aiSuiteTaxonomy());
  if (res.loading) return <PanelSkeleton />;
  if (res.error) return <ErrorState message={res.error} onRetry={() => void res.refetch()} />;
  const d = res.data as AiSuiteTaxonomyData;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Eșantion" value={d.sampleSize} hint="titluri analizate" />
        <StatCard label="Genuri distincte" value={d.topGenres.length} />
        <StatCard label="Clustere co-recurente" value={d.clusters.length} />
        <StatCard label="Categorii propuse" value={d.proposals.length} tone="good" />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
          <p className="mb-3 text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-500">Top genuri</p>
          <div className="space-y-2.5">
            {d.topGenres.map((g) => (
              <CountBar key={g.genre} label={g.genre} count={g.n} max={Math.max(...d.topGenres.map((x) => x.n), 1)} />
            ))}
          </div>
        </div>
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
          <p className="mb-3 text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-500">Clustere de genuri co-recurente</p>
          <div className="space-y-1">
            {d.clusters.map((c) => (
              <KeyValueRow key={c.pair} k={c.pair} v={`${c.support} titluri · forță ${c.strength}%`} mono />
            ))}
            {d.clusters.length === 0 ? <p className="py-2 text-center text-xs text-zinc-500">Fără co-recurențe semnificative în eșantion.</p> : null}
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-rose-500/25 bg-rose-500/[0.05] p-4">
        <p className="mb-3 text-[10px] font-bold uppercase tracking-[0.16em] text-rose-300/90">🌳 Categorii noi propuse</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {d.proposals.map((p) => (
            <div key={p.name} className="rounded-lg border border-white/10 bg-black/20 p-3">
              <div className="flex items-baseline justify-between gap-2">
                <p className="truncate text-sm font-bold text-zinc-100">{p.aiName || p.name}</p>
                {p.aiName ? <span className="shrink-0 font-mono text-[9px] font-bold text-rose-300/70">z-ai</span> : null}
              </div>
              <p className="mt-0.5 text-[11px] text-zinc-500">{p.rationale}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
        <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-500">Cuvinte-cheie din titluri</p>
        <div className="flex flex-wrap gap-1.5">
          {d.keywords.map((k) => (
            <span key={k.word} className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] text-zinc-400">
              {k.word} <span className="font-mono font-bold text-zinc-500">{k.occurrences}</span>
            </span>
          ))}
        </div>
      </div>
      <NoteStrip>{d.note}</NoteStrip>
      <ProviderChip provider={d.provider} />
    </div>
  );
}

/* ------------------------ AI Infinite Scroll Engine -------------------------- */

export function InfinitePanel() {
  const seed = useMemo(() => `suite-${Math.random().toString(36).slice(2, 8)}`, []);
  const [items, setItems] = useState<AiSuiteInfiniteFeedResponse['items']>([]);
  const [cursor, setCursor] = useState(0);
  const [nextCursor, setNextCursor] = useState<number | null>(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadingRef = useRef(false);

  const loadPage = useCallback(
    async (page: number) => {
      if (loadingRef.current) return;
      loadingRef.current = true;
      setLoading(true);
      try {
        const r = await api.aiSuiteInfiniteFeed(page, seed);
        setItems((prev) => (page === 0 ? r.items : [...prev, ...r.items]));
        setCursor(r.cursor);
        setNextCursor(r.nextCursor);
        setTotal(r.total);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Feed-ul a eșuat');
      } finally {
        loadingRef.current = false;
        setLoading(false);
      }
    },
    [seed],
  );

  useEffect(() => {
    void loadPage(0);
  }, [loadPage]);

  /* Real infinite scroll — IntersectionObserver pe sentinel. */
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && nextCursor !== null && !loadingRef.current) {
          void loadPage(nextCursor);
        }
      },
      { rootMargin: '600px 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [nextCursor, loadPage]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Încărcate" value={items.length} />
        <StatCard label="Total catalog" value={total.toLocaleString('ro-RO')} />
        <StatCard label="Pagini (cursor)" value={cursor + 1} hint={`seed ${seed}`} />
        <StatCard label="Sfârșit" value={nextCursor === null ? 'Atins' : 'Mai sunt'} tone={nextCursor === null ? 'default' : 'good'} />
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
        {items.map((it) => (
          <button
            key={`${it.contentId}-${it.aiScore}`}
            type="button"
            onClick={() => navigate(`/content/${it.contentId}`)}
            className="group overflow-hidden rounded-xl border border-white/10 bg-black/30 text-left transition hover:border-rose-500/40"
          >
            <div className="relative aspect-[2/3] w-full overflow-hidden bg-zinc-900">
              {it.thumbnail ? (
                <img src={it.thumbnail} alt={it.title} className="h-full w-full object-cover transition group-hover:scale-105" loading="lazy" />
              ) : (
                <div className="grid h-full w-full place-items-center text-2xl" aria-hidden>🎞️</div>
              )}
              <span className="absolute left-1.5 top-1.5 rounded-full bg-black/70 px-1.5 py-0.5 font-mono text-[9px] font-bold text-rose-300 backdrop-blur">
                {it.aiScore}
              </span>
            </div>
            <div className="p-2">
              <p className="truncate text-[11px] font-bold text-zinc-100">{it.title}</p>
              <p className="truncate text-[10px] text-zinc-500">⭐ {it.rating || '—'} · {it.genres[0] ?? it.type}</p>
            </div>
          </button>
        ))}
      </div>

      <div ref={sentinelRef} aria-hidden className="h-4" />

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-4 text-sm text-zinc-400">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Rankare AI și încărcare…
        </div>
      ) : null}
      {error ? <ErrorState message={error} onRetry={() => void loadPage(nextCursor ?? 0)} /> : null}
      {nextCursor === null && !loading ? (
        <p className="py-4 text-center text-sm text-zinc-500">
          ♾️ Ai ajuns la capăt — {items.length} din {total.toLocaleString('ro-RO')} titluri rankate AI.
        </p>
      ) : null}
      <NoteStrip>
        Feed rankat AI: scor = rating × 6 + vizionări 7 zile (max 20 × 1.5) + bonus poster + jitter determinist per seed.
        Cursor stabil server-side — poți da scroll la tot catalogul.
      </NoteStrip>
    </div>
  );
}
