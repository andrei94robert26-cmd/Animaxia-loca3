'use client';

/**
 * content-view.tsx — Title detail page. Handles two data paths:
 *  - numeric id   → DB library record (DbContent)
 *  - ext:type:id  → live provider detail (Jikan anime / TMDB movie / TMDB tv),
 *                   seeded instantly from the router's extItemCache.
 */

import { useEffect, useRef, useState } from 'react';
import { Bookmark, BookmarkCheck, BookmarkPlus, Film, Loader2, Pickaxe, Play, Plus, Users } from 'lucide-react';
import { toast } from 'sonner';
import { api, dbToItem } from '@/lib/animaxia/api';
import { platform, PlatformError } from '@/lib/animaxia/platform';
import { social } from '@/lib/animaxia/social';
import { useApi } from '@/lib/animaxia/hooks';
import { extItemCache, navigate, type AppRoute } from '@/lib/animaxia/router';
import type { AnimeItem, DbContent, MediaItem, NormalizedItem } from '@/lib/animaxia/types';
import { useAuth } from '@/components/animaxia/auth-provider';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Container, Section } from '../section';
import { ContentAiPanel } from '../content-ai-panel';
import { ContentReviews } from '../content-reviews';
import { ContentSocial } from '../content-social';
import { ContentRow } from '../content-row';
import { EmptyState, ErrorState, RatingBadge, TypeBadge } from '../states';

/* ------------------------------- helpers ------------------------------- */

