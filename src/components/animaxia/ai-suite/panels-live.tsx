'use client';

/**
 * ai-suite/panels-live.tsx — FAZA 32: panouri pentru motoarele live — AI News
 * Hub, AI Social Hub, AI Watch Party, AI Trend Analyzer, AI External Feed
 * Engine. Date reale: RSS extern + tabelele social/viewevents/watchparties.
 */

import { useState } from 'react';
import { ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/animaxia/api';
import { useApi } from '@/lib/animaxia/hooks';
import type {
  AiSuiteFeedsData,
  AiSuiteNewsData,
  AiSuiteSocialData,
  AiSuiteTrendsData,
  AiSuiteWatchPartyData,
} from '@/lib/animaxia/types';
import { ErrorState } from '../states';
import {
  AiDigest,
  CountBar,
  KeyValueRow,
  NoteStrip,
  PanelSkeleton,
  ProviderChip,
  StatCard,
} from './suite-ui';

/* -------------------------------- AI News Hub -------------------------------- */

export function NewsPanel() {
  const [busy, setBusy] = useState(false);
  const res = useApi('ai-suite-news', () => api.aiSuiteNews());
  const refresh = async () => {
    setBusy(true);
    try {
      await api.aiSuiteNewsRefresh();
      await res.refetch();
      toast.success('Știri re-încărcate', { description: 'Surse RSS externe + clasificare AI re-rulată.' });
    } catch {
      toast.error('Reîncărcarea a eșuat');
    } finally {
      setBusy(false);
    }
  };
  if (res.loading) return <PanelSkeleton />;
  if (res.error) return <ErrorState message={res.error} onRetry={() => void res.refetch()} />;
  const d = res.data as AiSuiteNewsData;
  const maxCat = Math.max(...d.byCategory.map((c) => c.n), 1);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Știri în flux" value={d.total} />
        <StatCard label="Surse active" value={`${d.sources.filter((s) => s.ok).length}/${d.sources.length}`} tone={d.sources.every((s) => s.ok) ? 'good' : 'warn'} />
        <StatCard label="Categorii AI" value={d.byCategory.length} hint="clasificare automată" />
        <div className="flex items-center justify-end sm:col-span-1">
          <Button size="sm" variant="outline" onClick={refresh} disabled={busy} className="h-9 border-white/15 bg-white/5 text-xs">
            {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden />}
            Reîncarcă
          </Button>
        </div>
      </div>

      <AiDigest text={d.aiDigest} provider={d.aiProvider} />

      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
        <p className="mb-3 text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-500">Pe categorii</p>
        <div className="space-y-2.5">
          {d.byCategory.map((c) => (
            <CountBar key={c.category} label={c.category} count={c.n} max={maxCat} />
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {d.sources.map((s) => (
            <span
              key={s.source}
              className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${s.ok ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-rose-500/30 bg-rose-500/10 text-rose-300'}`}
              title={s.error ?? `${s.items ?? 0} articole`}
            >
              {s.source} {s.ok ? '✓' : '✗'}
            </span>
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
        <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-500">Flux știri</p>
        <div className="max-h-96 space-y-1 overflow-y-auto pr-1">
          {d.items.map((it, i) => (
            <a
              key={`${it.title}-${i}`}
              href={it.link ?? '#'}
              target="_blank"
              rel="noreferrer noopener"
              className="group flex items-start gap-3 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2 transition hover:border-rose-500/30 hover:bg-rose-500/[0.04]"
            >
              <span className="mt-0.5 shrink-0 rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] font-bold text-zinc-400">
                {it.source}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-zinc-100 group-hover:text-white">{it.title}</span>
                <span className="block text-[11px] text-zinc-500">{it.category}</span>
              </span>
              <ExternalLink className="mt-1 h-3.5 w-3.5 shrink-0 text-zinc-600 group-hover:text-rose-400" aria-hidden />
            </a>
          ))}
        </div>
      </div>
      <ProviderChip provider={d.provider} />
    </div>
  );
}

/* ------------------------------- AI Social Hub ------------------------------- */

export function SocialPanel() {
  const res = useApi('ai-suite-social', () => api.aiSuiteSocial());
  if (res.loading) return <PanelSkeleton />;
  if (res.error) return <ErrorState message={res.error} onRetry={() => void res.refetch()} />;
  const d = res.data as AiSuiteSocialData;
  const totalSent = Math.max(d.commentSentiment.pozitiv + d.commentSentiment.neutru + d.commentSentiment.negativ, 1);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Comentarii" value={d.totals.comments.toLocaleString('ro-RO')} />
        <StatCard label="Review-uri" value={d.totals.reviews.toLocaleString('ro-RO')} />
        <StatCard label="Urmăriri" value={d.totals.follows.toLocaleString('ro-RO')} hint={`+${d.totals.newFollows7d} în 7 zile`} />
        <StatCard label="Activitate 7 zile" value={d.totals.activity7d.toLocaleString('ro-RO')} />
      </div>

      <AiDigest text={d.aiDigest} provider={d.aiProvider} />

      <div className="grid gap-3 lg:grid-cols-2">
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
          <p className="mb-3 text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-500">Sentiment comentarii (euristic RO/EN)</p>
          <div className="space-y-2.5">
            <CountBar label="😊 pozitiv" count={d.commentSentiment.pozitiv} max={totalSent} right={`${Math.round((d.commentSentiment.pozitiv / totalSent) * 100)}%`} />
            <CountBar label="😐 neutru" count={d.commentSentiment.neutru} max={totalSent} right={`${Math.round((d.commentSentiment.neutru / totalSent) * 100)}%`} />
            <CountBar label="🙁 negativ" count={d.commentSentiment.negativ} max={totalSent} right={`${Math.round((d.commentSentiment.negativ / totalSent) * 100)}%`} />
          </div>
        </div>
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
          <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-500">Cel mai discutat conținut</p>
          {d.topCommented.length ? (
            d.topCommented.map((t) => <KeyValueRow key={t.contentid} k={t.title} v={`${t.n} comentarii`} />)
          ) : (
            <p className="py-3 text-center text-xs text-zinc-500">Încă niciun comentariu.</p>
          )}
          {d.topReviewed.length ? (
            <>
              <p className="mb-2 mt-4 text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-500">Cel mai review-uit</p>
              {d.topReviewed.map((t) => (
                <KeyValueRow key={t.contentid} k={t.title} v={`${t.n} · ⭐ ${t.avgrating}`} />
              ))}
            </>
          ) : null}
        </div>
      </div>

      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
        <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-500">Comentarii recente</p>
        <div className="max-h-72 space-y-1 overflow-y-auto pr-1">
          {d.recentComments.length ? (
            d.recentComments.map((c) => (
              <div key={c.id} className="border-b border-white/5 py-2 last:border-0">
                <p className="text-sm text-zinc-200">{c.body}</p>
                <p className="mt-0.5 text-[11px] text-zinc-500">pe {c.title} · {new Date(c.createdat).toLocaleString('ro-RO')}</p>
              </div>
            ))
          ) : (
            <p className="py-3 text-center text-xs text-zinc-500">Fără comentarii încă.</p>
          )}
        </div>
      </div>
      <ProviderChip provider={d.provider} />
    </div>
  );
}

/* ------------------------------ AI Watch Party ------------------------------- */

export function WatchPartyPanel() {
  const res = useApi('ai-suite-watchparty', () => api.aiSuiteWatchParty());
  if (res.loading) return <PanelSkeleton />;
  if (res.error) return <ErrorState message={res.error} onRetry={() => void res.refetch()} />;
  const d = res.data as AiSuiteWatchPartyData;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Party-uri totale" value={d.totals.parties} />
        <StatCard label="Active acum" value={d.totals.active} tone={d.totals.active > 0 ? 'good' : 'default'} />
        <StatCard label="Membri" value={d.totals.members} hint={`${d.totals.uniqueUsers} utilizatori distinși`} />
        <StatCard label="Mesaje" value={d.totals.messages.toLocaleString('ro-RO')} />
      </div>

      <div className="rounded-xl border border-rose-500/25 bg-rose-500/[0.05] p-4">
        <p className="mb-3 text-[10px] font-bold uppercase tracking-[0.16em] text-rose-300/90">🍿 Alegeri AI pentru grupul tău</p>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {d.aiPicks.map((p) => (
            <div key={p.contentId} className="rounded-lg border border-white/10 bg-black/20 p-3">
              <p className="truncate text-sm font-bold text-zinc-100">{p.title}</p>
              <p className="mt-0.5 text-[11px] text-zinc-500">{p.type} · ⭐ {p.rating ?? '—'} · {p.genres.join(', ')}</p>
              <p className="mt-1.5 text-[11px] leading-snug text-rose-300/80">{p.reason}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
          <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-500">Party-uri active</p>
          {d.activeParties.length ? (
            d.activeParties.map((p) => <KeyValueRow key={p.id} k={`${p.title} (cod ${p.code})`} v={`${p.n} membri`} />)
          ) : (
            <p className="py-3 text-center text-xs text-zinc-500">Niciun party activ — creează unul în secțiunea Social.</p>
          )}
        </div>
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
          <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-500">Cel mai vizionat în party</p>
          {d.topWatchedInParty.length ? (
            d.topWatchedInParty.map((t) => <KeyValueRow key={t.contentid} k={t.title} v={`${t.n} party-uri`} />)
          ) : (
            <p className="py-3 text-center text-xs text-zinc-500">Încă fără istoric de party.</p>
          )}
        </div>
      </div>
      <NoteStrip>{d.note}</NoteStrip>
      <ProviderChip provider={d.provider} />
    </div>
  );
}

/* ----------------------------- AI Trend Analyzer ------------------------------ */

export function TrendsPanel() {
  const res = useApi('ai-suite-trends', () => api.aiSuiteTrends());
  if (res.loading) return <PanelSkeleton />;
  if (res.error) return <ErrorState message={res.error} onRetry={() => void res.refetch()} />;
  const d = res.data as AiSuiteTrendsData;
  const momentum = d.watchMomentum.prev7 > 0 ? Math.round(((d.watchMomentum.last7 - d.watchMomentum.prev7) / d.watchMomentum.prev7) * 100) : d.watchMomentum.last7 > 0 ? 100 : 0;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Vizionări 7 zile" value={d.topContent.reduce((a, t) => a + t.views, 0)} />
        <StatCard label="Momentum watch" value={`${momentum >= 0 ? '+' : ''}${momentum}%`} tone={momentum >= 0 ? 'good' : 'bad'} hint={`${d.watchMomentum.last7} vs ${d.watchMomentum.prev7} (7z vs 7z)`} />
        <StatCard label="Genuri active" value={d.genresThisWeek.length} />
        <StatCard label="Titluri în creștere" value={d.rising.length} tone="good" />
      </div>

      <AiDigest text={d.aiNarrative} provider={d.aiProvider} />

      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
        <p className="mb-3 text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-500">Genuri săptămâna aceasta</p>
        <div className="space-y-2.5">
          {d.genresThisWeek.map((g) => (
            <CountBar key={g.genre} label={g.genre} count={g.n} max={Math.max(...d.genresThisWeek.map((x) => x.n), 1)} />
          ))}
          {d.genresThisWeek.length === 0 ? <p className="py-2 text-center text-xs text-zinc-500">Feriștea de viewevents e încă mică.</p> : null}
        </div>
      </div>

      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
        <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-500">Titluri în creștere (7z vs 7z)</p>
        <div className="space-y-1">
          {d.rising.map((r) => (
            <KeyValueRow key={r.id} k={r.title} v={<span className={r.delta >= 0 ? 'text-emerald-300' : 'text-rose-300'}>{r.delta >= 0 ? '▲' : '▼'} {Math.abs(r.delta)}% · {r.now} viz</span>} />
          ))}
          {d.rising.length === 0 ? <p className="py-2 text-center text-xs text-zinc-500">Încă fără trenduri — trafic în acumulare.</p> : null}
        </div>
      </div>
      <ProviderChip provider={d.provider} />
    </div>
  );
}

/* --------------------------- AI External Feed Engine -------------------------- */

export function FeedsPanel() {
  const [fetching, setFetching] = useState<string | null>(null);
  const [fetched, setFetched] = useState<{ name: string; items: Array<{ title: string; category: string }> } | null>(null);
  const res = useApi('ai-suite-feeds', () => api.aiSuiteFeeds());
  const fetchOne = async (feedId: string, name: string) => {
    setFetching(feedId);
    try {
      const r = await api.aiSuiteFeedsFetch(feedId);
      if (r.ok && r.items) {
        setFetched({ name, items: r.items });
        toast.success(`${name} încărcat`, { description: `${r.classified} articole clasificate AI.` });
      } else {
        toast.error(`Feed-ul ${name} a eșuat`, { description: r.error ?? 'eroare necunoscută' });
      }
    } catch {
      toast.error(`Feed-ul ${name} a eșuat`);
    } finally {
      setFetching(null);
    }
  };
  if (res.loading) return <PanelSkeleton />;
  if (res.error) return <ErrorState message={res.error} onRetry={() => void res.refetch()} />;
  const d = res.data as AiSuiteFeedsData;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Feed-uri în catalog" value={d.catalog.length} />
        <StatCard label="Sănătoase" value={`${d.healthy}/${d.catalog.length}`} tone={d.healthy === d.catalog.length ? 'good' : 'warn'} />
        <StatCard label="Categorii" value={new Set(d.catalog.map((c) => c.category)).size} hint="general/entertainment/anime" />
        <StatCard label="Fetch real" value="la cerere" hint="circuit-breaker activ" />
      </div>

      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
        <p className="mb-3 text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-500">Catalog feed-uri externe</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {d.catalog.map((f) => {
            const check = d.checks.find((c) => c.id === f.id);
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => void fetchOne(f.id, f.name)}
                disabled={fetching !== null}
                className="group flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2.5 text-left transition hover:border-rose-500/30 hover:bg-rose-500/[0.04] disabled:opacity-60"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold text-zinc-100">{f.name}</span>
                  <span className="block text-[11px] text-zinc-500">
                    {f.category} · {check?.ok ? `✓ ${check.items ?? 0} articole` : `✗ ${check?.error?.slice(0, 40) ?? 'indisponibil'}`}
                  </span>
                </span>
                {fetching === f.id ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-rose-400" aria-hidden />
                ) : (
                  <span className="shrink-0 rounded-full bg-rose-600/90 px-2.5 py-1 text-[10px] font-bold text-white opacity-0 transition group-hover:opacity-100">
                    Fetch
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {fetched ? (
        <div className="rounded-xl border border-rose-500/25 bg-rose-500/[0.05] p-4">
          <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.16em] text-rose-300/90">{fetched.name} — clasificare AI</p>
          <div className="max-h-72 space-y-1 overflow-y-auto pr-1">
            {fetched.items.map((it, i) => (
              <div key={i} className="flex items-center gap-3 border-b border-white/5 py-1.5 last:border-0">
                <span className="min-w-0 flex-1 truncate text-sm text-zinc-200">{it.title}</span>
                <span className="shrink-0 rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] font-bold text-zinc-400">{it.category}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      <NoteStrip>{d.note}</NoteStrip>
      <ProviderChip provider={d.provider} />
    </div>
  );
}
