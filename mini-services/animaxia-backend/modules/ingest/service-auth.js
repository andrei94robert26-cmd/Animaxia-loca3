/**
 * Scoped service credential for automated metadata pushes.
 * Does not authenticate general /api routes and has no admin permissions.
 * Service credentials are configured only in the server environment.
 */
import crypto from 'node:crypto';
import { requireAuth, requireAdmin } from '../users/auth.js';
import { getSourceRecord, authenticateSourceCredential } from './source-registry.js';

const hash = (s) => crypto.createHash('sha256').update(s, 'utf8').digest();
function correctKey(submitted, configured) {
  if (typeof submitted !== 'string' || submitted.length < 32 || submitted.length > 512
    || typeof configured !== 'string' || configured.length < 32) return false;
  return crypto.timingSafeEqual(hash(submitted), hash(configured));
}
function sourceId(source) {
  return source && typeof source.type === 'string' && typeof source.id === 'string'
    ? source.type + ':' + source.id : null;
}
export function requireMetadataIngestAccess(req, res, next) {
  const submitted = req.get('x-animaxia-ingest-key');
  if (submitted != null) {
    const source = req.body?.source;
    const registered = getSourceRecord(source);
    if (registered) {
      if (!authenticateSourceCredential(source, submitted)) {
        return res.status(403).json({ error: 'Inactive source or invalid source credential' });
      }
      req.metadataIngestService = true;
      req.metadataIngestSourceScope = sourceId(source);
      return next();
    }
    if (!correctKey(submitted, process.env.ANIMAXIA_INGEST_SERVICE_KEY)) {
      return res.status(403).json({ error: 'Invalid ingest service credential' });
    }
    req.metadataIngestService = true;
    req.metadataIngestSourceScope = 'legacy-env';
    return next();
  }
  return requireAuth(req, res, () => requireAdmin(req, res, next));
}
/** Exact-source check, including activation state for registered providers. */
export function allowedMetadataServiceSource(source, req = {}) {
  const id = sourceId(source);
  if (!id) return false;
  const registered = getSourceRecord(source);
  if (registered) {
    if (Number(registered.enabled) !== 1) return false;
    if (req.metadataIngestService) return req.metadataIngestSourceScope === id;
    return true; // authenticated admin
  }
  if (!req.metadataIngestService) return true; // manual admin imports
  if (req.metadataIngestSourceScope !== 'legacy-env') return false;
  const allowed = (process.env.ANIMAXIA_INGEST_ALLOWED_SOURCES || '')
    .split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  return allowed.includes(id.toLowerCase());
}
