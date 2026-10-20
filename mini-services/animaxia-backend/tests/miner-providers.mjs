const H = 'https:' + '//';

const tests = [
  ['Vimeo', H + 'vimeo.com/76979871'],
  ['Twitch', H + 'twitch.tv/twitchdev'],
  ['VK', H + 'm.vkvideo.ru/video-220754053_456246684'],
  ['YouTube', H + 'youtu.be/BjwZQBT0qKs'],
  ['OK.ru', H + 'ok.ru/video/16353421827658'],
  ['Rumble', H + 'rumble.com/embed/v7dy3jk/?pub=4'],
  ['Dailymotion', H + 'dai.ly/xbf564y'],
  ['Odysee', H + 'odysee.com/@hackthemovies:1/did-we-love-or-hate-zach-cregger%27s:d'],
];

const validators = {
  Vimeo: s =>
    s.type === 'iframe' &&
    /^https:\/\/player\.vimeo\.com\/video\/\d+$/.test(s.url),

  Twitch: s =>
    s.type === 'iframe' &&
    /^https:\/\/player\.twitch\.tv\/\?(?:channel=[^&]+|video=v\d+)&parent=[^&]+$/.test(s.url),

  VK: s =>
    s.type === 'iframe' &&
    /^https:\/\/vkvideo\.ru\/video_ext\.php\?oid=-?\d+&id=\d+$/.test(s.url),

  YouTube: s =>
    s.type === 'youtube' &&
    /^https:\/\/www\.youtube\.com\/embed\/[\w-]+$/.test(s.url),

  'OK.ru': s =>
    s.type === 'iframe' &&
    /^https:\/\/ok\.ru\/videoembed\/\d+$/.test(s.url),

  Rumble: s =>
    (s.type === 'mp4' && /^https:\/\/.+\.mp4(?:\?|$)/.test(s.url)) ||
    (s.type === 'm3u8' && /^https:\/\/.+(?:\.m3u8|chunklist\.m3u8)/.test(s.url)),

  Dailymotion: s =>
    s.type === 'iframe' &&
    /^https:\/\/www\.dailymotion\.com\/embed\/video\/[\w-]+$/.test(s.url),

  Odysee: s =>
    s.type === 'iframe' &&
    /^https:\/\/odysee\.com\/\$\/embed\/.+/.test(s.url),
};

let failed = 0;

// Provider CI uses a fresh local database. Obtain a real access token via the
// public registration flow; anonymous mining must never be re-enabled for tests.
const register = await fetch('http://127.0.0.1:4000/api/auth/register', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    email: `ci-provider-${Date.now()}@example.invalid`,
    username: `ci${Date.now()}`,
    password: 'ProviderTest-LocalOnly-2026!'
  })
});
if (!register.ok) throw new Error(`Provider CI registration failed: HTTP ${register.status}`);
const accessToken = (await register.json()).accessToken;
if (!accessToken) throw new Error('Provider CI could not obtain an access token');

const anonymous = await fetch('http://127.0.0.1:4000/api/miner', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ url: 'https://example.org/a.mp4' })
});
if (anonymous.status !== 401) throw new Error(`Anonymous miner must return 401, got ${anonymous.status}`);

for (const [provider, url] of tests) {
  try {
    const res = await fetch('http://127.0.0.1:4000/api/miner', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ url }),
    });

    const data = await res.json();
    const sources = data?.record?.metadata?.player?.sources || [];

    const formatOK = sources.some(validators[provider]);

    if (res.ok && data.ok && sources.length && formatOK) {
      console.log(`✅ PASS ${provider}`);
      console.log(`   ${sources.map(s => `${s.type}: ${s.url}`).join('\n   ')}`);
    } else {
      failed++;
      console.log(`❌ FAIL ${provider}`);
      console.log(`   ${data.error || (sources.length ? 'FORMAT SOURCE INVALID' : 'player.sources gol')}`);
    }
  } catch (err) {
    failed++;
    console.log(`❌ FAIL ${provider}: ${err.message}`);
  }
}

console.log(`\nRezultat: ${tests.length - failed}/${tests.length} PASS`);
process.exitCode = failed ? 1 : 0;
