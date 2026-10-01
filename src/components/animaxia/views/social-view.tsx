'use client';

/**
 * social-view.tsx — Social hub (#/social). Five tabs (Feed / People / Reviews
 * / Parties / AI) plus the watch-party room (#/social/party/:id, rendered by
 * PartyRoom). The hub keeps ONE socket connection while mounted: live
 * activity events stream into the Feed tab and the presence count chips into
 * the header.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  CircleStop,
  Clapperboard,
  Crown,
  Loader2,
  LogIn,
  LogOut,
  MessageCircle,
  Radio,
  RefreshCw,
  Search,
  Sparkles,
  Star,
  UserPlus,
  Users,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/animaxia/api';
import { tokenStore, tryRefresh } from '@/lib/animaxia/platform';
import { useApi } from '@/lib/animaxia/hooks';
import { navigate, type AppRoute } from '@/lib/animaxia/router';
import {
  createSocialSocket,
  social,
  type ActivityEvent,
  type ActivityType,
  type PartyCard,
  type SocialAiHome,
  type SocialUserCard,
  type SocialUserProfile,
} from '@/lib/animaxia/social';
import type { DbContent } from '@/lib/animaxia/types';
import { useAuth } from '@/components/animaxia/auth-provider';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { Container, PageHeader, Section } from '../section';
import { BrandPlaceholder, EmptyState, ErrorState, TypeBadge } from '../states';
import { PartyRoom } from '../social/party-room';
import { ContentMiniCard, PlanBadge, RatingPill, SignInPrompt, UserAvatar, timeAgo } from '../social/social-ui';

/* ------------------------------ local helpers ------------------------------ */

type SocialTab = 'feed' | 'people' | 'reviews' | 'parties' | 'ai';

const TABS: { value: SocialTab; label: string }[] = [
  { value: 'feed', label: 'Feed' },
  { value: 'people', label: 'Persoane' },
  { value: 'reviews', label: 'Recenzii' },
  { value: 'parties', label: 'Vizionări în grup' },
  { value: 'ai', label: 'AI' },
];

const ACTIVITY_META: Record<ActivityType, { icon: React.ComponentType<{ className?: string }>; chip: string; verb: string }> = {
  review: {
    icon: Star,
    chip: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
    verb: 'a recenzat',
  },
  comment: {
    icon: MessageCircle,
    chip: 'border-teal-500/30 bg-teal-500/10 text-teal-300',
    verb: 'a comentat la',
  },
  follow: {
    icon: UserPlus,
    chip: 'border-violet-500/30 bg-violet-500/10 text-violet-300',
    verb: 'a început să urmărească pe',
  },
  'party:create': {
    icon: Users,
    chip: 'border-rose-500/30 bg-rose-500/10 text-rose-300',
    verb: 'a pornit o vizionare în grup pentru',
  },
  'party:join': {
    icon: LogIn,
    chip: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
    verb: 's-a alăturat la',
  },
  'party:ended': {
    icon: CircleStop,
    chip: 'border-white/15 bg-white/5 text-zinc-400',
    verb: 'a încheiat o vizionare în grup',
  },
};

function activityTarget(event: ActivityEvent): string | null {
  const meta = event.metadata || {};
  if (event.type === 'follow' && typeof meta.username === 'string') return meta.username;
  return null;
}

/* ---------------------------------- view ---------------------------------- */

export function SocialView({ route }: { route: AppRoute }) {
  if (route.params[0] === 'party') {
    const partyId = Number(route.params[1]);
    return <PartyRoom key={partyId} partyId={partyId} />;
  }
  return <SocialHub route={route} />;
}

