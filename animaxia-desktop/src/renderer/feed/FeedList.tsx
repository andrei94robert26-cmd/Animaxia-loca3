/**
 * feed/FeedList.tsx — The GLOBAL social activity feed (/api/social/feed/global,
 * public). Cursor-paginated: the first page loads on mount, further pages
 * append behind the "Load more" button until nextCursor runs dry.
 *
 * Activity row: type icon (lucide) + avatar + username (or "System" for new
 * content drops) + verb + time-ago, a clickable content-reference chip and a
 * truncated preview line. Content chips navigate to /content/:id.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Clapperboard, MessageCircle, ThumbsUp, UserRound } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { errorMessage } from '@/api/client';
import * as socialApi from '@/api/social';
import type { Activity } from '@/api/social';
import { Avatar, Button } from '@/components/primitives';
import { EmptyState, ErrorState, Skeleton } from '@/components/states';
import { formatRelative, truncate } from '@/utils/format';
import styles from './FeedList.module.css';

const PAGE_SIZE = 20;

const VERBS: Record<Activity['type'], string> = {
  comment: 'commented on',
  like: 'liked',
  content: 'added',
  user: 'joined Animaxia',
};

const TYPE_ICONS: Record<Activity['type'], LucideIcon> = {
  comment: MessageCircle,
  like: ThumbsUp,
  content: Clapperboard,
  user: UserRound,
};

/* ------------------------------- a single row ------------------------------- */

function ActivityRow({ activity, onOpen }: { activity: Activity; onOpen: (id: number) => void }): React.JSX.Element {
  const TypeIcon = TYPE_ICONS[activity.type] ?? UserRound;
  const content = activity.content;
  const actor = activity.user?.username ?? 'System';

  return (
    <article className={styles.item}>
      <div className={styles.topRow}>
        {activity.user ? (
          <Avatar url={activity.user.avatar} name={activity.user.username} size={36} />
        ) : (
          <Avatar name="System" size={36} />
        )}
        <div className={styles.topText}>
          <div className={styles.headLine}>
            <span className={styles.username}>{actor}</span> <span className={styles.verb}>{VERBS[activity.type]}</span>
            {content?.title ? <> <span className={styles.contentInline}>{truncate(content.title, 42)}</span></> : null}
          </div>
          <span className={styles.time}>{formatRelative(activity.createdat)}</span>
        </div>
        <TypeIcon size={15} className={styles.typeIcon} aria-label={activity.type} />
      </div>

      {content ? (
        <button
          type="button"
          className={styles.contentChip}
          onClick={() => onOpen(content.id)}
          aria-label={`Open ${content.title}`}
        >
          {content.thumbnail ? (
            <img className={styles.contentThumb} src={content.thumbnail} alt="" loading="lazy" />
          ) : (
            <span className={styles.contentThumbFallback} aria-hidden>
              <Clapperboard size={15} />
            </span>
          )}
          <span className={styles.contentChipText}>
            <span className={styles.contentChipTitle}>{content.title}</span>
            <span className={styles.contentChipType}>{content.type}</span>
          </span>
        </button>
      ) : null}

      {activity.preview ? <p className={styles.preview}>{truncate(activity.preview, 220)}</p> : null}
    </article>
  );
}

/* --------------------------------- the list --------------------------------- */

export function FeedList(): React.JSX.Element {
  const navigate = useNavigate();

  const [activities, setActivities] = useState<Activity[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPage = useCallback(async (nextCursor: string | null, replace: boolean) => {
    if (replace) setLoading(true);
    else setLoadingMore(true);
    setError(null);
    try {
      const page = await socialApi.feedGlobal(nextCursor, PAGE_SIZE);
      setActivities((prev) => (replace ? page.data : [...prev, ...page.data]));
      setCursor(page.nextCursor ?? null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    void fetchPage(null, true);
  }, [fetchPage]);

  const openContent = (id: number) => navigate(`/content/${id}`);

  if (loading && activities.length === 0) {
    return (
      <div className={styles.wrap} aria-busy>
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} h={104} radius={16} />
        ))}
      </div>
    );
  }

  if (error && activities.length === 0) {
    return <ErrorState message={error} onRetry={() => void fetchPage(null, true)} />;
  }

  if (activities.length === 0) {
    return (
      <EmptyState
        title="Nothing happening yet"
        hint="Comments, likes and new titles from the community land here."
      />
    );
  }

  return (
    <div className={styles.wrap}>
      {activities.map((activity, index) => (
        <ActivityRow key={`${activity.type}-${activity.id}-${index}`} activity={activity} onOpen={openContent} />
      ))}

      {error ? <ErrorState message={error} onRetry={() => void fetchPage(cursor, false)} compact /> : null}

      {cursor ? (
        <Button variant="outline" full loading={loadingMore} disabled={loadingMore} onClick={() => void fetchPage(cursor, false)}>
          Load more
        </Button>
      ) : (
        <p className={styles.endNote}>You&apos;re all caught up</p>
      )}
    </div>
  );
}

export default FeedList;
