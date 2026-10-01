'use client';

/**
 * social.ts — Animaxia FAZA 10 Social & Real-Time client. Typed wrappers for
 * every /api/social/* and /api/ai/social/* endpoint (monolith :4000 through
 * the Caddy gateway, same XTransformPort convention as api.ts / platform.ts)
 * plus the socket.io helper for the realtime service (:4010, path must stay
 * '/' — gateway constraint).
 */

import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import { BACKEND_PORT } from './api';
import { anonRequest, authRequest, tokenStore, PlatformError } from './platform';

/* ------------------------------ URL plumbing ------------------------------ */

const REALTIME_PORT = 4010;

type ParamValue = string | number | boolean | undefined | null;

/** Gateway URL for a social path (same convention as platform.ts platformUrl). */
function socialUrl(path: string, params?: Record<string, ParamValue>): string {
  const search = new URLSearchParams();
  search.set('XTransformPort', String(BACKEND_PORT));
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
    }
  }
  return `${path}?${search.toString()}`;
}

/** Auth-aware request: sends the Bearer token when present, but never lets a
 *  failed auth block a public endpoint (falls back to an anonymous call). */
async function authAwareRequest<T>(path: string, init?: RequestInit): Promise<T> {
  if (tokenStore.access) {
    try {
      return await authRequest<T>(path, init);
    } catch (err) {
      if (err instanceof PlatformError && err.status === 401) {
        return anonRequest<T>(path, init);
      }
      throw err;
    }
  }
  return anonRequest<T>(path, init);
}

/* ---------------------------------- types ---------------------------------- */

export interface SocialUserCard {
  id: number;
  username: string;
  avatar: string | null;
  plan: string;
  followers: number;
  following: number;
  reviews: number;
  isfollowing: boolean;
}

export interface SocialContentRef {
  id: number;
  title: string;
  type: string;
  thumbnail: string | null;
}

export type ActivityType = 'comment' | 'review' | 'follow' | 'party:create' | 'party:join' | 'party:ended';

export interface ActivityEvent {
  id: number;
  type: ActivityType;
  createdat: string;
  user: { id: number; username: string; avatar: string | null };
  content: SocialContentRef | null;
  preview: string | null;
  metadata: Record<string, unknown>;
}

export interface SocialFeedResponse {
  data: ActivityEvent[];
  nextCursor: string | null;
}

export interface SocialReview {
  id: number;
  rating: number;
  title: string | null;
  body: string;
  createdat: string;
  updatedat: string;
  user: { id: number; username: string; avatar: string | null };
  likes: number;
  liked: boolean;
}

export interface SocialReviewWithContent extends SocialReview {
  content: SocialContentRef;
}

export interface SocialReviewsResponse {
  data: SocialReview[];
  aggregate: { count: number; avg: number; distribution: Record<string, number> };
}

export interface PartyState {
  positionSec: number;
  isPaused: boolean;
  playbackRate: number;
  sourceIndex: number;
  updatedAt: string;
}

export interface PartyCard {
  id: number;
  code: string;
  title: string;
  isprivate: boolean;
  status: 'active' | 'ended';
  content: SocialContentRef;
  host: { id: number; username: string; avatar: string | null };
  members: number;
  createdat: string;
  updatedat: string;
  amimember?: boolean;
}

export interface PartyMemberRow {
  userid: number;
  username: string;
  avatar: string | null;
  role: 'host' | 'member';
  joinedat: string;
}

export interface SocketMemberRow {
  userid: number;
  username: string;
  avatar: string | null;
  online: boolean;
}

export interface ChatMessage {
  id: number | string | null;
  body: string;
  createdat: string;
  user: { id: number; username: string; avatar: string | null };
}

export interface PartyDetail {
  party: PartyCard;
  members: PartyMemberRow[];
  state: PartyState;
  messages: ChatMessage[];
}

export interface SocialUserProfile {
  user: { id: number; username: string; avatar: string | null; plan: string; createdat: string };
  stats: { followers: number; following: number; reviews: number; comments: number; partiesHosted: number };
  recentReviews: {
    id: number;
    rating: number;
    title: string | null;
    body: string;
    createdat: string;
    content: SocialContentRef;
  }[];
  recentActivity: {
    id: number;
    type: string;
    createdat: string;
    content: { id: number; title: string; type: string } | null;
    metadata: Record<string, unknown>;
  }[];
  relation: { isfollowing: boolean; followsme: boolean } | null;
  taste: { sharedGenres: string[]; myTopGenres: string[]; theirTopGenres: string[]; score: number } | null;
}

export interface SocialAiHome {
  friendsAlsoWatched: {
    content: SocialContentRef;
    friends: number;
    avgRating: number | null;
    friendNames: string[];
  }[];
  tasteMatches: {
    user: { id: number; username: string; avatar: string | null };
    sharedTitles: number;
    theirTitles: number;
    genreOverlap: string[];
    score: number;
  }[];
  socialPicks: {
    content: SocialContentRef;
    avgRating: number | null;
    reviewCount: number;
    reviewers: string[];
  }[];
}

