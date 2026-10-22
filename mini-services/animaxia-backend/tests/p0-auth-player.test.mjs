import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { baseAuthSecret, signTenantJwt, verifyTenantJwt } from '../modules/tenant/jwt-tenant.js';
import { resolvePlayer } from '../modules/player/player.js';

test('JWT secret is never a deterministic public development value', () => {
  const original = process.env.AUTHSECRET;
  try {
    delete process.env.AUTHSECRET;
    assert.ok(baseAuthSecret().length >= 32);
    assert.notEqual(baseAuthSecret(), 'animaxia-auth:sqlite-local');
    const token = signTenantJwt({ sub: 42, typ: 'access' });
    assert.equal(verifyTenantJwt(token)?.sub, 42);
  } finally {
    if (original === undefined) delete process.env.AUTHSECRET;
    else process.env.AUTHSECRET = original;
  }
});

test('JWT fails closed in production without configured secret', () => {
  const env = { NODE_ENV: process.env.NODE_ENV, AUTHSECRET: process.env.AUTHSECRET };
  try {
    process.env.NODE_ENV = 'production';
    delete process.env.AUTHSECRET;
    assert.throws(() => baseAuthSecret(), /AUTHSECRET/);
  } finally {
    for (const key of Object.keys(env)) {
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
  }
});

test('known compromised JWT signing secret is rejected in production', () => {
  const original = { NODE_ENV: process.env.NODE_ENV, AUTHSECRET: process.env.AUTHSECRET };
  try {
    process.env.NODE_ENV = 'production';
    process.env.AUTHSECRET = crypto.createHash('sha256').update('animaxia-auth:sqlite-local').digest('hex');
    assert.throws(() => baseAuthSecret(), /AUTHSECRET/);
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('player resolves MP4, HLS and DASH, ignoring unsafe URLs', async () => {
  const originalDash = process.env.PLAYERALLOWDASH;
  process.env.PLAYERALLOWDASH = 'true';
  const outcome = await resolvePlayer({ title: 'Test', metadata: { player: { sources: [
    { type: 'video', url: 'https://example.org/movie.mp4' },
    { type: 'video', url: 'https://example.org/playlist.m3u8' },
    { type: 'video', url: 'https://example.org/video.mpd' },
    { type: 'iframe', url: 'javascript:alert(1)' }
  ] } } });
  assert.equal(outcome.mode, 'direct');
  assert.deepEqual(outcome.sources.map((s) => s.type), ['mp4', 'm3u8', 'mpd']);
  if (originalDash === undefined) delete process.env.PLAYERALLOWDASH;
  else process.env.PLAYERALLOWDASH = originalDash;
});
