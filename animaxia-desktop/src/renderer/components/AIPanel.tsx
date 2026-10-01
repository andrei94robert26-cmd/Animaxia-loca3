/**
 * components/AIPanel.tsx — The content-screen AI suite (desktop port of the
 * mobile panel). Three modes over the Animaxia AI Cloud:
 *
 *   Explain          POST /api/ai/rag/explain    → matchScore + explanation +
 *                    vector-neighbour chips (public, anonymous quota)
 *   More like this   POST /api/ai/rag/recommend  → vector-ranked picks
 *   Ask Animaxia AI  POST /api/ai/rag/chat       → chat-with-content (auth)
 *
 * Handles the full state matrix: skeletons, errors + retry, 402 upgrade cards
 * (daily quota per plan), offline fallback for explain/recommend, quota meter
 * per response, provider/degraded badges.
 *
 * FAZA 7: navigation goes through react-router (useNavigate).
 */

import React, { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowUp, MessageCircle, PersonStanding, Sparkles } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { useApi } from '../hooks/useApi';
import { isApiError } from '../api/client';
import { cached } from '../api/cache';
import * as aiApi from '../api/ai';
import type { AiChatTurn } from '../api/ai';
import { Tabs } from './primitives';
import { ContentCard } from './content';
import { QuotaMeter } from './QuotaMeter';
import { ErrorState, SignInCard, Skeleton, UpgradeCard } from './states';
import styles from './AIPanel.module.css';

type PanelMode = 'explain' | 'more' | 'ask';

const MODES: { value: PanelMode; label: string }[] = [
  { value: 'explain', label: 'Explain this' },
  { value: 'more', label: 'More like this' },
  { value: 'ask', label: 'Ask Animaxia AI' },
];

export function AIPanel({ contentId, title }: { contentId: number; title: string }): React.JSX.Element {
  const [mode, setMode] = useState<PanelMode>('explain');

  return (
    <section className={styles.wrap} aria-label="Animaxia AI panel">
      <header className={styles.header}>
        <Sparkles size={16} color="var(--rose-soft)" />
        <span className={styles.headerTitle}>Animaxia AI</span>
        <span className="badge badge--rose">RAG · vector</span>
      </header>
      <Tabs tabs={MODES} value={mode} onChange={setMode} />
      <div className={styles.pane}>
        {mode === 'explain' ? <ExplainPane contentId={contentId} /> : null}
        {mode === 'more' ? <MorePane title={title} /> : null}
        {mode === 'ask' ? <AskPane contentId={contentId} title={title} /> : null}
      </div>
    </section>
  );
}

/* ------------------------------ shared helpers ------------------------------ */

function isQuotaError(err: unknown): boolean {
  return isApiError(err) && (err.upgrade || err.status === 402);
}

function ProviderBadge({ provider, degraded }: { provider?: string; degraded?: boolean }): React.JSX.Element | null {
  if (!provider) return null;
  return (
    <div>
      <span className={`badge ${degraded ? 'badge--amber' : 'badge--emerald'}`}>
        {degraded ? `${provider} · offline mode` : provider.toUpperCase()}
      </span>
    </div>
  );
}

/* -------------------------------- ExplainPane ------------------------------- */

