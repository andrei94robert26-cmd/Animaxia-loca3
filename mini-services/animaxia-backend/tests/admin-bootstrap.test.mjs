import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import crypto from 'node:crypto';
import { initDb, query } from '../db.js';
import { ensurePlatformSchema } from '../modules/platform/migrations.js';
import { authRouter, requireAuth, requireAdmin } from '../modules/users/auth.js';

test('production registration cannot claim administrator role or fake email verification', async () => {
  await initDb();
  await ensurePlatformSchema();
  const previous = {
    NODE_ENV: process.env.NODE_ENV, AUTHSECRET: process.env.AUTHSECRET,
    ADMINEMAILS: process.env.ADMINEMAILS, SMTPURL: process.env.SMTPURL,
  };
  const stamp = crypto.randomBytes(6).toString('hex');
  const email = 'bootstrap-ci-' + stamp + '@example.invalid';
  process.env.NODE_ENV = 'production';
  process.env.AUTHSECRET = crypto.randomBytes(48).toString('hex');
  process.env.ADMINEMAILS = email;
  delete process.env.SMTPURL;
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  app.get('/admin-protected', requireAuth, requireAdmin, (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    if (server.listening) return resolve();
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const register = await fetch(base + '/api/auth/register', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, username: 'bootstrapci' + stamp, password: 'StrongPassword-2026!' }),
    });
    assert.equal(register.status, 201);
    const body = await register.json();
    assert.equal(body.user.role, 'user');
    assert.equal(body.user.emailverified, false);
    assert.ok(body.accessToken);
    const guarded = await fetch(base + '/admin-protected', {
      headers: { authorization: 'Bearer ' + body.accessToken },
    });
    assert.equal(guarded.status, 403);
    const found = await query('SELECT id, role, emailverified FROM users WHERE email=?', [email]);
    assert.equal(found.rows.length, 1);
    assert.equal(found.rows[0].role, 'user');
    assert.equal(Number(found.rows[0].emailverified), 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await query('DELETE FROM users WHERE email=?', [email]);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