function formatDate(iso?: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function hostOf(url?: string): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function dbSourceLabel(c: DbContent): string {
  const md = c.metadata || {};
  if (typeof md.source === 'string' && md.source) return md.source;
  if (typeof md.siteName === 'string' && md.siteName) return md.siteName;
  const ext = c.externalid || '';
  if (/^https?:\/\//.test(ext)) return hostOf(ext) || 'mined';
  const prefix = ext.split(':')[0];
  return prefix || 'animaxia';
}

function isNotFound(message?: string | null): boolean {
  return Boolean(message && message.toLowerCase().includes('not found'));
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-0.5 text-[11px] font-medium text-zinc-300">
      {children}
    </span>
  );
}

function SourceChip({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center rounded-full border border-rose-500/25 bg-rose-500/10 px-2.5 py-0.5 font-mono text-[11px] font-semibold text-rose-300">
      {label}
    </span>
  );
}

function PosterFrame({ poster, title, className }: { poster: string | null; title: string; className?: string }) {
  if (poster) {
    return (
      <img
        src={poster}
        alt={`${title} poster`}
        className={`aspect-[2/3] w-full rounded-xl border border-white/10 object-cover shadow-2xl shadow-black/60 ${className ?? ''}`}
      />
    );
  }
  return (
    <div
      className={`grid aspect-[2/3] w-full place-items-center rounded-xl border border-white/10 bg-gradient-to-br from-white/[0.08] to-white/[0.02] shadow-2xl shadow-black/60 ${className ?? ''}`}
    >
      <Film className="h-10 w-10 text-rose-400/60" aria-hidden />
    </div>
  );
}

function NotFoundPanel({ message, onRetry }: { message?: string | null; onRetry?: () => void }) {
  return (
    <Container className="py-20">
      <EmptyState
        title="Titlu negăsit"
        message={message || 'Acest titlu nu este în bibliotecă și nu a putut fi încărcat.'}
        action={
          <div className="flex flex-wrap justify-center gap-2">
            {onRetry && (
              <Button variant="outline" className="border-white/15 bg-white/5 hover:bg-white/10" onClick={onRetry}>
                Încearcă din nou
              </Button>
            )}
            <Button className="bg-rose-600 font-bold hover:bg-rose-500" onClick={() => navigate('/home')}>
              Înapoi acasă
            </Button>
          </div>
        }
      />
    </Container>
  );
}

function ContentSkeleton() {
  return (
    <div aria-busy="true">
      <Skeleton className="h-[38vh] min-h-[260px] w-full rounded-none" />
      <Container className="relative -mt-20 sm:-mt-28">
        <div className="flex gap-5 sm:gap-8">
          <Skeleton className="aspect-[2/3] w-28 shrink-0 rounded-xl sm:w-44" />
          <div className="flex-1 space-y-4 pb-6 pt-2 sm:pt-8">
            <Skeleton className="h-4 w-44" />
            <Skeleton className="h-9 w-3/4 sm:h-11" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-11 w-56" />
            <Skeleton className="h-4 w-full max-w-xl" />
          </div>
        </div>
      </Container>
      <Container className="mt-10 space-y-4">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-4 w-3/4" />
      </Container>
    </div>
  );
}

/* ------------------------------ main view ------------------------------ */

export function ContentView({ route }: { route: AppRoute }) {
  const ref = route.params[0] || '';
  const isNumeric = /^\d+$/.test(ref);
  const isExt = ref.startsWith('ext:');
  const [, extType, extId] = isExt ? ref.split(':') : [];
  const extTypeValid = extType === 'anime' || extType === 'movie' || extType === 'tv';

  const db = useApi(`content-${ref}`, () => api.content(Number(ref)), { enabled: isNumeric });

  const ext = useApi(
    `ext-${ref}`,
    () =>
      extType === 'anime'
        ? api.animeById(extId as string)
        : extType === 'tv'
          ? api.tvById(extId as string)
          : api.movieById(extId as string),
    { enabled: isExt && extTypeValid && Boolean(extId) },
  );

  if (isNumeric) {
    /* useApi keeps the previous record while the key changes — only trust data matching the requested id. */
    const current = db.data && db.data.id === Number(ref) ? db.data : null;
    if (db.loading && !current) return <ContentSkeleton />;
    if (db.error && !current) {
      if (isNotFound(db.error)) return <NotFoundPanel message={db.error} />;
      return (
        <Container className="py-20">
          <ErrorState message={db.error} onRetry={db.refetch} />
        </Container>
      );
    }
    if (current) return <DbContentDetail content={current} />;
    return <ContentSkeleton />;
  }

  if (isExt) {
    if (!extTypeValid || !extId) return <NotFoundPanel message="Referința externă din URL este malformată." />;
    const instant = extItemCache.get(`ext:${extType}:${extId}`);
    const live = ext.data && String(ext.data.data.id) === String(extId) ? ext.data.data : null;
    if (ext.loading && !live && !instant) return <ContentSkeleton />;
    if (ext.error && !live && !instant) {
      if (isNotFound(ext.error)) return <NotFoundPanel message={ext.error} />;
      return (
        <Container className="py-20">
          <ErrorState message={ext.error} onRetry={ext.refetch} />
        </Container>
      );
    }
    return <ExtContentDetail extType={extType} extId={extId} instant={instant} live={live} />;
  }

  return <NotFoundPanel message="Referința de conținut din URL lipsește sau este malformată." />;
}

/* --------------------------- DB detail view --------------------------- */

function DbContentDetail({ content }: { content: DbContent }) {
  const md = content.metadata || {};
  const poster = content.thumbnail || null;
  const backdrop = typeof md.backdrop === 'string' && md.backdrop ? md.backdrop : null;
  const overview =
    [md.overview, md.synopsis, md.description].find((v) => typeof v === 'string' && v.trim() !== '') || null;
  const rating = typeof md.rating === 'number' ? md.rating : typeof md.score === 'number' ? md.score : null;
  const year = md.year != null && md.year !== '' ? String(md.year) : null;
  const genres = Array.isArray(md.genres) ? md.genres.map(String) : [];
  const playable = Boolean(md.player?.sources?.length);
  const sourceLabel = dbSourceLabel(content);
  const mined = md.mined;
  const added = formatDate(content.createdat);

  const runtime = typeof md.runtime === 'number' ? md.runtime : null;
  const episodes = typeof md.episodes === 'number' ? md.episodes : null;
  const status = typeof md.status === 'string' && md.status ? md.status : null;
  const studios = Array.isArray(md.studios) ? md.studios.map(String) : [];

  const fetchMore = content.type !== 'featured';
  const more = useApi(
    `content-more-${content.type}-${content.id}`,
    () => api.all({ type: content.type, limit: 13 }),
    { enabled: fetchMore },
  );
  const moreItems = (more.data?.data || []).map(dbToItem).filter((i) => i.dbId !== content.id);

  /* ---- platform: watchlist + view tracking (Task 10-b) ---- */

  const { user } = useAuth();
  const [wlBusy, setWlBusy] = useState(false);

  /* ---- FAZA 10: watch party (creates a live room for this title) ---- */
  const [partyBusy, setPartyBusy] = useState(false);

  async function startWatchParty() {
    if (!user) {
      toast('Conectează-te pentru a porni o vizionare în grup');
      navigate('/auth');
      return;
    }
    if (partyBusy) return;
    setPartyBusy(true);
    try {
      const res = await social.createParty({ contentId: content.id });
      toast.success('Vizionarea în grup a pornit — distribuie codul de invitație');
      navigate(`/social/party/${res.party.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Nu am putut porni vizionarea în grup');
    } finally {
      setPartyBusy(false);
    }
  }
  const watchlist = useApi(`watchlist-${user?.id ?? 'anon'}`, () => platform.watchlist(), {
    enabled: !!user,
  });
  const inWatchlist = Boolean(watchlist.data?.data.some((entry) => entry.content.id === content.id));

  async function toggleWatchlist() {
    if (!user) {
      toast('Conectează-te pentru a folosi Lista Mea');
      navigate('/auth');
      return;
    }
    if (wlBusy) return;
    setWlBusy(true);
    try {
      if (!inWatchlist) {
        await platform.addWatchlist(content.id);
        toast.success('Adăugat în Lista Mea');
      } else {
        await platform.removeWatchlist(content.id);
        toast('Eliminat din Lista Mea');
      }
      await watchlist.refetch();
    } catch (err) {
      if (err instanceof PlatformError && err.upgrade) {
        toast.error(err.message, { action: { label: 'Upgrade', onClick: () => navigate('/premium') } });
      } else {
        toast.error(err instanceof Error ? err.message : 'Nu am putut actualiza Lista Mea');
      }
    } finally {
      setWlBusy(false);
    }
  }

  /* Fire-and-forget analytics view event — once per content id per mount. */
  const viewedRef = useRef<number | null>(null);
  useEffect(() => {
    if (viewedRef.current === content.id) return;
    viewedRef.current = content.id;
    platform.recordView(content.id, 'view').catch(() => {
      /* analytics is best-effort */
    });
  }, [content.id]);

  const heroImage = backdrop || poster;

  return (
    <article>
      {/* Backdrop hero */}
      <div className="relative h-[38vh] min-h-[260px] w-full">
        {heroImage ? (
          <img src={heroImage} alt="" aria-hidden className="h-full w-full object-cover" />
        ) : (
          <div className="h-full w-full bg-gradient-to-br from-white/[0.08] via-transparent to-transparent" />
        )}
        <div aria-hidden className="absolute inset-0 bg-gradient-to-t from-[#0a0a10] via-[#0a0a10]/40 to-transparent" />
        <div aria-hidden className="absolute inset-0 bg-gradient-to-r from-[#0a0a10]/70 via-[#0a0a10]/10 to-transparent" />
      </div>

      {/* Info panel */}
      <Container className="relative z-10 -mt-20 sm:-mt-28">
        <div className="flex gap-5 sm:gap-8">
          <div className="w-28 shrink-0 sm:w-44">
            <PosterFrame poster={poster} title={content.title} />
          </div>
          <div className="min-w-0 flex-1 space-y-3 pb-4 pt-1 sm:pt-6">
            <div className="flex flex-wrap items-center gap-2">
              <TypeBadge type={content.type} />
              {rating != null && <RatingBadge value={rating} />}
              {year && <span className="text-xs font-semibold text-zinc-400">{year}</span>}
              <SourceChip label={sourceLabel} />
              {playable && (
                <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-300">
                  <Play className="h-3 w-3 fill-emerald-300" aria-hidden /> Redabil
                </span>
              )}
            </div>
            <h1 className="text-2xl font-black leading-tight tracking-tight text-white sm:text-4xl">
              {content.title}
            </h1>
            {genres.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                {genres.slice(0, 4).map((g) => (
                  <Chip key={g}>{g}</Chip>
                ))}
                {genres.length > 4 && <Chip>+{genres.length - 4}</Chip>}
              </div>
            )}
            <div className="flex flex-wrap gap-3 pt-1">
              <Button
                size="lg"
                className="bg-rose-600 font-bold text-white hover:bg-rose-500"
                onClick={() => navigate(`/player/${content.id}`)}
              >
                <Play className="fill-white" aria-hidden /> Vizionează acum
              </Button>
              <Button
                size="lg"
                variant="outline"
                aria-pressed={inWatchlist}
                onClick={toggleWatchlist}
                disabled={wlBusy}
                className={`border-white/15 bg-white/5 font-semibold hover:bg-white/10 ${
                  inWatchlist ? 'border-rose-500/40 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20 hover:text-rose-200' : ''
                }`}
              >
                {wlBusy ? (
                  <Loader2 className="animate-spin" aria-hidden />
                ) : inWatchlist ? (
                  <BookmarkCheck className="fill-rose-400/30" aria-hidden />
                ) : (
                  <BookmarkPlus aria-hidden />
                )}
                {inWatchlist ? 'În Lista Mea' : 'Lista Mea'}
              </Button>
              <Button
                size="lg"
                variant="outline"
                className="border-white/15 bg-white/5 font-semibold hover:bg-white/10"
                onClick={() => navigate(`/franchise?q=${encodeURIComponent(content.title)}`)}
              >
                <Bookmark aria-hidden /> Franciză
              </Button>
              <Button
                size="lg"
                variant="outline"
                onClick={() => void startWatchParty()}
                disabled={partyBusy}
                className="border-white/15 bg-white/5 font-semibold hover:bg-white/10"
              >
                {partyBusy ? <Loader2 className="animate-spin" aria-hidden /> : <Users aria-hidden />}
                Vizionare în grup
              </Button>
            </div>
          </div>
        </div>
      </Container>

      {/* Body */}
      <Container className="py-8 sm:py-10">
        <div className="grid gap-8 lg:grid-cols-3">
          <div className="space-y-8 lg:col-span-2">
            <Section title="Povestea">
              <p className="leading-relaxed text-zinc-300">
                {overview || 'Niciun synopsis nu este disponibil încă pentru acest titlu.'}
              </p>
            </Section>

            {(runtime != null || episodes != null || status || studios.length > 0) && (
              <div className="flex flex-wrap gap-2">
                {runtime != null && <Chip>{runtime} min</Chip>}
                {episodes != null && <Chip>{episodes} episoade</Chip>}
                {status && <Chip>{status}</Chip>}
                {studios.length > 0 && (
                  <Chip>
                    {studios.slice(0, 2).join(', ')}
                    {studios.length > 2 ? ` +${studios.length - 2}` : ''}
                  </Chip>
                )}
              </div>
            )}

            {mined && (
              <Alert className="border-fuchsia-500/25 bg-fuchsia-500/[0.06] text-zinc-200">
                <Pickaxe className="text-fuchsia-300" aria-hidden />
                <AlertTitle className="text-zinc-100">
                  Extras din {mined.siteName || hostOf(mined.url) || 'pagină externă'}
                </AlertTitle>
                <AlertDescription className="space-y-2">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-400">
                    {mined.url && (
                      <a
                        href={mined.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="break-all text-fuchsia-300 underline decoration-fuchsia-500/40 underline-offset-2 transition hover:text-fuchsia-200"
                      >
                        {mined.url}
                      </a>
                    )}
                    {formatDate(mined.at) && <span>extras {formatDate(mined.at)}</span>}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {(['mp4', 'm3u8', 'iframe', 'youtube'] as const).map((k) => (
                      <span
                        key={k}
                        className="rounded-full border border-white/10 bg-black/40 px-2 py-0.5 font-mono text-[10px] text-zinc-300"
                      >
                        {k} · {mined[k]?.length ?? 0}
                      </span>
                    ))}
                  </div>
                </AlertDescription>
              </Alert>
            )}
          </div>

          <Card className="h-fit border-white/10 bg-white/[0.03]">
            <CardHeader className="pb-3">
              <CardTitle className="text-xs font-bold uppercase tracking-widest text-zinc-400">Detalii</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="space-y-2.5 text-sm">
                <DetailRow label="Tip">
                  <TypeBadge type={content.type} />
                </DetailRow>
                {year && (
                  <DetailRow label="An">
                    <dd className="font-medium text-zinc-200">{year}</dd>
                  </DetailRow>
                )}
                {rating != null && (
                  <DetailRow label="Notă">
                    <RatingBadge value={rating} />
                  </DetailRow>
                )}
                <DetailRow label="Sursă">
                  <dd className="font-mono text-xs text-zinc-300">{sourceLabel}</dd>
                </DetailRow>
                <DetailRow label="Id extern">
                  <dd className="max-w-[180px] truncate font-mono text-xs text-zinc-400" title={content.externalid}>
                    {content.externalid}
                  </dd>
                </DetailRow>
                {added && (
                  <DetailRow label="Adăugat">
                    <dd className="text-zinc-300">{added}</dd>
                  </DetailRow>
                )}
                {genres.length > 0 && (
                  <DetailRow label="Genuri">
                    <dd className="text-right text-zinc-300">{genres.join(', ')}</dd>
                  </DetailRow>
                )}
              </dl>
            </CardContent>
          </Card>
        </div>

        {/* Community + AI assistant (Task 10-b) — DB titles only */}
        <div className="mt-10 grid items-start gap-8 lg:grid-cols-3">
          <div className="space-y-8 lg:col-span-2">
            <ContentReviews contentId={content.id} />
            <ContentSocial contentId={content.id} />
          </div>
          <ContentAiPanel contentId={content.id} title={content.title} />
        </div>

        {fetchMore && moreItems.length > 0 && (
          <div className="mt-10">
            <ContentRow title="Semănătoare cu aceasta" items={moreItems} seeAllHref={`/category/${content.type}`} />
          </div>
        )}
      </Container>
    </article>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-white/5 pb-2.5 last:border-0 last:pb-0">
      <dt className="shrink-0 text-zinc-500">{label}</dt>
      <div className="min-w-0 text-right">{children}</div>
    </div>
  );
}

/* -------------------------- External detail view -------------------------- */

function ExtContentDetail({
  extType,
  extId,
  instant,
  live,
}: {
  extType: 'anime' | 'movie' | 'tv';
  extId: string;
  instant?: NormalizedItem;
  live: AnimeItem | MediaItem | null;
}) {
  const [adding, setAdding] = useState(false);

  const isAnime = extType === 'anime';
  const liveAnime = isAnime && live ? (live as AnimeItem) : null;
  const liveMedia = !isAnime && live ? (live as MediaItem) : null;

  const title = live?.title || instant?.title || 'Titlu necunoscut';
  const poster =
    (isAnime ? liveAnime?.image : liveMedia?.image || liveMedia?.backdrop || null) || instant?.image || null;
  const backdrop = liveMedia?.backdrop || instant?.backdrop || null;
  const overview = (isAnime ? liveAnime?.synopsis : liveMedia?.overview) || instant?.overview || null;
  const rating = (isAnime ? liveAnime?.score : liveMedia?.rating) ?? instant?.rating ?? null;
  const year = live?.year ?? instant?.year ?? null;
  const genres = live?.genres || instant?.genres || [];
  const source = isAnime ? 'jikan' : 'tmdb';
  const externalId = isAnime ? `jikan:anime:${extId}` : `tmdb:${extType}:${extId}`;

  const status = liveAnime?.status || null;
  const episodes = typeof liveAnime?.episodes === 'number' ? liveAnime.episodes : null;
  const studios = liveAnime?.studios || [];
  const runtime = typeof liveMedia?.runtime === 'number' ? liveMedia.runtime : null;
  const trailerKey = liveMedia?.trailerKey || null;
  const heroImage = backdrop || poster;

  async function handleAdd() {
    if (adding) return;
    setAdding(true);
    try {
      const metadata: Record<string, unknown> = {
        overview: overview ?? undefined,
        rating: rating ?? undefined,
        year: year != null && year !== '' ? String(year) : undefined,
        genres: genres.length > 0 ? genres : undefined,
        source,
        mediaType: extType,
      };
      if (backdrop) metadata.backdrop = backdrop;
      if (trailerKey) {
        metadata.player = {
          sources: [
            {
              type: 'youtube',
              url: `https://www.youtube.com/embed/${trailerKey}`,
              label: 'Trailer oficial',
            },
          ],
        };
      }
      const res = await api.upsertContent({
        externalid: externalId,
        type: extType,
        title,
        thumbnail: poster ?? null,
        metadata,
      });
      toast.success('Adăugat în biblioteca ta Animaxia');
      navigate(`/content/${res.record.id}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Nu am putut adăuga acest titlu în bibliotecă');
    } finally {
      setAdding(false);
    }
  }

  return (
    <article>
      {/* Backdrop hero */}
      <div className="relative h-[38vh] min-h-[260px] w-full">
        {heroImage ? (
          <img src={heroImage} alt="" aria-hidden className="h-full w-full object-cover" />
        ) : (
          <div className="h-full w-full bg-gradient-to-br from-white/[0.08] via-transparent to-transparent" />
        )}
        <div aria-hidden className="absolute inset-0 bg-gradient-to-t from-[#0a0a10] via-[#0a0a10]/40 to-transparent" />
        <div aria-hidden className="absolute inset-0 bg-gradient-to-r from-[#0a0a10]/70 via-[#0a0a10]/10 to-transparent" />
      </div>

      {/* Info panel */}
      <Container className="relative z-10 -mt-20 sm:-mt-28">
        <div className="flex gap-5 sm:gap-8">
          <div className="w-28 shrink-0 sm:w-44">
            <PosterFrame poster={poster} title={title} />
          </div>
          <div className="min-w-0 flex-1 space-y-3 pb-4 pt-1 sm:pt-6">
            <div className="flex flex-wrap items-center gap-2">
              <TypeBadge type={extType} />
              {rating != null && <RatingBadge value={rating} />}
              {year != null && year !== '' && (
                <span className="text-xs font-semibold text-zinc-400">{String(year)}</span>
              )}
              <SourceChip label={source} />
              <span className="inline-flex items-center rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-0.5 text-[11px] font-medium text-zinc-400">
                Nu e în bibliotecă
              </span>
            </div>
            <h1 className="text-2xl font-black leading-tight tracking-tight text-white sm:text-4xl">{title}</h1>
            {genres.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                {genres.slice(0, 4).map((g) => (
                  <Chip key={g}>{g}</Chip>
                ))}
                {genres.length > 4 && <Chip>+{genres.length - 4}</Chip>}
              </div>
            )}
            <div className="flex flex-wrap gap-3 pt-1">
              <Button
                size="lg"
                className="bg-rose-600 font-bold text-white hover:bg-rose-500"
                onClick={handleAdd}
                disabled={adding}
              >
                {adding ? (
                  <Loader2 className="animate-spin" aria-hidden />
                ) : (
                  <Plus aria-hidden />
                )}
                {adding ? 'Se adaugă…' : 'Adaugă în Animaxia'}
              </Button>
              <Button
                size="lg"
                variant="outline"
                className="border-white/15 bg-white/5 font-semibold hover:bg-white/10"
                onClick={() => navigate(`/franchise?q=${encodeURIComponent(title)}`)}
              >
                <Bookmark aria-hidden /> Franciză
              </Button>
            </div>
          </div>
        </div>
      </Container>

      {/* Body */}
      <Container className="py-8 sm:py-10">
        <div className="grid gap-8 lg:grid-cols-3">
          <div className="space-y-8 lg:col-span-2">
            <Section title="Povestea">
              <p className="leading-relaxed text-zinc-300">
                {overview || 'Niciun synopsis nu este disponibil încă pentru acest titlu.'}
              </p>
            </Section>

            {(runtime != null || episodes != null || status || studios.length > 0) && (
              <div className="flex flex-wrap gap-2">
                {runtime != null && <Chip>{runtime} min</Chip>}
                {episodes != null && <Chip>{episodes} episoade</Chip>}
                {status && <Chip>{status}</Chip>}
                {studios.length > 0 && (
                  <Chip>
                    {studios.slice(0, 2).join(', ')}
                    {studios.length > 2 ? ` +${studios.length - 2}` : ''}
                  </Chip>
                )}
              </div>
            )}
          </div>

          <Card className="h-fit border-white/10 bg-white/[0.03]">
            <CardHeader className="pb-3">
              <CardTitle className="text-xs font-bold uppercase tracking-widest text-zinc-400">Detalii</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="space-y-2.5 text-sm">
                <DetailRow label="Tip">
                  <TypeBadge type={extType} />
                </DetailRow>
                {year != null && year !== '' && (
                  <DetailRow label="An">
                    <dd className="font-medium text-zinc-200">{String(year)}</dd>
                  </DetailRow>
                )}
                {rating != null && (
                  <DetailRow label="Notă">
                    <RatingBadge value={rating} />
                  </DetailRow>
                )}
                <DetailRow label="Sursă">
                  <dd className="font-mono text-xs text-zinc-300">{source}</dd>
                </DetailRow>
                <DetailRow label="Id extern">
                  <dd className="max-w-[180px] truncate font-mono text-xs text-zinc-400" title={externalId}>
                    {externalId}
                  </dd>
                </DetailRow>
                {genres.length > 0 && (
                  <DetailRow label="Genuri">
                    <dd className="text-right text-zinc-300">{genres.join(', ')}</dd>
                  </DetailRow>
                )}
              </dl>
              <p className="mt-4 text-xs leading-relaxed text-zinc-500">
                Detaliile live sunt preluate direct din {source === 'jikan' ? 'Jikan (MyAnimeList)' : 'TMDB'}. Adăugarea
                stochează o copie în biblioteca ta Animaxia.
              </p>
            </CardContent>
          </Card>
        </div>
      </Container>
    </article>
  );
}
