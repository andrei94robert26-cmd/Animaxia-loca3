/**
 * services/auth-service/router.js — Auth-service route composition.
 *
 * Mirrors the monolith mounts exactly (mini-services/animaxia-backend/
 * server.js):
 *
 *   app.use('/api/auth',     authRouter);                              // own guard per route
 *   app.use('/api/users',    requireAuth, profileRouter);              // mount-level auth
 *   app.use('/api/security', requireAuth, requireAdmin, securityRouter); // mount-level admin
 *
 * The domain requireAuth/requireAdmin guards (from @animaxia/domain/users/
 * auth.js) re-extract the Bearer token, re-verify it and re-fetch the user
 * row themselves — they do NOT depend on createService's earlier
 * attachUserFromToken pass (which exists so public routes like
 * GET /api/auth/me-adjacent optional-auth paths still see req.user).
 * Both produce the identical publicUser() req.user shape.
 */

import express from 'express';
import { authRouter, requireAuth, requireAdmin } from '@animaxia/domain/users/auth.js';
import profileRouter from '@animaxia/domain/users/profile.js';
import { securityRouter } from '@animaxia/domain/security/security.js';

/**
 * /api/users — authenticated profile/watchlist/history/preferences.
 * Monolith: app.use('/api/users', requireAuth, profileRouter) — every profile
 * route therefore assumes a fresh req.user snapshot.
 */
export const usersRouter = express.Router();
usersRouter.use(requireAuth, profileRouter);

/**
 * /api/security — admin-only security console (brute-force + bucket stats,
 * audit trail). Monolith: app.use('/api/security', requireAuth, requireAdmin,
 * securityRouter). The gateway additionally edge-gates /api/security/* with
 * its own admin ACL (via /internal/verify-admin) — defense in depth.
 */
export const securityAdminRouter = express.Router();
securityAdminRouter.use(requireAuth, requireAdmin, securityRouter);

export { authRouter };
export default { authRouter, usersRouter, securityAdminRouter };
