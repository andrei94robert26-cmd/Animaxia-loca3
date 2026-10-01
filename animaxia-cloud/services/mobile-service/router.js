/**
 * services/mobile-service/router.js — mobileApi: the mobile BFF mount.
 *
 * Thin composition layer (BLUEPRINT §7 frozen folder template): the whole
 * mobile surface lives in @animaxia/domain/mobile/mobile.js — mounted here
 * with NO extra middleware, exactly like the monolith's
 * `app.use('/api/mobile', mobileRouter)`:
 *
 *   GET /home        public; auth adds the Continue-watching row. The
 *                    ANONYMOUS variant is cached in the domain advancedCache
 *                    ('mobile:home', 60s TTL, tag 'content' → auto-invalidated
 *                    on content:changed). NEVER wrap in the global HTTP
 *                    cacheMiddleware — responses are user-dependent.
 *   GET /player/:id  public compact player payload (never cached).
 *   GET /profile     requireAuth (enforced inside the domain router).
 *   GET /config      public client bootstrap.
 *
 * No service-specific routes yet; this file exists so the service owns its
 * composition point if one is ever needed (keep any additions user-aware —
 * the global cacheMiddleware must never apply to /api/mobile).
 */

import express from 'express';
import mobileRouter from '@animaxia/domain/mobile/mobile.js';

export const mobileApi = express.Router();
mobileApi.use(mobileRouter);

export default mobileApi;
