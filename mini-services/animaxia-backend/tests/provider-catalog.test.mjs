import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import { initDb, query, getContentByExternalId, deleteContent } from '../db.js';
import { ensurePlatformSchema } from '../modules/platform/migrations.js';
import { ensureAdminUsersSchema } from '../modules/users/admin-users.js';
import { PROVIDER_CATALOG, DRIVER_IDS, providerReadiness } from '../modules/providers/catalog.js';
import { fetchProviderMetadata, buildProviderRequest, mapProviderItems } from '../modules/providers/fetch.js';
import { installSourceManifest, setSourceEnabled } from '../modules/ingest/source-registry.js';
import { signTenantJwt } from '../modules/tenant/jwt-tenant.js';
import { processNextMetadataJob, getMetadataJob } from '../modules/ingest/queue.js';
import { sqliteAdvancedSearch } from '../modules/search/sqlite-advanced.js';
import providerRoutes from '../modules/providers/routes.js';

test('88 API inventory has 6 implemented, separately enabled drivers', () => {
  assert.equal(PROVIDER_CATALOG.length, 88);
  assert.equal(new Set(PROVIDER_CATALOG.map((x) => x.id)).size, 88);
  assert.deepEqual(DRIVER_IDS, ['tmdb','jikan','tvmaze','itunes','cheapshark','gdelt']);
  assert.ok(PROVIDER_CATALOG.some((x) => x.id === 'spotify' && !x.driverImplemented));
  assert.equal(providerReadiness('not-a-provider'), null);
  assert.throws(() => buildProviderRequest('spotify', { q: 'music' }), /No verified fetch driver/);
  assert.throws(() => buildProviderRequest('itunes', { q: '' }), /at least 2/);
  const request = buildProviderRequest('jikan', { q: 'naruto', page: 1 });
  assert.equal(request.url.hostname, 'api.jikan.moe');
  assert.equal(request.url.pathname, '/v4/anime');
  assert.equal(request.url.searchParams.get('q'), 'naruto');
});

test('six provider JSON mappers are explicit, bounded, media metadata only', async () => {
  const originalKey = process.env.TMDB_API_KEY;
  process.env.TMDB_API_KEY = 'unit-test-key-no-network';
  const mockData = {
    tmdb: { results: [
      { id: 101, media_type: 'movie', title: 'Synthetic Movie', release_date: '2020-02-02', overview: 'Test film' },
      { id: 102, media_type: 'tv', name: 'Synthetic Series', first_air_date: '2022-07-02' },
      { id: 103, media_type: 'person', name: 'Not a title' },
    ] },
    jikan: { data: [
      { mal_id: 200, title: 'Synthetic Anime', year: 2019,
        genres: [{ name: 'Fantasy' }], studios: [{ name: 'Studio Unit' }] },
    ] },
    tvmaze: [{ score: 0.8, show: { id: 300, name: 'Synthetic Show', premiered: '2018-06-01', genres: ['Drama'] } }],
    itunes: { results: [{ trackId: 400, trackName: 'Synthetic Song', artistName: 'Unit Artist',
      releaseDate: '2021-03-11', primaryGenreName: 'Rock' }] },
    cheapshark: [{ gameID: '500', external: 'Synthetic Game', thumb: 'https://example.org/thumb.jpg' }],
    gdelt: { articles: [{ url: 'https://news.example.org/item/a', title: 'Synthetic News',
      seendate: '20261020T010000Z', domain: 'news.example.org' }] },
  };
  try {
    for (const id of DRIVER_IDS) {
      const captured = [];
      const mock = async (url, options) => {
        captured.push({ url, options });
        return new Response(JSON.stringify(mockData[id]), {
          headers: { 'content-type': 'application/json' }, status: 200,
        });
      };
      const result = await fetchProviderMetadata(id, { q: 'synthetic', page: 1 }, mock);
      assert.equal(captured.length, 1);
      assert.equal(captured[0].options.redirect, 'error');
      assert.equal(new URL(captured[0].url).protocol, 'https:');
      assert.equal(result.source.id, id);
      assert.ok(result.count >= 1);
      assert.ok(result.items.every((item) => item.id && item.title && item.category));
      assert.ok(result.items.length <= 25);
    }
    assert.deepEqual(mapProviderItems('tmdb', mockData.tmdb).map((x) => x.category),
      ['filme', 'seriale']);
    assert.deepEqual(mapProviderItems('itunes', mockData.itunes)[0].genres, ['Rock']);
    const oversized = async () => new Response('x'.repeat(1_100_000), {
      headers: { 'content-type': 'application/json' }, status: 200,
    });
    await assert.rejects(() => fetchProviderMetadata('jikan', { q: 'test' }, oversized),
      /too large/);
    const nonJson = async () => new Response('<html>bad</html>', {
      headers: { 'content-type': 'text/html' }, status: 200,
    });
    await assert.rejects(() => fetchProviderMetadata('jikan', { q: 'test' }, nonJson),
      /non-JSON/);
  } finally {
    if (originalKey === undefined) delete process.env.TMDB_API_KEY;
    else process.env.TMDB_API_KEY = originalKey;
  }
});

