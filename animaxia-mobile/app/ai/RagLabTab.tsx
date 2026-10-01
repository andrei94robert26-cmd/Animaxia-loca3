/**
 * ai/RagLabTab.tsx — "RAG Lab" segment of the mobile AI hub (NEW in Phase 6).
 *
 * A public playground over the Animaxia RAG surface (pgvector embeddings):
 *
 *   Recommend  POST /api/ai/rag/recommend { query, limit }  → vector-ranked
 *              picks with reasons + score badges (works signed-out — anonymous
 *              5/day quota; signed-in answers are personalized)
 *   Summarize  POST /api/ai/rag/summarize { contentId }     → grounded summary
 *              rendered as a quote panel
 *   Explain    POST /api/ai/rag/explain { contentId, question? } → match %
 *              + explanation + vector-neighbour rows (tap → Content)
 *   Chat       POST /api/ai/rag/chat { contentId, message, history } →
 *              chat-with-a-title with tappable source chips (auth)
 *
 * Every mode handles the full state matrix: inline validation, loading
 * (RowSkeleton / ActivityIndicator), ErrorState + Retry, 402 UpgradeCard,
 * provider/degraded badges and the per-plan quota meter. Responses are
 * treated defensively (?? [] / ?? '' guards) so a malformed payload can
 * never crash the tab.
 */

import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, radii, spacing, typography } from '../utils/theme';
import { useAuth } from '../hooks/useAuth';
import { isApiError } from '../api/client';
import * as aiApi from '../api/ai';
import type {
  AiChatTurn,
  AiCloudQuota,
  AiRagExplainResponse,
  AiRagRecommendResponse,
  AiRagSummarizeResponse,
} from '../api/ai';
import { navigateTo } from '../navigation/helpers';
import { Segmented } from '../components/Segmented';
import { ContentCard, Thumb } from '../components/content';
import { QuotaMeter } from '../components/QuotaMeter';
import { ErrorState, RowSkeleton, SignInCard, UpgradeCard } from '../components/states';

/* --------------------------------- modes ---------------------------------- */

type RagMode = 'recommend' | 'summarize' | 'explain' | 'chat';

const MODES: { value: RagMode; label: string }[] = [
  { value: 'recommend', label: 'Recommend' },
  { value: 'summarize', label: 'Summarize' },
  { value: 'explain', label: 'Explain' },
  { value: 'chat', label: 'Chat' },
];

/** Result-count options for the Recommend mode. */
const LIMITS = [3, 6, 10];

/* ------------------------------ shared helpers ----------------------------- */

function isQuotaError(err: unknown): boolean {
  return isApiError(err) && (err.upgrade || err.status === 402);
}

/** "42" → 42; "" / "abc" / "-1" → null. */
function parseContentId(raw: string): number | null {
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function quotaMessage(err: unknown): string {
  return isApiError(err) ? err.message : 'Daily AI quota reached';
}

function ragError(err: unknown): string {
  return isApiError(err) ? err.message : 'The RAG engine is unreachable';
}

/** Small provider chip — amber "degraded" variant when the LLM is offline. */
function ProviderBadge({
  provider,
  degraded,
}: {
  provider?: string;
  degraded?: boolean;
}): React.JSX.Element | null {
  if (!provider) return null;
  return (
    <View style={[styles.providerChip, degraded && styles.providerChipDegraded]}>
      <Ionicons
        name={degraded ? 'cloud-offline-outline' : 'server-outline'}
        size={10}
        color={degraded ? colors.amber : colors.emerald}
      />
      <Text style={[styles.providerText, degraded && styles.providerTextDegraded]}>
        {degraded ? `${provider} · degraded` : provider.toUpperCase()}
      </Text>
    </View>
  );
}

/** Primary "run this query" pill shared by the three POST modes. */
function RunButton({
  label,
  onPress,
  disabled,
  busy,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      style={[styles.runButton, (disabled || busy) && styles.runButtonDisabled]}
      disabled={disabled || busy}
      onPress={onPress}
    >
      {busy ? (
        <ActivityIndicator size="small" color="#fff" />
      ) : (
        <Ionicons name="search" size={15} color="#fff" />
      )}
      <Text style={styles.runButtonText}>{busy ? 'Working…' : label}</Text>
    </Pressable>
  );
}

/** Numeric content-id field + the "where do I find ids?" hint. */
function IdInput({ value, onChange }: { value: string; onChange: (v: string) => void }): React.JSX.Element {
  return (
    <View style={{ gap: 6 }}>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChange}
        placeholder="Content id — e.g. 42"
        placeholderTextColor={colors.textDim}
        keyboardType="number-pad"
        maxLength={9}
        accessibilityLabel="Content id"
      />
      <Text style={styles.idHint}>
        The numeric id is in any content page URL — animaxia://content/42 → 42.
      </Text>
    </View>
  );
}

