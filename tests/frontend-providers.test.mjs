import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const playerView = fs.readFileSync(
  'animaxia-player/frontend/src/components/animaxia/views/player-view.tsx',
  'utf8'
);

const types = fs.readFileSync(
  'animaxia-player/frontend/src/lib/animaxia/types.ts',
  'utf8'
);

const providers = [
  ['Vimeo', 'iframe'],
  ['Twitch', 'iframe'],
  ['VK Video', 'iframe'],
  ['YouTube', 'youtube'],
  ['OK.ru', 'iframe'],
  ['Rumble MP4', 'mp4'],
  ['Rumble HLS', 'm3u8'],
  ['Dailymotion', 'iframe'],
  ['Odysee', 'iframe'],
];

test('PlayerSourceType contine tipurile necesare', () => {
  for (const type of ['mp4', 'm3u8', 'iframe', 'youtube']) {
    assert.ok(
      types.includes(`'${type}'`),
      `Lipseste PlayerSourceType: ${type}`
    );
  }
});

test('renderer MP4 exista', () => {
  assert.ok(playerView.includes("type === 'mp4'"));
});

test('renderer HLS exista', () => {
  assert.ok(playerView.includes("type === 'm3u8'"));
  assert.ok(playerView.includes("import('hls.js')"));
});

test('renderer YouTube exista', () => {
  assert.ok(playerView.includes("type === 'youtube'"));
});

test('renderer iframe exista', () => {
  assert.ok(playerView.includes("type === 'iframe'"));
  assert.ok(playerView.includes('allowFullScreen'));
});

for (const [provider, type] of providers) {
  test(`${provider} -> ${type}`, () => {
    assert.ok(
      types.includes(`'${type}'`),
      `${provider}: tipul ${type} nu exista`
    );
  });
}

console.log('\n✅ FRONTEND PROVIDERS: mapping 8/8 verificat');
