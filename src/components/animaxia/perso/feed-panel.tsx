'use client';

/**
 * perso/feed-panel.tsx — FAZA 36-R (WS6): feed-ul „Pentru Tine" — carduri cu
 * reason badge pe grilă responsivă, „De ce?" (explain) în dialog, încărcare
 * la montare + Refresh manual (NEON FREE PLAN — zero auto-refresh).
 */

import { useState } from 'react';
import { Loader2, Play, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { api, ApiError } from '@/lib/animaxia/api';
import { useApi } from '@/lib/animaxia/hooks';
import { navigate } from '@/lib/animaxia/router';
import type { PersoExplainResponse, PersoFeedItem, PersoFeedResponse } from '@/lib/animaxia/types';
import { useAuth } from '../auth-provider';
import { BrandPlaceholder, RatingBadge, TypeBadge } from '../states';
import {
  PersoCard, PersoHonestNote, PersoLoading, PersoLoginPrompt, PersoMethodBadge,
  PersoReasonBadge, PersoRefreshButton, PERSO_SECTION_META,
} from './perso-ui';
import { cn } from '@/lib/utils';

/* ------------------------------- explain dialog ---------------------------- */

function ExplainDialog({
  contentId,
  open,
  onOpenChange,
  userId,
}: {
  contentId: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: number | undefined;
}) {
  const [res, setRes] = useState<PersoExplainResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (id: number) => {
    setLoading(true);
    setError(null);
    setRes(null);
    try {
      setRes(await api.persoExplain(id, userId));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Explicația a eșuat');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (next && contentId != null) void load(contentId);
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto border-white/10 bg-zinc-950 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base text-white">
            <span aria-hidden>🎯</span> De ce îți recomandăm {res?.title ? `„${res.title}"` : 'acest titlu'}?
          </DialogTitle>
          <DialogDescription className="text-xs text-zinc-500">
            Explicație onestă, calculată din profilul tău de gust și metadata catalogului.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <PersoLoading label="Calculăm liniile de reasoning…" />
        ) : error ? (
          <p role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
            {error}
          </p>
        ) : res ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={cn(
                  'rounded-full border px-2.5 py-1 text-xs font-black',
                  res.recommended
                    ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
                    : 'border-zinc-600/40 bg-zinc-700/20 text-zinc-300',
                )}
              >
                scor {res.score}/100 · {res.recommended ? 'recomandat pentru tine' : 'deocamdată nepotrivit profilului'}
              </span>
              <PersoMethodBadge method={res.method} />
            </div>

            {res.reasons.length > 0 ? (
              <ul className="space-y-2">
                {res.reasons.map((r, i) => (
                  <li key={`${r.key}-${i}`} className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
                    <div className="flex items-baseline justify-between gap-2">
                      <p className="text-sm font-bold text-zinc-100">{r.label}</p>
                      <span className="shrink-0 text-[11px] font-bold text-rose-300">+{r.points} p</span>
                    </div>
                    <p className="mt-0.5 text-xs leading-relaxed text-zinc-500">{r.detail}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-zinc-500">Nicio linie de reasoning — profilul tău nu acoperă acest titlu.</p>
            )}

            {res.note ? <PersoHonestNote>{res.note}</PersoHonestNote> : null}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/* --------------------------------- feed card -------------------------------- */

function FeedCard({
  item,
  onExplain,
}: {
  item: PersoFeedItem;
  onExplain: (contentId: number) => void;
}) {
  return (
    <article className="group flex flex-col overflow-hidden rounded-xl border border-white/10 bg-white/[0.03] transition hover:border-white/25 hover:bg-white/[0.05]">
      <button
        type="button"
        onClick={() => navigate(`/content/${item.contentId}`)}
        className="relative block aspect-[2/3] w-full overflow-hidden text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60"
        aria-label={`Deschide ${item.title}`}
      >
        {item.thumbnail ? (
          <img
            src={item.thumbnail}
            alt={`Poster ${item.title}`}
            loading="lazy"
            className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
          />
        ) : (
          <div className="grid h-full w-full place-items-center bg-zinc-900">
            <BrandPlaceholder title={item.title} />
          </div>
        )}
        <div className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/85 to-transparent p-2 pt-6">
          <TypeBadge type={item.type} />
          {item.rating != null ? <RatingBadge value={item.rating} /> : null}
        </div>
        {item.progressPct != null ? (
          <div
            className="absolute inset-x-0 bottom-0 h-1 bg-black/50"
            role="progressbar"
            aria-valuenow={item.progressPct}
            aria-label={`Progres ${item.title}`}
          >
            <div className="h-full bg-rose-500" style={{ width: `${item.progressPct}%` }} />
          </div>
        ) : null}
      </button>

      <div className="flex min-w-0 flex-1 flex-col gap-1.5 p-2.5">
        <p className="line-clamp-1 text-sm font-bold text-zinc-100" title={item.title}>
          {item.title}
        </p>
        <p className="text-[11px] text-zinc-600">
          {item.year ?? '—'}
          {item.genres.length > 0 ? ` · ${item.genres.slice(0, 2).join(', ')}` : ''}
        </p>
        <div className="mt-auto flex flex-wrap items-center gap-1.5">
          <PersoReasonBadge reason={item.reason} section={item.section} />
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            size="sm"
            onClick={() => navigate(`/content/${item.contentId}`)}
            className="h-8 flex-1 bg-rose-600 text-xs font-bold hover:bg-rose-500"
          >
            <Play className="mr-1 h-3 w-3 fill-white" aria-hidden />
            Deschide
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => onExplain(item.contentId)}
            className="h-8 border-white/15 bg-white/5 px-2.5 text-xs font-semibold text-zinc-300 hover:bg-white/10 hover:text-white"
            aria-label={`De ce e recomandat ${item.title}`}
          >
            De ce?
          </Button>
        </div>
      </div>
    </article>
  );
}

/* --------------------------------- the panel -------------------------------- */

export function FeedPanel() {
  const { user } = useAuth();
  const feedRes = useApi(
    `perso-feed-${user?.id ?? 'anon'}`,
    () => api.persoFeed(user?.id, 24),
    { enabled: Boolean(user) },
  );
  const [explainId, setExplainId] = useState<number | null>(null);
  const [explainOpen, setExplainOpen] = useState(false);

  if (!user) return <PersoLoginPrompt />;

  const openExplain = (contentId: number) => {
    setExplainId(contentId);
    setExplainOpen(true);
  };

  if (feedRes.loading && !feedRes.data) {
    return (
      <div className="space-y-4" aria-busy="true">
        <Skeleton className="h-9 w-72 rounded-lg" />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
          {Array.from({ length: 12 }).map((_, i) => (
            <Skeleton key={i} className="aspect-[2/3] rounded-xl" />
          ))}
        </div>
      </div>
    );
  }
  if (feedRes.error) {
    const needLogin = feedRes.error.toLowerCase().includes('autentificare');
    if (needLogin) return <PersoLoginPrompt />;
    return (
      <div role="alert" className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
        Feed-ul „Pentru Tine" nu a putut fi încărcat: {feedRes.error}
        <div className="mt-2">
          <PersoRefreshButton onClick={() => void feedRes.refetch()} loading={feedRes.loading} label="Reîncearcă" />
        </div>
      </div>
    );
  }

  const feed: PersoFeedResponse | null = feedRes.data;
  const items = feed?.items ?? [];
  const sections = (feed?.sections ?? []).filter((s) => s.count > 0);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <PersoMethodBadge method={feed?.method} />
          {feed ? (
            <span className="text-[11px] text-zinc-600">
              {items.length} titluri · {feed.profileSummary.signals} semnale reale
            </span>
          ) : null}
        </div>
        <PersoRefreshButton onClick={() => void feedRes.refetch()} loading={feedRes.loading} />
      </div>

      {feed?.note ? <PersoHonestNote>{feed.note}</PersoHonestNote> : null}

      {items.length === 0 ? (
        <PersoCard>
          <div className="py-8 text-center">
            <span className="text-3xl" aria-hidden>🍿</span>
            <p className="mt-2 text-sm font-bold text-zinc-200">Feed-ul tău e gol — onest.</p>
            <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-zinc-500">
              Vizionează, apreciază sau notează titluri și secțiunile „Continuă să urmărești", „Pentru că ai
              văzut…" și „Genuri favorite" se construiesc singure din semnalele tale reale.
            </p>
            <Button onClick={() => navigate('/home')} className="mt-4 h-10 bg-rose-600 text-sm font-bold hover:bg-rose-500">
              <Sparkles className="mr-1.5 h-4 w-4" aria-hidden />
              Descoperă titluri
            </Button>
          </div>
        </PersoCard>
      ) : (
        sections.map((section) => {
          const meta = PERSO_SECTION_META[section.key] ?? PERSO_SECTION_META.genre;
          const sectionItems = items.filter((i) => i.section === section.key);
          return (
            <section key={section.key} aria-label={section.label}>
              <div className="mb-2.5 flex flex-wrap items-center gap-2">
                <h3 className="flex items-center gap-1.5 text-sm font-black text-zinc-100">
                  <span aria-hidden>{meta.emoji}</span>
                  {section.key === 'similar' && feed?.anchorTitle
                    ? `Pentru că ai văzut „${feed.anchorTitle}"`
                    : section.label}
                </h3>
                <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] font-bold text-zinc-400">
                  {section.count}
                </span>
              </div>
              <div className="custom-scrollbar -mx-1 flex snap-x gap-3 overflow-x-auto px-1 pb-2 lg:mx-0 lg:grid lg:grid-cols-4 lg:overflow-visible lg:px-0 xl:grid-cols-6">
                {sectionItems.map((item) => (
                  <div key={item.contentId} className="w-36 shrink-0 snap-start lg:w-auto">
                    <FeedCard item={item} onExplain={openExplain} />
                  </div>
                ))}
              </div>
            </section>
          );
        })
      )}

      {feedRes.loading && feedRes.data ? (
        <p className="flex items-center gap-2 text-xs text-zinc-500">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Reîmprospătăm feed-ul…
        </p>
      ) : null}

      <ExplainDialog
        contentId={explainId}
        open={explainOpen}
        onOpenChange={setExplainOpen}
        userId={user?.id}
      />
    </div>
  );
}
