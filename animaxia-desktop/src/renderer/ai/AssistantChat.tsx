/**
 * ai/AssistantChat.tsx — "Assistant" tab of the desktop AI Hub: a full chat
 * with animaxiaAssistant (POST /api/ai/assistant, auth).
 *
 *   • history restored on mount (GET /api/ai/assistant/history?limit=20) with
 *     a dim "restored history" divider between persisted and live turns
 *   • last 8 turns sent back as short-term memory
 *   • optimistic user bubble with rollback on failure + inline retry
 *   • per-reply meta: tool-call traces (name · ms, ok/fail), memories-used
 *     chip, provider badge ("provider · offline mode" when degraded), refusal
 *     notice (server-side guardrails)
 *   • quota meter whenever a response carries one; 402 → UpgradeCard
 *   • Enter sends, Shift+Enter inserts a newline
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUp, Brain, ShieldAlert, Sparkles, Wrench } from 'lucide-react';
import { useAuth } from '@/auth/AuthContext';
import { errorMessage, isApiError } from '@/api/client';
import * as aiApi from '@/api/ai';
import type { AiChatTurn, AiCloudQuota } from '@/api/ai';
import { Badge, Button, Textarea } from '@/components/primitives';
import { QuotaMeter } from '@/components/QuotaMeter';
import { ErrorState, SignInCard, UpgradeCard } from '@/components/states';
import styles from './AssistantChat.module.css';

/** How many trailing turns travel with every request. */
const HISTORY_WINDOW = 8;

/** Starter prompts shown while the conversation is empty. */
const SUGGESTIONS: string[] = [
  'What should I watch tonight?',
  'Summarize my week',
  'Pick a movie under 2 hours',
];

interface ChatTurnState {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  /** true for turns restored from the persisted conversation log. */
  restored?: boolean;
  tools?: { name: string; ms: number; ok: boolean }[];
  memories?: number;
  provider?: string;
  degraded?: boolean;
  refused?: boolean;
}