function SocialHub({ route }: { route: AppRoute }) {
  const { user, initializing } = useAuth();
  const initialTab = route.query.get('tab');
  const [tab, setTab] = useState<SocialTab>(
    TABS.some((t) => t.value === initialTab) ? (initialTab as SocialTab) : 'feed',
  );

  /* ONE socket while the hub is mounted (anon ok): presence + live ticker.
     Created only after the session restore finishes, so the handshake always
     carries the FRESH access token (a stale token is rejected by the realtime
     service and would kill the ticker for the whole visit). */
  const [online, setOnline] = useState<number | null>(null);
  const [liveEvents, setLiveEvents] = useState<ActivityEvent[]>([]);

  useEffect(() => {
    if (initializing) return;
    const socket = createSocialSocket();
    socket.on('hello', (d: { online?: number }) => {
      if (typeof d.online === 'number') setOnline(d.online);
    });
    socket.on('presence:online', (d: { online: number }) => setOnline(d.online));
    socket.on('social:activity', (event: ActivityEvent) => {
      if (!event || typeof event !== 'object' || event.id == null) return;
      setLiveEvents((prev) => (prev.some((e) => e.id === event.id) ? prev : [event, ...prev].slice(0, 30)));
    });
    /* Auth rejected (e.g. the access token expired mid-session): rotate once
       and re-arm the handshake so the next reconnection attempt passes. */
    socket.on('connect_error', (err: Error) => {
      if (!/token/i.test(err.message)) return;
      void (async () => {
        if (tokenStore.refresh) await tryRefresh().catch(() => {});
        socket.auth = tokenStore.access ? { token: tokenStore.access } : {};
      })();
    });
    return () => {
      socket.removeAllListeners();
      socket.disconnect();
    };
  }, [initializing]);

  return (
    <Container className="space-y-8 py-8 sm:py-10">
      <PageHeader title="Social" subtitle="Urmărește oameni, recenzează titluri, intră în vizionări în grup — live.">
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {online != null && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-[11px] font-semibold text-emerald-300">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
              </span>
              {online} online
            </span>
          )}
          {!user && (
            <Button
              type="button"
              size="sm"
              className="bg-rose-600 font-bold text-white hover:bg-rose-500"
              onClick={() => navigate('/auth')}
            >
              <LogIn aria-hidden /> Sign in
            </Button>
          )}
        </div>
      </PageHeader>

      <Tabs value={tab} onValueChange={(v) => setTab(v as SocialTab)}>
        <TabsList className="h-10 w-full justify-start gap-1 overflow-x-auto rounded-xl border border-white/10 bg-white/[0.03] p-1 sm:w-auto">
          {TABS.map((t) => (
            <TabsTrigger
              key={t.value}
              value={t.value}
              className="shrink-0 whitespace-nowrap rounded-lg px-4 text-zinc-400 hover:text-zinc-100 data-[state=active]:bg-rose-600 data-[state=active]:text-white sm:px-5"
            >
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="feed" className="pt-6">
          <FeedTab liveEvents={liveEvents} />
        </TabsContent>
        <TabsContent value="people" className="pt-6">
          <PeopleTab />
        </TabsContent>
        <TabsContent value="reviews" className="pt-6">
          <ReviewsTab />
        </TabsContent>
        <TabsContent value="parties" className="pt-6">
          <PartiesTab />
        </TabsContent>
        <TabsContent value="ai" className="pt-6">
          <AiTab />
        </TabsContent>
      </Tabs>
    </Container>
  );
}

/* --------------------------------- feed tab -------------------------------- */

function FeedTab({ liveEvents }: { liveEvents: ActivityEvent[] }) {
  const { user } = useAuth();
  const feed = useApi(`social-feed-v2-${user ? `u${user.id}` : 'anon'}`, () =>
    user ? social.feed() : social.publicFeed(),
  );

  /* Cursor pagination — same accumulate-locally pattern as feed-view. */
  const [moreItems, setMoreItems] = useState<ActivityEvent[]>([]);
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
      const res = user ? await social.feed(activeCursor) : await social.publicFeed(activeCursor);
      setMoreItems((prev) => [...prev, ...res.data]);
      setMoreCursor(res.nextCursor);
    } catch (e) {
      setMoreError(e instanceof Error ? e.message : 'Nu am putut încărca mai multă activitate');
    } finally {
      setLoadingMore(false);
    }
  }

  if (feed.loading && !feed.data) return <FeedSkeleton />;
  if (feed.error && !feed.data) return <ErrorState message={feed.error} onRetry={feed.refetch} />;

  /* Live events on top, deduped against everything already listed. */
  const listedIds = new Set(items.map((e) => e.id));
  const fresh = liveEvents.filter((e) => !listedIds.has(e.id));

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      {fresh.length > 0 && (
        <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-rose-300">
          <Radio className="h-3.5 w-3.5 animate-pulse" aria-hidden /> Live
        </p>
      )}
      {fresh.map((event) => (
        <ActivityCard key={`live-${event.id}`} event={event} live />
      ))}
      {fresh.length > 0 && items.length > 0 && <div className="h-px bg-white/10" role="separator" />}

      {items.length === 0 && fresh.length === 0 ? (
        <EmptyState
          icon={<Clapperboard className="h-6 w-6" aria-hidden />}
          title="Încă nimic aici"
          message="Recenziile, urmăririle și vizionările în grup apar aici pe măsură ce se întâmplă. Fii primul — urmărește pe cineva sau pornește o vizionare în grup."
          action={
            <Button variant="outline" className="border-white/15 bg-white/5 hover:bg-white/10" onClick={() => navigate('/home')}>
              Răsfoiește biblioteca
            </Button>
          }
        />
      ) : (
        <ol className="space-y-3" aria-label="Social activity">
          {items.map((event, i) => (
            <li key={`${event.type}-${event.id}-${i}`}>
              <ActivityCard event={event} />
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
            {loadingMore ? <Loader2 className="animate-spin" aria-hidden /> : <ChevronDown aria-hidden />}
            {loadingMore ? 'Se încarcă…' : 'Încarcă mai mult'}
          </Button>
        </div>
      )}
    </div>
  );
}

function ActivityCard({ event, live }: { event: ActivityEvent; live?: boolean }) {
  const meta = ACTIVITY_META[event.type] ?? ACTIVITY_META.comment;
  const Icon = meta.icon;
  const target = activityTarget(event);

  return (
    <article
      className={cn(
        'flex gap-4 rounded-xl border bg-white/[0.03] p-4 transition-colors hover:border-white/20',
        live ? 'border-rose-500/30' : 'border-white/10',
      )}
    >
      <span className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-xl border', meta.chip)} aria-hidden>
        <Icon className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <p className="min-w-0 text-sm text-zinc-400">
            {live && (
              <span className="mr-1.5 inline-flex items-center gap-1 rounded-full bg-rose-600 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wider text-white">
                Live
              </span>
            )}
            <span className="font-semibold text-zinc-100">{event.user?.username}</span> {meta.verb}
            {target ? <span className="font-semibold text-zinc-100"> {target}</span> : null}
          </p>
          <time className="shrink-0 text-[11px] text-zinc-500" dateTime={event.createdat}>
            {timeAgo(event.createdat)}
          </time>
        </div>
        {event.content ? <ContentMiniCard content={event.content} /> : null}
        {event.preview ? <p className="line-clamp-2 break-words text-sm text-zinc-400">{event.preview}</p> : null}
      </div>
    </article>
  );
}

function FeedSkeleton() {
  return (
    <div className="mx-auto max-w-3xl space-y-3" aria-busy="true" aria-label="Loading social feed">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex gap-4 rounded-xl border border-white/10 bg-white/[0.03] p-4">
          <Skeleton className="h-10 w-10 shrink-0 rounded-xl" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-44" />
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-16 w-full rounded-lg" />
          </div>
        </div>
      ))}
    </div>
  );
}

