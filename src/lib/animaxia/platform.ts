'use client';

/**
 * platform.ts — Animaxia Phase-2 platform client: typed wrappers for every
 * platform endpoint (auth, users, premium, social, ai, analytics, search,
 * cache, workers, security, mobile) + the Phase-4 AI Cloud (RAG engine,
 * assistant, personal AI, tools, admin AI, vector) + Bearer-token management
 * with a single automatic access-token refresh on 401.
 *
 * All requests go through the Caddy gateway using relative URLs with the
 * XTransformPort query param (backend on :4000) — same pattern as api.ts.
 */

import { BACKEND_PORT } from './api';
import type { DbContent } from './types';

/* --------------------------------- helpers --------------------------------- */

function platformUrl(path: string, params?: Record<string, string | number | boolean | undefined | null>): string {
  const search = new URLSearchParams();
  search.set('XTransformPort', String(BACKEND_PORT));
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
    }
  }
  return `${path}?${search.toString()}`;
}

export class PlatformError extends Error {
  status: number;
  upgrade?: boolean;
  code?: string;
  constructor(message: string, status: number, upgrade?: boolean, code?: string) {
    super(message);
    this.name = 'PlatformError';
    this.status = status;
    this.upgrade = upgrade;
    this.code = code;
  }
}

/* ------------------------------ token storage ------------------------------ */

const ACCESS_KEY = 'animaxia.accessToken';
const REFRESH_KEY = 'animaxia.refreshToken';

export const tokenStore = {
  get access(): string | null {
    try {
      return window.localStorage.getItem(ACCESS_KEY);
    } catch {
      return null;
    }
  },
  get refresh(): string | null {
    try {
      return window.localStorage.getItem(REFRESH_KEY);
    } catch {
      return null;
    }
  },
  set(access: string, refresh: string) {
    try {
      window.localStorage.setItem(ACCESS_KEY, access);
      window.localStorage.setItem(REFRESH_KEY, refresh);
    } catch {
      /* private mode — session will not persist */
    }
  },
  clear() {
    try {
      window.localStorage.removeItem(ACCESS_KEY);
      window.localStorage.removeItem(REFRESH_KEY);
    } catch {
      /* noop */
    }
  },
};

/* ------------------------------ fetch plumbing ----------------------------- */

async function rawRequest<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers as Record<string, string> | undefined),
      },
    });
  } catch {
    throw new PlatformError('Cannot reach the Animaxia backend — it may be restarting', 0);
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const b = (body as { error?: string; upgrade?: boolean; code?: string } | null) ?? {};
    throw new PlatformError(b.error || `Request failed with status ${res.status}`, res.status, b.upgrade, b.code);
  }
  return body as T;
}

/** Authenticated request with one automatic token-refresh retry on 401. */
export async function authRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const access = tokenStore.access;
  const doFetch = () =>
    rawRequest<T>(path, {
      ...init,
      headers: { ...(init?.headers as Record<string, string> | undefined), ...(access ? { Authorization: `Bearer ${access}` } : {}) },
    });
  try {
    return await doFetch();
  } catch (err) {
    if (err instanceof PlatformError && err.status === 401 && tokenStore.refresh) {
      const refreshed = await tryRefresh();
      if (refreshed) {
        return authRequest<T>(path, init); // retry with the new token
      }
    }
    throw err;
  }
}

/** Attempt a refresh-token rotation. Returns true on success. */
export async function tryRefresh(): Promise<boolean> {
  const refresh = tokenStore.refresh;
  if (!refresh) return false;
  try {
    const res = await rawRequest<{ ok: true; accessToken: string; refreshToken: string }>('/api/auth/refresh?XTransformPort=4000', {
      method: 'POST',
      body: JSON.stringify({ refreshToken: refresh }),
    });
    tokenStore.set(res.accessToken, res.refreshToken);
    return true;
  } catch {
    tokenStore.clear();
    return false;
  }
}

/** Anonymous request (no Bearer header). */
export async function anonRequest<T>(path: string, init?: RequestInit): Promise<T> {
  return rawRequest<T>(path, init);
}

/* ---------------------------------- types ----------------------------------- */

export interface Preferences {
  types?: string[];
  genres?: string[];
  franchises?: string[];
}

export interface PlatformUser {
  id: number;
  email: string;
  username: string;
  avatar: string | null;
  role: 'user' | 'admin';
  plan: 'free' | 'plus' | 'pro';
  planexpiresat: string | null;
  preferences: Preferences;
  createdat: string;
  lastloginat: string | null;
  /* TS2b (2FA UI): additive flags from /api/auth/me — older backends omit them. */
  emailverified?: boolean;
  twofaenabled?: boolean;
}