/** Inline "engine is thinking" row for the summarize/explain modes. */
function BusyRow({ label }: { label: string }): React.JSX.Element {
  return (
    <View style={styles.busyRow}>
      <ActivityIndicator color={colors.rose} />
      <Text style={styles.busyText}>{label}</Text>
    </View>
  );
}

/* --------------------------------- the tab --------------------------------- */

export function RagLabTab(): React.JSX.Element {
  const [mode, setMode] = useState<RagMode>('recommend');

  return (
    <View style={styles.wrap}>
      <View style={styles.labHeader}>
        <Ionicons name="flask-outline" size={14} color={colors.roseSoft} />
        <Text style={styles.labHeaderText}>RAG Lab — vector search over the whole library</Text>
      </View>
      <Segmented options={MODES} value={mode} onChange={setMode} />
      <View style={styles.pane}>
        {mode === 'recommend' ? <RecommendPane /> : null}
        {mode === 'summarize' ? <SummarizePane /> : null}
        {mode === 'explain' ? <ExplainPane /> : null}
        {mode === 'chat' ? <ChatPane /> : null}
      </View>
    </View>
  );
}

/* ------------------------------ Recommend mode ------------------------------ */

function RecommendPane(): React.JSX.Element {
  const { width } = useWindowDimensions();
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState<number>(6);
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
      setResult(await aiApi.aiRagRecommend(q, limit));
    } catch (err) {
      setResult(null);
      if (isQuotaError(err)) setQuotaBlocked(quotaMessage(err));
      else setError(ragError(err));
    } finally {
      setLoading(false);
    }
  }, [query, limit, loading]);

  // Two responsive poster columns inside the hub's horizontal padding.
  const cardWidth = Math.min(190, Math.max(120, Math.floor((width - spacing.lg * 2 - spacing.md) / 2)));
  const picks = result?.data ?? [];

  return (
    <View style={{ gap: spacing.md }}>
      <Text style={styles.paneHint}>
        Describe what you feel like — the vector engine ranks the whole library and explains every pick.
      </Text>
      <TextInput
        style={styles.input}
        value={query}
        onChangeText={setQuery}
        placeholder="e.g. dark sci-fi anime with mechs"
        placeholderTextColor={colors.textDim}
        returnKeyType="search"
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={200}
        accessibilityLabel="Recommendation query"
        onSubmitEditing={run}
      />
      <View style={styles.limitRow}>
        <Text style={styles.limitLabel}>results</Text>
        {LIMITS.map((n) => {
          const active = limit === n;
          return (
            <Pressable
              key={n}
              accessibilityRole="button"
              accessibilityLabel={`${n} results`}
              accessibilityState={{ selected: active }}
              style={[styles.limitChip, active && styles.limitChipActive]}
              onPress={() => setLimit(n)}
            >
              <Text style={[styles.limitText, active && styles.limitTextActive]}>{n}</Text>
            </Pressable>
          );
        })}
      </View>
      <RunButton label="Find titles" onPress={run} disabled={!query.trim()} busy={loading} />

      {loading ? <RowSkeleton /> : null}
      {!loading && quotaBlocked ? <UpgradeCard message={quotaBlocked} /> : null}
      {!loading && error ? <ErrorState message={error} onRetry={run} /> : null}

      {!loading && result ? (
        <View style={{ gap: spacing.md }}>
          <View style={styles.metaRow}>
            <ProviderBadge provider={result.provider} degraded={result.degraded} />
            {result.personalized ? (
              <View style={styles.personalizedChip}>
                <Ionicons name="person" size={9} color={colors.roseSoft} />
                <Text style={styles.personalizedText}>personalized ranking</Text>
              </View>
            ) : null}
          </View>
          {result.intro ? <Text style={styles.lead}>{result.intro}</Text> : null}
          {picks.length === 0 ? (
            <Text style={styles.emptyText}>Nothing matched — try a broader description.</Text>
          ) : (
            <View style={styles.picksWrap}>
              {picks.map((pick, index) => (
                <View key={`${pick.id}-${index}`} style={[styles.pickCell, { width: cardWidth }]}>
                  <ContentCard item={pick} width={cardWidth} reason={pick.reason} />
                  <View style={styles.scoreBadge}>
                    <Ionicons name="sparkles" size={9} color={colors.roseSoft} />
                    <Text style={styles.scoreText}>{Number(pick.score ?? 0).toFixed(2)}</Text>
                  </View>
                </View>
              ))}
            </View>
          )}
          {result.quota ? <QuotaMeter quota={result.quota} /> : null}
        </View>
      ) : null}
    </View>
  );
}

