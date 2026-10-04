'use client';

/**
 * franchise-hub-view.tsx — REAL franchise & trilogy hubs (sidebar menus
 * "🎬 Francize" and "🎞️ Trilogii"). Data comes from /api/franchises and
 * /api/trilogies: curated TMDB collections resolved at runtime, each with
 * its actual parts (clickable → external movie detail), average rating and
 * year span. Card CTA opens the existing franchise detail view
 * (#/franchise?q=…) which layers the Neon library + live Jikan/TMDB rows.
 */

import { ArrowRight, Clapperboard, Film, Star } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { api, mediaToItem } from '@/lib/animaxia/api';
import { useApi } from '@/lib/animaxia/hooks';
import { franchiseChips, navigate, targetForItem } from '@/lib/animaxia/router';
import type { FranchiseCollection } from '@/lib/animaxia/types';
import { cn } from '@/lib/utils';
import { Container, PageHeader } from '../section';
import { ErrorState } from '../states';

const HUB_META = {
  franchises: {
    title: 'Francize',
    subtitle:
      'Cele mai mari saga din cinema — date reale din colecțiile TMDB, cu toate filmele în ordine cronologică.',
    chip: 'TMDB Collections · live',
  },
  trilogies: {
    title: 'Trilogii',
    subtitle:
      'Trilogii legendare — trei filme, o poveste completă. Plus saga-uri care au depășit trilogia.',
    chip: 'TMDB Collections · live',
  },
} as const;

function openPart(part: FranchiseCollection['parts'][number]) {
  const target = targetForItem(
    mediaToItem({
      id: part.id,
      title: part.title,
      image: part.image ?? undefined,
      overview: part.overview || undefined,
      rating: part.rating ?? undefined,
      year: part.year ?? undefined,
      mediaType: 'movie',
      source: part.source,
    }),
  );
  if (target) navigate(target.href);
}

