import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import crypto from 'node:crypto';
import { initDb, query, getContentByExternalId, deleteContent } from '../db.js';
import { ensurePlatformSchema } from '../modules/platform/migrations.js';
import { ensureAdminUsersSchema } from '../modules/users/admin-users.js';
import { signTenantJwt } from '../modules/tenant/jwt-tenant.js';
import sourceRoutes from '../modules/ingest/source-routes.js';
import ingestRoutes from '../modules/ingest/metadata.js';
import queueRoutes from '../modules/ingest/queue-routes.js';
import {
  ensureSourceRegistrySchema, getSourceRecord,
} from '../modules/ingest/source-registry.js';
import { ensureMetadataQueueSchema, getMetadataJob } from '../modules/ingest/queue.js';

test('install, activate, push, rotate and disable addon JSON source with isolated key', async () => {
  await initDb();
  await ensurePlatformSchema();
  await ensureAdminUsersSchema();
  ensureSourceRegistrySchema();
  ensureMetadataQueueSchema();
  const nonce = crypto.randomBytes(6).toString('hex');
  const addonId = 'ciaddon' + nonce;
  const type = 'addon';
  const source = { type, id: addonId };
  const env = {
    key: process.env.ANIMAXIA_INGEST_SERVICE_KEY,
    sources: process.env.ANIMAXIA_INGEST_ALLOWED_SOURCES,
  };
  const legacyKey = crypto.randomBytes(48).toString('base64url');
  process.env.ANIMAXIA_INGEST_SERVICE_KEY = legacyKey;
  process.env.ANIMAXIA_INGEST_ALLOWED_SOURCES = type + ':' + addonId;
  const account = await query(
    'INSERT INTO users(email,username,passwordhash,role) VALUES(?,?,?,?) RETURNING id',
    ['ci-addon-' + nonce + '@example.invalid', 'addon' + nonce, 'test-only', 'admin'],
  );
  const adminId = Number(account.rows[0].id);
  const bearer = 'Bearer ' + signTenantJwt({ sub: adminId, typ: 'access', tenant: 'global' });
  const app = express();
  app.use(express.json());
  app.use('/api/integrations/sources', sourceRoutes);
  app.use('/api/ingest', ingestRoutes);
  app.use('/api/ingest', queueRoutes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    if (server.listening) return resolve();
    server.once('listening', resolve); server.once('error', reject);
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const hit = (path, method, body, key = null, admin = false) => fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(key != null ? { 'x-animaxia-ingest-key': key } : {}),
      ...(admin ? { authorization: bearer } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const manifest = {
    source, name: 'CI Test Addon', description: 'Only JSON metadata',
    version: '1.2', protocol: 'json-push-v1',
    categories: ['filme', 'anime'],
  };
  const payload = {
    source, items: [{
      id: 'movie' + nonce, category: 'filme', title: 'JSON addon title ' + nonce,
      year: 2026, actors: ['Actor Ci'], genres: ['Adventure'],
    }],
  };
  const externalid = type + ':' + addonId + ':movie:movie' + nonce;
  let queuedId = null;
  try {
    const unauth = await hit('/api/integrations/sources', 'POST', manifest);
    assert.equal(unauth.status, 401);
    const forbiddenProtocol = await hit('/api/integrations/sources', 'POST',
      { ...manifest, protocol: 'execute-js-v1' }, null, true);
    assert.equal(forbiddenProtocol.status, 400);

    const installed = await hit('/api/integrations/sources', 'POST', manifest, null, true);
    assert.equal(installed.status, 201);
    const created = await installed.json();
    const originalKey = created.credential;
    assert.equal(created.enabled, false);
    assert.equal(created.protocol, 'json-push-v1');
    assert.ok(originalKey.length >= 32);
    assert.equal(getSourceRecord(source).credentialhash.length, 64);
    assert.notEqual(getSourceRecord(source).credentialhash, originalKey);
    const installedAgain = await hit('/api/integrations/sources', 'POST', manifest, null, true);
    assert.equal(installedAgain.status, 409);

    const list = await hit('/api/integrations/sources', 'GET', undefined, null, true);
    assert.equal(list.status, 200);
    const publicRow = (await list.json()).sources.find((s) => s.source.id === addonId);
    assert.equal(publicRow.enabled, false);
    assert.equal(publicRow.credential, undefined);
    assert.equal(publicRow.credentialhash, undefined);

    // Inactive registrations reject admin and both credential types.
    assert.equal((await hit('/api/ingest/metadata', 'POST', payload, originalKey)).status, 403);
    assert.equal((await hit('/api/ingest/metadata', 'POST', payload, null, true)).status, 403);

    const path = '/api/integrations/sources/' + type + '/' + addonId;
    assert.equal((await hit(path, 'PATCH', { enabled: true }, null, true)).status, 200);
    // Old global key cannot impersonate a newly installed scoped provider.
    assert.equal((await hit('/api/ingest/metadata', 'POST', payload, legacyKey)).status, 403);
    assert.equal((await hit('/api/ingest/metadata', 'POST', payload, originalKey)).status, 200);
    const record = await getContentByExternalId(externalid);
    assert.ok(record);
    assert.deepEqual(record.metadata.actors, ['Actor Ci']);

    const jobRequest = { ...payload, idempotencyKey: 'one:' + nonce };
    const enqueued = await hit('/api/ingest/metadata/queue', 'POST', jobRequest, originalKey);
    assert.equal(enqueued.status, 202);
    queuedId = (await enqueued.json()).id;
    assert.equal(getMetadataJob(queuedId).status, 'queued');
    const rotated = await hit(path + '/rotate-key', 'POST', {}, null, true);
    assert.equal(rotated.status, 200);
    const newKey = (await rotated.json()).credential;
    assert.notEqual(newKey, originalKey);
    assert.equal((await hit('/api/ingest/metadata', 'POST', payload, originalKey)).status, 403);
    assert.equal((await hit('/api/ingest/metadata', 'POST', payload, newKey)).status, 200);

    const disabled = await hit(path, 'PATCH', { enabled: false }, null, true);
    assert.equal(disabled.status, 200);
    assert.equal(getMetadataJob(queuedId).status, 'failed');
    assert.equal((await hit('/api/ingest/metadata/queue', 'POST', jobRequest, newKey)).status, 403);
    // Disabling the addon must never erase its imported content.
    assert.ok(await getContentByExternalId(externalid));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    const record = await getContentByExternalId(externalid);
    if (record) await deleteContent(record.id);
    if (queuedId) await query('DELETE FROM metadata_sync_jobs WHERE id=?', [queuedId]);
    await query('DELETE FROM metadata_ingest_sources WHERE sourcetype=? AND sourceid=?', [type, addonId]);
    await query('DELETE FROM users WHERE id=?', [adminId]);
    if (env.key === undefined) delete process.env.ANIMAXIA_INGEST_SERVICE_KEY;
    else process.env.ANIMAXIA_INGEST_SERVICE_KEY = env.key;
    if (env.sources === undefined) delete process.env.ANIMAXIA_INGEST_ALLOWED_SOURCES;
    else process.env.ANIMAXIA_INGEST_ALLOWED_SOURCES = env.sources;
  }
});