export interface AuthResponse {
  ok: true;
  user: PlatformUser;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface ProfileStats {
  watchlist: number;
  history: number;
  comments: number;
}

export interface WatchlistEntry {
  content: DbContent;
  addedat: string;
}

export interface HistoryEntry {
  content: DbContent;
  watchedat: string;
  progress: number;
}

export interface PlanLimits {
  watchlist: number;
  history: number;
  aiPerDay: number;
  quality: string;
}

export interface Plan {
  key: 'free' | 'plus' | 'pro';
  name: string;
  price: number;
  period: string;
  currency: string;
  limits: PlanLimits;
  features: string[];
  color: string;
  highlight?: boolean;
}

export interface Subscription {
  id: number;
  plan: string;
  status: string;
  provider: string;
  sessionid: string | null;
  currentperiodend: string | null;
  createdat: string;
}

export interface PremiumMe {
  plan: string;
  limits: PlanLimits;
  subscription: Subscription | null;
  usage: { watchlist: number; history: number };
}

export interface CommentUser {
  id: number;
  username: string;
  avatar: string | null;
}

export interface Comment {
  id: number;
  body: string;
  createdat: string;
  user: CommentUser;
  likes: number;
  dislikes: number;
  myVote: number | null;
  replies: Comment[];
}

export interface FeedActivity {
  id: number;
  type: 'comment' | 'like' | 'content' | 'user';
  createdat: string;
  user?: CommentUser;
  content?: { id: number; title: string; type: string; thumbnail: string | null };
  preview?: string;
  value?: number;
}

export interface FeedResponse {
  data: FeedActivity[];
  nextCursor: string | null;
  basedOn?: { types: string[]; genres: string[]; trackedContent: number };
}

export interface AiRecommendation {
  content: DbContent;
  reason: string;
}

export interface TrendingEntry {
  content: DbContent;
  views: number;
  plays: number;
  score: number;
}

export interface AnalyticsOverview {
  totals: { users: number; content: number; comments: number; views: number; plays: number };
  viewsByDay: { date: string; count: number }[];
  topContent: { id: number; title: string; type: string; thumbnail: string | null; views: number }[];
  planDistribution: Record<string, number>;
  activeUsers7d: number;
  recentSignups: { username: string; createdat: string }[];
}

export interface UserAnalytics {
  totals: { views: number; plays: number; completed: number };
  viewsByDay: { date: string; count: number }[];
  topTypes: { type: string; count: number }[];
}

export interface SearchAdvancedResponse {
  took: number;
  total: number;
  max_score: number;
  data: (DbContent & { _score: number })[];
}

export interface WorkerJob {
  id: string;
  type: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  result?: unknown;
  error?: string | null;
  queuedat?: string;
  startedat?: string | null;
  finishedat?: string | null;
}

export interface MobileItem {
  id: number;
  title: string;
  type: string;
  thumbnail: string | null;
  rating: number | null;
  year: string | number | null;
  overview?: string | null;
  backdrop?: string | null;
}

export interface MobileHome {
  hero: MobileItem | null;
  rows: { key: string; title: string; items: MobileItem[] }[];
  config: { minVersion: string; latestVersion: string };
}

export interface AuditEntry {
  id: number;
  action: string;
  ip: string | null;
  meta: Record<string, unknown>;
  createdat: string;
  user: { username: string; email: string } | null;
}

/* --------------------------- AI Cloud (Phase 4) types --------------------------- */

export interface AiCloudQuota {
  plan: string;
  used: number;
  limit: number;
  perMinute: number;
}

export interface AiCloudStatus {
  ok: boolean;
  llm: { provider: string; model: string; available: boolean };
  vector: { backend: string; dims: number; counts: Record<string, number>; lastIndexedAt: string | null };
  assistant: { tools: number };
  quota: AiCloudQuota;
  plans: Record<string, number>;
}

/** A vector-ranked AI pick (shared shape across RAG recommend + personal home). */
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
  quota?: { plan: string; used: number; limit: number };
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
}

export interface AiRagChatResponse {
  ok: boolean;
  provider: string;
  degraded: boolean;
  reply: string;
  sources: { id: number; title: string; score: number }[];
}

/** A chat turn in the {role, content} wire format the RAG endpoints accept. */
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
}

