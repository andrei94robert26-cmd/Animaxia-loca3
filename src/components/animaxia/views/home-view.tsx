'use client';

/**
 * home-view.tsx — Animaxia landing page: hero carousel of playable library
 * titles, live stats strip, trending rows, latest news, franchise chips and
 * the miner CTA banner.
 */

import { useMemo } from 'react';
import { motion } from 'framer-motion';
import { ArrowRight, Clapperboard, Film, Pickaxe, Sword, Tv } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { api, animeToItem, dbToItem, mediaToItem } from '@/lib/animaxia/api';
import { useApi, type UseApiResult } from '@/lib/animaxia/hooks';
import { franchiseChips, navigate } from '@/lib/animaxia/router';
import type { NormalizedItem } from '@/lib/animaxia/types';
import { ContentGrid } from '../content-grid';
import { ContentRow } from '../content-row';
import { HeroCarousel } from '../hero-carousel';
import { AiInfiniteFeedSection } from '../home-ai-feed';
import {
  AiAnalysisPanel,
  AiExternalAnalysisPanel,
  AiMetadataPanel,
  AiTaxonomyAutoPanel,
  CommunityActivityPanel,
  NeonLibraryPanel,
  PlatformHeroPanel,
  TaxonomyPanel,
} from '../home-panels';
import { Container, Section } from '../section';
import { ResumeBanner } from '../player/resume-banner'; // FAZA 34-c (WS4): „Continuă de unde ai rămas”
import { ErrorState } from '../states';

