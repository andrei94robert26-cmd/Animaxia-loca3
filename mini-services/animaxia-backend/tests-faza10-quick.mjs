#!/usr/bin/env node
/**
 * FAZA 10 quick REST contract check (throwaway verification — the full smoke
 * lives in animaxia-social/tests/smoke-social.mjs). Exercises: register ×2,
 * follow, people, profile, review upsert + like + aggregate, feed v2,
 * party create/join/sync/messages/leave, AI social home + review digest.
 */
const BASE = 'http://localhost:4000';
const now = Date.CURRENT_TIMESTAMP;
let passed = 0;
let failed = 0;

function check(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name} ${extra}`);
  }
}

async function req(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

const run = async () => {
  /* --- register two users --- */
  const u1 = await req('POST', '/api/auth/register', { body: { email: `smoke1_${now}@test.dev`, username: `smoke1_${now}`, password: 'Passw0rd!123' } });
  const u2 = await req('POST', '/api/auth/register', { body: { email: `smoke2_${now}@test.dev`, username: `smoke2_${now}`, password: 'Passw0rd!123' } });
  check('register u1', u1.status === 201 && u1.json?.accessToken, JSON.stringify(u1.json).slice(0, 200));
  check('register u2', u2.status === 201 && u2.json?.accessToken, JSON.stringify(u2.json).slice(0, 200));
  const t1 = u1.json.accessToken;
  const t2 = u2.json.accessToken;
  const id1 = u1.json.user?.id;
  const id2 = u2.json.user?.id;

  /* --- content id --- */
  const all = await req('GET', '/api/all?limit=3');
  const contentId = all.json?.data?.[0]?.id;
  check('content id', Number.isInteger(contentId), `data[0]=${JSON.stringify(all.json?.data?.[0]).slice(0, 120)}`);

  /* --- follows --- */
  const selfFollow = await req('POST', '/api/social/follow', { token: t1, body: { userId: id1 } });
  check('self-follow 400', selfFollow.status === 400, JSON.stringify(selfFollow.json));

  const follow = await req('POST', '/api/social/follow', { token: t1, body: { userId: id2 } });
  check('follow u1→u2', follow.status === 200 && follow.json?.following === true, JSON.stringify(follow.json));

  const followAgain = await req('POST', '/api/social/follow', { token: t1, body: { userId: id2 } });
  check('follow idempotent', followAgain.status === 200 && followAgain.json?.following === true);

  const people = await req('GET', '/api/social/people', { token: t1 });
  check('people excludes followed', people.status === 200 && Array.isArray(people.json?.data) && !people.json.data.some((p) => p.id === id2), JSON.stringify(people.json).slice(0, 200));

  const following = await req('GET', '/api/social/following', { token: t1 });
  check('following contains u2', following.status === 200 && following.json?.data?.some((p) => p.id === id2 && p.isfollowing === true));

  const followers = await req('GET', '/api/social/followers', { token: t2 });
  check('followers of u2 contains u1', followers.status === 200 && followers.json?.data?.some((p) => p.id === id1));

  const profile = await req('GET', `/api/social/user/${id2}/profile`, { token: t1 });
  check('profile public shape', profile.status === 200 && profile.json?.user?.username && profile.json?.stats && profile.json?.relation?.isfollowing === true && profile.json?.user?.email === undefined, JSON.stringify(profile.json).slice(0, 300));

  /* --- reviews --- */
  const badReview = await req('POST', '/api/social/reviews', { token: t1, body: { contentId, rating: 11, body: 'x'.repeat(20) } });
  check('review rating 11 → 400', badReview.status === 400);

  const review = await req('POST', '/api/social/reviews', { token: t1, body: { contentId, rating: 9, title: 'Great ride', body: 'Visually stunning and emotionally satisfying from start to finish.' } });
  check('review create 201', review.status === 201 && review.json?.review?.rating === 9, JSON.stringify(review.json).slice(0, 300));

  const reviewUpdate = await req('POST', '/api/social/reviews', { token: t1, body: { contentId, rating: 8, body: 'On a rewatch it holds up beautifully, though the pacing dips mid-way.' } });
  check('review upsert 200 edited', reviewUpdate.status === 200 && reviewUpdate.json?.created === false && reviewUpdate.json?.review?.rating === 8);

  const review2 = await req('POST', '/api/social/reviews', { token: t2, body: { contentId, rating: 10, body: 'An instant classic — every frame is wallpaper material.' } });
  check('review u2 201', review2.status === 201);

  const like = await req('POST', `/api/social/reviews/${review2.json.review.id}/like`, { token: t1, body: {} });
  check('review like toggle', like.status === 200 && like.json?.liked === true && like.json?.likes === 1, JSON.stringify(like.json));

  const list = await req('GET', `/api/social/reviews/content/${contentId}`, { token: t1 });
  check('reviews aggregate', list.status === 200 && list.json?.aggregate?.count >= 2 && list.json.aggregate.avg >= 8 && list.json.data?.some((r) => r.liked === true), JSON.stringify(list.json?.aggregate));

  const recent = await req('GET', '/api/social/reviews/recent?limit=5');
  check('reviews recent with content', recent.status === 200 && recent.json?.data?.[0]?.content?.title);

  /* --- feed v2 --- */
  const feed = await req('GET', '/api/social/feed/v2?limit=10', { token: t1 });
  check('feed v2 has follow + review events', feed.status === 200 && Array.isArray(feed.json?.data) && feed.json.data.some((e) => e.type === 'follow') && feed.json.data.some((e) => e.type === 'review'), JSON.stringify(feed.json).slice(0, 400));

  const feedPublic = await req('GET', '/api/social/feed/v2/public?limit=10');
  check('feed v2 public works anon', feedPublic.status === 200 && Array.isArray(feedPublic.json?.data));

  /* --- watch party --- */
  const party = await req('POST', '/api/social/party', { token: t1, body: { contentId } });
  check('party create 201 + code', party.status === 201 && party.json?.party?.code && party.json?.party?.host?.id === id1, JSON.stringify(party.json).slice(0, 300));

  const partyId = party.json.party.id;
  const partyCode = party.json.party.code;

  const join = await req('POST', `/api/social/party/${partyId}/join`, { token: t2 });
  check('party join u2', join.status === 200 && join.json?.party?.amimember === true);

  const parties = await req('GET', '/api/social/parties', { token: t2 });
  check('parties list shows party', parties.status === 200 && parties.json?.data?.some((p) => p.id === partyId && p.members >= 2 && p.amimember === true));

  const syncByMember = await req('POST', `/api/social/party/${partyId}/sync`, { token: t2, body: { state: { positionSec: 10, isPaused: false } } });
  check('sync by non-host 403', syncByMember.status === 403);

  const sync = await req('POST', `/api/social/party/${partyId}/sync`, { token: t1, body: { state: { positionSec: 1337, isPaused: false, playbackRate: 1, sourceIndex: 0 } } });
  check('sync by host', sync.status === 200 && sync.json?.state?.positionSec === 1337 && sync.json.state.isPaused === false);

  const msg = await req('POST', `/api/social/party/${partyId}/messages`, { token: t2, body: { body: 'Hello from u2!' } });
  check('party message', msg.status === 201 && msg.json?.message?.body === 'Hello from u2!');

  const detail = await req('GET', `/api/social/party/${partyId}`);
  check('party detail state+messages', detail.status === 200 && detail.json?.state?.positionSec === 1337 && detail.json?.messages?.length === 1 && detail.json?.members?.length === 2, JSON.stringify(detail.json).slice(0, 300));

  const byCode = await req('POST', '/api/social/party/join-code', { body: { code: partyCode } });
  check('join by code', byCode.status === 200 && byCode.json?.party?.id === partyId);

  /* --- AI social --- */
  const aiHome = await req('GET', '/api/ai/social/home', { token: t1 });
  check('AI social home shape', aiHome.status === 200 && Array.isArray(aiHome.json?.friendsAlsoWatched) && Array.isArray(aiHome.json?.tasteMatches) && Array.isArray(aiHome.json?.socialPicks), JSON.stringify(aiHome.json).slice(0, 300));

  const digest = await req('POST', `/api/ai/social/review-digest/${contentId}`, { token: t1, body: {} });
  check('review digest', digest.status === 200 && digest.json?.summary && digest.json?.reviewCount >= 2 && digest.json?.themes?.length >= 0 && ['positive', 'mixed', 'critical'].includes(digest.json?.sentiment), JSON.stringify(digest.json).slice(0, 300));

  /* --- cleanup: leave parties, unfollow --- */
  const leave = await req('POST', `/api/social/party/${partyId}/leave`, { token: t1 });
  check('host leave ends party', leave.status === 200 && leave.json?.status === 'ended');

  const unfollow = await req('POST', '/api/social/unfollow', { token: t1, body: { userId: id2 } });
  check('unfollow', unfollow.status === 200 && unfollow.json?.following === false);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
};

run().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
