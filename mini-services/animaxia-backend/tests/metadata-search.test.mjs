import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { initDb, upsertContent, getContentById, deleteContent } from '../db.js';
import metadataRouter from '../modules/search/metadata.js';

test('SQLite persists complete metadata and metadata endpoint filters JSON fields', async () => {
  await initDb();
  const externalid = 'ci:metadata:' + Date.now();
  const { record } = await upsertContent({
    externalid,
    type: 'anime',
    title: 'Animaxia CI Star Quest',
    thumbnail: 'https://example.org/poster.jpg',
    metadata: {
      year: 2024,
      description: 'The celestial mission',
      actors: ['Actor CI'],
      genres: ['Fantasy'],
      studios: ['Studio CI'],
      franchise: 'Star Quest',
      trilogy: 'Original Trilogy',
      collection: 'First Collection',
      posterId: 'poster-ci-001',
      player: { sources: [{ type: 'mp4', url: 'https://example.org/video.mp4' }] },
    },
  });
  const serverApp = express();
  serverApp.use('/api/search', metadataRouter);
  const server = serverApp.listen(0, '127.0.0.1');
  try {
    const loaded = await getContentById(record.id);
    assert.equal(loaded.type, 'anime');
    assert.equal(loaded.thumbnail, 'https://example.org/poster.jpg');
    assert.equal(loaded.externalid, externalid);
    assert.deepEqual(loaded.metadata.genres, ['Fantasy']);
    assert.equal(loaded.metadata.player.sources[0].type, 'mp4');
    const address = server.address();
    const endpoint = 'http://127.0.0.1:' + address.port + '/api/search/metadata';
    const url = new URL(endpoint);
    url.searchParams.set('category', 'anime');
    url.searchParams.set('year', '2024');
    url.searchParams.set('actor', 'Actor CI');
    url.searchParams.set('genre', 'Fantasy');
    url.searchParams.set('studio', 'Studio CI');
    url.searchParams.set('franchise', 'Star Quest');
    url.searchParams.set('trilogy', 'Original Trilogy');
    url.searchParams.set('collection', 'First Collection');
    url.searchParams.set('posterId', 'poster-ci-001');
    const response = await fetch(url);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.ok(result.data.some((row) => row.id === record.id));
    assert.equal(result.paginationMode, 'keyset');
    const invalid = await fetch(endpoint + '?year=twenty');
    assert.equal(invalid.status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await deleteContent(record.id);
  }
});
