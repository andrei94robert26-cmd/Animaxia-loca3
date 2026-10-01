/**
 * screens/HomeScreen.tsx — Home: hero carousel + curated rows
 * (GET /api/mobile/home — Continue watching · Trending · New · Anime · Movies).
 *
 * Offline-first: the payload is cached (stale-while-error) so Home renders
 * instantly and survives airplane mode (a dim inline hint marks cached data;
 * the Shell adds the global banner).
 *
 * Desktop "new content" notification: on every FRESH payload the hero + first
 * row ids are diffed against the last-seen set (localStorage) and one system
 * notification is fired when unseen titles appear — the main process gates it
 * on the user's notification settings.
 */

import React, { useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { useApi } from '../hooks/useApi';
import * as mobile from '../api/mobile';
import type { MobileItem } from '../api/mobile';
import { ContentRow, HeroCarousel } from '../components/content';
import type { HeroSlide } from '../components/content';
import { EmptyState, ErrorState, Skeleton, SkeletonRow } from '../components/states';
import { progressPercent } from '../utils/format';

const SEEN_IDS_KEY = 'animaxia.homeSeenIds';

function readSeenIds(): number[] {
  try {
    const raw = window.localStorage.getItem(SEEN_IDS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is number => typeof value === 'number');
  } catch {
    return [];
  }
}

function writeSeenIds(ids: number[]): void {
  try {
    window.localStorage.setItem(SEEN_IDS_KEY, JSON.stringify(ids));
  } catch {
    /* storage unavailable — detection is best-effort */
  }
}

export default function HomeScreen(): React.JSX.Element {
  const navigate = useNavigate();
  const { user } = useAuth();
  const home = useApi(mobile.getHomeCached, []);
  const profile = useApi(user ? mobile.getProfileCached : null, [user?.id]);

  /* Hero = featured item + the first row's items, deduped, capped at 5. */
  const heroSlides = useMemo<HeroSlide[]>(() => {
    const data = home.data;
    if (!data) return [];
    const firstRow: MobileItem[] = data.rows[0]?.items ?? [];
    const seen = new Set<number>();
    const slides: HeroSlide[] = [];
    for (const item of [data.hero, ...firstRow]) {
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      slides.push({
        id: item.id,
        title: item.title,
        type: item.type,
        overview: item.overview ?? null,
        thumbnail: item.thumbnail,
        backdrop: item.backdrop ?? null,
        rating: item.rating,
      });
    }
    return slides.slice(0, 5);
  }, [home.data]);

  /* New-content desktop notification (fresh payloads only, never on first run). */
  useEffect(() => {
    const data = home.data;
    if (!data || home.stale) return;
    const ids = [
      data.hero?.id,
      ...(data.rows[0]?.items ?? []).map((item) => item.id),
    ].filter((id): id is number => typeof id === 'number');
    const seen = readSeenIds();
    const seenSet = new Set(seen);
    const fresh = ids.filter((id) => !seenSet.has(id));
    if (seen.length > 0 && fresh.length > 0) {
      try {
        window.animaxia?.notifications.newContent({
          title: 'New on Animaxia',
          body: `${fresh.length} new title${fresh.length === 1 ? '' : 's'} just landed — fresh picks are on Home.`,
          route: '/',
        });
      } catch {
        /* notifications are best-effort — never block Home */
      }
    }
    writeSeenIds(ids);
  }, [home.data, home.stale]);

  /* Slim continue-watching strip for signed-in users (best-effort). */
  const continueWatching = useMemo(() => {
    const history = profile.data?.recentHistory ?? [];
    return history.filter((entry) => entry.progress > 1 && entry.progress < 97).slice(0, 12);
  }, [profile.data]);

  if (home.loading) {
    return (
      <div className="stack" style={{ gap: 20 }}>
        <Skeleton h={380} radius={16} />
        <SkeletonRow />
        <SkeletonRow />
      </div>
    );
  }

  if (home.error) {
    return <ErrorState message={home.error} onRetry={home.refetch} />;
  }

  const data = home.data;
  if (!data) return <></>;

  return (
    <div>
      {home.stale ? (
        <p className="dim" style={{ margin: '0 0 12px', fontSize: 12.5 }}>
          Offline — showing your cached Home
        </p>
      ) : null}

      <HeroCarousel
        slides={heroSlides}
        onPlay={(id) => navigate(`/player/${id}`)}
        onDetails={(id) => navigate(`/content/${id}`)}
      />

      {continueWatching.length > 0 ? (
        <ContentRow
          title="Continue watching"
          items={continueWatching.map((entry) => ({
            ...entry.content,
            reason: `${progressPercent(entry.progress)}% watched`,
          }))}
          onOpen={(id) => navigate(`/player/${id}`)}
        />
      ) : null}

      {data.rows.map((row) => (
        <ContentRow key={row.key} title={row.title} items={row.items} onOpen={(id) => navigate(`/content/${id}`)} />
      ))}

      {data.rows.length === 0 ? (
        <EmptyState title="Nothing here yet" hint="The library is empty — seed it from the web console." />
      ) : null}
    </div>
  );
}
