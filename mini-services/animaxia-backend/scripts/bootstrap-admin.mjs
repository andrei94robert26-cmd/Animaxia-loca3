#!/usr/bin/env node
/**
 * One-time, operator-run production administrator bootstrap.
 *
 * Usage:
 *   export ADMIN_BOOTSTRAP_EMAIL='verified-owner@example.org'
 *   node scripts/bootstrap-admin.mjs verified-owner@example.org
 *
 * Public HTTP registration NEVER promotes users in production. The operator
 * must independently verify identity and email ownership before running this.
 */
import 'dotenv/config';
import { initDb, query } from '../db.js';
import { ensurePlatformSchema } from '../modules/platform/migrations.js';

const email = String(process.argv[2] || '').trim().toLowerCase();
const approved = String(process.env.ADMIN_BOOTSTRAP_EMAIL || '').trim().toLowerCase();

if (!email || !approved || email !== approved) {
  console.error('Refusing: specify an email matching ADMIN_BOOTSTRAP_EMAIL on the server.');
  process.exitCode = 2;
} else {
  try {
    await initDb();
    await ensurePlatformSchema();
    const found = await query('SELECT id, email, emailverified, role FROM users WHERE lower(email)=?', [email]);
    const user = found.rows[0];
    if (!user) throw new Error('Register the user account first, then verify email ownership');
    if (!(user.emailverified === 1 || user.emailverified === true)) {
      throw new Error('Refusing to promote an unverified email. Configure SMTP and verify first');
    }
    if (user.role !== 'admin') {
      await query('UPDATE users SET role=? WHERE id=?', ['admin', Number(user.id)]);
      await query('UPDATE refreshtokens SET revoked=1 WHERE userid=?', [Number(user.id)]);
    }
    console.log('Administrator bootstrap verified and applied for account id=' + Number(user.id));
  } catch (err) {
    console.error('Administrator bootstrap refused:', err.message);
    process.exitCode = 1;
  }
}
