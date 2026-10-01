/**
 * api/social.ts — /api/social/* client: activity feeds, threaded comments,
 * content likes.
 *
 *   GET  /feed/global?cursor=&limit=   → { data: [activity], nextCursor }  (public)
 *   GET  /feed/personal?cursor=&limit= → { data, nextCursor, basedOn }     (auth)
 *   GET  /content/:id/comments         → { data: [threads] }   (public; auth adds myVote)
 *   POST /content/:id/comments { body, parentId? } → { ok, comment }      (auth)
 *   POST /content/:id/like { value: 1|-1|0 }       → { ok, likes, dislikes, myVote } (auth)
 *   GET  /content/:id/likes                        → { likes, dislikes, myVote }
 *
 * Activity shape: { id, type: 'comment'|'like'|'content'|'user', createdat,
 *   user?: { id, username, avatar }, content?: { id, title, type, thumbnail },
 *   preview?: string, value?: 1 }
 * Cursors are opaque base64url strings — pass nextCursor back as ?cursor=.
 */

import { request } from './client';

/* ---------------------------------- types ---------------------------------- */

export interface SocialUser {
  id: number;
  username: string;
  avatar: string | null;
}

export interface SocialContentRef {
  id: number;
  title: string;
  type: string;
  thumbnail: string | null;
}

export interface Activity {
  id: number;
  type: 'comment' | 'like' | 'content' | 'user';
  createdat: string | null;
  user?: SocialUser;
  content?: SocialContentRef;
  preview?: string;
  value?: number;
}

export interface FeedPage {
  data: Activity[];
  nextCursor: string | null;
}

export interface CommentThread {
  id: number;
  body: string;
  createdat: string | null;
  user: SocialUser;
  likes: number;
  dislikes: number;
  myVote: number | null;
  replies: Omit<CommentThread, 'replies'>[];
}

export interface LikeState {
  likes: number;
  dislikes: number;
  myVote: number | null;
}

/* ---------------------------------- feeds ---------------------------------- */

export function feedGlobal(cursor?: string | null, limit = 20): Promise<FeedPage> {
  return request<FeedPage>('/api/social/feed/global', { query: { cursor, limit } });
}

export function feedPersonal(cursor?: string | null, limit = 20): Promise<FeedPage & { basedOn: unknown }> {
  return request<FeedPage & { basedOn: unknown }>('/api/social/feed/personal', { query: { cursor, limit } });
}

/* --------------------------------- comments -------------------------------- */

export function contentComments(contentId: number | string): Promise<{ data: CommentThread[] }> {
  return request<{ data: CommentThread[] }>(`/api/social/content/${contentId}/comments`);
}

export function addComment(contentId: number | string, body: string, parentId?: number): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/social/content/${contentId}/comments`, {
    method: 'POST',
    body: { body, ...(parentId ? { parentId } : {}) },
  });
}

/* ----------------------------------- likes ---------------------------------- */

export function contentLikes(contentId: number | string): Promise<LikeState> {
  return request<LikeState>(`/api/social/content/${contentId}/likes`);
}

/** value: 1 like · -1 dislike · 0 clear. */
export function likeContent(contentId: number | string, value: 1 | -1 | 0): Promise<LikeState> {
  return request<LikeState>(`/api/social/content/${contentId}/like`, {
    method: 'POST',
    body: { value },
  });
}
