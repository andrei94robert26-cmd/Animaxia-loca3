/**
 * services/auth-service/verifyAdmin.js — FROZEN internal contract with the
 * gateway's edge ACL (agent 2-b, services/gateway-service/auth.js):
 *
 *   POST /internal/verify-admin      body { sub: number|string }
 *     → 200 { ok: true, admin: <role === 'admin'>, user: publicUser(row) }
 *     → 404 { ok: false, admin: false, error: 'User not found' }   (unknown sub)
 *     → 400 { ok: false, error: 'Missing sub' }                    (invalid/missing sub)
 *
 * The gateway calls this on every admin-gated request (POST {AUTHSERVICEURL}/
 * internal/verify-admin with { sub: String(jwt.sub) }) and interprets:
 *   • 200 → gate on body.admin (true AND false are both cached 60s per sub)
 *   • 404 → unknown user → admin: false (cached)
 *   • anything else (400/5xx/network) → FAIL CLOSED (503 at the edge)
 * Internal call volume is therefore low (≤ 1 per sub per minute) and riding
 * behind createService's global limiter (120/min/IP) is fine.
 *
 * The route is mounted at '/internal' by server.js — NOT proxied by the
 * gateway, internal-only (cluster network policy should keep it that way;
 * the gateway is the only intended caller).
 */

import express from 'express';
import { getUserById, publicUser } from '@animaxia/domain/users/auth.js';
import { wrap } from '@animaxia/common/middleware.js';
import { logger } from '@animaxia/common/logger.js';

export const verifyAdminRouter = express.Router();

/**
 * POST /verify-admin — resolve a JWT subject to { admin, user }.
 * `sub` may arrive as a number (JWT payload) or its string form (the gateway
 * JSON-stringifies it); both are accepted.
 */
verifyAdminRouter.post(
  '/verify-admin',
  wrap(async (req, res) => {
    const raw = req.body?.sub;
    if (raw === null || raw === undefined || raw === '') {
      return res.status(400).json({ ok: false, error: 'Missing sub' });
    }
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ ok: false, error: 'Missing sub' });
    }

    const row = await getUserById(id);
    if (!row) {
      // Unknown user — gateway caches "definitely not an admin" for 60s.
      return res.status(404).json({ ok: false, admin: false, error: 'User not found' });
    }

    const admin = row.role === 'admin';
    logger.debug(`[verify-admin] sub=${id} → admin=${admin}`);
    return res.status(200).json({ ok: true, admin, user: publicUser(row) });
  }),
);

export default verifyAdminRouter;
