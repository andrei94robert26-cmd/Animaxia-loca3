/**
 * modules/users/auth.js — Authentication core:
 *   • POST /api/auth/register — create account (first user or ADMINEMAILS → admin)
 *   • POST /api/auth/login    — password login with brute-force protection
 *   • POST /api/auth/refresh  — rotating refresh tokens (sha256-hashed at rest)
 *   • POST /api/auth/logout   — revoke a refresh token
 *   • GET  /api/auth/me       — current user profile snapshot
 *   • POST /api/auth/forgot-password — issue a 6-digit reset code (Phase 6)
 *   • POST /api/auth/reset-password  — consume the code, set a new password (Phase 6)
 *   • GET  /api/auth/verify?token=   — TS3: consume an email verification token
 *   • POST /api/auth/2fa/setup|enable|disable — TS3: TOTP 2FA lifecycle
 * Middleware: attachUser (optional), requireAuth, requireAdmin.
 * Zero external crypto dependencies: node:crypto HS256 JWT + scrypt hashing
 * (TS3 keeps this true: TOTP is also node:crypto-only, see ./totp.js).
 */

import crypto from 'node:crypto';
import express from 'express';
import { one, rows, parseJsonb, isoOrNull, num } from '../platform/sql.js';
import { clientIpOf, bruteForce, auditLog, userRateLimit } from '../security/security.js';
import { logger } from '../../utils/logger.js';
import { baseAuthSecret, tenantSecretFor, verifyTenantJwt, tenantOfPayload } from '../tenant/jwt-tenant.js';
import { tenantOfUser, GLOBAL_TENANT_SLUG } from '../tenant/core.js';
import { sendMail, smtpConfigured } from './mailer.js'; // TS3: real SMTP (nodemailer, lazy)
import { generateSecret, verifyTotp } from './totp.js'; // TS3: RFC 6238 TOTP, node:crypto only

const ACCESS_TTL_SEC = 15 * 60; // 15 minutes
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const authLimiter = userRateLimit({ scope: 'ip', max: 30, windowMs: 60000, key: 'auth' });

/* --------------------------------- JWT core --------------------------------- */

function authSecret() {
  if (process.env.AUTHSECRET) return process.env.AUTHSECRET;
  // Deterministic derived secret: stable across restarts without extra config,
  // unique per deployment (bound to the DATABASEURL).
  return crypto
    .createHash('sha256')
    .update(`animaxia-auth:${process.env.DATABASEURL || 'local'}`)
    .digest('hex');
}

// FAZA 11: the canonical base secret + per-tenant derivation live in
// modules/tenant/jwt-tenant.js (same derivation as authSecret above).
void baseAuthSecret;
const authSecretForTenant = (slug) => tenantSecretFor(slug);

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

function signJwt(payload) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const nowSec = Math.floor(Date.now() / 1000);
  // FAZA 11: tokens with a non-global `tenant` claim are signed with the
  // per-tenant derived secret; everything else keeps the base secret
  // (byte-identical signatures to pre-FAZA-11 tokens).
  const secret = payload?.tenant && payload.tenant !== GLOBAL_TENANT_SLUG
    ? authSecretForTenant(payload.tenant)
    : authSecret();
  const body = b64url(JSON.stringify({ ...payload, iat: nowSec, exp: nowSec + ACCESS_TTL_SEC }));
  const sig = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

function verifyJwt(token) {
  // FAZA 11: dual-path verification (base secret first, then the
  // tenant-derived secret selected via the untrusted tenant claim).
  // Accepts every token the legacy single-path verifier accepted.
  return verifyTenantJwt(token);
}