export function AssistantChat(): React.JSX.Element {
  const { user } = useAuth();

  const [turns, setTurns] = useState<ChatTurnState[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [booted, setBooted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quotaBlocked, setQuotaBlocked] = useState<string | null>(null);
  const [quota, setQuota] = useState<AiCloudQuota | null>(null);
  /** Last message that failed to send — the inline retry resends it. */
  const [failedMessage, setFailedMessage] = useState<string | null>(null);

  const idRef = useRef(0);
  const nextId = () => {
    idRef.current += 1;
    return idRef.current;
  };
  const logRef = useRef<HTMLDivElement | null>(null);

  /* -------------------- restore the persisted conversation ------------------- */
  useEffect(() => {
    if (!user) {
      setBooted(true);
      return;
    }
    let cancelled = false;
    aiApi
      .aiAssistantHistory(20)
      .then((res) => {
        if (cancelled) return;
        setTurns(
          (res.data ?? []).map((entry) => ({
            id: nextId(),
            role: entry.role === 'assistant' ? 'assistant' : 'user',
            content: entry.message,
            restored: true,
          })),
        );
      })
      .catch(() => undefined) // history is best-effort; chat works without it
      .finally(() => {
        if (!cancelled) setBooted(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  /* ------------------------------ autoscroll --------------------------------- */
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, sending]);

  /* -------------------------------- sending ---------------------------------- */
  const send = useCallback(
    async (override?: string) => {
      const message = (override ?? draft).trim();
      if (!message || sending) return;

      // Short-term memory: the last 8 turns BEFORE this message.
      const history: AiChatTurn[] = turns
        .slice(-HISTORY_WINDOW)
        .map((t) => ({ role: t.role, content: t.content }));

      setDraft('');
      setError(null);
      setQuotaBlocked(null);
      setFailedMessage(null);
      setSending(true);
      setTurns((prev) => [...prev, { id: nextId(), role: 'user', content: message }]);

      try {
        const res = await aiApi.aiAssistant(message, history);
        setTurns((prev) => [
          ...prev,
          {
            id: nextId(),
            role: 'assistant',
            content: res.reply,
            tools: (res.toolsUsed ?? []).map((t) => ({ name: t.name, ms: t.ms, ok: t.ok })),
            memories: res.memoriesUsed,
            provider: res.provider,
            degraded: res.degraded,
            refused: res.refused,
          },
        ]);
        if (res.quota) setQuota(res.quota);
      } catch (err) {
        // Rollback the optimistic bubble; keep the text for the retry.
        setTurns((prev) => prev.slice(0, -1));
        if (isApiError(err) && (err.upgrade || err.status === 402)) {
          setQuotaBlocked(errorMessage(err));
        } else {
          setError(errorMessage(err));
          setFailedMessage(message);
        }
      } finally {
        setSending(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [draft, sending, turns],
  );

  if (!user) {
    return (
      <SignInCard message="Sign in to chat with animaxiaAssistant — it runs tools, reads your history and remembers your taste." />
    );
  }

  const liveStart = turns.findIndex((t) => !t.restored); // -1 when all restored
  const showDivider = liveStart > 0;
  const empty = booted && turns.length === 0 && !sending;

  return (
    <div className={styles.wrap}>
      <div className={styles.intro}>
        <Sparkles size={15} color="var(--rose-soft)" />
        <p className={styles.introText}>
          animaxiaAssistant — asks tools, reads your history, remembers your taste. The last {HISTORY_WINDOW} turns
          travel with every message.
        </p>
      </div>

      <div className={styles.log} ref={logRef} role="log" aria-live="polite" aria-label="Assistant conversation">
        {empty ? (
          <div className={styles.empty}>
            <div className={styles.emptyTitle}>No conversation yet</div>
            <p className={styles.emptyHint}>
              Ask about trending titles, your plan, or what to watch — piracy and account hacks are refused by the
              guardrails.
            </p>
            <div className={styles.suggestions}>
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" className="chip" onClick={() => void send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {turns.map((turn, index) => (
          <React.Fragment key={turn.id}>
            {showDivider && index === liveStart ? <div className={styles.divider}>restored history</div> : null}
            <div className={`${styles.bubble} ${turn.role === 'user' ? styles.bubbleUser : styles.bubbleAi}`}>
              <div className={turn.role === 'user' ? styles.bubbleUserText : styles.bubbleAiText}>{turn.content}</div>
              {turn.role === 'assistant' && (turn.tools?.length || turn.memories || turn.provider) ? (
                <div className={styles.meta}>
                  {turn.tools?.map((tool) => (
                    <Badge key={`${tool.name}-${tool.ms}`} tone={tool.ok ? 'zinc' : 'amber'}>
                      <Wrench size={10} /> {tool.name} · {tool.ms}ms
                    </Badge>
                  ))}
                  {turn.memories ? (
                    <Badge tone="rose">
                      <Brain size={10} /> {turn.memories} memories
                    </Badge>
                  ) : null}
                  {turn.provider ? (
                    <Badge tone={turn.degraded ? 'amber' : 'emerald'}>
                      {turn.degraded ? `${turn.provider} · offline mode` : turn.provider}
                    </Badge>
                  ) : null}
                </div>
              ) : null}
              {turn.refused ? (
                <div className={styles.refused}>
                  <ShieldAlert size={12} /> safety guardrail — request refused
                </div>
              ) : null}
            </div>
          </React.Fragment>
        ))}

        {sending ? (
          <div className={`${styles.bubble} ${styles.bubbleAi}`}>
            <div className={styles.thinking} aria-live="polite">
              thinking
              <span className={styles.dots}>
                <span className={styles.dot} />
                <span className={styles.dot} />
                <span className={styles.dot} />
              </span>
            </div>
          </div>
        ) : null}
      </div>

      {quotaBlocked ? (
        <div className="stack">
          {quota ? <QuotaMeter quota={quota} /> : null}
          <UpgradeCard message={quotaBlocked} />
        </div>
      ) : error ? (
        <ErrorState
          message={error}
          compact
          onRetry={failedMessage ? () => void send(failedMessage) : undefined}
        />
      ) : null}

      <div className={styles.inputRow}>
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder="Ask Animaxia…"
          aria-label="Message animaxiaAssistant"
          maxLength={2000}
        />
        <Button onClick={() => void send()} disabled={!draft.trim() || sending} loading={sending} aria-label="Send message">
          {sending ? null : <ArrowUp size={15} />}
          Send
        </Button>
      </div>
      <p className={styles.sendHint}>Enter to send · Shift+Enter for a new line</p>
      {quota ? <QuotaMeter quota={quota} /> : <p className={styles.quotaHint}>AI quota depends on your plan — free 10/day, plus 100, pro 500</p>}
    </div>
  );
}

export default AssistantChat;