export function HomeView() {
  const allRes = useApi('home-all', () => api.all({ limit: 16 }));
  /* Full-catalog fetch powering the Neon library panel + AI analysis + taxonomy. */
  const libraryRes = useApi('home-library-full', () => api.all({ limit: 100 }));
  const trendingRes = useApi('home-trending', () => api.moviesTrending('day'));
  const tvRes = useApi('home-tv', () => api.tvTrending('day'));
  const animeRes = useApi('home-anime', async () => {
    try {
      return await api.animeTop();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return api.animeTop();
    }
  });
  const healthRes = useApi('home-health', () => api.health());

  const trendingItems = useMemo(() => (trendingRes.data?.data ?? []).map(mediaToItem), [trendingRes.data]);
  const tvItems = useMemo(() => (tvRes.data?.data ?? []).map(mediaToItem), [tvRes.data]);
  const animeItems = useMemo(() => (animeRes.data?.data ?? []).map(animeToItem), [animeRes.data]);
  const libraryItems = useMemo(() => (allRes.data?.data ?? []).map(dbToItem), [allRes.data]);

  /* Hero candidates: playable library titles first, then entries with an
     image and overview, then the rest. Falls back to trending movies only
     when the library has nothing to show. */
  const heroItems = useMemo<NormalizedItem[]>(() => {
    if (allRes.loading) return [];
    const playable = libraryItems.filter((i) => i.playable);
    const rich = libraryItems.filter((i) => !i.playable && Boolean(i.image) && Boolean(i.overview));
    const rest = libraryItems.filter((i) => !i.playable && !(i.image && i.overview));
    const fromLibrary = [...playable, ...rich, ...rest].slice(0, 5);
    if (fromLibrary.length > 0) return fromLibrary;
    if (!trendingRes.loading) {
      return trendingItems.filter((i) => Boolean(i.image) && Boolean(i.overview)).slice(0, 5);
    }
    return [];
  }, [allRes.loading, libraryItems, trendingRes.loading, trendingItems]);

  const counts = healthRes.data?.db.countsByType ?? {};
  const stats: { icon: LucideIcon; label: string; value: number }[] = [
    { icon: Clapperboard, label: 'Total titluri', value: healthRes.data?.db.totalItems ?? 0 },
    { icon: Film, label: 'Filme', value: counts.movie ?? 0 },
    { icon: Tv, label: 'Seriale', value: counts.tv ?? 0 },
    { icon: Sword, label: 'Anime', value: counts.anime ?? 0 },
  ];

  const mainFailed = Boolean(allRes.error && trendingRes.error && animeRes.error);
  const refetchMain = () => {
    void allRes.refetch();
    void trendingRes.refetch();
    void animeRes.refetch();
  };

  return (
    <>
      {heroItems.length > 0 && <HeroCarousel items={heroItems} />}

      <Container className="space-y-10 py-8 sm:py-12">
        {mainFailed && (
          <ErrorState
            message="Biblioteca ta, TMDB și furnizorul de anime sunt momentan inaccesibile. Backend-ul se poate reporni — încearcă din nou într-un moment."
            onRetry={refetchMain}
          />
        )}

        {/* FAZA 34-c (WS4): banner de resume global — randează null pentru
            vizitatori / fără istoric reluabil, zero impact pe restul home-ului. */}
        <ResumeBanner />

        {/* Stats strip */}
        <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          {stats.map((stat) => (
            <StatCard
              key={stat.label}
              icon={stat.icon}
              label={stat.label}
              value={stat.value}
              loading={healthRes.loading}
            />
          ))}
        </div>

        {/* PLATFORMĂ ALIMENTATĂ DE TINE — upload anything, arhitectură reală 10M */}
        <PlatformHeroPanel />

        {/* 🧠 AI Flux Infinit — numbered pages of 20 posters, infinite scroll */}
        <AiInfiniteFeedSection />

        {/* Live rows */}
        <HomeRow
          title="Filme în tendințe"
          subtitle="Ce vizionează lumea pe TMDB azi"
          res={trendingRes}
          items={trendingItems}
          seeAllHref="/category/movie"
          emptyMessage="Filmele în tendințe sunt momentan indisponibile."
        />
        <HomeRow
          title="Anime populare"
          subtitle="Seriale și filme din topul MyAnimeList"
          res={animeRes}
          items={animeItems}
          seeAllHref="/category/anime"
          emptyMessage="Clasamentele de anime sunt momentan indisponibile."
        />
        <HomeRow
          title="Seriale în tendințe"
          subtitle="Serialele pe care le vizionează lumea azi"
          res={tvRes}
          items={tvItems}
          seeAllHref="/category/tv"
          emptyMessage="Serialele în tendințe sunt momentan indisponibile."
        />
        <HomeRow
          title="Biblioteca ta Animaxia"
          subtitle="Titlurile salvate în colecția ta"
          res={allRes}
          items={libraryItems}
          seeAllHref="/category/all"
          emptyMessage="Biblioteca e goală — adaugă titluri din orice pagină de detalii."
        />

        {/* Activitatea comunității — live din SQLite local */}
        <CommunityActivityPanel />

        {/* 🧠 Biblioteca ta locală — redare universală */}
        <NeonLibraryPanel
          rows={libraryRes.data?.data ?? []}
          loading={libraryRes.loading}
          totalCount={libraryRes.data?.total ?? 0}
        />

        {/* AI Analiză conținut — LIVE, auto-refresh 60s */}
        <AiAnalysisPanel
          rows={libraryRes.data?.data ?? []}
          loading={libraryRes.loading}
          onRefetch={() => void libraryRes.refetch()}
        />

        {/* AI Analiză Externă — LIVE, auto-refresh 30s + delta (FAZA 15) */}
        <AiExternalAnalysisPanel />

        {/* Genuri & Categorii create automat de AI */}
        <TaxonomyPanel
          rows={libraryRes.data?.data ?? []}
          loading={libraryRes.loading}
          onRefetch={() => void libraryRes.refetch()}
        />

        {/* Genuri & Categorii generate automat din posterele externe (FAZA 15) */}
        <AiTaxonomyAutoPanel />

        {/* AI Extractor Metadata — coverage + 8 dimensions (FAZA 15) */}
        <AiMetadataPanel />

        {/* Popular franchises */}
        <Section title="Francize populare" subtitle="Sari direct într-un univers care îți place">
          <div className="flex flex-wrap gap-2">
            {franchiseChips.map((chip) => (
              <button
                key={chip}
                type="button"
                onClick={() => navigate(`/franchise?q=${encodeURIComponent(chip)}`)}
                className="rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-medium text-zinc-300 transition hover:border-rose-500/50 hover:bg-rose-500/10 hover:text-rose-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60"
              >
                {chip}
              </button>
            ))}
          </div>
        </Section>

        {/* Miner CTA banner */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, ease: 'easeOut' }}
          className="relative overflow-hidden rounded-2xl border border-rose-500/20 bg-gradient-to-r from-rose-600/20 via-fuchsia-600/10 to-transparent p-6 sm:p-8"
        >
          <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-4">
              <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl border border-rose-500/30 bg-rose-500/15 text-rose-400">
                <Pickaxe className="h-6 w-6" aria-hidden />
              </span>
              <div>
                <h3 className="text-lg font-bold text-white">Ai un link de stream?</h3>
                <p className="mt-1 max-w-xl text-sm leading-relaxed text-zinc-400">
                  Lipește un link către orice pagină video, iar Minerul Animaxia îl va scana după
                  stream-uri MP4, playlist-uri HLS, iframe-uri și embed-uri YouTube — apoi va salva
                  titluri redabile direct în biblioteca ta.
                </p>
              </div>
            </div>
            <Button
              onClick={() => navigate('/admin')}
              className="shrink-0 bg-rose-600 font-bold text-white hover:bg-rose-500"
            >
              Deschide Minerul
              <ArrowRight className="ml-1.5 h-4 w-4" aria-hidden />
            </Button>
          </div>
        </motion.div>
      </Container>
    </>
  );
}

/* ----------------------------- local helpers ----------------------------- */

function StatCard({
  icon: Icon,
  label,
  value,
  loading,
}: {
  icon: LucideIcon;
  label: string;
  value: number;
  loading?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-rose-500/20 bg-rose-500/10 text-rose-400">
        <Icon className="h-5 w-5" aria-hidden />
      </span>
      <div className="min-w-0">
        {loading ? (
          <Skeleton className="h-7 w-14" />
        ) : (
          <p className="text-2xl font-black leading-none text-white">{value.toLocaleString('ro-RO')}</p>
        )}
        <p className="mt-1.5 truncate text-xs font-medium text-zinc-500">{label}</p>
      </div>
    </div>
  );
}

function HomeRow({
  title,
  subtitle,
  res,
  items,
  seeAllHref,
  emptyMessage,
}: {
  title: string;
  subtitle?: string;
  res: UseApiResult<unknown>;
  items: NormalizedItem[];
  seeAllHref?: string;
  emptyMessage?: string;
}) {
  if (res.error && !res.loading && !res.data) {
    return <ErrorState message={res.error} onRetry={res.refetch} compact />;
  }
  return (
    <ContentRow
      title={title}
      subtitle={subtitle}
      items={items}
      loading={res.loading}
      seeAllHref={seeAllHref}
      emptyMessage={emptyMessage}
    />
  );
}