function CollectionCard({ collection }: { collection: FranchiseCollection }) {
  const isTrilogy = collection.partCount === 3;
  return (
    <article className="group overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02] transition-colors hover:border-white/25">
      {/* Banner */}
      <button
        onClick={() => navigate(`/franchise?q=${encodeURIComponent(collection.name.replace(' Collection', ''))}`)}
        className="relative block h-36 w-full overflow-hidden"
        aria-label={`Deschide ${collection.name}`}
      >
        {collection.backdrop ? (
          <img
            src={collection.backdrop}
            alt=""
            className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
            loading="lazy"
          />
        ) : collection.poster ? (
          <img src={collection.poster} alt="" className="h-full w-full object-cover opacity-70" loading="lazy" />
        ) : (
          <div className="h-full w-full bg-gradient-to-br from-rose-600/25 via-fuchsia-600/15 to-transparent" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-[#0a0a10] via-[#0a0a10]/60 to-transparent" />
        <div className="absolute bottom-3 left-4 right-4 flex items-end justify-between gap-2">
          <div className="min-w-0 text-left">
            <h3 className="truncate text-lg font-black text-white drop-shadow">
              {collection.name.replace(' Collection', '')}
            </h3>
            <p className="text-xs font-medium text-zinc-400">
              {collection.years?.first && collection.years?.last
                ? `${collection.years.first}–${collection.years.last}`
                : collection.years?.first ?? ''}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <span
              className={cn(
                'rounded-full border px-2.5 py-1 text-[11px] font-bold',
                isTrilogy
                  ? 'border-fuchsia-500/40 bg-fuchsia-600/20 text-fuchsia-200'
                  : 'border-amber-500/40 bg-amber-600/15 text-amber-200',
              )}
            >
              <Film className="mr-1 inline h-3 w-3" aria-hidden />
              {collection.partCount} {collection.partCount === 1 ? 'film' : 'filme'}
            </span>
            {collection.avgRating != null && (
              <span className="flex items-center gap-1 rounded-full border border-white/15 bg-black/50 px-2.5 py-1 text-[11px] font-bold text-amber-200">
                <Star className="h-3 w-3 fill-amber-300 text-amber-300" aria-hidden />
                {collection.avgRating}
              </span>
            )}
          </div>
        </div>
      </button>

      {/* Parts strip — every part is a real, clickable TMDB movie */}
      <div className="space-y-3 p-4">
        {collection.overview && (
          <p className="line-clamp-2 text-xs leading-relaxed text-zinc-500">{collection.overview}</p>
        )}
        <div className="flex gap-2 overflow-x-auto pb-1 no-scrollbar">
          {collection.parts.map((part) => (
            <button
              key={`${collection.id}-${part.id}`}
              onClick={() => openPart(part)}
              className="group/part w-24 shrink-0 text-left"
              aria-label={`Deschide ${part.title}`}
            >
              <div className="aspect-[2/3] w-full overflow-hidden rounded-lg border border-white/10 bg-white/5 transition-colors group-hover/part:border-rose-500/50">
                {part.image ? (
                  <img
                    src={part.image}
                    alt={part.title}
                    className="h-full w-full object-cover"
                    loading="lazy"
                  />
                ) : (
                  <div className="grid h-full place-items-center">
                    <Film className="h-5 w-5 text-zinc-600" aria-hidden />
                  </div>
                )}
              </div>
              <p className="mt-1.5 truncate text-[11px] font-semibold text-zinc-300 group-hover/part:text-rose-300">
                {part.title}
              </p>
              <p className="text-[10px] text-zinc-600">{part.year ?? ''}</p>
            </button>
          ))}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => navigate(`/franchise?q=${encodeURIComponent(collection.name.replace(' Collection', ''))}`)}
          className="w-full border-white/15 bg-transparent text-xs font-bold text-zinc-300 hover:border-rose-500/50 hover:bg-rose-600/10 hover:text-rose-200"
        >
          Explorează universul
          <ArrowRight className="ml-1.5 h-3.5 w-3.5" aria-hidden />
        </Button>
      </div>
    </article>
  );
}

export function FranchiseHubView({ variant }: { variant: 'franchises' | 'trilogies' }) {
  const meta = HUB_META[variant];
  const res = useApi(
    `hub-${variant}`,
    () => (variant === 'franchises' ? api.franchises() : api.trilogies()),
    {},
  );

  const collections = res.data?.data ?? [];
  const trilogies = collections.filter((c) => c.partCount === 3);
  const sagas = collections.filter((c) => c.partCount !== 3);

  return (
    <Container className="space-y-8 py-8 sm:py-10">
      <PageHeader title={meta.title} subtitle={meta.subtitle}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full border border-rose-500/30 bg-rose-600/10 px-3 py-1 text-xs font-bold text-rose-200">
            {meta.chip}
          </span>
          {res.data && (
            <span className="text-sm font-medium text-zinc-500">
              {res.data.total} colecții · {collections.reduce((sum, c) => sum + c.partCount, 0)} filme
            </span>
          )}
        </div>
      </PageHeader>

      {res.error && !res.loading && !res.data ? (
        <ErrorState message={res.error} onRetry={res.refetch} />
      ) : res.loading ? (
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="overflow-hidden rounded-2xl border border-white/10">
              <Skeleton className="h-36 rounded-none bg-white/5" />
              <div className="space-y-3 p-4">
                <Skeleton className="h-4 w-2/3 bg-white/5" />
                <Skeleton className="h-24 bg-white/5" />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <>
          {variant === 'trilogies' && trilogies.length > 0 && (
            <section className="space-y-4">
              <h2 className="flex items-center gap-2 text-lg font-black text-white">
                <Clapperboard className="h-5 w-5 text-fuchsia-400" aria-hidden />
                Trilogii adevărate
                <span className="text-sm font-medium text-zinc-500">· exact 3 filme</span>
              </h2>
              <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
                {trilogies.map((c) => (
                  <CollectionCard key={c.id} collection={c} />
                ))}
              </div>
            </section>
          )}

          {variant === 'trilogies' && sagas.length > 0 && (
            <section className="space-y-4">
              <h2 className="flex items-center gap-2 text-lg font-black text-white">
                <Film className="h-5 w-5 text-amber-400" aria-hidden />
                Dincolo de trilogie
                <span className="text-sm font-medium text-zinc-500">· saga-uri mai mari</span>
              </h2>
              <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
                {sagas.map((c) => (
                  <CollectionCard key={c.id} collection={c} />
                ))}
              </div>
            </section>
          )}

          {variant === 'franchises' && (
            <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
              {collections.map((c) => (
                <CollectionCard key={c.id} collection={c} />
              ))}
            </div>
          )}

          {/* Quick access to the anime universes (live Jikan + TMDB detail view) */}
          <section className="space-y-3 rounded-2xl border border-white/10 bg-white/[0.02] p-5">
            <h2 className="text-sm font-bold uppercase tracking-widest text-zinc-500">
              Universuri anime & cinema — căutare rapidă
            </h2>
            <div className="flex flex-wrap gap-2">
              {franchiseChips.map((chip) => (
                <button
                  key={chip}
                  onClick={() => navigate(`/franchise?q=${encodeURIComponent(chip)}`)}
                  className="rounded-full border border-white/10 bg-white/[0.03] px-3.5 py-1.5 text-xs font-semibold text-zinc-300 transition-colors hover:border-fuchsia-500/50 hover:bg-fuchsia-600/10 hover:text-fuchsia-200"
                >
                  {chip}
                </button>
              ))}
            </div>
          </section>

          {res.data && res.data.failed.length > 0 && (
            <p className="text-xs text-zinc-600">
              Colecții negăsite momentan pe TMDB: {res.data.failed.join(', ')}.
            </p>
          )}
        </>
      )}
    </Container>
  );
}
