/**
 * ai/AssistantTab.tsx — "Assistant" half of the mobile AI hub: a full chat
 * with animaxiaAssistant (POST /api/ai/assistant).
 *
 *   • history restored on mount (GET /api/ai/assistant/history?limit=20)
 *   • last 8 turns sent as short-term memory
 *   • per-reply meta: tool-call traces (name + ms, green/red), memories-used
 *     chip, provider badge, offline-mode + refusal notices
 *   • quota per plan (free 10 / plus 100 / pro 500 per day) — 402 → upgrade
 *   • piracy / account-hacking requests are refused server-side (guardrails);
 *     the refusal notice renders inline
 *
 * Phase 6: pure expo-router-free module — the quota hint navigates through the
 * React Navigation module ref, and the hub screen (app/screens/AIHubScreen)
 * mounts this tab inside its Assistant segment.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, radii, spacing, typography } from '../utils/theme';
import { isApiError } from '../api/client';
import { navigateTo } from '../navigation/helpers';
import * as aiApi from '../api/ai';
import type { AiChatTurn } from '../api/ai';
import { ErrorState, UpgradeCard } from '../components/states';

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  tools?: { name: string; ms: number; ok: boolean }[];
  memories?: number;
  provider?: string;
  degraded?: boolean;
  refused?: boolean;
}

export function AssistantTab(): React.JSX.Element {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quotaBlocked, setQuotaBlocked] = useState<string | null>(null);
  const [booted, setBooted] = useState(false);
  const listRef = useRef<View>(null);

  // Restore the persisted conversation (Neon agentconversations, newest last).
  useEffect(() => {
    let cancelled = false;
    aiApi
      .aiAssistantHistory(20)
      .then((res) => {
        if (cancelled) return;
        setTurns(
          (res.data ?? []).map((entry) => ({
            role: entry.role === 'assistant' ? 'assistant' : 'user',
            content: entry.message,
          })),
        );
      })
      .catch(() => undefined)
      .finally(() => !cancelled && setBooted(true));
    return () => {
      cancelled = true;
    };
  }, []);

  const history = useMemo<AiChatTurn[]>(
    () => turns.slice(-8).map((t) => ({ role: t.role, content: t.content })),
    [turns],
  );

  const send = useCallback(async () => {
    const message = draft.trim();
    if (!message || sending) return;
    setDraft('');
    setError(null);
    setQuotaBlocked(null);
    setSending(true);
    setTurns((prev) => [...prev, { role: 'user', content: message }]);
    try {
      const res = await aiApi.aiAssistant(message, history);
      setTurns((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: res.reply,
          tools: (res.toolsUsed ?? []).map((t) => ({ name: t.name, ms: t.ms, ok: t.ok })),
          memories: res.memoriesUsed,
          provider: res.provider,
          degraded: res.degraded,
          refused: res.refused,
        },
      ]);
    } catch (err) {
      setTurns((prev) => prev.slice(0, -1));
      setDraft(message);
      if (isApiError(err) && (err.upgrade || err.status === 402)) {
        setQuotaBlocked(err.message);
      } else {
        setError(isApiError(err) ? err.message : 'The assistant is unreachable');
      }
    } finally {
      setSending(false);
    }
  }, [draft, sending, history]);

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.wrap}
      keyboardVerticalOffset={8}
    >
      <View style={styles.introCard}>
        <Ionicons name="color-wand-outline" size={15} color={colors.roseSoft} />
        <Text style={styles.introText}>
          animaxiaAssistant — asks tools, reads your history, remembers your taste. Try “what should I watch tonight?”
        </Text>
      </View>

      <View ref={listRef} style={styles.chatLog}>
        {booted && turns.length === 0 && !sending ? (
          <Text style={styles.emptyText}>
            No conversation yet. Ask about trending titles, your plan, or what to watch.
          </Text>
        ) : null}
        {turns.map((turn, index) => (
          <View
            key={`${turn.role}-${index}`}
            style={[styles.bubble, turn.role === 'user' ? styles.bubbleUser : styles.bubbleAi]}
          >
            <Text style={turn.role === 'user' ? styles.userText : styles.aiText}>{turn.content}</Text>
            {turn.role === 'assistant' && (turn.tools?.length || turn.memories || turn.provider) ? (
              <View style={styles.metaRow}>
                {turn.tools?.map((tool) => (
                  <View
                    key={tool.name}
                    style={[styles.toolChip, !tool.ok && styles.toolChipFail]}
                  >
                    <Ionicons
                      name={tool.ok ? 'checkmark-circle' : 'close-circle'}
                      size={10}
                      color={tool.ok ? colors.emerald : colors.red}
                    />
                    <Text style={styles.toolText}>
                      {tool.name} · {tool.ms}ms
                    </Text>
                  </View>
                ))}
                {turn.memories ? (
                  <View style={styles.toolChip}>
                    <Ionicons name="bulb-outline" size={10} color={colors.fuchsia} />
                    <Text style={styles.toolText}>{turn.memories} memories</Text>
                  </View>
                ) : null}
                {turn.provider ? (
                  <View style={[styles.toolChip, turn.degraded && styles.toolChipWarn]}>
                    <Text style={[styles.toolText, turn.degraded && { color: colors.amber }]}>
                      {turn.degraded ? `${turn.provider} · offline` : turn.provider}
                    </Text>
                  </View>
                ) : null}
              </View>
            ) : null}
            {turn.refused ? (
              <View style={styles.refusedRow}>
                <Ionicons name="shield-checkmark-outline" size={11} color={colors.amber} />
                <Text style={styles.refusedText}>safety guardrail</Text>
              </View>
            ) : null}
          </View>
        ))}
        {sending ? (
          <View style={[styles.bubble, styles.bubbleAi]}>
            <Text style={styles.aiText}>checking tools…</Text>
          </View>
        ) : null}
      </View>

      {quotaBlocked ? (
        <UpgradeCard message={quotaBlocked} />
      ) : error ? (
        <ErrorState message={error} compact onRetry={() => setError(null)} />
      ) : null}

      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          placeholder="Ask Animaxia…"
          placeholderTextColor={colors.textDim}
          multiline
          maxLength={2000}
          accessibilityLabel="Message Animaxia assistant"
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send message"
          style={[styles.sendButton, (!draft.trim() || sending) && styles.sendDisabled]}
          disabled={!draft.trim() || sending}
          onPress={send}
        >
          <Ionicons name="arrow-up" size={17} color="#fff" />
        </Pressable>
      </View>
      <Pressable
        onPress={() => navigateTo('Premium')}
        accessibilityRole="button"
        accessibilityLabel="See premium plans"
        style={styles.quotaHintRow}
      >
        <Text style={styles.quotaHintText}>AI quota depends on your plan — free 10/day, plus 100, pro 500</Text>
      </Pressable>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, gap: spacing.md, paddingTop: spacing.md },
  introCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(244,63,94,0.07)',
    borderWidth: 1,
    borderColor: 'rgba(244,63,94,0.25)',
    borderRadius: radii.md,
    padding: spacing.md,
  },
  introText: { flex: 1, color: colors.textMuted, fontSize: typography.tiny, lineHeight: 16 },

  chatLog: { flex: 1, gap: 8 },
  emptyText: { color: colors.textDim, fontSize: typography.tiny, textAlign: 'center', paddingVertical: spacing.xl },
  bubble: { borderRadius: radii.md, padding: 11, maxWidth: '92%', gap: 7 },
  bubbleUser: { backgroundColor: colors.rose, alignSelf: 'flex-end' },
  bubbleAi: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.borderSoft, alignSelf: 'flex-start' },
  userText: { color: '#fff', fontSize: typography.small, lineHeight: 19 },
  aiText: { color: colors.text, fontSize: typography.small, lineHeight: 19 },

  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  toolChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.cardSoft,
    borderRadius: radii.sm,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  toolChipFail: { backgroundColor: 'rgba(248,113,113,0.12)' },
  toolChipWarn: { backgroundColor: 'rgba(251,191,36,0.12)' },
  toolText: { color: colors.textMuted, fontSize: 9, fontWeight: '700' },

  refusedRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  refusedText: { color: colors.amber, fontSize: 9, fontWeight: '700' },

  inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm },
  input: {
    flex: 1,
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
  sendButton: {
    width: 42,
    height: 42,
    borderRadius: radii.pill,
    backgroundColor: colors.rose,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendDisabled: { opacity: 0.4 },
  quotaHintRow: { alignItems: 'center' },
  quotaHintText: { color: colors.textDim, fontSize: 10 },
});

export default AssistantTab;
