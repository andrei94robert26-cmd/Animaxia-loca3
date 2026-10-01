/**
 * screens/AIHubScreen.tsx — The desktop AI Hub (route /ai).
 *
 *   Personal    daily picks · because-you-watched · taste tags · recap
 *               (GET /api/ai/personal/home, /personal/recap — auth)
 *   Assistant   animaxiaAssistant chat with tool traces + memories
 *               (POST /api/ai/assistant, GET /assistant/history — auth)
 *   RAG Lab     public vector playground: recommend · summarize · explain
 *
 * The header carries a live AI Cloud status chip (GET /api/ai/cloud/status,
 * cached with stale-on-error): emerald "llm provider · vector backend" when
 * the LLM answers, amber "degraded" otherwise. Personal + Assistant gate
 * themselves on auth; RAG Lab renders for everyone.
 */

import React, { useState } from 'react';
import { cached } from '@/api/cache';
import * as aiApi from '@/api/ai';
import { useApi } from '@/hooks/useApi';
import { Tabs } from '@/components/primitives';
import { PersonalTab } from '@/ai/PersonalTab';
import { AssistantChat } from '@/ai/AssistantChat';
import { RagLab } from '@/ai/RagLab';

type AiTab = 'personal' | 'assistant' | 'rag';

const TABS: { value: AiTab; label: string }[] = [
  { value: 'personal', label: 'Personal' },
  { value: 'assistant', label: 'Assistant' },
  { value: 'rag', label: 'RAG Lab' },
];

export default function AIHubScreen(): React.JSX.Element {
  const [tab, setTab] = useState<AiTab>('personal');

  const status = useApi(() => cached('ai:cloud:status', aiApi.aiCloudStatus), []);

  const cloudUp = Boolean(status.data && status.data.ok && status.data.llm.available);
  const statusLabel = status.data
    ? cloudUp
      ? `${status.data.llm.provider} · ${status.data.vector.backend}`
      : 'degraded'
    : status.error
      ? 'cloud unreachable'
      : 'checking…';
  const statusTone = status.data ? (cloudUp ? 'badge--emerald' : 'badge--amber') : 'badge--zinc';

  return (
    <div className="stack" style={{ gap: 18 }}>
      <header className="row row--wrap">
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 900, letterSpacing: 0.2 }}>AI Hub</h1>
          <p className="dim" style={{ margin: '2px 0 0', fontSize: 12.5 }}>
            Personal recommendations, the animaxiaAssistant and the RAG Lab — powered by Animaxia AI Cloud.
          </p>
        </div>
        <div style={{ marginLeft: 'auto' }}>
          <button
            type="button"
            className="chip"
            onClick={status.refetch}
            title="AI Cloud status — click to refresh"
            aria-label={`AI Cloud status: ${statusLabel}`}
          >
            <span className={`badge ${statusTone}`}>{statusLabel}</span>
          </button>
        </div>
      </header>

      <Tabs tabs={TABS} value={tab} onChange={setTab} />

      {tab === 'personal' ? <PersonalTab /> : null}
      {tab === 'assistant' ? <AssistantChat /> : null}
      {tab === 'rag' ? <RagLab /> : null}
    </div>
  );
}
