import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import crypto from 'node:crypto';
import { initDb, query, getContentByExternalId, deleteContent } from '../db.js';
import { ensurePlatformSchema } from '../modules/platform/migrations.js';
import { ensureAdminUsersSchema } from '../modules/users/admin-users.js';
import { signTenantJwt } from '../modules/tenant/jwt-tenant.js';
import metadataIngestRouter from '../modules/ingest/metadata.js';
import metadataSearchRouter from '../modules/search/metadata.js';

test('hub/API/addon JSON batch ingestion persists searchable metadata safely', async () => {
  await initDb();
  await ensurePlatformSchema();
  await ensureAdminUsersSchema();
  const previousServiceKey = process.env.ANIMAXIA_INGEST_SERVICE_KEY;
  const previousSources = process.env.ANIMAXIA_INGEST_ALLOWED_SOURCES;
  process.env.ANIMAXIA_INGEST_SERVICE_KEY = crypto.randomBytes(48).toString('hex');
  process.env.ANIMAXIA_INGEST_ALLOWED_SOURCES = 'addon:torentino';
  const stamp = crypto.randomBytes(6).toString('hex');
  const makeUser = async (role) => {
    const result = await query(
      'INSERT INTO users (email, username, passwordhash, role) VALUES (?,?,?,?) RETURNING id',
      ['batch-' + stamp + role + '@example.invalid', 'batch' + stamp + role, 'test-only', role],
    );
    return Number(result.rows[0].id);
  };
  const adminId = await makeUser('admin');
  const userId = await makeUser('user');
  const bearer = (id) => 'Bearer ' + signTenantJwt({ typ: 'access', sub: id, tenant: 'global' });
  const app = express();
  app.use(express.json());
  app.use('/api/ingest', metadataIngestRouter);
  app.use('/api/search', metadataSearchRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    if (server.listening) return resolve();
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const key = 'addon:torentino:movie:' + stamp;
  const item = {
    id: stamp, title: 'Animaxia Metadata Batch ' + stamp, category: 'filme',
    year: 2024, genres: ['Fantasy'], actors: ['Actor A'],
    studios: ['Studio A'], franchise: 'Galaxy', trilogy: 'The First',
    collection: 'Collection A', posterId: 'poster-' + stamp,
    description: 'A verified import experiment',
    sources: [
      { type: 'video', url: 'https://example.org/clip.mp4?x=1' },
      { type: 'iframe', url: 'javascript:alert(1)' },
    ],
  };
  const post = (body, token) => fetch(base + '/api/ingest/metadata', {
    method: 'POST', headers: {
      'content-type': 'application/json', ...(token ? { authorization: token } : {}),
    },
    body: JSON.stringify(body),
  });
  try {
    const payload = { source: { type: 'addon', id: 'torentino' }, items: [item, { title: 'No ID' }] };
    assert.equal((await post(payload)).status, 401);
    assert.equal((await post(payload, bearer(userId))).status, 403);
    const response = await post(payload, bearer(adminId));
    assert.equal(response.status, 200);
    const json = await response.json();
    assert.equal(json.accepted, 1);
    assert.equal(json.rejected, 1);
    assert.equal(json.partial, true);
    assert.equal(json.indexed, 'scheduled');
    const record = await getContentByExternalId(key);
    assert.equal(record.title, item.title);
    assert.equal(record.type, 'movie');
    assert.deepEqual(record.metadata.actors, ['Actor A']);
    assert.equal(record.metadata.posterId, item.posterId);
    assert.equal(record.metadata.player.sources.length, 1);
    assert.equal(record.metadata.player.sources[0].type, 'mp4');

    const filters = new URL(base + '/api/search/metadata');
    filters.searchParams.set('category', 'filme');
    filters.searchParams.set('year', '2024');
    filters.searchParams.set('actor', 'Actor A');
    filters.searchParams.set('genre', 'Fantasy');
    filters.searchParams.set('franchise', 'Galaxy');
    filters.searchParams.set('posterId', item.posterId);
    const searchable = await fetch(filters);
    assert.equal(searchable.status, 200);
    assert.ok((await searchable.json()).data.some((row) => row.id === record.id));

    const update = await post({ source: payload.source, items: [{
      id: stamp, category: 'filme', title: item.title, rating: 9.1,
    }] }, bearer(adminId));
    assert.equal(update.status, 200);
    assert.equal((await update.json()).updated, 1);
    const updated = await getContentByExternalId(key);
    assert.equal(updated.metadata.rating, 9.1);
    assert.deepEqual(updated.metadata.actors, ['Actor A']);
    assert.equal(updated.metadata.player.sources.length, 1);

    // Service credential is scoped ONLY to approved source identifiers.
    const serviceBody = { source: payload.source, items: [{
      id: stamp + 'svc', title: 'Service-only import ' + stamp,
      category: 'filme', year: 2025,
    }] };
    const serviceRequest = (requestBody, keyValue) => fetch(base + '/api/ingest/metadata', {
      method: 'POST', headers: {
        'content-type': 'application/json',
        'x-animaxia-ingest-key': keyValue,
      }, body: JSON.stringify(requestBody),
    });
    assert.equal((await serviceRequest(serviceBody, 'wrong-service-key')).status, 403);
    assert.equal((await serviceRequest({
      ...serviceBody, source: { type: 'api', id: 'unapproved' },
    }, process.env.ANIMAXIA_INGEST_SERVICE_KEY)).status, 403);
    const serviceResponse = await serviceRequest(
      serviceBody, process.env.ANIMAXIA_INGEST_SERVICE_KEY);
    assert.equal(serviceResponse.status, 200);
    assert.equal((await serviceResponse.json()).created, 1);

    // Common API payload aliases: TMDB-style media_type/name/date/company.
    const apiBody = { source: { type: 'api', id: 'tmdb' }, items: [{
      id: stamp + 'tv', name: 'TV Series ' + stamp, media_type: 'tv',
      first_air_date: '2023-02-20', posterId: 123456,
      production_companies: [{ name: 'TMDB Studio' }],
      belongs_to_collection: { name: 'Shared Universe' },
      genres: [{ name: 'Drama' }],
    }] };
    const apiResponse = await post(apiBody, bearer(adminId));
    assert.equal(apiResponse.status, 200);
    assert.equal((await apiResponse.json()).created, 1);
    const apiRow = await getContentByExternalId('api:tmdb:tv:' + stamp + 'tv');
    assert.equal(apiRow.type, 'tv');
    assert.equal(apiRow.year, 2023);
    assert.equal(apiRow.metadata.posterId, '123456');
    assert.deepEqual(apiRow.metadata.studios, ['TMDB Studio']);
    assert.equal(apiRow.metadata.collection, 'Shared Universe');

    const invalid = await post({ source: payload.source, items: Array(101).fill(item) }, bearer(adminId));
    assert.equal(invalid.status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    const row = await getContentByExternalId(key);
    if (row) await deleteContent(row.id);
    const serviceRow = await getContentByExternalId('addon:torentino:movie:' + stamp + 'svc');
    if (serviceRow) await deleteContent(serviceRow.id);
    const apiRow = await getContentByExternalId('api:tmdb:tv:' + stamp + 'tv');
    if (apiRow) await deleteContent(apiRow.id);
    if (previousServiceKey === undefined) delete process.env.ANIMAXIA_INGEST_SERVICE_KEY;
    else process.env.ANIMAXIA_INGEST_SERVICE_KEY = previousServiceKey;
    if (previousSources === undefined) delete process.env.ANIMAXIA_INGEST_ALLOWED_SOURCES;
    else process.env.ANIMAXIA_INGEST_ALLOWED_SOURCES = previousSources;
    await query('DELETE FROM users WHERE id IN (?,?)', [adminId, userId]);
  }
});
