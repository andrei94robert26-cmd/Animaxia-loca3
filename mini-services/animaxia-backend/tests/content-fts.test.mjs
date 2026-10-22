import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { initDb, upsertContent, getContentById, deleteContent } from '../db.js';
import {
  ensureContentFts, countFtsRows, prepareFtsQuery,
} from '../modules/search/content-fts.js';
import { sqliteAdvancedSearch } from '../modules/search/sqlite-advanced.js';

test('FTS5 indexes, queries, updates and removes real Content metadata', async () => {
  await initDb();
  const existing = countFtsRows();
  assert.equal(ensureContentFts().engine, 'sqlite-fts5');
  const nonce = crypto.randomBytes(6).toString('hex');
  const titleToken = 'galaxyfts' + nonce;
  const actorToken = 'actorfts' + nonce;
  const overviewToken = 'cosmicfts' + nonce;
  const nextTitle = 'newtitlefts' + nonce;
  let id = null;
  try {
    const created = await upsertContent({
      externalid: 'fts-ci:' + nonce,
      title: 'Film ' + titleToken, type: 'movie',
      metadata: {
        year: 2025,
        overview: 'A narrative about ' + overviewToken,
        actors: [actorToken],
        genres: ['Adventure'],
        studios: ['Test Studio'],
      },
    });
    id = created.record.id;
    assert.equal(countFtsRows(), existing + 1);
    const title = await sqliteAdvancedSearch({ q: titleToken, type: 'movie' });
    assert.equal(title.searchMode, 'sqlite-fts5');
    assert.ok(title.data.some((item) => item.id === id));
    const actor = await sqliteAdvancedSearch({ q: actorToken, type: 'movie' });
    assert.ok(actor.data.some((item) => item.id === id));
    const synopsis = await sqliteAdvancedSearch({ q: overviewToken, type: 'movie' });
    assert.ok(synopsis.data.some((item) => item.id === id));

    const changed = await upsertContent({
      externalid: 'fts-ci:' + nonce,
      title: 'Film ' + nextTitle, type: 'movie',
      metadata: { actors: ['Different actor'], overview: 'Replaced overview' },
    });
    assert.equal(changed.created, false);
    assert.equal((await getContentById(id)).title, 'Film ' + nextTitle);
    const newHits = await sqliteAdvancedSearch({ q: nextTitle });
    assert.ok(newHits.data.some((item) => item.id === id));
    const oldHits = await sqliteAdvancedSearch({ q: titleToken });
    assert.ok(!oldHits.data.some((item) => item.id === id));
    const oldActorHits = await sqliteAdvancedSearch({ q: actorToken });
    assert.ok(!oldActorHits.data.some((item) => item.id === id));

    assert.equal(prepareFtsQuery('alpha+ OR beta'), null);
    const escaped = await sqliteAdvancedSearch({ q: 'rare\" NEAR(x)' });
    assert.equal(escaped.searchMode, 'sqlite-like-fallback');
  } finally {
    if (id != null) await deleteContent(id);
  }
  assert.equal(countFtsRows(), existing);
  const deleted = await sqliteAdvancedSearch({ q: nextTitle });
  assert.equal(deleted.total, 0);
});
