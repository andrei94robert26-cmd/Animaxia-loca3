/**
 * services/social-service/router.js — Social route composition.
 *
 * Mirrors the monolith mount exactly (mini-services/animaxia-backend/
 * server.js):
 *
 *   app.use('/api/social', commentsRouter, feedRouter);
 *
 * One path, both domain routers in order: commentsRouter owns the
 * /content/:id/comments|likes and /comments/:id routes, feedRouter adds
 * /feed/global (public) and /feed/personal (requireAuth). Neither router has
 * a catch-all, so requests fall through comments → feed exactly as in the
 * monolith. Mutating routes carry their own requireAuth + per-user limiter
 * (20 comments/min); the gateway additionally edge-gates POST/PUT/DELETE on
 * /api/social/* with a token check.
 */

import express from 'express';
import { commentsRouter } from '@animaxia/domain/social/comments.js';
import { feedRouter } from '@animaxia/domain/social/feed.js';

/** /api/social — comments, votes, content likes + activity feeds. */
export const socialRouter = express.Router();
socialRouter.use(commentsRouter, feedRouter);

export default socialRouter;
