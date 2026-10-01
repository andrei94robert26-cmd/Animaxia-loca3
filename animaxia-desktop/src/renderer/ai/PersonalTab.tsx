/**
 * ai/PersonalTab.tsx — "Personal" tab of the desktop AI Hub.
 *
 * GET /api/ai/personal/home (auth) →
 *   greeting (LLM) · mood chip · daily picks (vector-ranked, with reasons) ·
 *   because-you-watched row · AI taste profile (tags + summary) · quota meter ·
 *   weekly-recap expander (GET /api/ai/personal/recap on demand).
 *
 * Data flows through cached() (network-first + stale-on-error fallback) so the
 * tab keeps working offline; the useApi hook surfaces the `stale` flag as a
 * "served from cache" hint. 402 quota errors are folded into the data channel
 * by withQuotaGuard (useApi flattens thrown errors to plain strings, which
 * would otherwise make isApiError() quota detection impossible) → UpgradeCard.
 */

import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CalendarDays, ChevronDown, CloudOff, Sparkles } from 'lucide-react';
import { useAuth } from '@/auth/AuthContext';
import { useApi } from '@/hooks/useApi';
import { cached } from '@/api/cache';
import { errorMessage, isApiError } from '@/api/client';
import * as aiApi from '@/api/ai';
import type { AiPersonalHomeResponse, AiPersonalRecapResponse } from '@/api/ai';
import { ContentCard } from '@/components/content';
import { QuotaMeter } from '@/components/QuotaMeter';
import { Badge, SectionHeader } from '@/components/primitives';
import { ErrorState, SignInCard, Skeleton, SkeletonRow, UpgradeCard } from '@/components/states';
import { truncate } from '@/utils/format';
import styles from './PersonalTab.module.css';

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

/**
 * useApi flattens thrown errors to message strings, so quota (402) errors are
 * converted into a typed sentinel carried inside `data` — the render branch
 * turns them into <UpgradeCard> while every other error still reaches
 * <ErrorState> normally.
 */
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

/* --------------------------------- the tab ---------------------------------- */