/* ------------------------------ Summarize mode ------------------------------ */

function SummarizePane(): React.JSX.Element {
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
      else setError(ragError(err));
    } finally {
      setLoading(false);
    }
  }, [id, loading]);

  return (
    <View style={{ gap: spacing.md }}>
      <Text style={styles.paneHint}>
        Spoiler-light summary of any title, cited from the library metadata.
      </Text>
      <IdInput value={idDraft} onChange={setIdDraft} />
      <RunButton label="Summarize" onPress={run} disabled={!id} busy={loading} />

      {loading ? <BusyRow label="reading the library…" /> : null}
      {!loading && quotaBlocked ? <UpgradeCard message={quotaBlocked} /> : null}
      {!loading && error ? <ErrorState message={error} onRetry={run} /> : null}

      {!loading && result ? (
        <View style={{ gap: spacing.md }}>
          <View style={styles.summaryCard}>
            <View style={styles.summaryHeader}>
              <Ionicons name="document-text-outline" size={14} color={colors.roseSoft} />
              <Text style={styles.summaryTitle} numberOfLines={2}>
                {result.title}
              </Text>
            </View>
            <Text style={styles.summaryBody}>{result.summary}</Text>
          </View>
          <View style={styles.metaRow}>
            <ProviderBadge provider={result.provider} degraded={result.degraded} />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Open ${result.title}`}
              style={styles.openChip}
              onPress={() => id && navigateTo('Content', { id })}
            >
              <Ionicons name="open-outline" size={10} color={colors.text} />
              <Text style={styles.openChipText}>open title</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}

/* ------------------------------- Explain mode ------------------------------- */

function ExplainPane(): React.JSX.Element {
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
      else setError(ragError(err));
    } finally {
      setLoading(false);
    }
  }, [id, question, loading]);

  const similar = result?.similar ?? [];

  return (
    <View style={{ gap: spacing.md }}>
      <Text style={styles.paneHint}>
        Ask “will I like this?” — the engine matches the title against your taste vectors (works anonymously too).
      </Text>
      <IdInput value={idDraft} onChange={setIdDraft} />
      <TextInput
        style={styles.input}
        value={question}
        onChangeText={setQuestion}
        placeholder="Optional question — e.g. is it slow-paced?"
        placeholderTextColor={colors.textDim}
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={200}
        accessibilityLabel="Optional question for the RAG engine"
      />
      <RunButton label="Explain the match" onPress={run} disabled={!id} busy={loading} />

      {loading ? <BusyRow label="matching your taste…" /> : null}
      {!loading && quotaBlocked ? <UpgradeCard message={quotaBlocked} /> : null}
      {!loading && error ? <ErrorState message={error} onRetry={run} /> : null}

      {!loading && result ? (
        <View style={{ gap: spacing.md }}>
          <View style={styles.resultHeader}>
            <Ionicons name="person-circle-outline" size={16} color={colors.emerald} />
            <Text style={styles.resultTitle} numberOfLines={1}>
              {result.title}
            </Text>
            {result.matchScore != null ? (
              <View style={styles.matchChip}>
                <Text style={styles.matchText}>match {Math.round(result.matchScore * 100)}%</Text>
              </View>
            ) : null}
          </View>
          <View style={styles.panel}>
            <Text style={styles.panelText}>{result.explanation}</Text>
          </View>
          <ProviderBadge provider={result.provider} degraded={result.degraded} />
          {similar.length > 0 ? (
            <View style={{ gap: spacing.sm }}>
              <Text style={styles.subLabel}>Vector neighbours</Text>
              {similar.slice(0, 8).map((n) => (
                <Pressable
                  key={`${n.id}-${n.title}`}
                  accessibilityRole="button"
                  accessibilityLabel={`Open ${n.title}`}
                  style={styles.simRow}
                  onPress={() => navigateTo('Content', { id: n.id })}
                >
                  <Thumb uri={n.thumbnail} style={styles.simThumb} iconSize={13} />
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={styles.simTitle} numberOfLines={1}>
                      {n.title}
                    </Text>
                    {n.genres && n.genres.length > 0 ? (
                      <Text style={styles.simMeta} numberOfLines={1}>
                        {n.genres.slice(0, 3).join(' · ')}
                      </Text>
                    ) : null}
                  </View>
                  <Text style={styles.simScore}>{Number(n.score ?? 0).toFixed(2)}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}
          {result.quota ? <QuotaMeter quota={result.quota} /> : null}
        </View>
      ) : null}
    </View>
  );
}

/* -------------------------------- Chat mode -------------------------------- */

interface RagTurn {
  role: 'user' | 'assistant';
  content: string;
  sources?: { id: number; title: string; score: number }[];
  provider?: string;
  degraded?: boolean;
}

function ChatPane(): React.JSX.Element {
  const { user } = useAuth();
  const [idDraft, setIdDraft] = useState('');
  const [draft, setDraft] = useState('');
  const [turns, setTurns] = useState<RagTurn[]>([]);
  /** The content id the current conversation belongs to (switch → fresh chat). */
  const [conversationId, setConversationId] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quotaBlocked, setQuotaBlocked] = useState<string | null>(null);
  const [quota, setQuota] = useState<AiCloudQuota | null>(null);

  const id = parseContentId(idDraft);

  const history = useMemo<AiChatTurn[]>(
    () => turns.slice(-8).map((t) => ({ role: t.role, content: t.content })),
    [turns],
  );

  const send = useCallback(async () => {
    const message = draft.trim();
    if (!message || !id || sending) return;
    setError(null);
    setQuotaBlocked(null);
    setSending(true);
    setDraft('');

    // New content id → the old conversation is irrelevant: start clean.
    const switching = conversationId !== id;
    const hist = switching ? [] : history;
    setConversationId(id);
    setTurns((prev) =>
      switching ? [{ role: 'user', content: message }] : [...prev, { role: 'user', content: message }],
    );

    try {
      const res = await aiApi.aiRagChat(id, message, hist);
      setTurns((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: res.reply,
          sources: res.sources ?? [],
          provider: res.provider,
          degraded: res.degraded,
        },
      ]);
      if (res.quota) setQuota(res.quota);
    } catch (err) {
      // Roll back the optimistic user bubble and give the draft back.
      setTurns((prev) => prev.slice(0, -1));
      setDraft(message);
      if (isQuotaError(err)) setQuotaBlocked(quotaMessage(err));
      else setError(ragError(err));
    } finally {
      setSending(false);
    }
  }, [draft, id, sending, conversationId, history]);

  if (!user) {
    return (
      <SignInCard message="Sign in to chat with a title — every answer is grounded in the library metadata (RAG)." />
    );
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ gap: spacing.md }}>
      <Text style={styles.paneHint}>
        Pick a title and ask anything about it — every answer lists the sources it was grounded on.
      </Text>
      <IdInput value={idDraft} onChange={setIdDraft} />

      {turns.length === 0 && !sending ? (
        <View style={styles.emptyChat}>
          <Ionicons name="chatbubbles-outline" size={20} color={colors.textDim} />
          <Text style={styles.emptyChatText}>
            No messages yet — your last 8 turns are sent back as context.
          </Text>
        </View>
      ) : null}

      <View style={styles.chatLog}>
        {turns.map((turn, index) => (
          <View
            key={`${turn.role}-${index}`}
            style={[styles.bubble, turn.role === 'user' ? styles.bubbleUser : styles.bubbleAi]}
          >
            <Text style={turn.role === 'user' ? styles.bubbleUserText : styles.bubbleAiText}>
              {turn.content}
            </Text>
            {turn.role === 'assistant' && turn.sources && turn.sources.length > 0 ? (
              <View style={styles.sourceRow}>
                <Text style={styles.sourceLabel}>based on:</Text>
                {turn.sources.slice(0, 4).map((s) => (
                  <Pressable
                    key={`${s.id}-${s.title}`}
                    accessibilityRole="button"
                    accessibilityLabel={`Open ${s.title}`}
                    style={styles.sourceChip}
                    onPress={() => navigateTo('Content', { id: s.id })}
                  >
                    <Text style={styles.sourceChipText} numberOfLines={1}>
                      {s.title} · {Number(s.score ?? 0).toFixed(2)}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
            {turn.role === 'assistant' ? (
              <ProviderBadge provider={turn.provider} degraded={turn.degraded} />
            ) : null}
          </View>
        ))}
        {sending ? (
          <View style={[styles.bubble, styles.bubbleAi]}>
            <Text style={styles.bubbleAiText}>reading the library…</Text>
          </View>
        ) : null}
      </View>

      {quotaBlocked ? <UpgradeCard message={quotaBlocked} /> : null}
      {error ? <ErrorState message={error} compact onRetry={() => setError(null)} /> : null}
      {quota ? <QuotaMeter quota={quota} /> : null}

      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          placeholder={id ? 'Ask about the title…' : 'Enter a content id first…'}
          placeholderTextColor={colors.textDim}
          multiline
          maxLength={2000}
          accessibilityLabel="Message the RAG chat"
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send message"
          style={[styles.sendButton, (!draft.trim() || !id || sending) && styles.sendButtonDisabled]}
          disabled={!draft.trim() || !id || sending}
          onPress={send}
        >
          <Ionicons name="arrow-up" size={17} color="#fff" />
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

/* ---------------------------------- styles --------------------------------- */

const styles = StyleSheet.create({
  wrap: { gap: spacing.md, paddingTop: spacing.sm },
  labHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    backgroundColor: 'rgba(217,70,239,0.07)',
    borderWidth: 1,
    borderColor: 'rgba(217,70,239,0.25)',
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
  },
  labHeaderText: { flex: 1, color: colors.textMuted, fontSize: typography.tiny, lineHeight: 15 },
  pane: { minHeight: 120 },

  paneHint: { color: colors.textMuted, fontSize: typography.tiny, lineHeight: 16 },

  input: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
    color: colors.text,
    fontSize: typography.small,
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 10,
    maxHeight: 110,
  },
  idHint: { color: colors.textDim, fontSize: 10 },

  limitRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  limitLabel: {
    color: colors.textDim,
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  limitChip: {
    backgroundColor: colors.cardSoft,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.pill,
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  limitChipActive: { backgroundColor: colors.rose, borderColor: colors.rose },
  limitText: { color: colors.textMuted, fontSize: typography.tiny, fontWeight: '700' },
  limitTextActive: { color: '#fff' },

  runButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: colors.rose,
    borderRadius: radii.pill,
    paddingVertical: 11,
  },
  runButtonDisabled: { opacity: 0.4 },
  runButtonText: { color: '#fff', fontSize: typography.small, fontWeight: '700' },

  busyRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: spacing.md },
  busyText: { color: colors.textDim, fontSize: typography.tiny },

  metaRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm },
  providerChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(52,211,153,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(52,211,153,0.3)',
    borderRadius: radii.sm,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  providerChipDegraded: {
    backgroundColor: 'rgba(251,191,36,0.1)',
    borderColor: 'rgba(251,191,36,0.35)',
  },
  providerText: { color: colors.emerald, fontSize: 9, fontWeight: '800', letterSpacing: 0.5 },
  providerTextDegraded: { color: colors.amber },
  personalizedChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(244,63,94,0.1)',
    borderRadius: radii.sm,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  personalizedText: { color: colors.roseSoft, fontSize: 9, fontWeight: '800' },

  lead: { color: colors.text, fontSize: typography.body, lineHeight: 21, fontWeight: '600' },
  emptyText: { color: colors.textMuted, fontSize: typography.small },

  picksWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  pickCell: { position: 'relative' },
  scoreBadge: {
    position: 'absolute',
    top: 6,
    right: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: 'rgba(0,0,0,0.78)',
    borderRadius: radii.sm,
    paddingHorizontal: 5,
    paddingVertical: 2,
  },
  scoreText: { color: colors.roseSoft, fontSize: 10, fontWeight: '800' },

  summaryCard: {
    backgroundColor: colors.card,
    borderLeftWidth: 3,
    borderLeftColor: colors.rose,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  summaryHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  summaryTitle: { flex: 1, color: colors.text, fontSize: typography.body, fontWeight: '800' },
  summaryBody: { color: colors.textMuted, fontSize: typography.small, lineHeight: 20 },

  openChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: colors.cardSoft,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.pill,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  openChipText: { color: colors.text, fontSize: 10, fontWeight: '700' },

  resultHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  resultTitle: { flex: 1, color: colors.text, fontSize: typography.body, fontWeight: '800' },
  matchChip: {
    backgroundColor: 'rgba(52,211,153,0.14)',
    borderRadius: radii.sm,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  matchText: { color: colors.emerald, fontSize: 11, fontWeight: '800' },

  panel: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    padding: spacing.lg,
  },
  panelText: { color: colors.textMuted, fontSize: typography.small, lineHeight: 20 },

  subLabel: {
    color: colors.textDim,
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  simRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radii.md,
    padding: spacing.md,
  },
  simThumb: { width: 46, height: 46, borderRadius: radii.sm },
  simTitle: { color: colors.text, fontSize: typography.small, fontWeight: '700' },
  simMeta: { color: colors.textDim, fontSize: 10 },
  simScore: { color: colors.roseSoft, fontSize: 11, fontWeight: '800' },

  emptyChat: { alignItems: 'center', gap: 8, paddingVertical: spacing.lg },
  emptyChatText: { color: colors.textDim, fontSize: typography.tiny, textAlign: 'center' },

  chatLog: { gap: 8 },
  bubble: { borderRadius: radii.md, padding: 11, maxWidth: '92%', gap: 7 },
  bubbleUser: { backgroundColor: colors.rose, alignSelf: 'flex-end' },
  bubbleAi: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    alignSelf: 'flex-start',
  },
  bubbleUserText: { color: '#fff', fontSize: typography.small, lineHeight: 19 },
  bubbleAiText: { color: colors.text, fontSize: typography.small, lineHeight: 19 },

  sourceRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  sourceLabel: { color: colors.textDim, fontSize: 9 },
  sourceChip: {
    backgroundColor: 'rgba(244,63,94,0.1)',
    borderRadius: radii.sm,
    paddingHorizontal: 7,
    paddingVertical: 3,
    maxWidth: 150,
  },
  sourceChipText: { color: colors.roseSoft, fontSize: 9, fontWeight: '700' },

  inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm },
  sendButton: {
    width: 42,
    height: 42,
    borderRadius: radii.pill,
    backgroundColor: colors.rose,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendButtonDisabled: { opacity: 0.4 },
});

export default RagLabTab;
