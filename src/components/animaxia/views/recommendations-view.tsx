'use client';

/**
 * recommendations-view.tsx — „Pentru tine”: recomandări personalizate pe
 * genurile din istoricul + lista utilizatorului logat (TS2b), un dice-roll
 * random anime picker și rândurile curatoriate globale (Jikan, TMDB,
 * biblioteca locală).
 */

import { useMemo, useState } from 'react';
import { Clapperboard, Dices, Info, Loader2, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { animeToItem, api, dbToItem, mediaToItem } from '@/lib/animaxia/api';
import { useApi } from '@/lib/animaxia/hooks';
import { platform } from '@/lib/animaxia/platform';
import { extItemCache, navigate } from '@/lib/animaxia/router';
import type { AnimeItem, NormalizedItem } from '@/lib/animaxia/types';
import { useAuth } from '@/components/animaxia/auth-provider';
import { Button } from '@/components/ui/button';
import { Container, PageHeader } from '../section';
import { ContentCard } from '../content-card';
import { ContentRow } from '../content-row';
import { EmptyState, RatingBadge, TypeBadge } from '../states';

/* ------------------ TS2b: scor de potrivire pe genuri ------------------ */

/** Genurile favorite = top 3 genuri din istoric + watchlist (frecvență). */
function topGenres(items: NormalizedItem[]): string[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const genres = item.genres ?? [];
    if (genres.length === 0) continue;
    for (const genre of genres) {
      const key = genre.toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([genre]) => genre);
}

/** Punctaj: #gen favorit = 3, #2 = 2, #3 = 1 (potrivire simplă, onestă). */
function genreScore(genres: string[] | undefined, favorites: string[]): number {
  if (!genres || genres.length === 0 || favorites.length === 0) return 0;
  const own = genres.map((g) => g.toLowerCase());
  let score = 0;
  favorites.forEach((fav, index) => {
    if (own.includes(fav)) score += favorites.length - index;
  });
  return score;
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-0.5 text-[11px] font-medium text-zinc-300">
      {children}
    </span>
  );
}

