import test from 'node:test';
import assert from 'node:assert/strict';

const BASE = 'http://127.0.0.1:4000/api/search/advanced';

const providers = [
  'Rumble',
  'Hack The Movies',
  'ВКонтакте',
  'Dailymotion',
  'Florin Cercel',
  'OK.ru',
  'Vimeo',
  'TwitchDev',
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

for (const query of providers) {
  test(`provider: ${query}`, async () => {
    const body = await search({ q: query });

    assert.ok(body.total >= 1, `Lipseste providerul ${query}`);
    assert.ok(body.data.length >= 1, `Fara rezultate pentru ${query}`);
  });
}

test('year 2026 contains canonical Florin Cercel', async () => {
  const body = await search({ year: '2026' });

  const florin = body.data.filter(item =>
    String(item.title || '').toLowerCase().includes('florin cercel')
  );

  assert.equal(florin.length, 1);
  assert.equal(florin[0].year, 2026);
});

test('Florin Cercel is not duplicated', async () => {
  const body = await search({ q: 'Florin Cercel' });

  assert.equal(body.total, 1);
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].year, 2026);
});
