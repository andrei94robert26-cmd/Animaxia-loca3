'use client';

/**
 * franchise-view.tsx — Without a query: a grid of franchise shortcut cards.
 * With ?q=: a franchise hub combining library, anime and TMDB results.
 */

import { useMemo } from 'react';
import { Bookmark } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api, animeToItem, dbToItem, mediaToItem } from '@/lib/animaxia/api';
import { useApi } from '@/lib/animaxia/hooks';
import { franchiseChips, navigate, type AppRoute } from '@/lib/animaxia/router';
import { ContentGrid } from '../content-grid';
import { ContentRow } from '../content-row';
import { Container, PageHeader, Section } from '../section';
import { EmptyState, ErrorState } from '../states';

export function FranchiseView({ route }: { route: AppRoute }) {
  const q = route.query.get('q')?.trim() || '';
  if (!q) return <FranchiseIndex />;
  return <FranchiseDetail q={q} />;
}

/* ------------------------------ index state ------------------------------ */

function FranchiseIndex() {
  return (
    <Container className="space-y-6 py-8 sm:py-10">
      <PageHeader
        title="Francize"
        subtitle="Intră într-un univers îndrăgit — răsfoiește tot ce știe Animaxia despre saga-urile tale preferate."
      />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4">
        {franchiseChips.map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => navigate(`/franchise?q=${encodeURIComponent(name)}`)}
            aria-label={`Deschide franciza ${name}`}
            className="group flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-4 text-left transition hover:border-rose-500/40 hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60"
          >
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-rose-500/20 bg-gradient-to-br from-rose-500/25 to-fuchsia-600/15 text-rose-300">
              <Bookmark className="h-5 w-5" aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-semibold text-zinc-100 group-hover:text-white">{name}</span>
              <span className="mt-0.5 block text-xs text-zinc-500">Explorează franciza</span>
            </span>
          </button>
        ))}
      </div>
    </Container>
  );
}

/* ------------------------------ detail state ----------------------------- */

function FranchiseDetail({ q }: { q: string }) {
  const libRes = useApi(`fr-lib-${q}`, () => api.all({ search: q, limit: 24 }));
  const animeRes = useApi(`fr-anime-${q}`, () => api.animeSearch(q));
  const mediaRes = useApi(`fr-media-${q}`, () => api.moviesSearch(q));

  const libItems = useMemo(() => (libRes.data?.data ?? []).map(dbToItem), [libRes.data]);
  const animeItems = useMemo(() => (animeRes.data?.data ?? []).map(animeToItem), [animeRes.data]);
  const mediaItems = useMemo(() => (mediaRes.data?.data ?? []).map(mediaToItem), [mediaRes.data]);

  const allErrored = Boolean(libRes.error && animeRes.error && mediaRes.error);
  const allLoaded = !libRes.loading && !animeRes.loading && !mediaRes.loading;
  const allEmpty =
    allLoaded &&
    !libRes.error &&
    !animeRes.error &&
    !mediaRes.error &&
    libItems.length === 0 &&
    animeItems.length === 0 &&
    mediaItems.length === 0;
  const otherChips = franchiseChips.filter((c) => c.toLowerCase() !== q.toLowerCase()).slice(0, 8);

  const refetchAll = () => {
    void libRes.refetch();
    void animeRes.refetch();
    void mediaRes.refetch();
  };

  return (
    <Container className="space-y-10 py-8 sm:py-10">
      {/* Franchise hero panel */}
      <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-r from-fuchsia-600/15 via-rose-600/10 to-transparent p-6 sm:p-8">
        <p className="text-xs font-bold uppercase tracking-[0.25em] text-rose-300">Franciză</p>
        <h1 className="mt-2 text-3xl font-black tracking-tight text-white sm:text-4xl">{q}</h1>
        <p className="mt-2 text-sm text-zinc-400">Tot ce știe Animaxia despre această franciză</p>
        <div className="mt-5 flex flex-wrap gap-2">
          {otherChips.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => navigate(`/franchise?q=${encodeURIComponent(name)}`)}
              className="rounded-full border border-white/10 bg-white/[0.05] px-3.5 py-1.5 text-xs font-medium text-zinc-300 transition hover:border-rose-500/50 hover:text-rose-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60"
            >
              {name}
            </button>
          ))}
        </div>
      </div>

      {allErrored ? (
        <ErrorState
          message="Biblioteca ta, furnizorul de anime și TMDB sunt momentan inaccesibile."
          onRetry={refetchAll}
        />
      ) : allEmpty ? (
        <EmptyState
          title={`Niciun rezultat pentru „${q}”`}
          message="Nimic nu a corespuns acestei francize în biblioteca ta, clasamentele de anime sau TMDB."
          action={
            <Button
              onClick={() => navigate(`/search?q=${encodeURIComponent(q)}`)}
              className="bg-rose-600 font-bold text-white hover:bg-rose-500"
            >
              Caută altceva
            </Button>
          }
        />
      ) : (
        <>
          {libRes.error ? (
            <ErrorState message={libRes.error} onRetry={libRes.refetch} compact />
          ) : libItems.length > 0 || libRes.loading ? (
            <Section title="În biblioteca ta" subtitle="Titlurile salvate care corespund acestei francize">
              <ContentGrid
                items={libItems}
                loading={libRes.loading}
                skeletonCount={6}
                emptyTitle="Încă nu e în biblioteca ta"
                emptyMessage="Adaugă titluri din orice pagină de detalii pentru a-ți construi colecția."
              />
            </Section>
          ) : null}

          {animeRes.error ? (
            <ErrorState message={animeRes.error} onRetry={animeRes.refetch} compact />
          ) : (
            <ContentRow
              title="Anime"
              subtitle="Rezultate din MyAnimeList"
              items={animeItems}
              loading={animeRes.loading}
              emptyMessage="Niciun anime găsit pentru această franciză."
            />
          )}

          {mediaRes.error ? (
            <ErrorState message={mediaRes.error} onRetry={mediaRes.refetch} compact />
          ) : (
            <Section title="Filme & TV" subtitle="Rezultate din TMDB">
              <ContentGrid
                items={mediaItems}
                loading={mediaRes.loading}
                skeletonCount={6}
                emptyTitle="Niciun film sau serial"
                emptyMessage={`TMDB nu a returnat nimic pentru „${q}”.`}
              />
            </Section>
          )}
        </>
      )}
    </Container>
  );
}
