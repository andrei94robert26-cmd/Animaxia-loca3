import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import crypto from 'node:crypto';
import { initDb, query, getContentByExternalId, deleteContent } from '../db.js';
import { ensurePlatformSchema } from '../modules/platform/migrations.js';
import { ensureAdminUsersSchema } from '../modules/users/admin-users.js';
import { signTenantJwt } from '../modules/tenant/jwt-tenant.js';
import metadataQueueRouter from '../modules/ingest/queue-routes.js';
import {
  enqueueMetadataBatch, getMetadataJob, processNextMetadataJob,
  recoverMetadataJobs, metadataSourceStatus, ensureMetadataQueueSchema,
} from '../modules/ingest/queue.js';

test('durable JSON metadata jobs: auth, deduplication, success, restart and retry', async () => {
  await initDb();
  await ensurePlatformSchema();
  await ensureAdminUsersSchema();
  ensureMetadataQueueSchema();
  const secret = crypto.randomBytes(48).toString('hex');
  const oldKey = process.env.ANIMAXIA_INGEST_SERVICE_KEY;
  const oldAllowed = process.env.ANIMAXIA_INGEST_ALLOWED_SOURCES;
  process.env.ANIMAXIA_INGEST_SERVICE_KEY = secret;
  process.env.ANIMAXIA_INGEST_ALLOWED_SOURCES = 'api:tmdb';
  const nonce = crypto.randomBytes(6).toString('hex');
  const adminEmail = 'queue-ci-' + nonce + '@example.invalid';
  const row = await query(
    'INSERT INTO users(email,username,passwordhash,role) VALUES(?,?,?,?) RETURNING id',
    [adminEmail, 'queue-ci-' + nonce, 'placeholder', 'admin'],
  );
  const adminId = Number(row.rows[0].id);
  const adminToken = signTenantJwt({ sub: adminId, typ: 'access', tenant: 'global' });
  const app = express();
  app.use(express.json());
  app.use('/api/ingest', metadataQueueRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    if (server.listening) return resolve();
    server.once('listening', resolve); server.once('error', reject);
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const source = { type: 'api', id: 'tmdb' };
  const document = {
    id: nonce, category: 'filme', title: 'Persistent Metadata CI ' + nonce,
    year: 2025, actors: ['Test Actor'], genres: ['Fantasy'],
  };
  const payload = { source, items: [document], idempotencyKey: 'once:' + nonce };
  const submit = (body, headers = {}) => fetch(base + '/api/ingest/metadata/queue', {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const bearer = { authorization: 'Bearer ' + adminToken };
  const submittedIds = [];
  try {
    const anonymous = await submit(payload);
    assert.equal(anonymous.status, 401);
    const invalidKey = await submit(payload, { 'x-animaxia-ingest-key': 'invalid' });
    assert.equal(invalidKey.status, 403);
    const disallowed = await submit(
      { ...payload, source: { type: 'addon', id: 'unknown' } },
      { 'x-animaxia-ingest-key': secret },
    );
    assert.equal(disallowed.status, 403);

    const enqueued = await submit(payload, { 'x-animaxia-ingest-key': secret });
    assert.equal(enqueued.status, 202);
    const first = await enqueued.json();
    submittedIds.push(first.id);
    assert.equal(first.status, 'queued');
    assert.equal(first.workerActive, false);
    assert.equal(first.queued, true);
    const duplicate = await submit(payload, { 'x-animaxia-ingest-key': secret });
    assert.equal(duplicate.status, 200);
    const duplicateBody = await duplicate.json();
    assert.equal(duplicateBody.id, first.id);
    assert.equal(duplicateBody.duplicate, true);
    assert.equal(duplicateBody.queued, false);
    const collision = await submit({
      ...payload, items: [{ ...document, title: 'Another title with same key' }],
    }, { 'x-animaxia-ingest-key': secret });
    assert.equal(collision.status, 409);
    assert.equal(getMetadataJob(first.id).status, 'queued');

    const stateAnonymous = await fetch(base + '/api/ingest/metadata/jobs/' + first.id);
    assert.equal(stateAnonymous.status, 401);
    const stateAdmin = await fetch(base + '/api/ingest/metadata/jobs/' + first.id, {
      headers: bearer,
    });
    assert.equal(stateAdmin.status, 200);
    const statusResponse = await fetch(base + '/api/ingest/metadata/sources/status', {
      headers: bearer,
    });
    assert.equal(statusResponse.status, 200);
    assert.ok((await statusResponse.json()).sources.some((s) =>
      s.type === 'api' && s.id === 'tmdb' && s.queued >= 1));

    const processed = await processNextMetadataJob();
    assert.equal(processed.id, first.id);
    assert.equal(processed.status, 'done');
    assert.equal(processed.result.accepted, 1);
    const imported = await getContentByExternalId('api:tmdb:movie:' + nonce);
    assert.equal(imported.title, document.title);
    assert.deepEqual(imported.metadata.actors, ['Test Actor']);
    assert.equal(getMetadataJob(first.id).status, 'done');

    const again = enqueueMetadataBatch({
      source, items: [{ ...document, id: nonce + 'recover' }],
      idempotencyKey: 'recover:' + nonce,
    });
    submittedIds.push(again.id);
    await query("UPDATE metadata_sync_jobs SET status='running' WHERE id=?", [again.id]);
    assert.equal(recoverMetadataJobs(), 1);
    assert.equal(getMetadataJob(again.id).status, 'queued');
    const recovered = await processNextMetadataJob();
    assert.equal(recovered.id, again.id);
    assert.equal(recovered.status, 'done');

    const badId = crypto.randomUUID();
    submittedIds.push(badId);
    await query(
      "INSERT INTO metadata_sync_jobs(id,sourcetype,sourceid,payload) VALUES(?,?,?,?)",
      [badId, 'api', 'tmdb', '{invalid json'],
    );
    const retried = await processNextMetadataJob();
    assert.equal(retried.id, badId);
    assert.equal(retried.status, 'queued');
    assert.equal(retried.attempts, 1);
    assert.match(retried.error, /JSON|token|position/i);
    // A worker crash after the third attempt must not endlessly replay.
    const exhaustedId = crypto.randomUUID();
    submittedIds.push(exhaustedId);
    await query(`
      INSERT INTO metadata_sync_jobs
        (id,sourcetype,sourceid,payload,status,attempts)
      VALUES(?,?,?,?,'running',3)
    `, [exhaustedId, 'api', 'tmdb', JSON.stringify(payload)]);
    assert.equal(recoverMetadataJobs(), 1);
    assert.equal(getMetadataJob(exhaustedId).status, 'failed');

    const summary = metadataSourceStatus();
    assert.equal(summary.queue.distributed, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const id of [nonce, nonce + 'recover']) {
      const entry = await getContentByExternalId('api:tmdb:movie:' + id);
      if (entry) await deleteContent(entry.id);
    }
    for (const id of submittedIds) {
      await query('DELETE FROM metadata_sync_jobs WHERE id=?', [id]);
    }
    await query('DELETE FROM users WHERE id=?', [adminId]);
    if (oldKey === undefined) delete process.env.ANIMAXIA_INGEST_SERVICE_KEY;
    else process.env.ANIMAXIA_INGEST_SERVICE_KEY = oldKey;
    if (oldAllowed === undefined) delete process.env.ANIMAXIA_INGEST_ALLOWED_SOURCES;
    else process.env.ANIMAXIA_INGEST_ALLOWED_SOURCES = oldAllowed;
  }
});
