/** JSON-only provider registration. Admin endpoints never execute addon JS. */
import express from 'express';
import { requireAuth, requireAdmin } from '../users/auth.js';
import {
  ensureSourceRegistrySchema, installSourceManifest, listRegisteredSources,
  publicSource, setSourceEnabled, rotateSourceCredential,
} from './source-registry.js';
import { auditLog, clientIpOf } from '../security/security.js';

const router = express.Router();
router.use(requireAuth, requireAdmin);

router.get('/', (_req, res, next) => {
  try {
    ensureSourceRegistrySchema();
    return res.json({ sources: listRegisteredSources(), mode: 'json-push-v1', executableCode: false });
  } catch (error) { return next(error); }
});
router.post('/', async (req, res, next) => {
  try {
    const installed = installSourceManifest(req.body);
    await auditLog({
      userid: req.user.id, action: 'ingest.source.install', ip: clientIpOf(req),
      meta: { source: installed.source },
    }).catch(() => {});
    return res.status(201).json(installed);
  } catch (error) { return next(error); }
});
router.get('/:type/:id', (req, res, next) => {
  try {
    const installed = publicSource({ type: req.params.type, id: req.params.id });
    return installed ? res.json(installed) : res.status(404).json({ error: 'Source not installed' });
  } catch (error) { return next(error); }
});
router.patch('/:type/:id', async (req, res, next) => {
  try {
    const source = { type: req.params.type, id: req.params.id };
    const changed = setSourceEnabled(source, req.body?.enabled);
    await auditLog({
      userid: req.user.id, action: 'ingest.source.enable', ip: clientIpOf(req),
      meta: { source, enabled: changed.enabled },
    }).catch(() => {});
    return res.json(changed);
  } catch (error) { return next(error); }
});
router.post('/:type/:id/rotate-key', async (req, res, next) => {
  try {
    const source = { type: req.params.type, id: req.params.id };
    const changed = rotateSourceCredential(source);
    await auditLog({
      userid: req.user.id, action: 'ingest.source.rotate-key',
      ip: clientIpOf(req), meta: { source },
    }).catch(() => {});
    return res.json(changed);
  } catch (error) { return next(error); }
});
export default router;