export function RecommendationsView() {
  const [roll, setRoll] = useState<AnimeItem | null>(null);
  const [rolling, setRolling] = useState(false);
  const { user } = useAuth();

  const topAnime = useApi('rec-anime-top', () => api.animeTop());
  const topMovies = useApi('rec-movies-top', () => api.moviesTop());
  const popularTv = useApi('rec-tv-popular', () => api.tvPopular());
  const fresh = useApi('rec-fresh', () => api.all({ limit: 14, sort: 'createdat' }));

  /* TS2b: istoricul + lista utilizatorului logat — combustibilul rândului
     „Pentru tine”. Anonim → ambele rămân dezactivate (rând absent). */
  const history = useApi('rec-my-history', () => platform.history(50), { enabled: Boolean(user) });
  const watchlist = useApi('rec-my-watchlist', () => platform.watchlist(), { enabled: Boolean(user) });

  const seenKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const entry of history.data?.data ?? []) keys.add(`db-${entry.content.id}`);
    for (const entry of watchlist.data?.data ?? []) keys.add(`db-${entry.content.id}`);
    return keys;
  }, [history.data, watchlist.data]);

  const favoriteGenres = useMemo(() => {
    const watched = (history.data?.data ?? []).map((e) => dbToItem(e.content));
    const saved = (watchlist.data?.data ?? []).map((e) => dbToItem(e.content));
    return topGenres([...watched, ...saved]);
  }, [history.data, watchlist.data]);

  const personalized = useMemo<NormalizedItem[]>(() => {
    /* Onest: rândul există doar cu semnal real (≥2 titluri cunoscute). */
    const knownCount = (history.data?.data ?? []).length + (watchlist.data?.data ?? []).length;
    if (!user || knownCount < 2 || favoriteGenres.length === 0) return [];

    const candidates: NormalizedItem[] = [
      ...(topAnime.data?.data ?? []).map(animeToItem),
      ...(topMovies.data?.data ?? []).map(mediaToItem),
      ...(popularTv.data?.data ?? []).map(mediaToItem),
      ...(fresh.data?.data ?? []).map(dbToItem),
    ];

    const byKey = new Map<string, NormalizedItem>();
    for (const item of candidates) {
      if (seenKeys.has(item.key)) continue; // exclude ce e deja în istoric/listă
      if (!item.genres || item.genres.length === 0) continue;
      byKey.set(item.key, item);
    }

    return [...byKey.values()]
      .map((item) => ({ item, score: genreScore(item.genres, favoriteGenres) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 14)
      .map((x) => x.item);
  }, [user, history.data, watchlist.data, topAnime.data, topMovies.data, popularTv.data, fresh.data, seenKeys, favoriteGenres]);

  async function rollDice() {
    if (rolling) return;
    setRolling(true);
    try {
      const res = await api.animeRandom();
      setRoll(res.data);
    } catch {
      toast.error('Jikan este limitat de rate — încearcă din nou în curând');
    } finally {
      setRolling(false);
    }
  }

  function openRollDetails(item: AnimeItem) {
    extItemCache.put(`ext:anime:${item.id}`, animeToItem(item));
    navigate(`/content/ext:anime:${item.id}`);
  }

  return (
    <Container className="space-y-10 py-8 sm:py-10">
      <PageHeader title="Pentru tine" subtitle="Recomandări alese cu grijă și o aruncare cu zarul." />

      {/* Surprise me */}
      <div className="rounded-2xl bg-gradient-to-br from-rose-500/50 via-fuchsia-500/30 to-amber-500/40 p-[1px]">
        <div className="rounded-2xl bg-[#0d0d14] p-5 sm:p-7">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 className="text-xl font-black tracking-tight text-white sm:text-2xl">Surprinde-mă</h2>
              <p className="mt-1 max-w-xl text-sm text-zinc-400">
                Trage un anime la întâmplare din arhiva Jikan — un click, o alegere. Dacă nimeriri o
                comoară, păstreaz-o în bibliotecă.
              </p>
            </div>
            <Button
              size="lg"
              onClick={rollDice}
              disabled={rolling}
              className="bg-rose-600 font-bold text-white hover:bg-rose-500"
            >
              {rolling ? <Loader2 className="animate-spin" aria-hidden /> : <Dices aria-hidden />}
              {rolling ? 'Se aruncă zarul…' : 'Dă cu zarul'}
            </Button>
          </div>

          <div className="mt-6">
            {roll ? (
              <div className="flex flex-col gap-6 sm:flex-row">
                <div className="w-full shrink-0 sm:w-56">
                  {roll.image ? (
                    <img
                      src={roll.image}
                      alt={`${roll.title} — poster`}
                      className="aspect-[2/3] w-full rounded-xl border border-white/10 object-cover shadow-2xl shadow-black/60"
                    />
                  ) : (
                    <div className="grid aspect-[2/3] w-full place-items-center rounded-xl border border-white/10 bg-gradient-to-br from-white/[0.08] to-white/[0.02]">
                      <Clapperboard className="h-10 w-10 text-rose-400/60" aria-hidden />
                    </div>
                  )}
                </div>
                <div className="min-w-0 flex-1 space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <TypeBadge type="anime" />
                    {roll.score != null && <RatingBadge value={roll.score} />}
                  </div>
                  <h3 className="text-xl font-black tracking-tight text-white sm:text-2xl">{roll.title}</h3>
                  <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
                    {[roll.year, roll.type, roll.episodes ? `${roll.episodes} episoade` : null]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                  {roll.genres && roll.genres.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {roll.genres.slice(0, 5).map((g) => (
                        <Chip key={g}>{g}</Chip>
                      ))}
                    </div>
                  )}
                  <p className="line-clamp-4 text-sm leading-relaxed text-zinc-400">
                    {roll.synopsis || 'Niciun synopsis disponibil pentru această alegere.'}
                  </p>
                  <div className="flex flex-wrap gap-3 pt-1">
                    <Button
                      variant="outline"
                      className="border-white/15 bg-white/5 font-semibold hover:bg-white/10"
                      onClick={() => openRollDetails(roll)}
                    >
                      <Info aria-hidden /> Detalii
                    </Button>
                    <Button
                      variant="outline"
                      className="border-rose-500/40 bg-rose-500/10 font-semibold text-rose-300 hover:bg-rose-500/20 hover:text-rose-200"
                      onClick={rollDice}
                      disabled={rolling}
                    >
                      {rolling ? <Loader2 className="animate-spin" aria-hidden /> : <Dices aria-hidden />}
                      Mai dă o dată
                    </Button>
                  </div>
                </div>
              </div>
            ) : (
              <EmptyState
                title={rolling ? 'Se aruncă zarul…' : 'Soarta așteaptă'}
                message={
                  rolling
                    ? 'Îl întrebăm pe Jikan pentru o alegere la întâmplare.'
                    : 'Apasă zarul și lasă soarta să-ți aleagă următoarea vizionare din mii de anime.'
                }
                icon={<Dices className="h-6 w-6" aria-hidden />}
              />
            )}
          </div>
        </div>
      </div>

      {/* Rows */}
      <div className="space-y-10">
        {/* TS2b: rând personalizat „Pentru tine” — doar pentru utilizatori
            logați cu istoric real (≥2 titluri). Anonim → absent, onest. */}
        {user &&
          (history.loading ||
            watchlist.loading ||
            topAnime.loading ||
            topMovies.loading ||
            popularTv.loading ||
            fresh.loading) && <ContentRow title="Pentru tine" subtitle="Se calculează pe baza istoricului tău…" items={[]} loading />}
        {user && personalized.length > 0 && (
          <section aria-label="Pentru tine — recomandări personalizate" className="space-y-3">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 className="flex flex-wrap items-center gap-2 text-lg font-black tracking-tight text-white sm:text-xl">
                  Pentru tine
                  <span className="inline-flex items-center gap-1 rounded-full border border-fuchsia-500/40 bg-fuchsia-500/10 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-fuchsia-300">
                    <Sparkles className="h-3 w-3" aria-hidden />
                    personalizat pe istoricul tău
                  </span>
                </h2>
                <p className="mt-1 text-sm text-zinc-400">
                  Potrivire pe genurile tale favorite:{' '}
                  {favoriteGenres.map((g) => (
                    <span key={g} className="capitalize">
                      {g}
                      {g !== favoriteGenres[favoriteGenres.length - 1] ? ' · ' : ''}
                    </span>
                  ))}
                </p>
              </div>
            </div>
            <PersonalizedScroller items={personalized} />
          </section>
        )}
        <ContentRow
          title="Top anime din toate timpurile"
          subtitle="Serialele cu cea mai mare notă pe MyAnimeList"
          items={(topAnime.data?.data || []).map(animeToItem)}
          loading={topAnime.loading}
          seeAllHref="/category/anime"
        />
        <ContentRow
          title="Filme cu cele mai bune note"
          subtitle="Capodopere din toate timpurile, de pe TMDB"
          items={(topMovies.data?.data || []).map(mediaToItem)}
          loading={topMovies.loading}
          seeAllHref="/category/movie"
        />
        <ContentRow
          title="Seriale populare chiar acum"
          subtitle="Ce vizionează toată lumea"
          items={(popularTv.data?.data || []).map(mediaToItem)}
          loading={popularTv.loading}
          seeAllHref="/category/tv"
        />
        <ContentRow
          title="Proaspăt în biblioteca ta"
          subtitle="Cele mai recent adăugate titluri"
          items={(fresh.data?.data || []).map(dbToItem)}
          loading={fresh.loading}
          seeAllHref="/category/all"
          emptyMessage="Biblioteca ta e goală — deschide orice categorie și adaugă titluri din TMDB sau Jikan."
        />
      </div>
    </Container>
  );
}

/* --------------------- rândul personalizat (scroller) --------------------- */

function PersonalizedScroller({ items }: { items: NormalizedItem[] }) {
  return (
    <div className="custom-scrollbar flex snap-x snap-mandatory gap-3 overflow-x-auto scroll-smooth pb-2 sm:gap-4">
      {items.map((item) => (
        <div key={item.key} className="w-[150px] shrink-0 snap-start sm:w-[176px]">
          <ContentCard item={item} />
        </div>
      ))}
    </div>
  );
}
