'use client';

/**
 * feed-view.tsx — Activity feed (#/feed). Two tabs: "Global" (public activity
 * stream) and "For you" (personalized, auth-gated with a locked panel when
 * signed out). Cursor-based "Load more" appends locally; the tab switch resets
 * the accumulated list.
 */

import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, Clapperboard, Film, Lock, Loader2, MessageSquare, ThumbsUp, UserRound } from 'lucide-react';
import { platform, type FeedActivity } from '@/lib/animaxia/platform';
import { useApi } from '@/lib/animaxia/hooks';
import { navigate, type AppRoute } from '@/lib/animaxia/router';
import { useAuth } from '@/components/animaxia/auth-provider';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { Container, PageHeader } from '../section';
import { BrandPlaceholder, EmptyState, ErrorState, TypeBadge } from '../states';

/* ------------------------------- local helpers ------------------------------ */

type FeedKind = 'global' | 'personal';

const ACTIVITY_META: Record<
  FeedActivity['type'],
  { icon: React.ComponentType<{ className?: string }>; chip: string; verb: string }
> = {
  comment: {
    icon: MessageSquare,
    chip: 'border-teal-500/30 bg-teal-500/10 text-teal-300',
    verb: 'commented on',
  },
  like: {
    icon: ThumbsUp,
    chip: 'border-rose-500/30 bg-rose-500/10 text-rose-300',
    verb: 'liked',
  },
  content: {
    icon: Film,
    chip: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
    verb: 'Nou în bibliotecă',
  },
  user: {
    icon: UserRound,
    chip: 'border-violet-500/30 bg-violet-500/10 text-violet-300',
    verb: 'joined Animaxia',
  },
};