test('admin sync queues real-mapped mock provider payload into persisted searchable catalog', async () => {
  await initDb();
  await ensurePlatformSchema();
  await ensureAdminUsersSchema();
  const nonce = crypto.randomBytes(6).toString('hex');
  const fixtureTitle = 'Provider CI ' + nonce;
  const source = { type: 'api', id: 'jikan' };
  // Existing source installations are considered shared operator state.
  const prior = providerReadiness('jikan');
  if (prior.installed) {
    // Ensure test doesn't mutate a real integration if CI isn't isolated.
    assert.fail('Provider test needs a disposable SQLite database');
  }
  installSourceManifest({ source, name: 'Jikan CI JSON source' });
  setSourceEnabled(source, true);
  const admin = await query(
    'INSERT INTO users(email,username,passwordhash,role) VALUES(?,?,?,?) RETURNING id',
    ['providerci' + nonce + '@example.invalid', 'providerci' + nonce, 'testonly', 'admin'],
  );
  const userId = Number(admin.rows[0].id);
  const token = signTenantJwt({ sub: userId, typ: 'access', tenant: 'global' });
  const app = express();
  app.use(express.json());
  app.use('/api/integrations/providers', providerRoutes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.listening ? resolve() : server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const original = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.jikan.moe/')) {
      providerCalls += 1;
      return new Response(JSON.stringify({ data: [{
        mal_id: 866272, title: fixtureTitle, year: 2023,
        synopsis: 'A synthetic test result', genres: [{ name: 'Adventure' }],
      }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return original(url, init);
  };
  let jobId;
  try {
    const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
    const anonymous = await original(base + '/api/integrations/providers');
    assert.equal(anonymous.status, 401);
    const catalog = await original(base + '/api/integrations/providers', { headers });
    assert.equal(catalog.status, 200);
    assert.equal((await catalog.json()).catalogCount, 88);
    const unsupported = await original(base + '/api/integrations/providers/spotify/sync', {
      method: 'POST', headers, body: JSON.stringify({ q: 'pop' }),
    });
    assert.equal(unsupported.status, 501);
    const accepted = await original(base + '/api/integrations/providers/jikan/sync', {
      method: 'POST', headers, body: JSON.stringify({ q: 'naruto', page: 1 }),
    });
    assert.equal(accepted.status, 202);
    const enqueued = await accepted.json();
    jobId = enqueued.jobId;
    assert.equal(enqueued.fetched, 1);
    assert.equal(getMetadataJob(jobId).status, 'queued');
    assert.equal(providerCalls, 1);
    const processed = await processNextMetadataJob();
    assert.equal(processed.id, jobId);
    assert.equal(processed.status, 'done');
    const record = await getContentByExternalId('api:jikan:anime:866272');
    assert.equal(record.title, fixtureTitle);
    const found = await sqliteAdvancedSearch({ q: nonce, type: 'anime' });
    assert.ok(found.data.some((x) => x.id === record.id));
  } finally {
    globalThis.fetch = original;
    await new Promise((resolve) => server.close(resolve));
    const record = await getContentByExternalId('api:jikan:anime:866272');
    if (record && record.title === fixtureTitle) await deleteContent(record.id);
    if (jobId) await query('DELETE FROM metadata_sync_jobs WHERE id=?', [jobId]);
    await query('DELETE FROM metadata_ingest_sources WHERE sourcetype=? AND sourceid=?', ['api','jikan']);
    await query('DELETE FROM users WHERE id=?', [userId]);
  }
});