export function PersonalTab(): React.JSX.Element {
  const { user } = useAuth();
  const navigate = useNavigate();

  const home = useApi(
    user ? withQuotaGuard(() => cached('ai:personal:home', aiApi.aiPersonalHome)) : null,
    [user?.id],
  );

  const [recapOpen, setRecapOpen] = useState(false);
  const recap = useApi<AiPersonalRecapResponse>(
    recapOpen && user ? () => cached('ai:personal:recap', aiApi.aiPersonalRecap) : null,
    [recapOpen, user?.id],
  );

  if (!user) {
    return (
      <SignInCard message="Personal AI reads your taste — sign in and Animaxia ranks your days with vector embeddings, answers with RAG and runs the assistant with tools." />
    );
  }

  const openContent = (id: number) => navigate(`/content/${id}`);

  if (home.loading) {
    return (
      <div className={styles.wrap} aria-busy>
        <div className={styles.recapSkeleton}>
          <Skeleton w="38%" h={26} radius={8} />
          <Skeleton w="72%" h={16} radius={6} />
        </div>
        <SkeletonRow count={5} />
        <SkeletonRow count={5} />
      </div>
    );
  }
  if (home.data && isQuotaBlocked(home.data)) {
    return <UpgradeCard message={home.data.quotaBlocked} />;
  }
  if (home.error) {
    return <ErrorState message={home.error} onRetry={home.refetch} />;
  }
  if (!home.data) {
    return <ErrorState message="Personal AI is unavailable" onRetry={home.refetch} />;
  }

  const d: AiPersonalHomeResponse = home.data;

  return (
    <div className={styles.wrap}>
      {/* greeting + mood */}
      <section className={styles.greetingCard} aria-label="AI greeting">
        <div className="row row--wrap">
          <Badge tone="rose">
            <Sparkles size={11} /> {d.mood}
          </Badge>
          <Badge tone={d.degraded ? 'amber' : 'zinc'}>
            {d.degraded ? `${d.provider} · offline mode` : d.provider}
          </Badge>
        </div>
        <h2 className={styles.greeting}>{d.greeting}</h2>
        <p className={styles.greetingSub}>Your day, ranked by the Animaxia vector engine.</p>
      </section>

      {/* AI taste profile */}
      <section className="card" aria-label="Your AI profile">
        <SectionHeader title="Your AI profile" subtitle="Learned from your ratings, watchlist and history" />
        {d.aiProfile.tags.length > 0 ? (
          <div className={styles.profileTags}>
            {d.aiProfile.tags.slice(0, 10).map((tag, i) => (
              <Badge key={`${tag}-${i}`} tone="zinc">
                {tag}
              </Badge>
            ))}
          </div>
        ) : (
          <p className="dim">No taste signal yet — watch and rate a few titles.</p>
        )}
        {d.aiProfile.summary ? <p className={styles.profileSummary}>{d.aiProfile.summary}</p> : null}
      </section>

      {d.quota ? <QuotaMeter quota={d.quota} /> : null}

      {/* daily picks */}
      <section>
        <SectionHeader title="Your daily picks" subtitle="Vector-ranked for today" />
        {d.dailyPicks.length === 0 ? (
          <p className="muted">Watch a few titles — the AI needs a taste to read.</p>
        ) : (
          <div className="row-scroller">
            {d.dailyPicks.map((pick) => (
              <ContentCard key={`${pick.id}-${pick.title}`} item={pick} reason={pick.reason} onOpen={openContent} />
            ))}
          </div>
        )}
      </section>

      {/* because you watched */}
      {d.becauseYouWatched.length > 0 ? (
        <section>
          <SectionHeader title="Because you watched…" subtitle="Nearest neighbours of your history" />
          <div className="row-scroller">
            {d.becauseYouWatched.map((item) => (
              <ContentCard
                key={`${item.id}-${item.title}`}
                item={{ ...item, rating: null, year: null }}
                reason={item.because}
                onOpen={openContent}
              />
            ))}
          </div>
        </section>
      ) : null}

      {/* weekly recap expander */}
      <section className={styles.recapCard} aria-label="Weekly recap">
        <button
          type="button"
          className={styles.recapHeader}
          onClick={() => setRecapOpen((v) => !v)}
          aria-expanded={recapOpen}
        >
          <CalendarDays size={15} color="var(--emerald)" />
          <span className={styles.recapTitle}>Your week on Animaxia</span>
          <ChevronDown size={15} color="var(--text-dim)" className={recapOpen ? styles.chevronUp : styles.chevron} />
        </button>
        {recapOpen ? (
          recap.loading ? (
            <div className={styles.recapSkeleton} aria-busy>
              <Skeleton w="82%" h={13} radius={6} />
              <Skeleton w="64%" h={13} radius={6} />
              <Skeleton w="40%" h={13} radius={6} />
            </div>
          ) : recap.error ? (
            <ErrorState message={recap.error} onRetry={recap.refetch} compact />
          ) : recap.data ? (
            <div className="stack">
              <span className={styles.recapWeek}>Week {recap.data.week}</span>
              <p className={styles.recapText}>{recap.data.recap}</p>
              <div className="row row--wrap">
                <Badge tone="emerald">{recap.data.stats.watched} watched</Badge>
                {recap.data.stats.topGenres.slice(0, 3).map((genre) => (
                  <Badge key={genre} tone="zinc">
                    {genre}
                  </Badge>
                ))}
              </div>
            </div>
          ) : (
            <p className={styles.recapPreview}>{d.recapPreview}</p>
          )
        ) : (
          <p className={styles.recapPreview}>
            {truncate(d.recapPreview, 220)}{' '}
            <button type="button" className={styles.recapLink} onClick={() => setRecapOpen(true)}>
              full recap
            </button>
          </p>
        )}
      </section>

      {home.stale ? (
        <button type="button" className={styles.staleRow} onClick={home.refetch}>
          <CloudOff size={13} />
          <span>Served from the offline cache — click to refresh</span>
        </button>
      ) : null}
    </div>
  );
}

export default PersonalTab;
