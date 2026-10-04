import test from 'node:test';
import assert from 'node:assert/strict';

const LOOPBACK = ['http:', '', '127.0.0.1'].join('/');

const DIRECT = `${LOOPBACK}:4060`;
const PROXY = `${LOOPBACK}:3000`;

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, {
    method: options.method ?? 'GET',
    cache: 'no-store',
  });

  const text = await response.text();

  let body = null;

  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }

  return {
    response,
    body,
  };
}

test('GET /api/health', async () => {
  const { response, body } = await jsonRequest(
    `${DIRECT}/api/health`,
  );

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(
    body.service,
    'animaxia-stability',
  );
});

test('GET /api/stability/status', async () => {
  const { response, body } = await jsonRequest(
    `${DIRECT}/api/stability/status`,
  );

  assert.equal(response.status, 200);
  assert.equal(
    body.service,
    'animaxia-stability',
  );

  assert.equal(
    typeof body.score,
    'number',
  );

  assert.ok(
    ['stable', 'degraded', 'critical'].includes(
      body.state,
    ),
  );

  assert.ok(body.incidents);
  assert.ok(body.failovers);
});

test('GET /api/incidents', async () => {
  const { response, body } = await jsonRequest(
    `${DIRECT}/api/incidents`,
  );

  assert.equal(response.status, 200);
  assert.equal(
    Array.isArray(body.incidents),
    true,
  );
});

test('GET /api/failovers', async () => {
  const { response, body } = await jsonRequest(
    `${DIRECT}/api/failovers`,
  );

  assert.equal(response.status, 200);
  assert.equal(
    Array.isArray(body.regions),
    true,
  );

  const us = body.regions.find(
    (region) => region.region === 'us',
  );

  assert.ok(us);
  assert.equal(us.available, true);
  assert.equal(us.intentionalDemo, true);
});

test('GET /api/recoveries', async () => {
  const { response, body } = await jsonRequest(
    `${DIRECT}/api/recoveries`,
  );

  assert.equal(response.status, 200);
  assert.equal(
    Array.isArray(body.recoveries),
    true,
  );
});

test('POST /api/recovery/run', async () => {
  const { response, body } = await jsonRequest(
    `${DIRECT}/api/recovery/run`,
    {
      method: 'POST',
    },
  );

  assert.equal(response.status, 200);
  assert.ok(body.recovery);
  assert.ok(body.status);
});

test('Next proxy forwards to port 4060', async () => {
  const { response, body } = await jsonRequest(
    `${PROXY}/api/stability/status?XTransformPort=4060`,
  );

  assert.equal(response.status, 200);

  assert.equal(
    response.headers.get(
      'x-animaxia-proxy-port',
    ),
    '4060',
  );

  assert.equal(
    body.service,
    'animaxia-stability',
  );
});
