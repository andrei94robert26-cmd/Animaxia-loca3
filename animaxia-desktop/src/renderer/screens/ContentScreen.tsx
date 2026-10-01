/**
 * screens/ContentScreen.tsx — Content details + AI suite (desktop port).
 *
 *   GET /api/mobile/player/:id (cached)  → content · sources · primary · nextUp
 *   GET /api/ai/personal/player (auth)   → predicted rating + match score
 *                                         (cache key shared with PlayerScreen,
 *                                         so both screens use one payload)
 *   POST/DELETE /api/users/me/watchlist → save / unsave (optimistic, plan-limited)
 *
 * The signed-in header shows an "AI predicts ★ 8.7 for you" chip (+ % match)
 * whenever the companion payload is fresh and non-degraded — silent otherwise.
 * The AIPanel below provides Explain / More like this / Ask Animaxia AI.
 */

import React, { useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Bookmark, BookmarkCheck, Play, Sparkles, Star } from 'lucide-react';
import * as mobile from '../api/mobile';
import * as ai from '../api/ai';
import { cached } from '../api/cache';
import { useAuth } from '../auth/AuthContext';
import { useApi } from '../hooks/useApi';
import { useWatchlist } from '../watchlist/useWatchlist';
import { AIPanel } from '../components/AIPanel';
import { RatingChip } from '../components/content';
import { Button } from '../components/primitives';
import { ErrorState, SignInCard, Skeleton } from '../components/states';
import styles from './ContentScreen.module.css';

export default function ContentScreen(): React.JSX.Element {
  const navigate = useNavigate();
  const { id: idParam } = useParams();
  const idKey = idParam ?? '';
  const numericId = Number(idKey);
  const validId = Number.isInteger(numericId) && numericId > 0;

  const { user } = useAuth();
  const payload = useApi(validId ? () => mobile.getPlayerCached(idKey) : null, [idKey]);
  const companion = useApi(
    user && validId ? () => cached(`ai:companion:${idKey}`, () => ai.aiPersonalPlayer(numericId)) : null,
    [user?.id, idKey],
  );

  const watchlist = useWatchlist(Boolean(user));
  const inWatchlist = validId && watchlist.ids.has(numericId);

  /* Personal prediction — silent when degraded/missing, never blocks details. */
  const prediction = useMemo(() => {
    const data = companion.data;
    if (!data || data.degraded || data.predictedRating == null) return null;
    return { rating: data.predictedRating, match: data.matchScore };
  }, [companion.data]);

  if (!validId) {
    return <ErrorState message="That content id does not exist." />;
  }

  const content = payload.data?.content ?? null;

  if (payload.loading) {
    return (
      <div className="stack" style={{ gap: 14 }}>
        <Skeleton h={320} radius={16} />
        <Skeleton w="60%" h={26} />
        <Skeleton h={80} radius={12} />
        <Skeleton h={220} radius={16} />
      </div>
    );
  }

  if (payload.error) {
    return <ErrorState message={payload.error} onRetry={payload.refetch} />;
  }

  if (!content) return <></>;

  const backdrop = content.backdrop ?? content.thumbnail;

  return (
    <div>
      {/* backdrop hero */}
      <div className={styles.backdrop}>
        {backdrop ? <img src={backdrop} alt="" /> : null}
        <div className={styles.backdropShade} />
      </div>

      <h1 className={styles.title}>{content.title}</h1>

      {/* AI prediction chips (signed-in, non-degraded payloads only) */}
      {prediction ? (
        <div className={`${styles.chipRow}`} style={{ marginBottom: 10 }}>
          <span className="badge badge--rose" aria-label={`AI predicts ${prediction.rating.toFixed(1)} out of 10 for you`}>
            <Sparkles size={11} /> AI predicts <Star size={11} /> {prediction.rating.toFixed(1)} for you
          </span>
          {prediction.match != null ? (
            <span className="badge badge--emerald">{Math.round(prediction.match * 100)}% match</span>
          ) : null}
        </div>
      ) : null}

      {/* meta chips */}
      <div className={styles.chipRow}>
        {content.type ? <span className="badge badge--rose">{content.type}</span> : null}
        <RatingChip rating={content.rating} />
        {content.year != null && content.year !== '' ? (
          <span className="badge badge--zinc">{String(content.year)}</span>
        ) : null}
      </div>

      {content.overview ? <p className={styles.overview}>{content.overview}</p> : null}

      {/* actions */}
      {user ? (
        <>
          <div className={styles.actions}>
            <Button onClick={() => navigate(`/player/${idKey}`)}>
              <Play size={15} /> Play
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                void watchlist.toggle(numericId);
              }}
              aria-label={inWatchlist ? 'Remove from watchlist' : 'Add to watchlist'}
            >
              {inWatchlist ? <BookmarkCheck size={15} /> : <Bookmark size={15} />}
              {inWatchlist ? 'In watchlist' : 'Save'}
            </Button>
            {watchlist.stale ? <span className="badge badge--amber">cached list</span> : null}
          </div>
          {watchlist.lastError ? <p className={styles.actionError}>{watchlist.lastError}</p> : null}
        </>
      ) : (
        <div style={{ marginTop: 18 }}>
          <SignInCard message="Sign in to save titles to your watchlist and get personal AI picks." />
        </div>
      )}

      {/* AI suite — Explain this · More like this · Ask Animaxia AI */}
      <AIPanel contentId={numericId} title={content.title} />
    </div>
  );
}
