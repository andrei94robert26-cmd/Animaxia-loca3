/**
 * ai/RagLab.tsx — "RAG Lab" tab of the desktop AI Hub: a PUBLIC playground
 * over the Animaxia RAG surface (pgvector embeddings). Works signed-out on the
 * anonymous 5/day quota; signed-in answers additionally rank against the
 * user's taste vectors.
 *
 *   Recommend  POST /api/ai/rag/recommend { query, limit }  → intro + ranked
 *              picks with reasons + vector scores
 *   Summarize  POST /api/ai/rag/summarize { contentId }     → grounded,
 *              spoiler-light summary
 *   Explain    POST /api/ai/rag/explain { contentId, question? } → match % +
 *              explanation + vector-neighbour chips (tap → Content)
 *
 * The three tools are fully independent: each owns its loading / error /
 * quota state and retry button. Lab actions are LIVE queries (no response
 * caching) so every run re-queries the vector store; provider + degraded
 * badges and the per-plan quota meter surface per response.
 */

import React, { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FlaskConical, PersonStanding, Search, Sparkles, SquareTerminal } from 'lucide-react';
import { errorMessage, isApiError } from '@/api/client';
import * as aiApi from '@/api/ai';
import type {
  AiRagExplainResponse,
  AiRagRecommendResponse,
  AiRagSummarizeResponse,
} from '@/api/ai';
import { Badge, Button, Input } from '@/components/primitives';
import { ContentCard } from '@/components/content';
import { QuotaMeter } from '@/components/QuotaMeter';
import { ErrorState, LoadingState, UpgradeCard } from '@/components/states';
import styles from './RagLab.module.css';

/* ------------------------------ shared helpers ------------------------------ */

function isQuotaError(err: unknown): boolean {
  return isApiError(err) && (err.upgrade || err.status === 402);
}

function quotaMessage(err: unknown): string {
  return isApiError(err) ? err.message : 'Daily AI quota reached';
}

function labMessage(err: unknown): string {
  const msg = errorMessage(err);
  return /quota|402|upgrade/i.test(msg) ? msg : `The AI engine is unreachable — ${msg}`;
}

