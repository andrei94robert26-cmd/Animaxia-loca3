/**
 * Persistent push-only source registry for metadata providers.
 *
 * Installs JSON manifests, NOT executable third-party addon code.
 * Each registered source receives a per-source credential stored as SHA256.
 * Credentials are returned only on creation/rotation, never in list/detail.
 */
import crypto from 'node:crypto';
import { localDb } from '../local/sqlite.js';

const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const TYPES = new Set(['api', 'addon', 'hub']);
const text = (v, cap) => typeof v === 'string' ? v.trim().slice(0, cap) : '';
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const issueCredential = () => crypto.randomBytes(48).toString('base64url');
let schemaReady = false;

export function ensureSourceRegistrySchema() {
  if (schemaReady) return { storage: 'sqlite', executableCode: false };
  localDb.exec(`
    CREATE TABLE IF NOT EXISTS metadata_ingest_sources (
      sourcetype TEXT NOT NULL,
      sourceid TEXT NOT NULL,
      displayname TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      version TEXT NOT NULL DEFAULT '1',
      categories TEXT NOT NULL DEFAULT '[]',
      protocol TEXT NOT NULL DEFAULT 'json-push-v1',
      credentialhash TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      createdat TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedat TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (sourcetype,sourceid)
    );
    CREATE INDEX IF NOT EXISTS idx_metadata_ingest_sources_enabled
      ON metadata_ingest_sources(enabled,sourcetype,sourceid);
  `);
  schemaReady = true;
  return { storage: 'sqlite', executableCode: false };
}
export function normalizeSourceManifest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw Object.assign(new Error('Expected JSON source manifest'), { status: 400 });
  }
  const source = raw.source && typeof raw.source === 'object' ? raw.source : raw;
  const type = source.type;
  const id = source.id;
  if (!TYPES.has(type) || typeof id !== 'string' || !ID.test(id)) {
    throw Object.assign(new Error('Invalid source type or identifier'), { status: 400 });
  }
  const name = text(raw.name || raw.displayName || id, 120);
  const description = text(raw.description, 1000);
  const version = text(raw.version || '1', 40);
  const protocol = raw.protocol || 'json-push-v1';
  if (!name || !version || protocol !== 'json-push-v1') {
    throw Object.assign(new Error('Only json-push-v1 metadata manifests are supported'), { status: 400 });
  }
  const input = raw.categories ?? [];
  if (!Array.isArray(input) || input.length > 30 || input.some((v) =>
    typeof v !== 'string' || v.length > 80)) {
    throw Object.assign(new Error('categories must be a list of up to 30 short strings'), { status: 400 });
  }
  const categories = [...new Set(input.map((v) => v.trim()).filter(Boolean))];
  return { type, id, name, description, version, categories, protocol };
}
const asPublic = (row) => row && ({
  source: { type: row.sourcetype, id: row.sourceid },
  name: row.displayname, description: row.description, version: row.version,
  categories: JSON.parse(row.categories || '[]'),
  protocol: row.protocol, enabled: Number(row.enabled) === 1,
  hasCredential: Boolean(row.credentialhash),
  createdAt: row.createdat, updatedAt: row.updatedat,
});
export function getSourceRecord(source) {
  if (!source || !TYPES.has(source.type) || typeof source.id !== 'string' || !ID.test(source.id)) {
    return null;
  }
  ensureSourceRegistrySchema();
  return localDb.prepare(`
    SELECT * FROM metadata_ingest_sources
    WHERE sourcetype=? AND sourceid=?
  `).get(source.type, source.id) || null;
}
export function listRegisteredSources({ limit = 100 } = {}) {
  ensureSourceRegistrySchema();
  const cap = Math.max(1, Math.min(250, Number.parseInt(limit, 10) || 100));
  return localDb.prepare(`
    SELECT * FROM metadata_ingest_sources
    ORDER BY createdat DESC,sourcetype,sourceid LIMIT ?
  `).all(cap).map(asPublic);
}
export function installSourceManifest(manifest) {
  const m = normalizeSourceManifest(manifest);
  ensureSourceRegistrySchema();
  if (getSourceRecord(m)) {
    throw Object.assign(new Error('This source is already installed'), { status: 409 });
  }
  const credential = issueCredential();
  localDb.prepare(`
    INSERT INTO metadata_ingest_sources
      (sourcetype,sourceid,displayname,description,version,categories,protocol,credentialhash,enabled)
    VALUES(?,?,?,?,?,?,?,?,0)
  `).run(m.type,m.id,m.name,m.description,m.version,JSON.stringify(m.categories),
    m.protocol,hash(credential));
  return {
    ...asPublic(getSourceRecord(m)), credential,
    notice: 'Save this credential now. It is never returned again.',
  };
}
export function setSourceEnabled(source, enabled) {
  if (typeof enabled !== 'boolean') {
    throw Object.assign(new Error('enabled must be boolean'), { status: 400 });
  }
  const row = getSourceRecord(source);
  if (!row) throw Object.assign(new Error('Source is not installed'), { status: 404 });
  localDb.prepare(`
    UPDATE metadata_ingest_sources SET enabled=?,updatedat=CURRENT_TIMESTAMP
    WHERE sourcetype=? AND sourceid=?
  `).run(enabled ? 1 : 0, source.type, source.id);
  if (!enabled) {
    // Do not lose catalog documents. Block waiting work from a disabled source.
    const table = localDb.prepare(`
      SELECT 1 FROM sqlite_master WHERE type='table' AND name='metadata_sync_jobs'
    `).get();
    if (table) localDb.prepare(`
      UPDATE metadata_sync_jobs SET status='failed',
        error='Source disabled by administrator',finishedat=CURRENT_TIMESTAMP
      WHERE sourcetype=? AND sourceid=? AND status='queued'
    `).run(source.type, source.id);
  }
  return asPublic(getSourceRecord(source));
}
export function rotateSourceCredential(source) {
  if (!getSourceRecord(source)) {
    throw Object.assign(new Error('Source is not installed'), { status: 404 });
  }
  const credential = issueCredential();
  localDb.prepare(`
    UPDATE metadata_ingest_sources SET credentialhash=?,updatedat=CURRENT_TIMESTAMP
    WHERE sourcetype=? AND sourceid=?
  `).run(hash(credential), source.type, source.id);
  return {
    ...asPublic(getSourceRecord(source)), credential,
    notice: 'Previous source credential is now invalid. Save this value.',
  };
}
export function authenticateSourceCredential(source, credential) {
  const row = getSourceRecord(source);
  if (!row || typeof credential !== 'string' || credential.length < 32 || credential.length > 512) {
    return false;
  }
  const left = Buffer.from(hash(credential), 'hex');
  const right = Buffer.from(row.credentialhash, 'hex');
  return Number(row.enabled) === 1
    && right.length === left.length && crypto.timingSafeEqual(left, right);
}
export function publicSource(source) {
  return asPublic(getSourceRecord(source));
}
