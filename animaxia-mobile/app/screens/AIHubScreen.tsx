/**
 * app/screens/AIHubScreen.tsx — The mobile AI hub (Phase 6 React Navigation
 * version of the Phase-5 app/ai.tsx):
 *
 *   Personal    daily picks · because-you-watched · taste tags · recap
 *               (GET /api/ai/personal/home, /personal/recap — auth)
 *   Assistant   animaxiaAssistant chat with tool traces + memories
 *               (POST /api/ai/assistant, GET /api/ai/assistant/history — auth)
 *   RAG Lab     NEW in Phase 6 — the public vector playground:
 *               recommend · summarize · explain · chat (app/ai/RagLabTab)
 *
 * Personal + Assistant are auth-gated (per-plan quota); RAG Lab renders for
 * everyone (recommend/summarize/explain run on the anonymous 5/day quota and
 * its Chat pane gates itself on auth). A status strip shows the live AI Cloud
 * state (GET /api/ai/cloud/status — provider + vector backend + dims),
 * mirroring the web hub badges.
 */

import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, radii, spacing } from '../utils/theme';
import { useAuth } from '../hooks/useAuth';
import { useApi } from '../hooks/useApi';
import { cachedFresh } from '../api/cache';
import * as aiApi from '../api/ai';
import { Screen } from '../components/Screen';
import { Segmented } from '../components/Segmented';
import { PersonalTab } from '../ai/PersonalTab';
import { AssistantTab } from '../ai/AssistantTab';
import { RagLabTab } from '../ai/RagLabTab';
import { SignInCard } from '../components/states';

type AiMode = 'personal' | 'assistant' | 'rag';

const MODES: { value: AiMode; label: string }[] = [
  { value: 'personal', label: 'Personal' },
  { value: 'assistant', label: 'Assistant' },
  { value: 'rag', label: 'RAG Lab' },
];

export default function AIHubScreen(): React.JSX.Element {
  const { user } = useAuth();
  const [mode, setMode] = useState<AiMode>('personal');
  const status = useApi(
    () => cachedFresh('ai:cloud:status', 60 * 1000, () => aiApi.aiCloudStatus()),
    [],
  );

  return (
    <Screen
      title="Animaxia AI"
      back={false}
      scroll={mode !== 'assistant'}
      bottomPadding={mode === 'personal' ? 120 : 96}
    >
      <View style={styles.wrap}>
        <Segmented options={MODES} value={mode} onChange={setMode} />

        {mode === 'personal' ? (
          user ? (
            <PersonalTab />
          ) : (
            <View style={{ paddingTop: spacing.xl }}>
              <SignInCard message="The AI hub is personal — sign in and Animaxia reads your taste (vector embeddings), answers with RAG and runs the assistant with tools." />
            </View>
          )
        ) : null}

        {mode === 'assistant' ? (
          user ? (
            <AssistantTab />
          ) : (
            <View style={{ paddingTop: spacing.xl }}>
              <SignInCard message="Sign in to chat with animaxiaAssistant — it runs tools, reads your history and remembers your taste." />
            </View>
          )
        ) : null}

        {/* RAG Lab is public (anonymous daily quota); its Chat pane gates itself. */}
        {mode === 'rag' ? <RagLabTab /> : null}

        {/* AI Cloud status strip */}
        {status.data ? (
          <Pressable
            style={styles.statusStrip}
            onPress={() => status.refetch()}
            accessibilityRole="text"
            accessibilityLabel="AI Cloud status"
          >
            <Ionicons name="server-outline" size={11} color={colors.textDim} />
            <Text style={styles.statusText}>
              {status.data.llm.provider} · {status.data.vector.backend} {status.data.vector.dims}d ·{' '}
              {status.data.assistant.tools} tools
            </Text>
            <View style={[styles.statusDot, status.data.llm.available && styles.statusDotUp]} />
          </Pressable>
        ) : null}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, paddingBottom: 120 },
  statusStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radii.pill,
    paddingHorizontal: 12,
    paddingVertical: 7,
    alignSelf: 'center',
    marginTop: spacing.lg,
  },
  statusText: { color: colors.textDim, fontSize: 10, fontWeight: '600' },
  statusDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.textDim },
  statusDotUp: { backgroundColor: colors.emerald },
});