/* ------------------------------ password hashing ----------------------------- */

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const N = 16384;
  const r = 8;
  const p = 1;
  const key = crypto.scryptSync(String(password), salt, 32, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

function verifyPassword(password, stored) {
  try {
    const [scheme, nStr, rStr, pStr, saltB64, hashB64] = String(stored || '').split('$');
    if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(String(password), salt, expected.length, {
      N: parseInt(nStr, 10),
      r: parseInt(rStr, 10),
      p: parseInt(pStr, 10),
    });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/* ------------------------------ user serialization ---------------------------- */

export function publicUser(row) {
  if (!row) return null;
  return {
    id: num(row.id),
    email: row.email,
    username: row.username,
    avatar: row.avatar || null,
    role: row.role || 'user',
    plan: row.plan || 'free',
    planexpiresat: isoOrNull(row.planexpiresat),
    preferences: parseJsonb(row.preferences, {}),
    createdat: isoOrNull(row.createdat),
    lastloginat: isoOrNull(row.lastloginat),
    // TS3 (auth avansat): additive fields — email verification + 2FA state.
    emailverified: row.emailverified === true,
    twofaenabled: row.twofaenabled === true,
  };
}

export async function getUserById(id) {
  return one(`SELECT * FROM users WHERE id = $1`, [Number(id)]);
}

/* -------------------------------- token session ------------------------------- */

async function issueSession(user, ip, tenantSlug = null) {
  // FAZA 11: resolve the caller's tenant (explicit override on refresh
  // rotation, else the user's membership; 'global' fallback keeps the
  // pre-FAZA-11 token shape + signing path for anonymous/legacy accounts).
  let tenant = tenantSlug || GLOBAL_TENANT_SLUG;
  if (!tenantSlug) {
    try {
      const t = await tenantOfUser(user.id);
      if (t?.slug) tenant = t.slug;
    } catch {
      tenant = GLOBAL_TENANT_SLUG;
    }
  }
  const accessToken = signJwt({ sub: Number(user.id), email: user.email, plan: user.plan || 'free', typ: 'access', tenant });
  const refreshToken = crypto.randomBytes(48).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
  await rows(
    `INSERT INTO refreshtokens (userid, tokenhash, expiresat, tenantid) VALUES ($1, $2, datetime('now','+' || $3), $4)`,
    [Number(user.id), tokenHash, `${Math.round(REFRESH_TTL_MS / 1000)} seconds`, tenant],
  );
  return { accessToken, refreshToken, expiresIn: ACCESS_TTL_SEC, tenant };
}

async function findRefreshToken(refreshToken) {
  if (!refreshToken || typeof refreshToken !== 'string') return null;
  const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
  const row = await one(
    `SELECT rt.*, u.id AS uid FROM refreshtokens rt
     JOIN users u ON u.id = rt.userid
     WHERE rt.tokenhash = $1 AND rt.revoked = FALSE AND rt.expiresat > NOW()`,
    [tokenHash],
  );
  // FAZA 11: refresh tokens are tenant-aware — the rotated session keeps the
  // tenant the token was issued under (falls back to the user's current
  // tenant when the column predates FAZA 11).
  return row || null;
}

async function revokeRefreshToken(refreshToken) {
  if (!refreshToken || typeof refreshToken !== 'string') return false;
  const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
  const res = await one(
    `UPDATE refreshtokens SET revoked = TRUE WHERE tokenhash = $1 AND revoked = FALSE RETURNING id`,
    [tokenHash],
  );
  return Boolean(res);
}

/* --------------------------------- middleware -------------------------------- */

function extractBearer(req) {
  const header = req.headers.authorization;
  if (!header || !String(header).startsWith('Bearer ')) return null;
  const token = String(header).slice(7).trim();
  return token || null;
}

/** Attach req.user when a valid Bearer token is present; never rejects. */
export async function attachUser(req, _res, next) {
  try {
    const token = extractBearer(req);
    if (token) {
      const payload = verifyJwt(token);
      if (payload?.sub) {
        const row = await getUserById(payload.sub);
        if (row) {
          req.user = publicUser(row);
          req.user.tenant = tenantOfPayload(payload); // FAZA 11 (additive field)
        }
      }
    }
  } catch {
    // DB hiccup on an optional path — continue as anonymous.
  }
  next();
}

/** Require a valid Bearer token; sets req.user (fresh row) or rejects 401. */
export async function requireAuth(req, res, next) {
  const token = extractBearer(req);
  const payload = token ? verifyJwt(token) : null;
  if (!payload?.sub) {
    return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
  }
  try {
    const row = await getUserById(payload.sub);
    if (!row) return res.status(401).json({ error: 'Account no longer exists', code: 'AUTH_REQUIRED' });
    req.user = publicUser(row);
    req.user.tenant = tenantOfPayload(payload); // FAZA 11 (additive field)
    return next();
  } catch (err) {
    return next(err);
  }
}

/** Require the caller to be an admin (use after requireAuth). */
export function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required', code: 'ADMIN_REQUIRED' });
  }
  return next();
}

/* ---------------------------------- router ----------------------------------- */

export const authRouter = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[a-zA-Z0-9._-]{3,24}$/;

authRouter.post('/register', authLimiter, async (req, res, next) => {
  try {
    const { email, username, password } = req.body || {};
    const ip = clientIpOf(req);
    if (!email || !username || !password) {
      return res.status(400).json({ error: 'Missing required fields: email, username, password' });
    }
    if (!EMAIL_RE.test(String(email))) {
      return res.status(400).json({ error: 'Invalid email address' });
    }
    if (!USERNAME_RE.test(String(username))) {
      return res.status(400).json({ error: 'Username must be 3-24 characters (letters, numbers, . _ -)' });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const existing = await one(`SELECT id, email FROM users WHERE email = $1`, [String(email).toLowerCase()]);
    if (existing) {
      await auditLog({ action: 'auth.register.duplicate', ip, meta: { email } });
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    // Bootstrap rule: ADMINEMAILS env list, or the very first account created.
    const adminEmails = (process.env.ADMINEMAILS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const adminCount = await one(`SELECT COUNT(*)::int AS count FROM users WHERE role = 'admin'`);
    const role = adminEmails.includes(String(email).toLowerCase()) || num(adminCount?.count) === 0 ? 'admin' : 'user';

    const inserted = await one(
      `INSERT INTO users (email, username, passwordhash, role, preferences)
       VALUES ($1, $2, $3, $4, '{}'::jsonb)
       RETURNING *`,
      [String(email).toLowerCase(), String(username), hashPassword(password), role],
    );

    // TS3 (email verification): with SMTP configured the account starts
    // UNVERIFIED and a single-use 24h token is emailed; without SMTP (sandbox)
    // the account is auto-verified. Registration is NEVER blocked by mail —
    // sendMail degrades silently and the token simply stays pending.
    let emailVerified = false;
    try {
      if (smtpConfigured()) {
        const verifyToken = crypto.randomBytes(32).toString('hex');
        await rows(
          `INSERT INTO emailtokens (token, userid, purpose, expiresat)
           VALUES ($1, $2, 'verify-email', NOW() + interval '24 hours')`,
          [verifyToken, Number(inserted.id)],
        );
        const appUrl = String(process.env.APPURL || 'http://localhost:81').replace(/\/+$/, '');
        const verifyUrl = `${appUrl}/#/auth?verify=${verifyToken}`;
        await sendMail({
          to: inserted.email,
          subject: 'Animaxia — confirmă adresa de email',
          text: `Salut, ${inserted.username}!\n\nConfirma adresa de email pentru contul tău Animaxia:\n${verifyUrl}\n\nLink-ul expiră în 24 de ore și poate fi folosit o singură dată.`,
          html: `<p>Salut, <b>${inserted.username}</b>!</p><p>Confirmă adresa de email pentru contul tău Animaxia:</p><p><a href="${verifyUrl}">${verifyUrl}</a></p><p style="color:#888">Link-ul expiră în 24 de ore și poate fi folosit o singură dată.</p>`,
        });
        logger.info(`[auth] Verification email sent/queued for ${inserted.email}`);
      } else {
        emailVerified = true;
        await rows(`UPDATE users SET emailverified = TRUE WHERE id = $1`, [Number(inserted.id)]);
        logger.info(`[auth] sandbox: auto-verified ${inserted.email} (SMTPURL unset)`);
      }
    } catch (verifyErr) {
      // Never block registration on the verification side-channel.
      logger.warn(`[auth] email-verify side-channel failed for ${inserted.email}: ${verifyErr?.message || verifyErr}`);
    }

    const session = await issueSession(inserted, ip);
    await auditLog({ userid: Number(inserted.id), action: 'auth.register', ip, meta: { role } });
    logger.info(`[auth] Registered ${inserted.email} (role=${role})`);
    return res.status(201).json({ ok: true, user: publicUser({ ...inserted, emailverified: emailVerified }), ...session });
  } catch (err) {
    // TS1 (security/integrity): users_username_lower_unique (case-insensitive)
    // → honest 409 instead of a raw 500 from the unique index violation.
    if (err && err.code === '23505' && /users_username_lower_unique|users_username_key/i.test(String(err.constraint || err.message))) {
      return res.status(409).json({ error: 'Username already taken' });
    }
    return next(err);
  }
});

authRouter.post('/login', authLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    const ip = clientIpOf(req);
    if (!email || !password) {
      return res.status(400).json({ error: 'Missing required fields: email, password' });
    }

    const gate = bruteForce.check(ip, email);
    if (!gate.allowed) {
      await auditLog({ action: 'auth.login.locked', ip, meta: { email } });
      res.set('Retry-After', String(gate.retryAfterSec));
      return res.status(429).json({
        error: `Too many failed attempts — account locked for ${gate.retryAfterSec}s`,
        retryAfterSec: gate.retryAfterSec,
        code: 'BRUTE_FORCE_LOCK',
      });
    }

    const row = await one(`SELECT * FROM users WHERE email = $1`, [String(email).toLowerCase()]);
    if (!row || !verifyPassword(password, row.passwordhash)) {
      bruteForce.record(ip, email, false);
      await auditLog({ userid: row ? Number(row.id) : null, action: 'auth.login.failed', ip, meta: { email } });
      const check = bruteForce.check(ip, email);
      return res.status(401).json({
        error: 'Invalid email or password',
        attemptsRemaining: check.remaining,
      });
    }

    bruteForce.record(ip, email, true);

    // TS2b (admin producție): suspended accounts are refused after the
    // password proves correct — the ban is an account state, not a credential
    // error, so it stays a distinct 403 (never counted as a brute-force miss).
    if (row.banned === true) {
      await auditLog({ userid: Number(row.id), action: 'auth.login.banned', ip, meta: { email } });
      return res.status(403).json({ error: 'Cont suspendat', code: 'ACCOUNT_BANNED' });
    }

    await rows(`UPDATE users SET lastloginat = NOW() WHERE id = $1`, [Number(row.id)]);

    // TS3 (2FA TOTP): enabled accounts must present a valid current code —
    // a missing code answers 401 2FA_REQUIRED so the client can re-prompt.
    if (row.twofaenabled) {
      const totp = String(req.body?.code ?? '').trim();
      if (!totp) {
        return res.status(401).json({ error: '2FA code required', code: '2FA_REQUIRED' });
      }
      if (!verifyTotp(row.twofasecret, totp)) {
        bruteForce.record(ip, email, false); // brute-forcing codes hits the same lock
        await auditLog({ userid: Number(row.id), action: 'auth.login.2fa_failed', ip, meta: { email } });
        return res.status(401).json({ error: 'Invalid 2FA code', code: '2FA_INVALID' });
      }
    }

    const session = await issueSession(row, ip);
    await auditLog({ userid: Number(row.id), action: 'auth.login', ip, meta: {} });
    return res.json({ ok: true, user: publicUser(row), ...session });
  } catch (err) {
    return next(err);
  }
});

/* TS1 (security): token refresh is an auth surface too — same limiter as
   login/register (brute-forcing refresh tokens gets throttled the same way). */
authRouter.post('/refresh', authLimiter, async (req, res, next) => {
  try {
    const { refreshToken } = req.body || {};
    const row = await findRefreshToken(refreshToken);
    if (!row) {
      return res.status(401).json({ error: 'Invalid or expired refresh token', code: 'REFRESH_INVALID' });
    }
    // Rotation: revoke the presented token, issue a fresh pair.
    await rows(`UPDATE refreshtokens SET revoked = TRUE WHERE id = $1`, [Number(row.id)]);
    const user = await getUserById(row.userid);
    if (!user) return res.status(401).json({ error: 'Account no longer exists', code: 'REFRESH_INVALID' });
    const session = await issueSession(user, clientIpOf(req), row.tenantid || null);
    return res.json({ ok: true, ...session });
  } catch (err) {
    return next(err);
  }
});

authRouter.post('/logout', async (req, res, next) => {
  try {
    const { refreshToken } = req.body || {};
    const revoked = await revokeRefreshToken(refreshToken);
    return res.json({ ok: true, revoked });
  } catch (err) {
    return next(err);
  }
});

authRouter.get('/me', requireAuth, async (req, res) => {
  const stats = await one(
    `SELECT
       (SELECT COUNT(*)::int FROM watchlist WHERE userid = $1) AS watchlist,
       (SELECT COUNT(*)::int FROM watchhistory WHERE userid = $1) AS history,
       (SELECT COUNT(*)::int FROM comments WHERE userid = $1) AS comments`,
    [req.user.id],
  );
  res.json({ user: req.user, stats: { watchlist: num(stats?.watchlist), history: num(stats?.history), comments: num(stats?.comments) } });
});

/* ----------------- TS3: email verification + 2FA TOTP (additive) -------------- */

/**
 * GET /api/auth/verify?token= — consume a single-use, <24h email verification
 * token: marks the account emailverified=true and the token used. The email
 * link targets {APPURL}/#/auth?verify={token}; the SPA calls this endpoint.
 */
authRouter.get('/verify', async (req, res, next) => {
  try {
    const token = String(req.query.token || '').trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(token)) {
      return res.status(400).json({ error: 'Invalid verification token format' });
    }
    const row = await one(
      `SELECT userid FROM emailtokens
       WHERE token = $1 AND purpose = 'verify-email' AND usedat IS NULL AND expiresat > NOW()`,
      [token],
    );
    if (!row) {
      return res.status(400).json({ error: 'Invalid or expired verification token' });
    }
    await rows(`UPDATE emailtokens SET usedat = NOW() WHERE token = $1`, [token]);
    await rows(`UPDATE users SET emailverified = TRUE WHERE id = $1`, [Number(row.userid)]);
    await auditLog({ userid: Number(row.userid), action: 'auth.email.verified', ip: clientIpOf(req), meta: {} });
    logger.info(`[auth] Email verified for user ${row.userid}`);
    return res.json({ ok: true, message: 'Email verificat' });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /api/auth/2fa/setup — start TOTP enrollment: stores a fresh secret
 * (still inactive) and returns it with an otpauth:// URL for the user's
 * authenticator app (Google Authenticator &c. render the QR from this).
 * The CURRENT CODE IS NEVER RETURNED — activation requires proving the user
 * owns a working device via POST /2fa/enable {code}.
 */
authRouter.post('/2fa/setup', requireAuth, async (req, res, next) => {
  try {
    const row = await getUserById(req.user.id);
    if (row?.twofaenabled) {
      return res.status(400).json({ error: '2FA is already enabled — disable it first (/2fa/disable)' });
    }
    const secret = generateSecret(); // 20 bytes → 32 base32 chars
    await rows(`UPDATE users SET twofasecret = $1 WHERE id = $2`, [secret, req.user.id]);
    const email = row?.email || req.user.email;
    const otpauthUrl = `otpauth://totp/Animaxia:${encodeURIComponent(email)}?secret=${secret}&issuer=Animaxia`;
    await auditLog({ userid: req.user.id, action: 'auth.2fa.setup_started', ip: clientIpOf(req), meta: {} });
    logger.info(`[auth] 2FA setup started for user ${req.user.id} (secret stored, NOT enabled)`);
    return res.json({ ok: true, secret, otpauthUrl });
  } catch (err) {
    return next(err);
  }
});

/** POST /api/auth/2fa/enable {code} — confirm enrollment with a live code. */
authRouter.post('/2fa/enable', requireAuth, async (req, res, next) => {
  try {
    const { code } = req.body || {};
    const row = await getUserById(req.user.id);
    if (row?.twofaenabled) {
      return res.json({ ok: true, already: true });
    }
    if (!row?.twofasecret) {
      return res.status(400).json({ error: 'No 2FA setup in progress — call /2fa/setup first' });
    }
    if (!code || !verifyTotp(row.twofasecret, String(code).trim())) {
      return res.status(400).json({ error: 'Invalid 2FA code — check your authenticator app and try again' });
    }
    await rows(`UPDATE users SET twofaenabled = TRUE WHERE id = $1`, [req.user.id]);
    await auditLog({ userid: req.user.id, action: 'auth.2fa.enabled', ip: clientIpOf(req), meta: {} });
    logger.info(`[auth] 2FA ENABLED for user ${req.user.id}`);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

/** POST /api/auth/2fa/disable {code} — verify a live code, then wipe the secret. */
authRouter.post('/2fa/disable', requireAuth, async (req, res, next) => {
  try {
    const { code } = req.body || {};
    const row = await getUserById(req.user.id);
    if (!row?.twofaenabled && !row?.twofasecret) {
      return res.status(400).json({ error: '2FA is not enabled' });
    }
    if (!row?.twofasecret || !code || !verifyTotp(row.twofasecret, String(code).trim())) {
      await auditLog({ userid: req.user.id, action: 'auth.2fa.disable_failed', ip: clientIpOf(req), meta: {} });
      return res.status(400).json({ error: 'Invalid 2FA code — 2FA stays enabled' });
    }
    await rows(`UPDATE users SET twofasecret = NULL, twofaenabled = FALSE WHERE id = $1`, [req.user.id]);
    await auditLog({ userid: req.user.id, action: 'auth.2fa.disabled', ip: clientIpOf(req), meta: {} });
    logger.info(`[auth] 2FA DISABLED for user ${req.user.id} (secret wiped)`);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

/* --------------------- password reset (Phase 6, additive) -------------------- */

const RESET_CODE_TTL_MIN = 30;

/**
 * POST /api/auth/forgot-password { email } — always ok (no user enumeration).
 * Sandbox mode (no SMTPURL configured — the default): the 6-digit code is
 * returned in the response so the flow is completable end-to-end; a production
 * deployment emails it instead. Codes are stored sha256-hashed, single-use,
 * valid 30 minutes.
 */
authRouter.post('/forgot-password', authLimiter, async (req, res, next) => {
  try {
    const { email } = req.body || {};
    const ip = clientIpOf(req);
    if (!email || !EMAIL_RE.test(String(email))) {
      return res.status(400).json({ error: 'A valid email address is required' });
    }
    const normalized = String(email).toLowerCase();
    const user = await one(`SELECT id, email, username FROM users WHERE email = $1`, [normalized]);
    await auditLog({ userid: user ? Number(user.id) : null, action: 'auth.forgot_password', ip, meta: { email: normalized } });

    let sandboxCode = null;
    if (user) {
      const code = String(crypto.randomInt(100000, 1000000));
      const codeHash = crypto.createHash('sha256').update(`${normalized}:${code}`).digest('hex');
      await rows(
        `INSERT INTO passwordresets (userid, codehash, expiresat)
         VALUES ($1, $2, datetime('now','+' || $3))`,
        [Number(user.id), codeHash, `${RESET_CODE_TTL_MIN} minutes`],
      );
      // TS3: with SMTP configured the code is EMAILED — it is never placed in
      // the JSON response in that mode. The in-response code stays a sandbox
      // fallback ONLY (no SMTPURL + non-production + not explicitly disabled).
      if (smtpConfigured()) {
        const sent = await sendMail({
          to: normalized,
          subject: 'Animaxia — cod de resetare a parolei',
          text: `Codul tău de resetare Animaxia este: ${code}\nCodul este valabil ${RESET_CODE_TTL_MIN} de minute și poate fi folosit o singură dată.`,
          html: `<p>Codul tău de resetare Animaxia este: <b style="font-size:18px">${code}</b></p><p style="color:#888">Valabil ${RESET_CODE_TTL_MIN} de minute, o singură utilizare.</p>`,
        });
        logger.info(`[auth] Reset code emailed to ${normalized} (sent=${sent})`);
      } else {
        const allowCodeInResponse =
          !process.env.SMTPURL &&
          process.env.NODE_ENV !== 'production' &&
          process.env.ALLOWRESETCODEINRESPONSE !== 'false';
        if (allowCodeInResponse) {
          sandboxCode = code;
          logger.info(`[auth] Reset code for ${normalized}: ${code} (sandbox mode — SMTPURL unset, non-production)`);
        }
      }
    }
    return res.json({
      ok: true,
      message: 'If an account exists for this email, a reset code has been sent.',
      sandbox: sandboxCode != null,
      ...(sandboxCode ? { code: sandboxCode, codeExpiresInMin: RESET_CODE_TTL_MIN } : {}),
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /api/auth/reset-password { email, code, newPassword } — consume a valid
 * pending code, set the new password and revoke every refresh token (all
 * devices log out). Audited.
 */
authRouter.post('/reset-password', authLimiter, async (req, res, next) => {
  try {
    const { email, code, newPassword } = req.body || {};
    const ip = clientIpOf(req);
    if (!email || !code || !newPassword) {
      return res.status(400).json({ error: 'Missing required fields: email, code, newPassword' });
    }
    if (String(newPassword).length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    const normalized = String(email).toLowerCase();
    const codeHash = crypto.createHash('sha256').update(`${normalized}:${String(code)}`).digest('hex');
    const reset = await one(
      `SELECT pr.id, pr.userid FROM passwordresets pr
       JOIN users u ON u.id = pr.userid
       WHERE u.email = $1 AND pr.codehash = $2 AND pr.used = FALSE AND pr.expiresat > NOW()
       ORDER BY pr.createdat DESC LIMIT 1`,
      [normalized, codeHash],
    );
    if (!reset) {
      await auditLog({ action: 'auth.reset_password.failed', ip, meta: { email: normalized } });
      return res.status(400).json({ error: 'Invalid or expired reset code', code: 'RESET_CODE_INVALID' });
    }
    await rows(`UPDATE passwordresets SET used = TRUE WHERE id = $1`, [Number(reset.id)]);
    await rows(`UPDATE users SET passwordhash = $1 WHERE id = $2`, [hashPassword(newPassword), Number(reset.userid)]);
    // New password everywhere → kill all sessions.
    await rows(`UPDATE refreshtokens SET revoked = TRUE WHERE userid = $1 AND revoked = FALSE`, [Number(reset.userid)]);
    await auditLog({ userid: Number(reset.userid), action: 'auth.reset_password', ip, meta: {} });
    logger.info(`[auth] Password reset completed for ${normalized}`);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

export default authRouter;
