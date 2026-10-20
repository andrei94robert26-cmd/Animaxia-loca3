/**
 * Scoped service credential for automated metadata pushes.
 * Does not authenticate general /api routes and has no admin permissions.
 * Service credentials are configured only in the server environment.
 */
import crypto from 'node:crypto';
import { requireAuth, requireAdmin } from '../users/auth.js';

const hash = (s) => crypto.createHash('sha256').update(s, 'utf8').digest();
function correctKey(submitted, configured) {
  if (typeof submitted !== 'string' || submitted.length < 32 || submitted.length > 512
    || typeof configured !== 'string' || configured.length < 32) return false;
  return crypto.timingSafeEqual(hash(submitted), hash(configured));
}
export function requireMetadataIngestAccess(req, res, next) {
  const submitted = req.get('x-animaxia-ingest-key');
  if (submitted != null) {
    if (!correctKey(submitted, process.env.ANIMAXIA_INGEST_SERVICE_KEY)) {
      return res.status(403).json({ error: 'Invalid ingest service credential' });
    }
    req.metadataIngestService = true;
    return next();
  }
  return requireAuth(req, res, () => requireAdmin(req, res, next));
}
export function allowedMetadataServiceSource(source) {
  if (!source || typeof source.type !== 'string' || typeof source.id !== 'string') return false;
  const allowed = (process.env.ANIMAXIA_INGEST_ALLOWED_SOURCES || '')
    .split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  // Service credentials fail closed without a configured allowlist.
  return allowed.includes((source.type + ':' + source.id).toLowerCase());
}
