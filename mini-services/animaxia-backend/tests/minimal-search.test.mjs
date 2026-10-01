import test from 'node:test';
import assert from 'node:assert/strict';

const BASE = 'http://127.0.0.1:4000/api/search/advanced';

const providers = [
  ['Rumble', 1],
  ['Hack The Movies', 2],   // Odysee
  ['ВКонтакте', 3],         // VK
  ['Dailymotion', 4],
  ['Florin Cercel', 5],     // YouTube
  ['OK.ru', 6],
  ['Vimeo', 8],
  ['TwitchDev', 9],
];

async function search(params) {
  const url = new URL(BASE);

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url);
  assert.equal(response.status, 200);

  return response.json();
}

for (const [query, expectedId] of providers) {
  test(`provider: ${query}`, async () => {
    const body = await search({ q: query });

    assert.ok(
      body.data.some(item => Number(item.id) === expectedId),
      `ID ${expectedId} lipseste pentru ${query}`
    );
  });
}

test('year 2026 returns canonical ID 5 only', async () => {
  const body = await search({ year: '2026' });

  assert.deepEqual(
    body.data.map(item => Number(item.id)),
    [5]
  );
});

test('Florin Cercel is not duplicated', async () => {
  const body = await search({ q: 'Florin Cercel' });

  assert.equal(body.total, 1);
  assert.equal(Number(body.data[0].id), 5);
  assert.equal(body.data[0].year, 2026);
  assert.equal(body.data.some(item => Number(item.id) === 7), false);
});
