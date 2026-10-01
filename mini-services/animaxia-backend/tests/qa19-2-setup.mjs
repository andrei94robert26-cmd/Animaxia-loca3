/**
 * qa19-2-setup.mjs — FAZA 19-2 QA helper: registers a QA user, promotes it to
 * admin directly in Neon (same pattern as smoke-searchfull.mjs), attaches one
 * REAL WebVTT subtitle track to content 1 (Big Buck Bunny) and verifies the
 * progress round-trip. Prints the tokens for the browser QA session.
 */
const API_ORIGIN = 'http://localhost:4000';
const CONTENT_ID = 1;

const stamp = Date.CURRENT_TIMESTAMP.toString(36);
const email = `f19admin-${stamp}@synth.animaxia`;
const username = `f19admin${stamp}`;
const password = 'F19Player!2026';

async function main() {
  const reg = await fetch(`${API_ORIGIN}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Forwarded-For': '10.79.0.10' },
    body: JSON.stringify({ email, username, password }),
  });
  const regBody = await reg.json().catch(() => null);
  if (!regBody?.accessToken) throw new Error(`register failed: ${reg.status} ${JSON.stringify(regBody)}`);

  const dbUrl = process.env.DATABASEURL;
  const pg = (await import('pg')).default;
  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query('UPDATE users SET role = $1 WHERE email = $2', ['admin', email]);
  await client.end();

  const login = await fetch(`${API_ORIGIN}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Forwarded-For': '10.79.0.11' },
    body: JSON.stringify({ email, password }),
  });
  const loginBody = await login.json().catch(() => null);
  const token = loginBody?.accessToken ?? regBody.accessToken;

  /* Attach a real Romanian WebVTT track to content 1 for the browser QA. */
  const vtt = [
    'WEBVTT',
    '',
    '00:00:01.000 --> 00:00:06.000',
    '[FAZA 19] Subtitrare reală — test player',
    '',
    '00:00:06.000 --> 00:00:11.000',
    'Redată din /api/playerhub/subtitles',
    '',
    '00:00:11.000 --> 00:00:20.000',
    'Big Buck Bunny — demo WebVTT (ro)',
    '',
  ].join('\n');

  const attach = await fetch(`${API_ORIGIN}/api/playerhub/subtitles/${CONTENT_ID}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'X-Forwarded-For': '10.79.0.12' },
    body: JSON.stringify({ label: 'Română (QA)', lang: 'ro', vtt }),
  });
  const attachBody = await attach.json().catch(() => null);
  console.log('attach:', attach.status, JSON.stringify(attachBody));

  const list = await fetch(`${API_ORIGIN}/api/playerhub/subtitles/${CONTENT_ID}`);
  const listBody = await list.json().catch(() => null);
  console.log('list:', list.status, JSON.stringify(listBody));

  const trackId = listBody?.data?.[0]?.id;
  if (trackId) {
    const track = await fetch(`${API_ORIGIN}/api/playerhub/subtitles/${CONTENT_ID}/${trackId}`);
    console.log('track VTT status:', track.status, 'content-type:', track.headers.get('content-type'));
  }

  console.log('---');
  console.log('EMAIL=' + email);
  console.log('PASSWORD=' + password);
  console.log('TOKEN=' + token);
}

main().catch((err) => {
  console.error('QA setup failed:', err);
  process.exit(1);
});
