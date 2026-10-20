import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import crypto from 'node:crypto';
import { initDb, query } from '../db.js';
import { ensurePlatformSchema } from '../modules/platform/migrations.js';
import { ensureAdminUsersSchema, adminUsersRouter } from '../modules/users/admin-users.js';
import { requireAuth, requireAdmin, authRouter } from '../modules/users/auth.js';
import { signTenantJwt } from '../modules/tenant/jwt-tenant.js';
import ingestRouter, { normalizeSource } from '../modules/ingest/dedup.js';

test('source ingest enforces admin auth, dedup and ban, including existing JWT', async () => {
  await initDb();
  await ensurePlatformSchema();
  await ensureAdminUsersSchema();

  const stamp = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
  const insertUser = async (role) => {
    const out = await query(
      'INSERT INTO users(email,username,passwordhash,role) VALUES(?,?,?,?) RETURNING id',
      [stamp + role + '@example.invalid', 'ci_' + stamp + role, 'invalid-hash', role],
    );
    return Number(out.rows[0].id);
  };
  const adminId = await insertUser('admin');
  const memberId = await insertUser('user');
  const jwtFor = (id) => signTenantJwt({ sub: id, typ: 'access', tenant: 'global' });
  const adminToken = jwtFor(adminId);
  const memberToken = jwtFor(memberId);
  const app = express();
  app.use(express.json());
  app.get('/protected', requireAuth, (_req, res) => res.json({ ok: true }));
  app.use('/api/auth', authRouter);
  app.use('/api/ingest', ingestRouter);
  app.use('/api/admin/users', requireAuth, requireAdmin, adminUsersRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    if (server.listening) return resolve();
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const url = 'https://example.org/animaxia-' + stamp + '.mp4';
  const send = (route, token, body, method = 'POST') => fetch(base + route, {
    method, headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: 'Bearer ' + token } : {}),
    },
    body: JSON.stringify(body),
  });

  try {
    assert.equal(normalizeSource('javascript:alert(1)'), null);
    assert.equal(normalizeSource('<iframe src="javascript:alert(1)"></iframe>'), null);
    const anonymous = await send('/api/ingest/register', null, { url });
    assert.equal(anonymous.status, 401);
    const unauthorized = await send('/api/ingest/register', memberToken, { url });
    assert.equal(unauthorized.status, 403);
    const invalid = await send('/api/ingest/register', adminToken, { url: 'javascript:alert(1)' });
    assert.equal(invalid.status, 400);

    const first = await send('/api/ingest/register', adminToken, { url: url + '?utm_source=ci' });
    assert.equal(first.status, 200);
    const created = await first.json();
    assert.equal(created.registered, true);
    assert.equal(created.source.urlhash.length, 64);
    const second = await send('/api/ingest/register', adminToken, { url });
    assert.equal(second.status, 200);
    const duplicate = await second.json();
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.source.hits, 2);
    const wrongId = await send('/api/ingest/register', adminToken, { url, contentId: -1 });
    assert.equal(wrongId.status, 400);

    const ban = await send('/api/admin/users/' + memberId, adminToken, { banned: true }, 'PATCH');
    assert.equal(ban.status, 200);
    assert.equal((await ban.json()).user.banned, true);
    const oldJwt = await fetch(base + '/protected', { headers: { authorization: 'Bearer ' + memberToken } });
    assert.equal(oldJwt.status, 403);
    const unauthorizedIngest = await send('/api/ingest/register', memberToken, { url: url + '?id=another' });
    assert.equal(unauthorizedIngest.status, 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await query('DELETE FROM contentsources WHERE originalurl LIKE ?', ['%animaxia-' + stamp + '%']);
    await query('DELETE FROM users WHERE id IN (?,?)', [memberId, adminId]);
  }
});
