import test from 'node:test';
import assert from 'node:assert/strict';
import { initDb, upsertContent, deleteContent } from '../db.js';
import { ensurePlatformSchema } from '../modules/platform/migrations.js';
import { sqliteAdvancedSearch, normalizedType } from '../modules/search/sqlite-advanced.js';

test('Romanian accented category aliases normalize to catalog types', () => {
  assert.equal(normalizedType('ȘTIRI'), 'news');
  assert.equal(normalizedType('Muzică'), 'music');
  assert.equal(normalizedType('Desene Animate'), 'cartoon');
  assert.equal(normalizedType('Telenovele'), 'telenovela');
});

test('advanced SQLite search indexes metadata filters and paginates', async () => {
  await initDb();
  await ensurePlatformSchema();
  const stamp = 'ci-advanced-' + Date.now();
  const created = [];
  try {
    for (let i = 0; i < 3; i++) {
      const saved = await upsertContent({
        externalid: stamp + '-' + i,
        type: 'anime',
        title: 'Star Quest ' + stamp + ' ' + i,
        thumbnail: 'https://example.org/poster-' + i + '.png',
        metadata: {
          year: 2024, rating: 8 + i / 10,
          actors: ['Actor CI'], genres: ['Fantasy'],
          studios: ['Studio CI'], franchise: stamp,
          trilogy: 'Trilogy CI', collection: 'Collection CI',
          overview: 'Space explorers on their first expedition',
          posterId: 'image-ci-' + i,
        },
      });
      created.push(saved.record.id);
    }
    const params = {
      q: stamp, type: 'anime', year: 2024,
      genre: 'Fantasy', actor: 'Actor CI', studio: 'Studio CI',
      franchise: stamp, trilogy: 'Trilogy CI', collection: 'Collection CI',
      description: 'explorers', minRating: 8, sort: 'title', limit: 1,
    };
    const first = await sqliteAdvancedSearch(params);
    assert.equal(first.total, 3);
    assert.equal(first.data.length, 1);
    assert.equal(first.data[0].type, 'anime');
    assert.equal(first.data[0].thumbnail.startsWith('https://'), true);
    assert.ok(first.nextCursor);
    const second = await sqliteAdvancedSearch({ ...params, cursor: first.nextCursor });
    assert.equal(second.data.length, 1);
    assert.notEqual(second.data[0].id, first.data[0].id);
    const third = await sqliteAdvancedSearch({ ...params, cursor: second.nextCursor });
    assert.equal(third.data.length, 1);
    assert.equal(third.nextCursor, null);
    await assert.rejects(() => sqliteAdvancedSearch({
      ...params, genre: 'Different', cursor: first.nextCursor
    }), (err) => err.status === 400);
    const byRating = await sqliteAdvancedSearch({
      type: 'anime', franchise: stamp, sort: 'rating', limit: 1,
    });
    assert.equal(byRating.total, 3);
    assert.equal(byRating.data[0].title.endsWith(' 2'), true);
  } finally {
    for (const id of created) await deleteContent(id);
  }
});