export interface AiAssistantHistoryEntry {
  role: string;
  message: string;
  toolsused: unknown[];
  createdat: string;
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

export interface AiPersonalFeedResponse {
  ok: boolean;
  data: AiPersonalFeedItem[];
  recap: { week: string; recap: string; stats: { watched: number; topGenres: string[]; topTitles: string[] } } | null;
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
  stats: { watched: number; topGenres: string[]; topTitles: string[]; historyTotal: number };
}

export interface AiTool {
  name: string;
  description: string;
  parameters: Record<string, string>;
  required: string[];
  example: Record<string, unknown>;
}

export interface AiToolRunResponse {
  ok: boolean;
  tool: string;
  result: unknown;
  ms: number;
}

export interface AiAdminStatsResponse {
  ok: boolean;
  provider: { provider: string; model: string; available: boolean };
  usage: {
    totalCalls: number;
    callsToday: number;
    errors: number;
    errorRate: number;
    degradedCalls: number;
    tokens: { prompt: number; completion: number };
    costUsd: number;
    byProvider: Record<string, number>;
    byFeature: Record<string, number>;
    byMode: Record<string, number>;
    latency: { p50: number; p95: number; avg: number };
    persistedLogs: number | null;
    ringSize: number;
  };
  vector: { backend: string; dims: number; counts: Record<string, number> };
  assistant: { tools: number; toolNames: string[] };
}

export interface AiAdminPromptsResponse {
  ok: boolean;
  topPrompts: { feature: string; mode: string | null; snippet: string; count: number; tokens: number }[];
  recent: {
    traceid: string;
    userid: number | null;
    feature: string;
    mode: string | null;
    provider: string;
    tokens: number;
    latencyms: number;
    status: string;
    degraded: boolean;
    snippet: string;
    createdat: string;
  }[];
}

export interface AiAdminErrorsResponse {
  ok: boolean;
  total: number;
  errorRate: number;
  recent: { traceid: string; provider: string; feature: string; message: string | null; snippet: string; createdat: string }[];
}

export interface VectorStatusResponse {
  backend: string;
  configured: string;
  active: boolean;
  embedProvider: string;
  dims: number;
  counts: Record<string, number>;
  lastIndexedAt: string | null;
}

/* ----------------------------------- API ----------------------------------- */

export const platform = {
  /* auth */
  register: (body: { email: string; username: string; password: string }) =>
    anonRequest<AuthResponse>(platformUrl('/api/auth/register'), { method: 'POST', body: JSON.stringify(body) }),
  login: (body: { email: string; password: string; code?: string }) =>
    anonRequest<AuthResponse>(platformUrl('/api/auth/login'), { method: 'POST', body: JSON.stringify(body) }),
  logout: (refreshToken: string) =>
    anonRequest<{ ok: true; revoked: boolean }>(platformUrl('/api/auth/logout'), {
      method: 'POST',
      body: JSON.stringify({ refreshToken }),
    }),
  me: () => authRequest<{ user: PlatformUser; stats: ProfileStats }>(platformUrl('/api/auth/me')),

  /* TS2b (2FA UI): TOTP lifecycle + email verification (auth.js TS3 routes). */
  twoFactorSetup: () =>
    authRequest<{ ok: true; secret: string; otpauthUrl: string }>(platformUrl('/api/auth/2fa/setup'), {
      method: 'POST',
      body: '{}',
    }),
  twoFactorEnable: (code: string) =>
    authRequest<{ ok: true }>(platformUrl('/api/auth/2fa/enable'), {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),
  twoFactorDisable: (code: string) =>
    authRequest<{ ok: true }>(platformUrl('/api/auth/2fa/disable'), {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),
  /** GET /api/auth/verify?token= — consume a single-use email token (public). */
  verifyEmail: (token: string) =>
    anonRequest<{ ok: true; message: string }>(platformUrl('/api/auth/verify', { token })),

  /* users */
  profile: () => authRequest<{ user: PlatformUser; stats: ProfileStats }>(platformUrl('/api/users/me')),
  patchProfile: (body: { username?: string; avatar?: string; preferences?: Preferences }) =>
    authRequest<{ user: PlatformUser }>(platformUrl('/api/users/me'), { method: 'PATCH', body: JSON.stringify(body) }),
  uploadAvatar: (image: string) =>
    authRequest<{ user: PlatformUser }>(platformUrl('/api/users/me/avatar'), { method: 'POST', body: JSON.stringify({ image }) }),
  watchlist: () => authRequest<{ data: WatchlistEntry[] }>(platformUrl('/api/users/me/watchlist')),
  addWatchlist: (contentId: number) =>
    authRequest<{ ok: true; added: boolean }>(platformUrl('/api/users/me/watchlist'), {
      method: 'POST',
      body: JSON.stringify({ contentId }),
    }),
  removeWatchlist: (contentId: number) =>
    authRequest<{ ok: true; removed: boolean }>(platformUrl(`/api/users/me/watchlist/${contentId}`), { method: 'DELETE' }),
  history: (limit = 50) => authRequest<{ data: HistoryEntry[] }>(platformUrl('/api/users/me/history', { limit })),
  recordHistory: (contentId: number, progress: number) =>
    authRequest<{ ok: true }>(platformUrl('/api/users/me/history'), {
      method: 'POST',
      body: JSON.stringify({ contentId, progress }),
    }),
  preferences: () => authRequest<{ preferences: Preferences }>(platformUrl('/api/users/me/preferences')),
  putPreferences: (body: Preferences) =>
    authRequest<{ preferences: Preferences }>(platformUrl('/api/users/me/preferences'), {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  /* premium */
  plans: () => anonRequest<{ data: Plan[] }>(platformUrl('/api/premium/plans')),
  premiumMe: () => authRequest<PremiumMe>(platformUrl('/api/premium/me')),
  premiumVerify: () => authRequest<{ plan: string; active: boolean; limits: PlanLimits }>(platformUrl('/api/premium/verify')),
  checkout: (plan: 'plus' | 'pro') =>
    authRequest<{ ok: true; sessionId: string; url: string; mode: string }>(platformUrl('/api/premium/checkout'), {
      method: 'POST',
      body: JSON.stringify({ plan }),
    }),
  confirmCheckout: (sessionId: string) =>
    authRequest<{ ok: true; user: PlatformUser; subscription: Subscription }>(platformUrl('/api/premium/confirm'), {
      method: 'POST',
      body: JSON.stringify({ sessionId }),
    }),
  cancelSubscription: () =>
    authRequest<{ ok: true; subscription: Subscription }>(platformUrl('/api/premium/cancel'), { method: 'POST', body: '{}' }),

  /* social */
  comments: (contentId: number | string) =>
    anonRequest<{ data: Comment[] }>(platformUrl(`/api/social/content/${contentId}/comments`)),
  addComment: (contentId: number | string, body: string, parentid?: number) =>
    authRequest<{ ok: true; comment: Comment }>(platformUrl(`/api/social/content/${contentId}/comments`), {
      method: 'POST',
      body: JSON.stringify({ body, ...(parentid ? { parentid } : {}) }),
    }),
  deleteComment: (id: number) =>
    authRequest<{ ok: true }>(platformUrl(`/api/social/comments/${id}`), { method: 'DELETE' }),
  voteComment: (id: number, value: 1 | -1 | 0) =>
    authRequest<{ ok: true; likes: number; dislikes: number; myVote: number }>(platformUrl(`/api/social/comments/${id}/vote`), {
      method: 'POST',
      body: JSON.stringify({ value }),
    }),
  likeContent: (contentId: number | string, value: 1 | -1 | 0) =>
    authRequest<{ ok: true; likes: number; dislikes: number; myVote: number }>(
      platformUrl(`/api/social/content/${contentId}/like`),
      { method: 'POST', body: JSON.stringify({ value }) },
    ),
  contentLikes: (contentId: number | string) =>
    anonRequest<{ likes: number; dislikes: number; myVote: number | null }>(platformUrl(`/api/social/content/${contentId}/likes`)),
  globalFeed: (cursor?: string | null, limit = 20) =>
    anonRequest<FeedResponse>(platformUrl('/api/social/feed/global', { cursor, limit })),
  personalFeed: (cursor?: string | null, limit = 20) =>
    authRequest<FeedResponse>(platformUrl('/api/social/feed/personal', { cursor, limit })),

  /* ai */
  aiStatus: () =>
    anonRequest<{ provider: string; available: boolean; model: string; requestsToday: number; quota: Record<string, number> }>(
      platformUrl('/api/ai/status'),
    ),
  /* AI endpoints are public but send Bearer when present so signed-in users
     get their own (higher) daily quota and personalized results. */
  aiRecommendations: (limit = 10) =>
    authRequest<{ data: AiRecommendation[]; provider: string }>(platformUrl('/api/ai/recommendations', { limit })),
  aiSummarize: (contentId: number | string) =>
    authRequest<{ summary: string; provider: string }>(platformUrl('/api/ai/summarize'), {
      method: 'POST',
      body: JSON.stringify({ contentId }),
    }),
  aiDescribe: (body: { title: string; type: string; genres?: string[] }) =>
    authRequest<{ description: string; provider: string }>(platformUrl('/api/ai/describe'), {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  aiChat: (contentId: number | string, message: string) =>
    authRequest<{ reply: string; provider: string }>(platformUrl('/api/ai/chat'), {
      method: 'POST',
      body: JSON.stringify({ contentId, message }),
    }),

  /* ai cloud (Phase 4 — Animaxia AI Cloud). Public routes go through
     authRequest so signed-in callers attach a Bearer token (their own plan
     quota + personalized vector rankings); strictly authed routes 401 when
     the session is missing. */
  aiCloudStatus: () => authRequest<AiCloudStatus>(platformUrl('/api/ai/cloud/status')),
  aiRagRecommend: (body: { query?: string; limit?: number }) =>
    authRequest<AiRagRecommendResponse>(platformUrl('/api/ai/rag/recommend'), {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  aiRagSummarize: (contentId: number | string) =>
    authRequest<AiRagSummarizeResponse>(platformUrl('/api/ai/rag/summarize'), {
      method: 'POST',
      body: JSON.stringify({ contentId }),
    }),
  aiRagExplain: (contentId: number | string, question?: string) =>
    authRequest<AiRagExplainResponse>(platformUrl('/api/ai/rag/explain'), {
      method: 'POST',
      body: JSON.stringify({ contentId, ...(question ? { question } : {}) }),
    }),
  aiRagChat: (contentId: number | string, message: string, history: AiChatTurn[]) =>
    authRequest<AiRagChatResponse>(platformUrl('/api/ai/rag/chat'), {
      method: 'POST',
      body: JSON.stringify({ contentId, message, history }),
    }),
  aiAssistant: (message: string, history?: AiChatTurn[]) =>
    authRequest<AiAssistantResponse>(platformUrl('/api/ai/assistant'), {
      method: 'POST',
      body: JSON.stringify({ message, ...(history ? { history } : {}) }),
    }),
  aiAssistantHistory: (limit = 20) =>
    authRequest<{ ok: boolean; data: AiAssistantHistoryEntry[] }>(platformUrl('/api/ai/assistant/history', { limit })),
  aiPersonalHome: () => authRequest<AiPersonalHomeResponse>(platformUrl('/api/ai/personal/home')),
  aiPersonalFeed: (limit = 20) =>
    authRequest<AiPersonalFeedResponse>(platformUrl('/api/ai/personal/feed', { limit })),
  aiPersonalPlayer: (contentId: number | string) =>
    authRequest<AiPersonalPlayerResponse>(platformUrl('/api/ai/personal/player', { contentId })),
  aiPersonalRecap: () => authRequest<AiPersonalRecapResponse>(platformUrl('/api/ai/personal/recap')),
  aiTools: () => authRequest<{ ok: boolean; data: AiTool[] }>(platformUrl('/api/ai/tools')),
  aiToolRun: (name: string, args: Record<string, unknown>) =>
    authRequest<AiToolRunResponse>(platformUrl('/api/ai/tools/run'), {
      method: 'POST',
      body: JSON.stringify({ name, args }),
    }),
  aiAdminStats: () => authRequest<AiAdminStatsResponse>(platformUrl('/api/ai/admin/stats')),
  aiAdminPrompts: (limit = 10) => authRequest<AiAdminPromptsResponse>(platformUrl('/api/ai/admin/prompts', { limit })),
  aiAdminErrors: (limit = 10) => authRequest<AiAdminErrorsResponse>(platformUrl('/api/ai/admin/errors', { limit })),
  vectorStatus: () => anonRequest<VectorStatusResponse>(platformUrl('/api/vector/status')),

  /* analytics */
  recordView: (contentId: number | string, event: 'view' | 'play' | 'complete') =>
    anonRequest<{ ok: true }>(platformUrl('/api/analytics/views'), {
      method: 'POST',
      body: JSON.stringify({ contentId, event }),
    }),
  trending: (window: '24h' | '7d' | '30d' = '7d', limit = 10) =>
    anonRequest<{ data: TrendingEntry[]; fallback?: boolean }>(platformUrl('/api/analytics/trending', { window, limit })),
  userAnalytics: (userId: number, days = 14) =>
    authRequest<UserAnalytics>(platformUrl(`/api/analytics/user/${userId}`, { days })),
  analyticsOverview: () => authRequest<AnalyticsOverview>(platformUrl('/api/analytics/overview')),

  /* search */
  searchAdvanced: (p: {
    q: string;
    type?: string;
    genre?: string;
    year?: string | number;
    minRating?: number;
    sort?: 'score' | 'year' | 'rating' | 'title';
    fuzzy?: boolean;
    limit?: number;
  }) => anonRequest<SearchAdvancedResponse>(platformUrl('/api/search/advanced', p as Record<string, string | number | boolean | undefined>)),
  autocomplete: (q: string) =>
    anonRequest<{ suggestions: { id: number; title: string; type: string; thumbnail: string | null }[] }>(
      platformUrl('/api/search/autocomplete', { q }),
    ),
  searchStatus: () =>
    anonRequest<{ docs: number; terms: number; lastSync: string | null; dirty: boolean; engine: string }>(
      platformUrl('/api/search/status'),
    ),
  reindex: () => authRequest<{ ok: true; indexed: number }>(platformUrl('/api/search/index'), { method: 'POST', body: '{}' }),

  /* cache */
  cacheStats: () =>
    anonRequest<{
      lru: Record<string, number>;
      global: Record<string, number>;
    }>(platformUrl('/api/cache/stats')),
  cacheInvalidate: (body: { tags?: string[]; prefix?: string }) =>
    authRequest<{ ok: true; cleared: number }>(platformUrl('/api/cache/invalidate'), {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /* workers */
  workerMine: (body: { url: string; type?: string; externalId?: string }) =>
    authRequest<{ ok: true; jobId: string }>(platformUrl('/api/workers/mine'), { method: 'POST', body: JSON.stringify(body) }),
  workerPrefetch: (contentId: number) =>
    authRequest<{ ok: true; jobId: string }>(platformUrl('/api/workers/prefetch'), {
      method: 'POST',
      body: JSON.stringify({ contentId }),
    }),
  workerThumbnails: (body: { contentId?: number; missing?: boolean }) =>
    authRequest<{ ok: true; jobId: string }>(platformUrl('/api/workers/thumbnails'), { method: 'POST', body: JSON.stringify(body) }),
  workerRefresh: (source: 'tmdb' | 'jikan') =>
    authRequest<{ ok: true; jobId: string }>(platformUrl('/api/workers/refresh'), {
      method: 'POST',
      body: JSON.stringify({ source }),
    }),
  workerJobs: () => authRequest<{ data: WorkerJob[] }>(platformUrl('/api/workers/jobs')),
  workerJob: (id: string) => authRequest<WorkerJob>(platformUrl(`/api/workers/jobs/${id}`)),
  workerStatus: () =>
    authRequest<{
      pool: { size: number; busy: number; queued: number };
      jobs: { total: number; done: number; failed: number; running: number };
      schedules: { name: string; intervalMs: number; lastRunAt: string | null; nextRunAt: string | null; enabled: boolean }[];
    }>(platformUrl('/api/workers/status')),

  /* security (admin) */
  securityStatus: () =>
    authRequest<{
      bruteForce: Record<string, number>;
      buckets: { key: string; max: number; windowMs: number; trackedClients: number; totalLimited: number }[];
      auditTotal: number;
    }>(platformUrl('/api/security/status')),
  auditLog: (limit = 50, offset = 0) =>
    authRequest<{ data: AuditEntry[]; total: number }>(platformUrl('/api/security/audit', { limit, offset })),

  /* mobile */
  mobileHome: () => anonRequest<MobileHome>(platformUrl('/api/mobile/home')),
  mobilePlayer: (id: number | string) =>
    anonRequest<{
      content: MobileItem;
      mode: string;
      allowedTypes: string[];
      sources: { type: string; url: string; label?: string }[];
      primary: { type: string; url: string; label?: string } | null;
      nextUp: MobileItem | null;
    }>(platformUrl(`/api/mobile/player/${id}`)),
  mobileConfig: () =>
    anonRequest<{
      versions: { min: string; latest: string };
      features: Record<string, boolean>;
      endpoints: Record<string, string>;
    }>(platformUrl('/api/mobile/config')),
};

/** Worker-generated SVG thumbnail URL (served by the backend on :4000). */
export function workerThumbnailUrl(file: string): string {
  return platformUrl(`/api/workers/thumbnails/${file}`);
}
