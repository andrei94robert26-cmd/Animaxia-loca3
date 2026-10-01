/**
 * app/ai.tsx — The mobile AI hub (mini version of the web #/ai hub):
 *
 *   Personal    daily picks · because-you-watched · taste tags · recap
 *               (GET /api/ai/personal/home, /personal/recap)
 *   Assistant   animaxiaAssistant chat with tool traces + memories
 *               (POST /api/ai/assistant, GET /api/ai/assistant/history)
 *
 * Both halves are auth-gated (per-plan quota). A status strip at the bottom
 * shows the live AI Cloud state (GET /api/ai/cloud/status — provider +
 * vector backend + dims), mirroring the web hub badges.
 */

import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, radii, spacing, typography } from '../theme';
import { useAuth } from '../auth/useAuth';
import { useApi } from '../hooks/useApi';
import { cachedFresh } from '../api/cache';
import * as aiApi from '../api/ai';
import { Screen } from '../components/Screen';
import { BottomNav } from '../components/BottomNav';
import { Segmented } from '../components/Segmented';
import { PersonalTab } from '../ai/PersonalTab';
import { AssistantTab } from '../ai/AssistantTab';
import { SignInCard } from '../components/states';

type AiMode = 'personal' | 'assistant';

const MODES: { value: AiMode; label: string }[] = [
  { value: 'personal', label: 'Personal' },
  { value: 'assistant', label: 'Assistant' },
];

export default function AiScreen(): React.JSX.Element {
  const { user } = useAuth();
  const [mode, setMode] = useState<AiMode>('personal');
  const status = useApi(() => cachedFresh('ai:cloud:status', 60 * 1000, () => aiApi.aiCloudStatus()), []);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Screen
        title="Animaxia AI"
        back={false}
        scroll={mode === 'personal'}
        bottomPadding={mode === 'personal' ? 120 : 96}
      >
        <View style={styles.wrap}>
          <Segmented options={MODES} value={mode} onChange={setMode} />

          {user ? (
            mode === 'personal' ? (
              <PersonalTab />
            ) : (
              <AssistantTab />
            )
          ) : (
            <View style={{ paddingTop: spacing.xl }}>
              <SignInCard message="The AI hub is personal — sign in and Animaxia reads your taste (vector embeddings), answers with RAG and runs the assistant with tools." />
            </View>
          )}

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
      <BottomNav />
    </View>
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
