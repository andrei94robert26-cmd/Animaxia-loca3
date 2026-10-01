/**
 * components/AIPanel.tsx — The content-screen AI suite (Phase-5 requirement:
 * "detalii + AI panel"). Three modes over the Animaxia AI Cloud:
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
 * Phase 6: navigation goes through the React Navigation module ref
 * (app/navigation/helpers.ts) instead of expo-router.
 */

import React, { useCallback, useMemo, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { navigateTo } from '../navigation/helpers';
import { colors, radii, spacing, typography } from '../utils/theme';
import { useAuth } from '../hooks/useAuth';
import { useApi } from '../hooks/useApi';
import { isApiError } from '../api/client';
import { cached } from '../api/cache';
import * as aiApi from '../api/ai';
import type { AiChatTurn } from '../api/ai';
import { Segmented } from './Segmented';
import { ContentCard } from './content';
import { QuotaMeter } from './QuotaMeter';
import { ErrorState, SignInCard, Skeleton, UpgradeCard } from './states';

type PanelMode = 'explain' | 'more' | 'ask';

const MODES: { value: PanelMode; label: string }[] = [
  { value: 'explain', label: 'Explain this' },
  { value: 'more', label: 'More like this' },
  { value: 'ask', label: 'Ask Animaxia AI' },
];

export function AIPanel({ contentId, title }: { contentId: number; title: string }): React.JSX.Element {
  const [mode, setMode] = useState<PanelMode>('explain');

  return (
    <View style={styles.wrap}>
      <View style={styles.headerRow}>
        <Ionicons name="sparkles" size={16} color={colors.roseSoft} />
        <Text style={styles.headerTitle}>Animaxia AI</Text>
        <View style={styles.ragChip}>
          <Text style={styles.ragChipText}>RAG · vector</Text>
        </View>
      </View>
      <Segmented options={MODES} value={mode} onChange={setMode} />
      <View style={styles.pane}>
        {mode === 'explain' ? <ExplainPane contentId={contentId} /> : null}
        {mode === 'more' ? <MorePane title={title} /> : null}
        {mode === 'ask' ? <AskPane contentId={contentId} title={title} /> : null}
      </View>
    </View>
  );
}

/* ------------------------------ shared helpers ------------------------------ */

function isQuotaError(err: unknown): boolean {
  return isApiError(err) && (err.upgrade || err.status === 402);
}

function ProviderBadge({ provider, degraded }: { provider?: string; degraded?: boolean }): React.JSX.Element | null {
  if (!provider) return null;
  return (
    <View style={styles.providerRow}>
      <View style={[styles.providerChip, degraded && styles.providerChipDegraded]}>
        <Text style={[styles.providerText, degraded && styles.providerTextDegraded]}>
          {degraded ? `${provider} · offline mode` : provider.toUpperCase()}
        </Text>
      </View>
    </View>
  );
}

/* -------------------------------- ExplainPane ------------------------------- */

function ExplainPane({ contentId }: { contentId: number }): React.JSX.Element {
  const state = useApi(
    () => cached(`ai:explain:${contentId}`, () => aiApi.aiRagExplain(contentId)),
    [contentId],
  );

  if (state.loading) {
    return (
      <View style={{ gap: 10 }}>
        <Skeleton style={{ height: 18, width: '55%' }} />
        <Skeleton style={{ height: 88, borderRadius: radii.md }} />
        <Skeleton style={{ height: 14, width: '40%' }} />
      </View>
    );
  }
  if (state.error && isQuotaError(state.error)) {
    return <UpgradeCard message={isApiError(state.error) ? state.error.message : 'Daily AI quota reached'} />;
  }
  if (state.error) return <ErrorState message={state.error} onRetry={state.refetch} compact />;
  if (!state.data) return <View />;

  const { data } = state;
  return (
    <View style={{ gap: spacing.md }}>
      {data.matchScore != null ? (
        <View style={styles.matchRow}>
          <Ionicons name="person-circle-outline" size={15} color={colors.emerald} />
          <Text style={styles.matchText}>
            Your match: <Text style={styles.matchStrong}>{Math.round(data.matchScore * 100)}%</Text>
          </Text>
        </View>
      ) : null}
      <Text style={styles.answer}>{data.explanation}</Text>
      <ProviderBadge provider={data.provider} degraded={data.degraded} />
      {data.similar && data.similar.length > 0 ? (
        <View style={styles.neighborWrap}>
          <Text style={styles.neighborTitle}>Vector neighbours</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
            {data.similar.slice(0, 8).map((n) => (
              <Pressable
                key={`${n.id}-${n.title}`}
                accessibilityRole="button"
                accessibilityLabel={`Open ${n.title}`}
                style={styles.neighborChip}
                onPress={() => navigateTo('Content', { id: n.id })}
              >
                <Text style={styles.neighborChipText} numberOfLines={1}>
                  {n.title}
                </Text>
                <Text style={styles.neighborScore}>{n.score.toFixed(2)}</Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      ) : null}
      {data.quota ? <QuotaMeter quota={data.quota} /> : null}
      {state.stale ? <Text style={styles.staleHint}>cached answer — tap retry when back online</Text> : null}
    </View>
  );
}

/* --------------------------------- MorePane --------------------------------- */

function MorePane({ title }: { title: string }): React.JSX.Element {
  const state = useApi(
    () => cached(`ai:more:${title}`, () => aiApi.aiRagRecommend(title, 6)),
    [title],
  );

  if (state.loading) {
    return (
      <View style={{ flexDirection: 'row', gap: spacing.md }}>
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} style={{ width: 108, aspectRatio: 2 / 3, borderRadius: radii.md }} />
        ))}
      </View>
    );
  }
  if (state.error && isQuotaError(state.error)) {
    return <UpgradeCard message={isApiError(state.error) ? state.error.message : 'Daily AI quota reached'} />;
  }
  if (state.error) return <ErrorState message={state.error} onRetry={state.refetch} compact />;
  if (!state.data) return <View />;

  const picks = state.data.data ?? [];
  if (picks.length === 0) return <Text style={styles.emptyText}>No similar titles found yet.</Text>;

  return (
    <View style={{ gap: spacing.md }}>
      {state.data.intro ? <Text style={styles.answer}>{state.data.intro}</Text> : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.md }}>
        {picks.map((pick) => (
          <ContentCard key={`${pick.id}-${pick.title}`} item={pick} reason={pick.reason} />
        ))}
      </ScrollView>
      <ProviderBadge provider={state.data.provider} degraded={state.data.degraded} />
      {state.data.quota ? <QuotaMeter quota={state.data.quota} /> : null}
    </View>
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
    return <SignInCard message="Sign in to chat with this title — the assistant answers from the video metadata." />;
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ gap: spacing.md }}>
      <Text style={styles.askHint}>
        Chat about <Text style={styles.askHintStrong}>{title}</Text> — answers are grounded in the library (RAG).
      </Text>

      {turns.length === 0 && !sending ? (
        <View style={{ gap: 8 }}>
          {['Is this good for beginners?', 'What is it about, no spoilers?', 'Who would enjoy this?'].map((q) => (
            <Pressable
              key={q}
              accessibilityRole="button"
              accessibilityLabel={q}
              style={styles.quickQuestion}
              onPress={() => setDraft(q)}
            >
              <Ionicons name="chatbubble-ellipses-outline" size={13} color={colors.roseSoft} />
              <Text style={styles.quickQuestionText}>{q}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      <View style={styles.chatLog}>
        {turns.map((turn, index) => (
          <View
            key={`${turn.role}-${index}`}
            style={[styles.bubble, turn.role === 'user' ? styles.bubbleUser : styles.bubbleAi]}
          >
            <Text style={turn.role === 'user' ? styles.bubbleUserText : styles.bubbleAiText}>{turn.content}</Text>
            {turn.sources && turn.sources.length > 0 ? (
              <View style={styles.sourceRow}>
                <Text style={styles.sourceLabel}>based on:</Text>
                {turn.sources.slice(0, 3).map((s) => (
                  <Text key={s.id} style={styles.sourceChip} numberOfLines={1}>
                    {s.title} · {s.score.toFixed(2)}
                  </Text>
                ))}
              </View>
            ) : null}
          </View>
        ))}
        {sending ? (
          <View style={[styles.bubble, styles.bubbleAi]}>
            <Text style={styles.bubbleAiText}>thinking…</Text>
          </View>
        ) : null}
      </View>

      {error ? <ErrorState message={error} compact onRetry={() => setError(null)} /> : null}

      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          placeholder={`Ask about ${title}…`}
          placeholderTextColor={colors.textDim}
          multiline
          maxLength={2000}
          accessibilityLabel="Ask Animaxia AI"
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send message"
          style={[styles.sendButton, (!draft.trim() || sending) && styles.sendButtonDisabled]}
          disabled={!draft.trim() || sending}
          onPress={send}
        >
          <Ionicons name="arrow-up" size={17} color="#fff" />
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

/* ---------------------------------- styles ---------------------------------- */

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
    padding: spacing.lg,
    gap: spacing.md,
    marginTop: spacing.xl,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerTitle: { color: colors.text, fontSize: typography.body, fontWeight: '800', flex: 1 },
  ragChip: {
    backgroundColor: colors.roseDark,
    borderRadius: radii.sm,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  ragChipText: { color: '#fff', fontSize: 9, fontWeight: '800', letterSpacing: 0.5 },
  pane: { minHeight: 120 },

  matchRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  matchText: { color: colors.emerald, fontSize: typography.small, fontWeight: '700' },
  matchStrong: { fontSize: typography.h2, fontWeight: '900' },
  answer: { color: colors.textMuted, fontSize: typography.small, lineHeight: 20 },

  providerRow: { flexDirection: 'row' },
  providerChip: {
    backgroundColor: 'rgba(52,211,153,0.12)',
    borderRadius: radii.sm,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderWidth: 1,
    borderColor: 'rgba(52,211,153,0.3)',
  },
  providerChipDegraded: {
    backgroundColor: 'rgba(251,191,36,0.1)',
    borderColor: 'rgba(251,191,36,0.35)',
  },
  providerText: { color: colors.emerald, fontSize: 9, fontWeight: '800', letterSpacing: 0.5 },
  providerTextDegraded: { color: colors.amber },

  neighborWrap: { gap: 8 },
  neighborTitle: { color: colors.textDim, fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  neighborChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.cardSoft,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.pill,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  neighborChipText: { color: colors.text, fontSize: typography.tiny, maxWidth: 130 },
  neighborScore: { color: colors.roseSoft, fontSize: 10, fontWeight: '700' },

  emptyText: { color: colors.textMuted, fontSize: typography.small },
  staleHint: { color: colors.textDim, fontSize: 10, fontStyle: 'italic' },

  askHint: { color: colors.textMuted, fontSize: typography.tiny },
  askHintStrong: { color: colors.text, fontWeight: '700' },
  quickQuestion: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.cardSoft,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radii.pill,
    paddingHorizontal: 12,
    paddingVertical: 8,
    alignSelf: 'flex-start',
  },
  quickQuestionText: { color: colors.text, fontSize: typography.tiny },

  chatLog: { gap: 8 },
  bubble: { borderRadius: radii.md, padding: 10, maxWidth: '92%' },
  bubbleUser: { backgroundColor: colors.rose, alignSelf: 'flex-end' },
  bubbleAi: { backgroundColor: colors.cardSoft, alignSelf: 'flex-start' },
  bubbleUserText: { color: '#fff', fontSize: typography.small, lineHeight: 19 },
  bubbleAiText: { color: colors.text, fontSize: typography.small, lineHeight: 19 },
  sourceRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 6 },
  sourceLabel: { color: colors.textDim, fontSize: 9 },
  sourceChip: {
    color: colors.roseSoft,
    fontSize: 9,
    backgroundColor: 'rgba(244,63,94,0.1)',
    borderRadius: radii.sm,
    paddingHorizontal: 6,
    paddingVertical: 2,
    overflow: 'hidden',
  },

  inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm },
  input: {
    flex: 1,
    backgroundColor: colors.cardSoft,
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

export default AIPanel;