function ExplainPane({ contentId }: { contentId: number }): React.JSX.Element {
  const navigate = useNavigate();
  const state = useApi(
    () => cached(`ai:explain:${contentId}`, () => aiApi.aiRagExplain(contentId)),
    [contentId],
  );

  if (state.loading) {
    return (
      <div className={styles.stack}>
        <Skeleton w="55%" h={18} />
        <Skeleton h={88} radius={12} />
        <Skeleton w="40%" h={14} />
      </div>
    );
  }
  if (state.error && isQuotaError(state.errorObj)) {
    return <UpgradeCard message={isApiError(state.errorObj) ? state.errorObj.message : 'Daily AI quota reached'} />;
  }
  if (state.error) return <ErrorState message={state.error} onRetry={state.refetch} compact />;
  if (!state.data) return <></>;

  const { data } = state;
  return (
    <div className={styles.stack}>
      {data.matchScore != null ? (
        <div className={styles.matchRow}>
          <PersonStanding size={15} color="var(--emerald)" />
          <span className={styles.matchText}>
            Your match: <strong className={styles.matchStrong}>{Math.round(data.matchScore * 100)}%</strong>
          </span>
        </div>
      ) : null}
      <p className={styles.answer}>{data.explanation}</p>
      <ProviderBadge provider={data.provider} degraded={data.degraded} />
      {data.similar && data.similar.length > 0 ? (
        <div className={styles.stack}>
          <div className={styles.neighborTitle}>Vector neighbours</div>
          <div className={styles.chipRow}>
            {data.similar.slice(0, 8).map((n) => (
              <button
                key={`${n.id}-${n.title}`}
                type="button"
                className="chip"
                onClick={() => navigate(`/content/${n.id}`)}
                aria-label={`Open ${n.title}`}
              >
                <span className={styles.neighborName}>{n.title}</span>
                <span className="chip__score">{n.score.toFixed(2)}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {data.quota ? <QuotaMeter quota={data.quota} /> : null}
      {state.stale ? <span className={styles.staleHint}>cached answer — retry when back online</span> : null}
    </div>
  );
}

/* --------------------------------- MorePane --------------------------------- */

function MorePane({ title }: { title: string }): React.JSX.Element {
  const navigate = useNavigate();
  const state = useApi(
    () => cached(`ai:more:${title}`, () => aiApi.aiRagRecommend(title, 6)),
    [title],
  );

  if (state.loading) {
    return (
      <div className="row">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} w={108} h={162} radius={12} />
        ))}
      </div>
    );
  }
  if (state.error && isQuotaError(state.errorObj)) {
    return <UpgradeCard message={isApiError(state.errorObj) ? state.errorObj.message : 'Daily AI quota reached'} />;
  }
  if (state.error) return <ErrorState message={state.error} onRetry={state.refetch} compact />;
  if (!state.data) return <></>;

  const picks = state.data.data ?? [];
  if (picks.length === 0) return <p className="muted">No similar titles found yet.</p>;

  return (
    <div className={styles.stack}>
      {state.data.intro ? <p className={styles.answer}>{state.data.intro}</p> : null}
      <div className="row-scroller">
        {picks.map((pick) => (
          <ContentCard key={`${pick.id}-${pick.title}`} item={pick} reason={pick.reason} onOpen={(id) => navigate(`/content/${id}`)} />
        ))}
      </div>
      <ProviderBadge provider={state.data.provider} degraded={state.data.degraded} />
      {state.data.quota ? <QuotaMeter quota={state.data.quota} /> : null}
    </div>
  );
}

/* ---------------------------------- AskPane --------------------------------- */

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  sources?: { id: number; title: string; score: number }[];
}

function AskPane({ contentId, title }: { contentId: number; title: string }): React.JSX.Element {
  const { user } = useAuth();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const history = useMemo<AiChatTurn[]>(
    () => turns.slice(-8).map((t) => ({ role: t.role, content: t.content })),
    [turns],
  );

  const send = useCallback(async () => {
    const message = draft.trim();
    if (!message || sending) return;
    setDraft('');
    setError(null);
    setSending(true);
    setTurns((prev) => [...prev, { role: 'user', content: message }]);
    try {
      const res = await aiApi.aiRagChat(contentId, message, history);
      setTurns((prev) => [...prev, { role: 'assistant', content: res.reply, sources: res.sources }]);
    } catch (err) {
      setTurns((prev) => prev.slice(0, -1)); // roll back the optimistic user bubble
      setDraft(message);
      setError(isApiError(err) ? err.message : 'The assistant is unreachable');
    } finally {
      setSending(false);
    }
  }, [draft, sending, contentId, history]);

  if (!user) {
    return (
      <SignInCard message="Sign in to chat with this title — the assistant answers from the video metadata." />
    );
  }

  return (
    <div className={styles.stack}>
      <p className={styles.askHint}>
        Chat about <strong>{title}</strong> — answers are grounded in the library (RAG).
      </p>

      {turns.length === 0 && !sending ? (
        <div className={styles.stack}>
          {['Is this good for beginners?', 'What is it about, no spoilers?', 'Who would enjoy this?'].map((q) => (
            <button key={q} type="button" className="chip" onClick={() => setDraft(q)}>
              <MessageCircle size={13} color="var(--rose-soft)" /> {q}
            </button>
          ))}
        </div>
      ) : null}

      <div className={styles.chatLog}>
        {turns.map((turn, index) => (
          <div key={`${turn.role}-${index}`} className={`${styles.bubble} ${turn.role === 'user' ? styles.bubbleUser : styles.bubbleAi}`}>
            <div className={turn.role === 'user' ? styles.bubbleUserText : styles.bubbleAiText}>{turn.content}</div>
            {turn.sources && turn.sources.length > 0 ? (
              <div className={styles.sourceRow}>
                <span className={styles.sourceLabel}>based on:</span>
                {turn.sources.slice(0, 3).map((s) => (
                  <span key={s.id} className="badge badge--zinc">
                    {s.title} · {s.score.toFixed(2)}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        ))}
        {sending ? (
          <div className={`${styles.bubble} ${styles.bubbleAi}`}>
            <div className={styles.bubbleAiText}>thinking…</div>
          </div>
        ) : null}
      </div>

      {error ? <ErrorState message={error} compact onRetry={() => setError(null)} /> : null}

      <div className={styles.inputRow}>
        <textarea
          className="textarea"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={`Ask about ${title}…`}
          maxLength={2000}
          aria-label="Ask Animaxia AI"
          rows={2}
        />
        <button
          type="button"
          className="btn"
          onClick={() => void send()}
          disabled={!draft.trim() || sending}
          aria-label="Send message"
        >
          <ArrowUp size={16} />
        </button>
      </div>
    </div>
  );
}

export default AIPanel;