/* -------------------------------- people tab ------------------------------- */

function PeopleTab() {
  const { user } = useAuth();
  const [query, setQuery] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [profileId, setProfileId] = useState<number | null>(null);

  /* Debounced search (400 ms). */
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQ(query.trim()), 400);
    return () => clearTimeout(timer);
  }, [query]);

  const people = useApi(
    `social-people-${debouncedQ.toLowerCase()}`,
    () => social.people(debouncedQ || undefined, 12),
    { enabled: !!user },
  );
  const following = useApi(`social-following-${user?.id ?? 'anon'}`, () => social.following(), { enabled: !!user });

  /* Optimistic follow overrides shared by every list below. */
  const [overrides, setOverrides] = useState<Record<number, boolean>>({});
  const [busy, setBusy] = useState<Record<number, boolean>>({});

  function isFollowing(u: SocialUserCard): boolean {
    return overrides[u.id] ?? u.isfollowing ?? false;
  }

  async function toggleFollow(u: SocialUserCard) {
    if (!user) {
      toast('Conectează-te pentru a urmări oameni');
      navigate('/auth');
      return;
    }
    if (busy[u.id]) return;
    const next = !isFollowing(u);
    setOverrides((prev) => ({ ...prev, [u.id]: next }));
    setBusy((prev) => ({ ...prev, [u.id]: true }));
    try {
      await (next ? social.follow(u.id) : social.unfollow(u.id));
    } catch (err) {
      setOverrides((prev) => ({ ...prev, [u.id]: !next }));
      toast.error(err instanceof Error ? err.message : 'Nu am putut actualiza urmăririle');
    } finally {
      setBusy((prev) => ({ ...prev, [u.id]: false }));
    }
  }

  if (!user) {
    return (
      <SignInPrompt
        title="Conectează-te pentru a descoperi oameni"
        message="Urmărește recenzenți cu gusturi asemeniătoare — tabul Persoane clasifică comunitatea ca să-ți construiești feed-ul."
      />
    );
  }

  return (
    <div className="space-y-8">
      <div className="mx-auto max-w-2xl">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" aria-hidden />
          <label htmlFor="people-search" className="sr-only">
            Search people
          </label>
          <Input
            id="people-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Caută persoane după nume de utilizator…"
            autoComplete="off"
            className="h-11 rounded-xl border-white/10 bg-white/[0.04] pl-10 text-sm text-zinc-100 placeholder:text-zinc-500 focus-visible:border-rose-500/50 focus-visible:ring-rose-500/30"
          />
        </div>
      </div>

      <Section
        title={debouncedQ ? `Rezultate pentru „${debouncedQ}”` : 'Persoane sugerate'}
        subtitle="Cei mai activi membri ai comunității."
      >
        {people.loading && !people.data ? (
          <PeopleGridSkeleton />
        ) : people.error ? (
          <ErrorState message={people.error} onRetry={people.refetch} />
        ) : (people.data?.data ?? []).length === 0 ? (
          <EmptyState
            icon={<Users className="h-6 w-6" aria-hidden />}
            title={debouncedQ ? 'Nimeni nu corespunde căutării' : 'Încă nicio persoană'}
            message={debouncedQ ? 'Încearcă alt nume de utilizator.' : 'Comunitatea va apărea aici pe măsură ce se alătură oameni.'}
          />
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="Suggested people">
            {(people.data?.data ?? []).map((u) => (
              <li key={u.id}>
                <PersonCard person={u} following={isFollowing(u)} busy={!!busy[u.id]} onToggle={() => void toggleFollow(u)} onOpen={() => setProfileId(u.id)} />
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Urmărești" subtitle="Oamenii a căror activitate îți umple tabul Feed.">
        {following.loading && !following.data ? (
          <div className="space-y-2" aria-busy="true">
            <Skeleton className="h-16 w-full rounded-xl" />
            <Skeleton className="h-16 w-full rounded-xl" />
          </div>
        ) : following.error ? (
          <ErrorState message={following.error} onRetry={following.refetch} compact />
        ) : (following.data?.data ?? []).length === 0 ? (
          <EmptyState
            icon={<UserPlus className="h-6 w-6" aria-hidden />}
            title="Încă nu urmărești pe nimeni"
            message="Urmărește câțiva oameni de mai sus, iar recenziile, comentariile și vizionările lor în grup îți vor lumina feed-ul."
          />
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2" aria-label="People you follow">
            {(following.data?.data ?? []).map((u) => (
              <li key={u.id}>
                <PersonCard
                  person={u}
                  following={isFollowing(u)}
                  busy={!!busy[u.id]}
                  onToggle={() => void toggleFollow(u)}
                  onOpen={() => setProfileId(u.id)}
                />
              </li>
            ))}
          </ul>
        )}
      </Section>

      <ProfileDialog
        userId={profileId}
        onClose={() => setProfileId(null)}
        isFollowing={(u) => isFollowing(u)}
        busy={(id) => !!busy[id]}
        onToggle={(u) => void toggleFollow(u)}
      />
    </div>
  );
}

function PersonCard({
  person,
  following,
  busy,
  onToggle,
  onOpen,
}: {
  person: SocialUserCard;
  following: boolean;
  busy: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  return (
    <Card className="group border-white/10 bg-white/[0.03] transition-colors hover:border-white/20">
      <CardContent className="flex items-center gap-3 p-4">
        <button
          type="button"
          onClick={onOpen}
          aria-label={`Open ${person.username}'s profile`}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60"
        >
          <UserAvatar username={person.username} avatar={person.avatar} className="h-11 w-11 shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-sm font-bold text-zinc-100">{person.username}</span>
              <PlanBadge plan={person.plan} />
            </span>
            <span className="mt-0.5 block text-xs text-zinc-500">
              {person.followers} {person.followers === 1 ? 'follower' : 'followers'} · {person.reviews}{' '}
              {person.reviews === 1 ? 'review' : 'reviews'}
            </span>
          </span>
        </button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onToggle}
          disabled={busy}
          aria-pressed={following}
          className={cn(
            'shrink-0 font-semibold',
            following
              ? 'border-white/15 bg-white/5 text-zinc-300 hover:bg-white/10'
              : 'border-rose-500/40 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20 hover:text-rose-200',
          )}
        >
          {busy ? (
            <Loader2 className="animate-spin" aria-hidden />
          ) : following ? (
            <>
              <LogOut aria-hidden /> Unfollow
            </>
          ) : (
            <>
              <UserPlus aria-hidden /> Follow
            </>
          )}
        </Button>
      </CardContent>
    </Card>
  );
}

function PeopleGridSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true" aria-label="Loading people">
      {Array.from({ length: 6 }).map((_, i) => (
        <Skeleton key={i} className="h-[76px] rounded-xl" />
      ))}
    </div>
  );
}

/* ------------------------------ profile dialog ----------------------------- */

function ProfileDialog({
  userId,
  onClose,
  isFollowing,
  busy,
  onToggle,
}: {
  userId: number | null;
  onClose: () => void;
  isFollowing: (u: SocialUserCard) => boolean;
  busy: (id: number) => boolean;
  onToggle: (u: SocialUserCard) => void;
}) {
  const profile = useApi(`social-profile-${userId ?? 0}`, () => social.userProfile(userId as number), {
    enabled: userId != null,
  });

  const data: SocialUserProfile | null = userId != null ? profile.data : null;
  const person: SocialUserCard | null = data
    ? {
        id: data.user.id,
        username: data.user.username,
        avatar: data.user.avatar,
        plan: data.user.plan,
        followers: data.stats.followers,
        following: data.stats.following,
        reviews: data.stats.reviews,
        isfollowing: data.relation?.isfollowing ?? false,
      }
    : null;

  return (
    <Dialog open={userId != null} onOpenChange={(open) => !open && onClose()}>
      {/* aria-describedby={undefined}: the description only renders once the
          profile loads (Radix warns when a DialogContent has no description). */}
      <DialogContent
        aria-describedby={undefined}
        className="max-h-[85vh] max-w-2xl overflow-y-auto border-white/10 bg-[#12121c] text-zinc-100 custom-scrollbar"
      >
        {userId == null ? null : !data ? (
          profile.error ? (
            <div>
              <DialogTitle className="sr-only">Member profile</DialogTitle>
              <ErrorState message={profile.error} onRetry={profile.refetch} compact />
            </div>
          ) : (
            <div className="space-y-4" aria-busy="true" aria-label="Loading profile">
              <DialogTitle className="sr-only">Member profile</DialogTitle>
              <div className="flex items-center gap-3">
                <Skeleton className="h-14 w-14 rounded-full" />
                <div className="space-y-2">
                  <Skeleton className="h-5 w-36" />
                  <Skeleton className="h-3 w-24" />
                </div>
              </div>
              <Skeleton className="h-20 w-full rounded-xl" />
              <Skeleton className="h-32 w-full rounded-xl" />
            </div>
          )
        ) : !person ? null : (
          <>
            <DialogHeader>
              <div className="flex items-center gap-3">
                <UserAvatar username={data.user.username} avatar={data.user.avatar} className="h-14 w-14" />
                <div className="min-w-0 flex-1">
                  <DialogTitle className="flex flex-wrap items-center gap-2 truncate text-lg font-black text-white">
                    {data.user.username}
                    <PlanBadge plan={data.user.plan} />
                  </DialogTitle>
                  <DialogDescription className="mt-0.5">
                    Alăturat din {new Date(data.user.createdat).toLocaleDateString('ro-RO', { month: 'short', day: 'numeric', year: 'numeric' })}
                    {data.relation?.followsme ? ' · follows you' : ''}
                  </DialogDescription>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onToggle(person)}
                  disabled={busy(person.id)}
                  aria-pressed={isFollowing(person)}
                  className={cn(
                    'shrink-0 font-semibold',
                    isFollowing(person)
                      ? 'border-white/15 bg-white/5 text-zinc-300 hover:bg-white/10'
                      : 'border-rose-500/40 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20 hover:text-rose-200',
                  )}
                >
                  {busy(person.id) ? (
                    <Loader2 className="animate-spin" aria-hidden />
                  ) : isFollowing(person) ? (
                    <>
                      <LogOut aria-hidden /> Unfollow
                    </>
                  ) : (
                    <>
                      <UserPlus aria-hidden /> Follow
                    </>
                  )}
                </Button>
              </div>
            </DialogHeader>

            <div className="space-y-5">
              {/* Stats row */}
              <dl className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                {[
                  { label: 'Urmăritori', value: data.stats.followers },
                  { label: 'Urmărești', value: data.stats.following },
                  { label: 'Recenzii', value: data.stats.reviews },
                  { label: 'Comentarii', value: data.stats.comments },
                  { label: 'Vizionări în grup', value: data.stats.partiesHosted },
                ].map((s) => (
                  <div key={s.label} className="rounded-xl border border-white/10 bg-white/[0.03] p-2.5 text-center">
                    <dd className="text-base font-black text-zinc-100">{s.value}</dd>
                    <dt className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">{s.label}</dt>
                  </div>
                ))}
              </dl>

              {/* Taste overlap */}
              {data.taste && (data.taste.score > 0 || data.taste.sharedGenres.length > 0) && (
                <div className="rounded-xl border border-rose-500/20 bg-rose-500/[0.06] p-4">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-bold text-zinc-100">
                    <Sparkles className="h-4 w-4 text-rose-400" aria-hidden />
                    Taste overlap
                    <span className="rounded-full border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-[11px] font-bold text-rose-300">
                      {Math.round(data.taste.score * 100)}% match
                    </span>
                  </p>
                  {data.taste.sharedGenres.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {data.taste.sharedGenres.slice(0, 8).map((g) => (
                        <span
                          key={g}
                          className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-0.5 text-[11px] font-medium text-zinc-300"
                        >
                          {g}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Recent reviews */}
              <Section title="Recenzii recente">
                {data.recentReviews.length === 0 ? (
                  <p className="text-sm text-zinc-500">No reviews yet.</p>
                ) : (
                  <ul className="space-y-3">
                    {data.recentReviews.slice(0, 4).map((r) => (
                      <li key={r.id} className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <RatingPill rating={r.rating} />
                          {r.title ? <span className="text-sm font-semibold text-zinc-100">{r.title}</span> : null}
                          <span className="ml-auto text-[11px] text-zinc-500">{timeAgo(r.createdat)}</span>
                        </div>
                        <p className="mt-1.5 line-clamp-2 text-sm text-zinc-400">{r.body}</p>
                        <div className="mt-2">
                          <ContentMiniCard content={r.content} compact />
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>

              {/* Recent activity */}
              <Section title="Activitate recentă">
                {data.recentActivity.length === 0 ? (
                  <p className="text-sm text-zinc-500">No recent activity.</p>
                ) : (
                  <ul className="space-y-1.5">
                    {data.recentActivity.slice(0, 5).map((a) => {
                      const meta = ACTIVITY_META[(a.type as ActivityType) ?? 'comment'] ?? ACTIVITY_META.comment;
                      const Icon = meta.icon;
                      return (
                        <li key={a.id} className="flex items-center gap-2.5 text-sm text-zinc-400">
                          <span className={cn('grid h-7 w-7 shrink-0 place-items-center rounded-lg border', meta.chip)} aria-hidden>
                            <Icon className="h-3.5 w-3.5" />
                          </span>
                          <span className="min-w-0 flex-1 truncate">
                            {meta.verb} {a.content ? <span className="font-semibold text-zinc-200">{a.content.title}</span> : null}
                          </span>
                          <span className="shrink-0 text-[11px] text-zinc-500">{timeAgo(a.createdat)}</span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Section>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------- reviews tab ------------------------------- */

function ReviewsTab() {
  const { user } = useAuth();
  const reviews = useApi('social-recent-reviews', () => social.recentReviews(20));

  /* Optimistic like toggles keyed by review id. */
  const [likes, setLikes] = useState<Record<number, { likes: number; liked: boolean }>>({});
  const [busy, setBusy] = useState<Record<number, boolean>>({});

  async function toggleLike(id: number) {
    if (!user) {
      toast('Conectează-te pentru a aprecia recenziile');
      navigate('/auth');
      return;
    }
    if (busy[id]) return;
    const current =
      likes[id] ??
      (() => {
        const r = reviews.data?.data.find((x) => x.id === id);
        return r ? { likes: r.likes, liked: r.liked } : null;
      })();
    if (!current) return;
    const next = { likes: current.liked ? current.likes - 1 : current.likes + 1, liked: !current.liked };
    setLikes((prev) => ({ ...prev, [id]: next }));
    setBusy((prev) => ({ ...prev, [id]: true }));
    try {
      const res = await social.likeReview(id);
      setLikes((prev) => ({ ...prev, [id]: { likes: res.likes, liked: res.liked } }));
    } catch (err) {
      setLikes((prev) => ({ ...prev, [id]: current }));
      toast.error(err instanceof Error ? err.message : 'Nu am putut aprecia recenzia');
    } finally {
      setBusy((prev) => ({ ...prev, [id]: false }));
    }
  }

  if (reviews.loading && !reviews.data) {
    return (
      <div className="mx-auto max-w-3xl space-y-3" aria-busy="true" aria-label="Loading reviews">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-36 w-full rounded-xl" />
        ))}
      </div>
    );
  }
  if (reviews.error && !reviews.data) return <ErrorState message={reviews.error} onRetry={reviews.refetch} />;

  const list = reviews.data?.data ?? [];

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      {list.length === 0 ? (
        <EmptyState
          icon={<Star className="h-6 w-6" aria-hidden />}
          title="Încă nicio recenzie"
          message="Deschide orice titlu și împărtășește-ți verdictul — cele mai proaspete recenzii ale comunității apar aici."
          action={
            <Button variant="outline" className="border-white/15 bg-white/5 hover:bg-white/10" onClick={() => navigate('/home')}>
              Caută ceva de recenzat
            </Button>
          }
        />
      ) : (
        <ol className="space-y-3" aria-label="Recenzii recente ale comunității">
          {list.map((r) => {
            const likeState = likes[r.id] ?? { likes: r.likes, liked: r.liked };
            return (
              <li key={r.id}>
                <article className="rounded-xl border border-white/10 bg-white/[0.03] p-4 transition-colors hover:border-white/20">
                  <div className="flex items-center gap-2.5">
                    <UserAvatar username={r.user.username} avatar={r.user.avatar} className="h-8 w-8" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-bold text-zinc-100">{r.user.username}</p>
                      <p className="text-[11px] text-zinc-500">{timeAgo(r.createdat)}</p>
                    </div>
                    <RatingPill rating={r.rating} />
                  </div>
                  {r.title ? <p className="mt-2.5 text-sm font-semibold text-zinc-100">{r.title}</p> : null}
                  <p className="mt-1 line-clamp-3 break-words text-sm text-zinc-400">{r.body}</p>
                  <div className="mt-2.5">
                    <ContentMiniCard content={r.content} compact />
                  </div>
                  <div className="mt-2.5 flex items-center justify-between gap-3">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => void toggleLike(r.id)}
                      disabled={!!busy[r.id]}
                      aria-pressed={likeState.liked}
                      className={cn(
                        'gap-1.5 text-zinc-400 hover:bg-white/5 hover:text-white',
                        likeState.liked && 'text-rose-300 hover:text-rose-200',
                      )}
                    >
                      {busy[r.id] ? (
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                      ) : (
                        <Star className={cn('h-4 w-4', likeState.liked && 'fill-rose-400')} aria-hidden />
                      )}
                      {likeState.likes} {likeState.likes === 1 ? 'like' : 'likes'}
                    </Button>
                  </div>
                </article>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

/* ------------------------------- parties tab ------------------------------- */

function PartiesTab() {
  const { user } = useAuth();
  const parties = useApi('social-parties', () => social.parties(20));

  /* NEON FREE PLAN: auto-refresh la 5 MIN (fost 30s), doar tab vizibil —
   * lista de vizionări în grup; butonul manual de mai jos forțează update. */
  const partiesRef = useRef(parties.refetch);
  partiesRef.current = parties.refetch;
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') partiesRef.current().catch(() => {});
    }, 5 * 60 * 1000);
    return () => clearInterval(timer);
  }, []);

  /* Join by code. */
  const [code, setCode] = useState('');
  const [joiningCode, setJoiningCode] = useState(false);

  async function joinByCode() {
    const clean = code.trim().toUpperCase();
    if (clean.length !== 6 || joiningCode) return;
    if (!user) {
      toast('Conectează-te pentru a intra în vizionări în grup');
      navigate('/auth');
      return;
    }
    setJoiningCode(true);
    try {
      const res = await social.joinByCode(clean);
      navigate(`/social/party/${res.party.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Nu am putut intra cu acel cod');
    } finally {
      setJoiningCode(false);
    }
  }

  /* Join an active party. */
  const [joiningId, setJoiningId] = useState<number | null>(null);

  async function joinParty(p: PartyCard) {
    if (!user) {
      toast('Conectează-te pentru a intra în vizionări în grup');
      navigate('/auth');
      return;
    }
    if (joiningId != null) return;
    setJoiningId(p.id);
    try {
      await social.partyJoin(p.id);
      navigate(`/social/party/${p.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not join the party');
    } finally {
      setJoiningId(null);
    }
  }

  /* Start-a-party dialog. */
  const [startOpen, setStartOpen] = useState(false);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="grid gap-3 sm:grid-cols-2">
        {/* Join by code */}
        <Card className="border-white/10 bg-white/[0.03]">
          <CardContent className="p-4">
            <p className="text-sm font-bold text-zinc-100">Join by code</p>
            <p className="mt-0.5 text-xs text-zinc-500">Got an invite code? Hop straight in.</p>
            <form
              className="mt-3 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void joinByCode();
              }}
            >
              <label htmlFor="party-code" className="sr-only">
                Invite code
              </label>
              <Input
                id="party-code"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))}
                placeholder="XXXXXX"
                autoComplete="off"
                maxLength={6}
                className="h-10 rounded-xl border-white/10 bg-black/40 font-mono text-sm font-bold tracking-[0.25em] text-zinc-100 placeholder:tracking-[0.25em] placeholder:text-zinc-600"
              />
              <Button
                type="submit"
                disabled={code.trim().length !== 6 || joiningCode}
                className="h-10 shrink-0 bg-rose-600 font-bold text-white hover:bg-rose-500"
              >
                {joiningCode ? <Loader2 className="animate-spin" aria-hidden /> : <LogIn aria-hidden />}
                Join
              </Button>
            </form>
          </CardContent>
        </Card>

        {/* Start a party */}
        <Card className="border-white/10 bg-white/[0.03]">
          <CardContent className="flex h-full flex-col p-4">
            <p className="text-sm font-bold text-zinc-100">Pornește o vizionare în grup</p>
            <p className="mt-0.5 flex-1 text-xs text-zinc-500">
              Alege orice titlu din bibliotecă, invită prietenii cu codul și vizionează sincronizat — tu controlezi redarea.
            </p>
            <Button
              type="button"
              onClick={() => setStartOpen(true)}
              className="mt-3 w-full bg-rose-600 font-bold text-white hover:bg-rose-500"
            >
              <Users aria-hidden /> Vizionare nouă în grup
            </Button>
          </CardContent>
        </Card>
      </div>

      <Section
        title="Vizionări active"
        subtitle="Camere live în care poți intra chiar acum."
        action={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void parties.refetch()}
            disabled={parties.loading}
            className="h-8 border-white/15 bg-white/5 text-zinc-200 hover:bg-white/10 hover:text-white"
          >
            <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', parties.loading && 'animate-spin')} aria-hidden />
            Refresh
          </Button>
        }
      >
        {parties.loading && !parties.data ? (
          <div className="space-y-3" aria-busy="true" aria-label="Se încarcă vizionările">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-24 w-full rounded-xl" />
            ))}
          </div>
        ) : parties.error && !parties.data ? (
          <ErrorState message={parties.error} onRetry={parties.refetch} />
        ) : (parties.data?.data ?? []).length === 0 ? (
          <EmptyState
            icon={<Users className="h-6 w-6" aria-hidden />}
            title="Nicio vizionare în grup activă"
            message="Pornește una mai sus — alege un titlu, distribuie codul de invitație și vizionează împreună, sincronizat."
          />
        ) : (
          <ul className="space-y-3" aria-label="Vizionări în grup active">
            {(parties.data?.data ?? []).map((p) => (
              <li key={p.id}>
                <article className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-3 transition-colors hover:border-white/20 sm:gap-4 sm:p-4">
                  <span className="h-[72px] w-12 shrink-0 overflow-hidden rounded-lg border border-white/10 bg-white/[0.03]">
                    {p.content.thumbnail ? (
                      <img src={p.content.thumbnail} alt="" loading="lazy" className="h-full w-full object-cover" />
                    ) : (
                      <BrandPlaceholder title={p.content.title} />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="min-w-0 truncate text-sm font-bold text-zinc-100">{p.title}</p>
                      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-rose-300">
                        <span className="relative flex h-1.5 w-1.5">
                          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-400 opacity-75" />
                          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-rose-400" />
                        </span>
                        Live
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
                      <span className="inline-flex items-center gap-1.5">
                        <Crown className="h-3.5 w-3.5 text-amber-400" aria-hidden />
                        <span className="font-semibold text-zinc-300">{p.host.username}</span>
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <Users className="h-3.5 w-3.5" aria-hidden /> {p.members}
                      </span>
                      <TypeBadge type={p.content.type} />
                      <span>{timeAgo(p.createdat)}</span>
                    </div>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => void joinParty(p)}
                    disabled={joiningId === p.id}
                    className="shrink-0 bg-rose-600 font-bold text-white hover:bg-rose-500"
                  >
                    {joiningId === p.id ? <Loader2 className="animate-spin" aria-hidden /> : <LogIn aria-hidden />}
                    Intră
                  </Button>
                </article>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <StartPartyDialog open={startOpen} onOpenChange={setStartOpen} />
    </div>
  );
}

/* ---------------------------- start party dialog ---------------------------- */

function StartPartyDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { user } = useAuth();
  const [query, setQuery] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [results, setResults] = useState<DbContent[]>([]);
  const [searching, setSearching] = useState(false);
  const [creatingId, setCreatingId] = useState<number | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQ(query.trim()), 400);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    if (debouncedQ.length === 0) {
      setResults([]);
      return;
    }
    setSearching(true);
    api
      .all({ search: debouncedQ, limit: 12 })
      .then((res) => {
        if (!cancelled) setResults(res.data);
      })
      .catch(() => {
        if (!cancelled) setResults([]);
      })
      .finally(() => {
        if (!cancelled) setSearching(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedQ, open]);

  async function createParty(content: DbContent) {
    if (!user || creatingId != null) return;
    setCreatingId(content.id);
    try {
      const res = await social.createParty({ contentId: content.id });
      toast.success('Vizionarea în grup a pornit — distribuie codul de invitație');
      onOpenChange(false);
      navigate(`/social/party/${res.party.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Nu am putut porni vizionarea în grup');
    } finally {
      setCreatingId(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-xl overflow-y-auto border-white/10 bg-[#12121c] text-zinc-100 custom-scrollbar">
        <DialogHeader>
          <DialogTitle className="text-lg font-black text-white">Pornește o vizionare în grup</DialogTitle>
          <DialogDescription>
            Alege un titlu din bibliotecă — devii gazdă, iar redarea ta îi sincronizează pe toți din cameră.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" aria-hidden />
          <label htmlFor="party-content-search" className="sr-only">
            Caută titluri
          </label>
          <Input
            id="party-content-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Caută în bibliotecă…"
            autoComplete="off"
            className="h-11 rounded-xl border-white/10 bg-white/[0.04] pl-10 text-sm text-zinc-100 placeholder:text-zinc-500 focus-visible:border-rose-500/50 focus-visible:ring-rose-500/30"
          />
        </div>

        <div className="min-h-[120px]">
          {searching ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" aria-busy="true" aria-label="Se caută titluri">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-[104px] rounded-xl" />
              ))}
            </div>
          ) : debouncedQ.length === 0 ? (
            <p className="py-8 text-center text-sm text-zinc-500">Scrie cel puțin un caracter pentru a căuta în bibliotecă.</p>
          ) : results.length === 0 ? (
            <p className="py-8 text-center text-sm text-zinc-500">Niciun titlu nu corespunde căutării.</p>
          ) : (
            <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3" aria-label="Rezultatele căutării">
              {results.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => void createParty(c)}
                    disabled={creatingId != null}
                    className="group flex w-full flex-col gap-2 rounded-xl border border-white/10 bg-white/[0.03] p-2 text-left transition hover:border-rose-500/40 hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60 disabled:opacity-60"
                  >
                    <span className="aspect-[2/3] w-full overflow-hidden rounded-lg border border-white/10 bg-white/[0.03]">
                      {c.thumbnail ? (
                        <img src={c.thumbnail} alt="" loading="lazy" className="h-full w-full object-cover" />
                      ) : (
                        <BrandPlaceholder title={c.title} />
                      )}
                    </span>
                    <span className="line-clamp-2 text-xs font-semibold leading-tight text-zinc-100">{c.title}</span>
                    <span className="flex items-center gap-1.5">
                      <TypeBadge type={c.type} />
                      {creatingId === c.id && <Loader2 className="ml-auto h-3.5 w-3.5 animate-spin text-rose-400" aria-hidden />}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ---------------------------------- AI tab --------------------------------- */

function AiTab() {
  const { user } = useAuth();
  const home = useApi(`social-ai-home-${user?.id ?? 'anon'}`, () => social.aiHome(), { enabled: !!user });

  if (!user) {
    return (
      <SignInPrompt
        title="Conectează-te pentru alegerile AI sociale"
        message="Prietenii-au-vizionat-și, potriviri de gusturi și favoritele comunității — calculate din oamenii pe care îi urmărești."
      />
    );
  }

  if (home.loading && !home.data) {
    return (
      <div className="space-y-6" aria-busy="true" aria-label="Se încarcă alegerile AI sociale">
        <Skeleton className="h-6 w-52" />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="aspect-[2/3] rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-6 w-44" />
        <Skeleton className="h-24 w-full rounded-xl" />
      </div>
    );
  }
  if (home.error && !home.data) return <ErrorState message={home.error} onRetry={home.refetch} />;

  const data: SocialAiHome | null = home.data;
  if (!data) return null;

  const empty =
    data.friendsAlsoWatched.length === 0 && data.tasteMatches.length === 0 && data.socialPicks.length === 0;

  return (
    <div className="space-y-10">
      {empty && (
        <EmptyState
          icon={<Sparkles className="h-6 w-6" aria-hidden />}
          title="Încă nicio alegere socială"
          message="Urmărește câțiva oameni și vizionează câteva titluri — AI-ul încrucișează istoricul tău cu al lor pentru a construi aceste alegeri."
        />
      )}

      {data.friendsAlsoWatched.length > 0 && (
        <Section title="Prietenii au vizionat și" subtitle="De la oamenii pe care îi urmărești.">
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" aria-label="Prietenii au vizionat și">
            {data.friendsAlsoWatched.map((item) => (
              <li key={item.content.id}>
                <AiContentCard
                  contentId={item.content.id}
                  title={item.content.title}
                  type={item.content.type}
                  thumbnail={item.content.thumbnail}
                  reason={
                    item.friendNames.length > 0
                      ? `Pentru că ${item.friendNames[0]}${item.friends > 1 ? ` și încă ${item.friends - 1}` : ''} l-au vizionat`
                      : null
                  }
                  rating={item.avgRating}
                />
              </li>
            ))}
          </ul>
        </Section>
      )}

      {data.tasteMatches.length > 0 && (
        <Section title="Potrivirile tale de gusturi" subtitle="Membri al căror istoric de vizionare se suprapune cu al tău.">
          <ul className="space-y-2.5" aria-label="Potriviri de gusturi">
            {data.tasteMatches.map((m) => (
              <li
                key={m.user.id}
                className="flex flex-wrap items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-3"
              >
                <UserAvatar username={m.user.username} avatar={m.user.avatar} className="h-10 w-10" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold text-zinc-100">{m.user.username}</p>
                  <p className="text-xs text-zinc-500">
                    {m.sharedTitles} {m.sharedTitles === 1 ? 'titlu comun' : 'titluri comune'}
                  </p>
                  {m.genreOverlap.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {m.genreOverlap.slice(0, 5).map((g) => (
                        <span
                          key={g}
                          className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] font-medium text-zinc-300"
                        >
                          {g}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <span className="shrink-0 rounded-full border border-rose-500/30 bg-rose-500/10 px-2.5 py-0.5 text-[11px] font-bold text-rose-300">
                  {Math.round(m.score * 100)}% potrivire
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {data.socialPicks.length > 0 && (
        <Section title="Adorate de comunitate" subtitle="Titlurile cu cele mai bune note de la oamenii pe care îi urmărești.">
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" aria-label="Adorate de comunitate">
            {data.socialPicks.map((item) => (
              <li key={item.content.id}>
                <AiContentCard
                  contentId={item.content.id}
                  title={item.content.title}
                  type={item.content.type}
                  thumbnail={item.content.thumbnail}
                  reason={
                    item.reviewers.length > 0
                      ? `Adorat de ${item.reviewers.slice(0, 2).join(', ')}${item.reviewers.length > 2 ? ` +${item.reviewers.length - 2}` : ''}`
                      : null
                  }
                  rating={item.avgRating}
                  extra={
                    item.reviewCount > 0 ? (
                      <span className="text-[10px] text-zinc-500">
                        {item.reviewCount} {item.reviewCount === 1 ? 'recenzie' : 'recenzii'}
                      </span>
                    ) : null
                  }
                />
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

function AiContentCard({
  contentId,
  title,
  type,
  thumbnail,
  reason,
  rating,
  extra,
}: {
  contentId: number;
  title: string;
  type: string;
  thumbnail: string | null;
  reason: string | null;
  rating: number | null;
  extra?: React.ReactNode;
}) {
  const [imgError, setImgError] = useState(false);
  return (
    <button
      type="button"
      onClick={() => navigate(`/content/${contentId}`)}
      aria-label={`Deschide ${title}`}
      className="group flex w-full flex-col gap-2 rounded-xl border border-white/10 bg-white/[0.03] p-2 text-left transition hover:border-rose-500/40 hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60"
    >
      <span className="relative aspect-[2/3] w-full overflow-hidden rounded-lg border border-white/10 bg-white/[0.03]">
        {thumbnail && !imgError ? (
          <img
            src={thumbnail}
            alt=""
            loading="lazy"
            onError={() => setImgError(true)}
            className="h-full w-full object-cover transition group-hover:scale-[1.03]"
          />
        ) : (
          <BrandPlaceholder title={title} />
        )}
        {rating != null && (
          <span className="absolute right-1.5 top-1.5">
            <RatingPill rating={Math.round(rating * 10) / 10} />
          </span>
        )}
      </span>
      <span className="line-clamp-2 text-xs font-semibold leading-tight text-zinc-100">{title}</span>
      <span className="flex flex-wrap items-center gap-1.5">
        <TypeBadge type={type} />
        {extra}
      </span>
      {reason && <span className="line-clamp-2 text-[11px] leading-snug text-zinc-500">{reason}</span>}
    </button>
  );
}

export default SocialView;
