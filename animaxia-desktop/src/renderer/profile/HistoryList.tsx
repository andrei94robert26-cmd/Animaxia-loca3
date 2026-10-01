/**
 * profile/HistoryList.tsx — Continue-watching rows (profile domain).
 *
 * Fetches GET /api/users/me/history directly (NOT offline-cached — history
 * changes on every progress save) and renders one row per entry: thumbnail
 * (or a fallback tile), title, progress bar, "x ago" stamp and a Resume
 * button that jumps into the player.
 *
 * The list caps its height (max-h-96) and scrolls internally so the Profile
 * screen never grows unbounded on binge nights.
 */

import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Play } from 'lucide-react';
import { getHistory } from '@/api/users';
import type { HistoryEntry } from '@/api/users';
import { useApi } from '@/hooks/useApi';
import { Button } from '@/components/primitives';
import { EmptyState, ErrorState, Skeleton } from '@/components/states';
import { formatRelative, progressPercent } from '@/utils/format';
import styles from './HistoryList.module.css';

function HistoryRow({ entry, onResume }: { entry: HistoryEntry; onResume: () => void }): React.JSX.Element {
  const content = entry.content;
  const percent = progressPercent(entry.progress);
  return (
    <div className={styles.row}>
      {content.thumbnail ? (
        <img className={styles.thumb} src={content.thumbnail} alt="" loading="lazy" />
      ) : (
        <div className={`${styles.thumb} ${styles.thumbFallback}`}>{content.title}</div>
      )}
      <div className={styles.info}>
        <div className={styles.title}>{content.title}</div>
        <div
          className={styles.progressTrack}
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${content.title} progress`}
        >
          <div className={styles.progressFill} style={{ width: `${Math.max(3, percent)}%` }} />
        </div>
        <div className="dim">
          {formatRelative(entry.watchedat)}
          {entry.watchedat ? ' · ' : ''}
          {percent}% watched
        </div>
      </div>
      <Button size="sm" variant="ghost" onClick={onResume}>
        <Play size={13} /> Resume
      </Button>
    </div>
  );
}

export function HistoryList({ limit = 8 }: { limit?: number }): React.JSX.Element {
  const navigate = useNavigate();
  // Direct fetch (never cached) — history mutates on every playback save.
  const state = useApi(
    () => getHistory(limit).then((res) => ({ data: res.data, stale: false })),
    [limit],
  );

  if (state.loading) {
    return (
      <div className="stack" aria-hidden>
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} h={82} radius={12} />
        ))}
      </div>
    );
  }

  if (state.error) {
    return <ErrorState message={state.error} compact onRetry={state.refetch} />;
  }

  const entries = state.data ?? [];
  if (entries.length === 0) {
    return (
      <EmptyState
        title="Nothing watched yet"
        hint="Your progress appears here once you start playing a title."
        action={
          <Button size="sm" onClick={() => navigate('/')}>
            Browse Home
          </Button>
        }
      />
    );
  }

  return (
    <div className={styles.list}>
      {entries.map((entry) => (
        <HistoryRow
          key={entry.content.id}
          entry={entry}
          onResume={() => navigate(`/player/${entry.content.id}`)}
        />
      ))}
    </div>
  );
}

export default HistoryList;