/** "42" → 42; "" / "abc" / "-1" → null. */
function parseContentId(raw: string): number | null {
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Provider chip — amber "degraded" variant when the LLM fell back offline. */
function ProviderBadge({ provider, degraded }: { provider?: string; degraded?: boolean }): React.JSX.Element | null {
  if (!provider) return null;
  return <Badge tone={degraded ? 'amber' : 'emerald'}>{degraded ? `${provider} · offline mode` : provider}</Badge>;
}

/** Result block header shared by the three tools. */
function ToolShell({
  icon,
  title,
  tag,
  hint,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  tag: string;
  hint: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className={styles.tool} aria-label={title}>
      <header className={styles.toolHeader}>
        {icon}
        <span className={styles.toolTitle}>{title}</span>
        <Badge tone="zinc">{tag}</Badge>
      </header>
      <p className={styles.toolHint}>{hint}</p>
      <div className={styles.toolBody}>{children}</div>
    </section>
  );
}

/* ------------------------------ Recommend tool ------------------------------ */

const RECOMMEND_LIMIT = 6;

function RecommendTool(): React.JSX.Element {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quotaBlocked, setQuotaBlocked] = useState<string | null>(null);
  const [result, setResult] = useState<AiRagRecommendResponse | null>(null);

  const run = useCallback(async () => {
    const q = query.trim();
    if (!q || loading) return;
    setLoading(true);
    setError(null);
    setQuotaBlocked(null);
    try {
      setResult(await aiApi.aiRagRecommend(q, RECOMMEND_LIMIT));
    } catch (err) {
      setResult(null);
      if (isQuotaError(err)) setQuotaBlocked(quotaMessage(err));
      else setError(labMessage(err));
    } finally {
      setLoading(false);
    }
  }, [query, loading]);

  const picks = result?.data ?? [];

  return (
    <ToolShell
      icon={<Search size={15} color="var(--rose-soft)" />}
      title="Recommend"
      tag="vector"
      hint="Describe what you feel like — the vector engine ranks the whole library and explains every pick. Live query, up to 6 results."
    >
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="e.g. dark sci-fi anime with mechs"
        aria-label="Recommendation query"
        maxLength={200}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void run();
          }
        }}
      />
      <Button onClick={() => void run()} disabled={!query.trim()} loading={loading} full>
        Find titles
      </Button>

      {loading ? <LoadingState label="searching the vector store…" compact /> : null}
      {!loading && quotaBlocked ? <UpgradeCard message={quotaBlocked} /> : null}
      {!loading && error ? <ErrorState message={error} onRetry={() => void run()} compact /> : null}

      {!loading && result ? (
        <div className={styles.results}>
          <div className={styles.metaRow}>
            <ProviderBadge provider={result.provider} degraded={result.degraded} />
            {result.personalized ? <Badge tone="rose">personalized ranking</Badge> : null}
          </div>
          {result.intro ? <p className={styles.lead}>{result.intro}</p> : null}
          {picks.length === 0 ? (
            <p className="dim">Nothing matched — try a broader description.</p>
          ) : (
            <div className={styles.picksScroll}>
              {picks.map((pick, index) => (
                <div key={`${pick.id}-${index}`} className={styles.pickCell}>
                  <ContentCard
                    item={pick}
                    reason={pick.reason}
                    onOpen={(id) => navigate(`/content/${id}`)}
                  />
                  <span className={styles.pickScore}>
                    <Sparkles size={10} /> {Number(pick.score ?? 0).toFixed(2)}
                  </span>
                </div>
              ))}
            </div>
          )}
          {result.quota ? <QuotaMeter quota={result.quota} /> : null}
        </div>
      ) : null}
    </ToolShell>
  );
}

/* ------------------------------ Summarize tool ------------------------------ */