export interface ReviewDigest {
  ok: true;
  summary: string;
  sentiment: 'positive' | 'mixed' | 'critical' | 'neutral';
  themes: string[];
  reviewCount: number;
  provider: string;
  degraded: boolean;
}

/* ------------------------------- REST client ------------------------------- */

export const social = {
  /* people */
  people: (q?: string, limit = 12) =>
    authRequest<{ data: SocialUserCard[] }>(socialUrl('/api/social/people', { q, limit })),
  follow: (userId: number) =>
    authRequest<{ ok: true; following: boolean }>(socialUrl('/api/social/follow'), {
      method: 'POST',
      body: JSON.stringify({ userId }),
    }),
  unfollow: (userId: number) =>
    authRequest<{ ok: true; following: boolean }>(socialUrl('/api/social/unfollow'), {
      method: 'POST',
      body: JSON.stringify({ userId }),
    }),
  following: () => authRequest<{ data: SocialUserCard[] }>(socialUrl('/api/social/following')),
  followers: () => authRequest<{ data: SocialUserCard[] }>(socialUrl('/api/social/followers')),
  userProfile: (userId: number) =>
    authAwareRequest<SocialUserProfile>(socialUrl(`/api/social/user/${userId}/profile`)),

  /* reviews */
  contentReviews: (contentId: number) =>
    authAwareRequest<SocialReviewsResponse>(socialUrl(`/api/social/reviews/content/${contentId}`)),
  upsertReview: (body: { contentId: number; rating: number; title?: string; body: string }) =>
    authRequest<{ ok: true; review: SocialReview; created: boolean }>(socialUrl('/api/social/reviews'), {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  deleteReview: (id: number) =>
    authRequest<{ ok: true }>(socialUrl(`/api/social/reviews/${id}`), { method: 'DELETE' }),
  likeReview: (id: number) =>
    authRequest<{ ok: true; likes: number; liked: boolean }>(socialUrl(`/api/social/reviews/${id}/like`), {
      method: 'POST',
    }),
  recentReviews: (limit = 20) =>
    authAwareRequest<{ data: SocialReviewWithContent[] }>(socialUrl('/api/social/reviews/recent', { limit })),

  /* activity feed */
  feed: (cursor?: string, limit = 20) =>
    authRequest<SocialFeedResponse>(socialUrl('/api/social/feed/v2', { cursor, limit })),
  publicFeed: (cursor?: string, limit = 20) =>
    anonRequest<SocialFeedResponse>(socialUrl('/api/social/feed/v2/public', { cursor, limit })),

  /* watch parties */
  createParty: (body: { contentId: number; title?: string; isPrivate?: boolean }) =>
    authRequest<{ ok: true; party: PartyCard }>(socialUrl('/api/social/party'), {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  parties: (limit = 20) => anonRequest<{ data: PartyCard[] }>(socialUrl('/api/social/parties', { limit })),
  partyDetail: (id: number) => anonRequest<PartyDetail>(socialUrl(`/api/social/party/${id}`)),
  partyJoin: (id: number) =>
    authRequest<{ ok: true; party: PartyCard }>(socialUrl(`/api/social/party/${id}/join`), {
      method: 'POST',
      body: '{}',
    }),
  partyLeave: (id: number) =>
    authRequest<{ ok: true; status: string }>(socialUrl(`/api/social/party/${id}/leave`), {
      method: 'POST',
      body: '{}',
    }),
  partySync: (id: number, state: PartyState) =>
    authRequest<{ ok: true; state: PartyState }>(socialUrl(`/api/social/party/${id}/sync`), {
      method: 'POST',
      body: JSON.stringify({ state }),
    }),
  partyMessages: (id: number, beforeId?: number) =>
    anonRequest<{ data: ChatMessage[]; nextBeforeId: number | null }>(
      socialUrl(`/api/social/party/${id}/messages`, { beforeId }),
    ),
  partySendMessage: (id: number, body: string) =>
    authRequest<{ ok: true; message: ChatMessage }>(socialUrl(`/api/social/party/${id}/messages`), {
      method: 'POST',
      body: JSON.stringify({ body }),
    }),
  joinByCode: (code: string) =>
    authRequest<{ ok: true; party: PartyCard }>(socialUrl('/api/social/party/join-code'), {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),

  /* AI social */
  aiHome: () => authRequest<SocialAiHome>(socialUrl('/api/ai/social/home')),
  reviewDigest: (contentId: number) =>
    authRequest<ReviewDigest>(socialUrl(`/api/ai/social/review-digest/${contentId}`), { method: 'POST' }),
};

/* ------------------------------ socket helper ------------------------------ */

/**
 * Socket.io connection to the realtime service. URL MUST be exactly
 * '/?XTransformPort=4010' (gateway forwards by query param; never a host or
 * port). Auth token is forwarded in the handshake when signed in; guests get
 * the public activity ticker + presence only.
 */
export function createSocialSocket(): Socket {
  return io(`/?XTransformPort=${REALTIME_PORT}`, {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 1000,
    timeout: 8000,
    auth: tokenStore.access ? { token: tokenStore.access } : {},
  });
}