function timeAgo(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diff = Date.now() - t;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d`;
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/* ---------------------------------- view ---------------------------------- */

export function FeedView({ route }: { route: AppRoute }) {
  const { user } = useAuth();
  const [tab, setTab] = useState<FeedKind>(route.query.get('tab') === 'personal' ? 'personal' : 'global');

  return (
    <Container className="space-y-8 py-8 sm:py-10">
      <PageHeader title="Feed de activitate" subtitle="Tot ce se întâmplă în Animaxia." />

      <Tabs value={tab} onValueChange={(v) => setTab(v as FeedKind)}>
        <TabsList className="h-10 w-full justify-start gap-1 rounded-xl border border-white/10 bg-white/[0.03] p-1 sm:w-auto">
          <TabsTrigger
            value="global"
            className="rounded-lg px-4 text-zinc-400 hover:text-zinc-100 data-[state=active]:bg-rose-600 data-[state=active]:text-white sm:px-5"
          >
            Global
          </TabsTrigger>
          <TabsTrigger
            value="personal"
            className="rounded-lg px-4 text-zinc-400 hover:text-zinc-100 data-[state=active]:bg-rose-600 data-[state=active]:text-white sm:px-5"
          >
            For you
          </TabsTrigger>
        </TabsList>

        <TabsContent value="global" className="pt-6">
          <FeedList kind="global" userKey="anon" />
        </TabsContent>

        <TabsContent value="personal" className="pt-6">
          {user ? (
            <FeedList kind="personal" userKey={`u${user.id}`} />
          ) : (
            <LockedPersonalPanel />
          )}
        </TabsContent>
      </Tabs>
    </Container>
  );
}

/* ------------------------------- locked panel ------------------------------- */

function LockedPersonalPanel() {
  return (
    <div className="mx-auto flex max-w-3xl flex-col items-center justify-center gap-3 rounded-2xl border border-white/10 bg-white/[0.02] p-10 text-center">
      <div className="rounded-full bg-rose-500/10 p-3 text-rose-300">
        <Lock className="h-6 w-6" aria-hidden />
      </div>
      <div>
        <p className="font-semibold text-zinc-100">Sign in for a personalized feed</p>
        <p className="mt-1 max-w-md text-sm text-zinc-400">
          Your &ldquo;For you&rdquo; stream ranks global activity by your taste profile and watch history.
        </p>
      </div>
      <Button
        type="button"
        className="bg-rose-600 font-bold text-white hover:bg-rose-500"
        onClick={() => navigate('/auth')}
      >
        <Lock aria-hidden /> Sign in
      </Button>
    </div>
  );
}

/* --------------------------------- feed list -------------------------------- */

function FeedList({ kind, userKey }: { kind: FeedKind; userKey: string }) {
  const feed = useApi(
    `feed-${kind}-${userKey}`,
    () => (kind === 'global' ? platform.globalFeed() : platform.personalFeed()),
  );

  /* "Load more" accumulates pages locally; reset whenever the base key refetches. */
  const [moreItems, setMoreItems] = useState<FeedActivity[]>([]);
  const [moreCursor, setMoreCursor] = useState<string | null | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);

  useEffect(() => {
    setMoreItems([]);
    setMoreCursor(undefined);
    setMoreError(null);
  }, [feed.data]);

  const items = useMemo(() => [...(feed.data?.data ?? []), ...moreItems], [feed.data, moreItems]);
  const activeCursor = moreCursor !== undefined ? moreCursor : (feed.data?.nextCursor ?? null);

  async function loadMore() {
    if (!activeCursor || loadingMore) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const res =
        kind === 'global' ? await platform.globalFeed(activeCursor) : await platform.personalFeed(activeCursor);
      setMoreItems((prev) => [...prev, ...res.data]);
      setMoreCursor(res.nextCursor);
    } catch (e) {
      setMoreError(e instanceof Error ? e.message : 'Nu am putut încărca mai multă activitate');
    } finally {
      setLoadingMore(false);
    }
  }

  if (feed.loading && !feed.data) {
    return <FeedSkeleton />;
  }
  if (feed.error && !feed.data) {
    return <ErrorState message={feed.error} onRetry={feed.refetch} />;
  }

  const basedOn = kind === 'personal' ? feed.data?.basedOn : undefined;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      {basedOn && (
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-xs font-semibold uppercase tracking-wider text-zinc-500">Based on</span>
            {basedOn.types.map((t) => (
              <TypeBadge key={`t-${t}`} type={t} />
            ))}
            {basedOn.genres.slice(0, 6).map((g) => (
              <span
                key={`g-${g}`}
                className="inline-flex items-center rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-0.5 text-[11px] font-medium text-zinc-300"
              >
                {g}
              </span>
            ))}
            {basedOn.trackedContent > 0 && (
              <span className="inline-flex items-center rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-0.5 text-[11px] font-medium text-zinc-300">
                {basedOn.trackedContent} tracked {basedOn.trackedContent === 1 ? 'title' : 'titles'}
              </span>
            )}
          </div>
          <p className="mt-2 text-xs text-zinc-500">Ranked by your preferences and watch history.</p>
        </div>
      )}

      {items.length === 0 ? (
        <EmptyState
          icon={<Clapperboard className="h-6 w-6" aria-hidden />}
          title={kind === 'personal' ? 'Încă nimic pentru tine' : 'Încă nimic — fii primul care comentează!'}
          message={
            kind === 'personal'
              ? 'Vizionează, apreciază și urmărește câteva titluri, iar fluxul tău personalizat se va aprinde.'
              : 'Deschide orice titlu și pornește conversația — comentariile, aprecierile și noutățile apar toate aici.'
          }
          action={
            <Button
              type="button"
              variant="outline"
              className="border-white/15 bg-white/5 hover:bg-white/10"
              onClick={() => navigate('/home')}
            >
              Browse the library
            </Button>
          }
        />
      ) : (
        <ol className="space-y-3" aria-label={`${kind === 'personal' ? 'Personalized' : 'Global'} activity`}>
          {items.map((activity, i) => (
            <li key={`${activity.type}-${activity.id}-${i}`}>
              <ActivityCard activity={activity} />
            </li>
          ))}
        </ol>
      )}

      {activeCursor && (
        <div className="space-y-2 pt-1">
          {moreError && (
            <p className="text-center text-xs text-rose-300" role="alert">
              {moreError}
            </p>
          )}
          <Button
            type="button"
            variant="outline"
            onClick={() => void loadMore()}
            disabled={loadingMore}
            className="w-full border-white/15 bg-white/5 font-semibold hover:bg-white/10"
          >
            {loadingMore ? (
              <Loader2 className="animate-spin" aria-hidden />
            ) : (
              <ChevronDown aria-hidden />
            )}
            {loadingMore ? 'Se încarcă…' : 'Încarcă mai mult'}
          </Button>
        </div>
      )}
    </div>
  );
}

/* ------------------------------ activity card ------------------------------ */

function ActivityCard({ activity }: { activity: FeedActivity }) {
  const meta = ACTIVITY_META[activity.type] ?? ACTIVITY_META.content;
  const Icon = meta.icon;
  const username = activity.user?.username;

  return (
    <article className="flex gap-4 rounded-xl border border-white/10 bg-white/[0.03] p-4 transition-colors hover:border-white/20">
      <span className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-xl border', meta.chip)} aria-hidden>
        <Icon className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <p className="min-w-0 text-sm text-zinc-400">
            {username ? <span className="font-semibold text-zinc-100">{username}</span> : null}
            {username ? ` ${meta.verb}` : meta.verb}
          </p>
          <time className="shrink-0 text-[11px] text-zinc-500" dateTime={activity.createdat}>
            {timeAgo(activity.createdat)}
          </time>
        </div>
        {activity.content ? <ContentMiniCard content={activity.content} /> : null}
        {activity.preview ? <p className="line-clamp-2 break-words text-sm text-zinc-400">{activity.preview}</p> : null}
      </div>
    </article>
  );
}

function ContentMiniCard({ content }: { content: NonNullable<FeedActivity['content']> }) {
  const [imgError, setImgError] = useState(false);
  const showImage = Boolean(content.thumbnail) && !imgError;

  return (
    <button
      type="button"
      onClick={() => navigate(`/content/${content.id}`)}
      aria-label={`Open ${content.title}`}
      className="flex w-full items-stretch gap-3 rounded-lg border border-white/10 bg-black/20 p-2 text-left transition-colors hover:border-rose-500/40 hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60"
    >
      <span className="h-20 w-16 shrink-0 overflow-hidden rounded-lg border border-white/10 bg-white/[0.03]">
        {showImage ? (
          <img
            src={content.thumbnail as string}
            alt=""
            loading="lazy"
            onError={() => setImgError(true)}
            className="h-full w-full object-cover"
          />
        ) : (
          <BrandPlaceholder title={content.title} />
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col justify-center gap-1.5 py-0.5">
        <span className="line-clamp-2 break-words text-sm font-semibold text-zinc-100">{content.title}</span>
        <TypeBadge type={content.type} className="self-start" />
      </span>
    </button>
  );
}

function FeedSkeleton() {
  return (
    <div className="mx-auto max-w-3xl space-y-3" aria-busy="true" aria-label="Loading activity feed">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex gap-4 rounded-xl border border-white/10 bg-white/[0.03] p-4">
          <Skeleton className="h-10 w-10 shrink-0 rounded-xl" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-44" />
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-24 w-full rounded-lg" />
          </div>
        </div>
      ))}
    </div>
  );
}

export default FeedView;