function SummarizeTool(): React.JSX.Element {
  const navigate = useNavigate();
  const [idDraft, setIdDraft] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quotaBlocked, setQuotaBlocked] = useState<string | null>(null);
  const [result, setResult] = useState<AiRagSummarizeResponse | null>(null);

  const id = parseContentId(idDraft);

  const run = useCallback(async () => {
    if (!id || loading) return;
    setLoading(true);
    setError(null);
    setQuotaBlocked(null);
    try {
      setResult(await aiApi.aiRagSummarize(id));
    } catch (err) {
      setResult(null);
      if (isQuotaError(err)) setQuotaBlocked(quotaMessage(err));
      else setError(labMessage(err));
    } finally {
      setLoading(false);
    }
  }, [id, loading]);

  return (
    <ToolShell
      icon={<SquareTerminal size={15} color="var(--rose-soft)" />}
      title="Summarize"
      tag="grounded"
      hint="Spoiler-light summary of any title, cited from the library metadata. Try 1."
    >
      <Input
        value={idDraft}
        onChange={(e) => setIdDraft(e.target.value)}
        placeholder="Content id — e.g. 1"
        aria-label="Content id"
        inputMode="numeric"
        maxLength={9}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void run();
          }
        }}
      />
      <Button onClick={() => void run()} disabled={!id} loading={loading} full>
        Summarize
      </Button>

      {loading ? <LoadingState label="reading the library…" compact /> : null}
      {!loading && quotaBlocked ? <UpgradeCard message={quotaBlocked} /> : null}
      {!loading && error ? <ErrorState message={error} onRetry={() => void run()} compact /> : null}

      {!loading && result ? (
        <div className={styles.results}>
          <blockquote className={styles.summaryCard}>
            <p className={styles.summaryTitle}>{result.title}</p>
            <p className={styles.summaryBody}>{result.summary}</p>
          </blockquote>
          <div className={styles.openChipRow}>
            <ProviderBadge provider={result.provider} degraded={result.degraded} />
            {id ? (
              <button type="button" className="chip" onClick={() => navigate(`/content/${id}`)}>
                Open title
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </ToolShell>
  );
}

/* ------------------------------- Explain tool ------------------------------- */

function ExplainTool(): React.JSX.Element {
  const navigate = useNavigate();
  const [idDraft, setIdDraft] = useState('');
  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quotaBlocked, setQuotaBlocked] = useState<string | null>(null);
  const [result, setResult] = useState<AiRagExplainResponse | null>(null);

  const id = parseContentId(idDraft);

  const run = useCallback(async () => {
    if (!id || loading) return;
    const q = question.trim();
    setLoading(true);
    setError(null);
    setQuotaBlocked(null);
    try {
      setResult(await aiApi.aiRagExplain(id, q || undefined));
    } catch (err) {
      setResult(null);
      if (isQuotaError(err)) setQuotaBlocked(quotaMessage(err));
      else setError(labMessage(err));
    } finally {
      setLoading(false);
    }
  }, [id, question, loading]);

  const similar = result?.similar ?? [];

  return (
    <ToolShell
      icon={<PersonStanding size={15} color="var(--rose-soft)" />}
      title="Explain"
      tag="match"
      hint="Ask “will I like this?” — the engine matches the title against your taste vectors (works anonymously too). Try 1."
    >
      <Input
        value={idDraft}
        onChange={(e) => setIdDraft(e.target.value)}
        placeholder="Content id — e.g. 1"
        aria-label="Content id"
        inputMode="numeric"
        maxLength={9}
      />
      <Input
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        placeholder="Optional question — e.g. is it slow-paced?"
        aria-label="Optional question for the RAG engine"
        maxLength={200}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void run();
          }
        }}
      />
      <Button onClick={() => void run()} disabled={!id} loading={loading} full>
        Explain the match
      </Button>

      {loading ? <LoadingState label="matching your taste…" compact /> : null}
      {!loading && quotaBlocked ? <UpgradeCard message={quotaBlocked} /> : null}
      {!loading && error ? <ErrorState message={error} onRetry={() => void run()} compact /> : null}

      {!loading && result ? (
        <div className={styles.results}>
          <div className={styles.matchRow}>
            {result.matchScore != null ? (
              <>
                <span className={styles.matchScore}>{Math.round(result.matchScore * 100)}%</span>
                <span className={styles.matchLabel}>match for you</span>
              </>
            ) : (
              <span className={styles.matchLabel}>no taste signal yet</span>
            )}
          </div>
          <p className={styles.explanation}>{result.explanation}</p>
          <div className={styles.metaRow}>
            <ProviderBadge provider={result.provider} degraded={result.degraded} />
          </div>
          {similar.length > 0 ? (
            <div className={styles.toolBody}>
              <span className={styles.similarTitle}>Vector neighbours</span>
              <div className={styles.similarChips}>
                {similar.slice(0, 8).map((n) => (
                  <button
                    key={`${n.id}-${n.title}`}
                    type="button"
                    className="chip"
                    onClick={() => navigate(`/content/${n.id}`)}
                    aria-label={`Open ${n.title}`}
                  >
                    <span className={styles.similarName}>{n.title}</span>
                    <span className="chip__score">{Number(n.score ?? 0).toFixed(2)}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {result.quota ? <QuotaMeter quota={result.quota} /> : null}
        </div>
      ) : null}
    </ToolShell>
  );
}

/* --------------------------------- the tab ---------------------------------- */

export function RagLab(): React.JSX.Element {
  return (
    <div className={styles.wrap}>
      <div className={styles.intro}>
        <FlaskConical size={15} color="var(--rose-soft)" />
        <p className={styles.introText}>
          Public vector playground — anonymous visitors get 5 live queries/day (sign in for the per-plan quota and
          personalized ranking). Nothing is cached: every run re-queries the embedding store.
        </p>
      </div>
      <div className={styles.grid}>
        <RecommendTool />
        <SummarizeTool />
        <ExplainTool />
      </div>
    </div>
  );
}

export default RagLab;
