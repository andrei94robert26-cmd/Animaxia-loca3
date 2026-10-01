/**
 * feed/PersonalFeed.tsx — The AI-ranked personal feed (GET /api/ai/personal/feed,
 * auth): Animaxia AI Cloud re-ranks the activity stream for the signed-in user
 * and explains every card ("aiWhy"), topped by the weekly recap card.
 *
 *   • recap  → week label + recap text + stats chips (watched, top genres,
 *             top titles)
 *   • items  → comment / content activity rows: user chip or content thumbnail,
 *             preview, time-ago and the rose-tinted "Why Animaxia AI surfaced
 *             this" explanation
 *   • basedOn.personalized === false → dim notice that the ranker needs more
 *     watch/rate signal
 *
 * Served through cached() (network-first + stale-on-error); 402 quota errors
 * are folded into the data channel by withQuotaGuard (useApi flattens thrown
 * errors to strings, which would otherwise defeat isApiError detection).
 */

import React from 'react';
import { useNavigate } from 'react-router-dom';
import { CalendarDays, Clapperboard, MessageCircle, Sparkles } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useAuth } from '@/auth/AuthContext';
import { useApi } from '@/hooks/useApi';
import { cached } from '@/api/cache';
import { errorMessage, isApiError } from '@/api/client';
import * as aiApi from '@/api/ai';
import type { AiPersonalFeedItem, AiPersonalFeedResponse } from '@/api/ai';
import { Avatar, Badge } from '@/components/primitives';
import { EmptyState, ErrorState, SignInCard, Skeleton, UpgradeCard } from '@/components/states';
import { formatRelative, truncate } from '@/utils/format';
import styles from './PersonalFeed.module.css';

/* ------------------ 402 quota sentinel through the data channel -------------- */

/** Marks a 402 (upgrade) response — rendered as an UpgradeCard. */
interface QuotaBlocked {
  readonly quotaBlocked: string;
}

function isQuotaBlocked(value: unknown): value is QuotaBlocked {
  return (
    typeof value === 'object' &&
    value !== null &&
    'quotaBlocked' in value &&
    typeof (value as QuotaBlocked).quotaBlocked === 'string'
  );
}

function withQuotaGuard<T>(
  fetcher: () => Promise<{ data: T; stale: boolean }>,
): () => Promise<{ data: T | QuotaBlocked; stale: boolean }> {
  return async () => {
    try {
      return await fetcher();
    } catch (err) {
      if (isApiError(err) && (err.upgrade || err.status === 402)) {
        return { data: { quotaBlocked: errorMessage(err) }, stale: false };
      }
      throw err;
    }
  };
}

/* ------------------------------- a feed card -------------------------------- */

const ITEM_ICONS: Record<AiPersonalFeedItem['type'], LucideIcon> = {
  comment: MessageCircle,
  content: Clapperboard,
};

function FeedItemCard({ item, onOpen }: { item: AiPersonalFeedItem; onOpen: (id: number) => void }): React.JSX.Element {
  const TypeIcon = ITEM_ICONS[item.type] ?? Clapperboard;
  const contentId = item.contentid ?? null;

  return (
    <article className={styles.item}>
      <div className={styles.topRow}>
        {item.user ? <Avatar name={item.user} size={32} /> : <Avatar name="Animaxia" size={32} />}
        <div className={styles.topText}>
          <div className={styles.headLine}>
            <span className={styles.username}>{item.user ?? 'Someone'}</span>{' '}
            <span className={styles.verb}>{item.type === 'comment' ? 'commented on' : 'added'}</span>
            {item.content ? <> <span className={styles.contentInline}>{truncate(item.content, 40)}</span></> : null}
          </div>
          <span className={styles.time}>{formatRelative(item.createdat)}</span>
        </div>
        <TypeIcon size={15} className={styles.typeIcon} aria-label={item.type} />
      </div>

      {item.preview || item.thumbnail ? (
        <div className={styles.contentRow}>
          {item.thumbnail ? (
            <button
              type="button"
              className={styles.contentThumbButton}
              onClick={() => contentId && onOpen(contentId)}
              disabled={!contentId}
              aria-label={item.content ? `Open ${item.content}` : 'Content thumbnail'}
            >
              <img className={styles.contentThumb} src={item.thumbnail} alt="" loading="lazy" />
            </button>
          ) : null}
          {item.preview ? <p className={styles.preview}>{truncate(item.preview, 200)}</p> : null}
        </div>
      ) : null}

      {item.aiWhy ? (
        <div className={styles.aiWhy}>
          <Sparkles size={13} color="var(--rose-soft)" style={{ flexShrink: 0, marginTop: 2 }} />
          <div>
            <span className={styles.aiWhyLabel}>Why Animaxia AI surfaced this</span>
            <p className={styles.aiWhyText}>{item.aiWhy}</p>
          </div>
        </div>
      ) : null}
    </article>
  );
}

/* --------------------------------- the feed --------------------------------- */

export function PersonalFeed(): React.JSX.Element {
  const { user } = useAuth();
  const navigate = useNavigate();

  const feed = useApi(
    user ? withQuotaGuard(() => cached('ai:personal:feed', () => aiApi.aiPersonalFeed(12))) : null,
    [user?.id],
  );

  if (!user) {
    return <SignInCard message="Sign in — your personal feed is AI-ranked from what you watch, rate and save." />;
  }

  if (feed.loading) {
    return (
      <div className={styles.wrap} aria-busy>
        <Skeleton h={132} radius={16} />
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} h={150} radius={16} />
        ))}
      </div>
    );
  }
  if (feed.data && isQuotaBlocked(feed.data)) {
    return <UpgradeCard message={feed.data.quotaBlocked} />;
  }
  if (feed.error) {
    return <ErrorState message={feed.error} onRetry={feed.refetch} />;
  }
  if (!feed.data) {
    return <ErrorState message="The personal feed is unavailable" onRetry={feed.refetch} />;
  }

  const data: AiPersonalFeedResponse = feed.data;
  const openContent = (id: number) => navigate(`/content/${id}`);

  return (
    <div className={styles.wrap}>
      {!data.basedOn.personalized ? (
        <p className={styles.notice}>
          <Sparkles size={13} /> Not personalized yet — watch and rate a few titles first.
        </p>
      ) : null}

      {data.recap ? (
        <section className={styles.recapCard} aria-label="Weekly recap">
          <div className={styles.recapHeader}>
            <CalendarDays size={14} color="var(--emerald)" />
            <span className={styles.recapWeek}>Week {data.recap.week}</span>
          </div>
          <p className={styles.recapText}>{data.recap.recap}</p>
          <div className={styles.recapStats}>
            <Badge tone="emerald">{data.recap.stats.watched} watched</Badge>
            {data.recap.stats.topGenres.slice(0, 3).map((genre) => (
              <Badge key={genre} tone="zinc">
                {genre}
              </Badge>
            ))}
            {data.recap.stats.topTitles.slice(0, 3).map((title) => (
              <Badge key={title} tone="rose">
                {truncate(title, 26)}
              </Badge>
            ))}
          </div>
        </section>
      ) : null}

      {data.data.length === 0 ? (
        <EmptyState title="The AI needs more signal" hint="Watch and like a few titles — your ranked feed builds itself." />
      ) : (
        data.data.map((item, index) => (
          <FeedItemCard key={`${item.contentid ?? item.content}-${index}`} item={item} onOpen={openContent} />
        ))
      )}

      {feed.stale ? <p className="dim" style={{ margin: 0, textAlign: 'center', fontSize: 11 }}>Served from the offline cache — retry when back online</p> : null}
    </div>
  );
}

export default PersonalFeed;
