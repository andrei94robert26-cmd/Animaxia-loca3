/**
 * api/ai.ts — Animaxia AI Cloud client (/api/ai/* — served by ai-service :4003
 * through the gateway).
 *
 *   GET  /cloud/status                        → providers, vector backend, quotas
 *   POST /assistant { message, history }      → animaxiaAssistant reply (auth)
 *   GET  /assistant/history?limit=            → persisted turns (auth)
 *   GET  /personal/home                       → greeting + daily picks (auth)
 *   GET  /personal/feed?limit=                → AI-ranked feed + recap (auth)
 *   GET  /personal/player?contentId=          → player companion (auth)
 *   GET  /personal/recap                      → weekly recap (auth)
 *   POST /rag/recommend { query, limit }      → vector-ranked picks (public)
 *   POST /rag/summarize { contentId }         → RAG summary (public)
 *   POST /rag/explain { contentId, question } → match + explanation (public)
 *   POST /rag/chat { contentId, message, history } → chat-with-content (auth)
 *
 * Quota: every AI response carries `quota: { plan, used, limit, perMinute }`
 * (free 10/day · plus 100/day · pro 500/day · anonymous 5/day per IP).
 * 402 responses carry { upgrade: true } → the UI links to the Premium screen.
 */

import { request } from './client';

/* ---------------------------------- types ---------------------------------- */

export interface AiCloudQuota {
  plan: string;
  used: number;
  limit: number;
  perMinute: number;
}

export interface AiCloudStatus {
  ok: boolean;
  llm: { provider: string; model: string; available: boolean };
  config: { provider: string; vectorBackend: string };
  vector: { backend: string; dims: number; counts: Record<string, number>; lastIndexedAt: string | null };
  assistant: { tools: number };
  quota: AiCloudQuota;
  plans: Record<string, number>;
}

export interface AiRagPick {
  id: number;
  title: string;
  type: string;
  thumbnail: string | null;
  rating: number | null;
  year: string | number | null;
  genres: string[];
  reason: string;
  score: number;
}

export interface AiRagRecommendResponse {
  ok: boolean;
  provider: string;
  degraded: boolean;
  personalized: boolean;
  data: AiRagPick[];
  intro: string | null;
  quota?: AiCloudQuota;
}

export interface AiRagSummarizeResponse {
  ok: boolean;
  provider: string;
  degraded: boolean;
  title: string;
  summary: string;
}

export interface AiRagExplainResponse {
  ok: boolean;
  provider: string;
  degraded: boolean;
  title: string;
  matchScore: number | null;
  explanation: string;
  similar: { id: number; title: string; type: string; thumbnail: string | null; genres?: string[]; score: number }[];
  quota?: AiCloudQuota;
}

export interface AiRagChatResponse {
  ok: boolean;
  provider: string;
  degraded: boolean;
  reply: string;
  sources: { id: number; title: string; score: number }[];
  quota?: AiCloudQuota;
}

export interface AiChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface AiToolTrace {
  name: string;
  args: Record<string, unknown>;
  ms: number;
  ok: boolean;
}

export interface AiAssistantResponse {
  ok: boolean;
  reply: string;
  provider: string;
  degraded: boolean;
  toolsUsed: AiToolTrace[];
  memoriesUsed: number;
  refused?: boolean;
  traceId?: string;
  quota?: AiCloudQuota;
}

export interface AiAssistantHistoryEntry {
  role: string;
  message: string;
  toolsused: string[];
  createdat: string | null;
}

export interface AiBecauseYouWatched {
  id: number;
  title: string;
  type: string;
  thumbnail: string | null;
  score: number;
  because: string;
}

export interface AiPersonalHomeResponse {
  ok: boolean;
  greeting: string;
  mood: string;
  dailyPicks: AiRagPick[];
  becauseYouWatched: AiBecauseYouWatched[];
  aiProfile: { tags: string[]; summary: string | null };
  quota: AiCloudQuota;
  recapPreview: string;
  provider: string;
  degraded: boolean;
}

export interface AiPersonalFeedItem {
  type: 'comment' | 'content';
  user?: string;
  content: string | null;
  contentid?: number;
  contenttype: string | null;
  thumbnail: string | null;
  preview: string;
  createdat: string;
  aiWhy: string;
}

export interface AiWeeklyStats {
  watched: number;
  topGenres: string[];
  topTitles: string[];
  historyTotal?: number;
}

export interface AiPersonalFeedResponse {
  ok: boolean;
  data: AiPersonalFeedItem[];
  recap: { week: string; recap: string; stats: AiWeeklyStats } | null;
  basedOn: { personalized: boolean };
}

export interface AiPersonalPlayerResponse {
  ok: boolean;
  title: string;
  beforeYouWatch: string;
  predictedRating: number | null;
  matchScore: number | null;
  moreLikeThis: { id: number; title: string; type: string; thumbnail: string | null; genres: string[]; score: number }[];
  nextUp: { id: number; title: string; thumbnail: string | null } | null;
  provider: string;
  degraded: boolean;
}

export interface AiPersonalRecapResponse {
  ok: boolean;
  week: string;
  recap: string;
  stats: AiWeeklyStats;
  provider?: string;
  degraded?: boolean;
}

/* --------------------------------- methods --------------------------------- */

export function aiCloudStatus(): Promise<AiCloudStatus> {
  return request<AiCloudStatus>('/api/ai/cloud/status');
}

export function aiPersonalHome(): Promise<AiPersonalHomeResponse> {
  return request<AiPersonalHomeResponse>('/api/ai/personal/home');
}

export function aiPersonalFeed(limit = 12): Promise<AiPersonalFeedResponse> {
  return request<AiPersonalFeedResponse>('/api/ai/personal/feed', { query: { limit } });
}

export function aiPersonalPlayer(contentId: number): Promise<AiPersonalPlayerResponse> {
  return request<AiPersonalPlayerResponse>('/api/ai/personal/player', { query: { contentId } });
}

export function aiPersonalRecap(): Promise<AiPersonalRecapResponse> {
  return request<AiPersonalRecapResponse>('/api/ai/personal/recap');
}

export function aiAssistant(message: string, history: AiChatTurn[]): Promise<AiAssistantResponse> {
  return request<AiAssistantResponse>('/api/ai/assistant', {
    method: 'POST',
    body: { message, history },
  });
}

export function aiAssistantHistory(limit = 20): Promise<{ ok: boolean; data: AiAssistantHistoryEntry[] }> {
  return request<{ ok: boolean; data: AiAssistantHistoryEntry[] }>('/api/ai/assistant/history', {
    query: { limit },
  });
}

export function aiRagRecommend(query: string, limit = 6): Promise<AiRagRecommendResponse> {
  return request<AiRagRecommendResponse>('/api/ai/rag/recommend', {
    method: 'POST',
    body: { query, limit },
  });
}

export function aiRagSummarize(contentId: number): Promise<AiRagSummarizeResponse> {
  return request<AiRagSummarizeResponse>('/api/ai/rag/summarize', {
    method: 'POST',
    body: { contentId },
  });
}

export function aiRagExplain(contentId: number, question?: string): Promise<AiRagExplainResponse> {
  return request<AiRagExplainResponse>('/api/ai/rag/explain', {
    method: 'POST',
    body: { contentId, question },
  });
}

export function aiRagChat(contentId: number, message: string, history: AiChatTurn[]): Promise<AiRagChatResponse> {
  return request<AiRagChatResponse>('/api/ai/rag/chat', {
    method: 'POST',
    body: { contentId, message, history },
  });
}
