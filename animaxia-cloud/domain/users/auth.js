/**
 * domain/users/auth.js — Authentication core:
 *   • POST /api/auth/register — create account (first user or ADMINEMAILS → admin)
 *   • POST /api/auth/login    — password login with brute-force protection
 *   • POST /api/auth/refresh  — rotating refresh tokens (sha256-hashed at rest)
 *   • POST /api/auth/logout   — revoke a refresh token
 *   • GET  /api/auth/me       — current user profile snapshot
 *   • POST /api/auth/forgot-password — issue a 6-digit reset code (Phase 6)
 *   • POST /api/auth/reset-password  — consume the code, set a new password (Phase 6)
 * Middleware: attachUser (optional), requireAuth, requireAdmin.
 * JWT core (HS256 sign/verify + authSecret) lives in @animaxia/common/jwt.js.
 * Zero external crypto dependencies: node:crypto HS256 JWT + scrypt hashing.
 */

import crypto from 'node:crypto';
import express from 'express';
import { signJwt, verifyJwt } from '@animaxia/common/jwt.js';
import { one, rows, parseJsonb, isoOrNull, num } from '@animaxia/common/sql.js';
import { clientIpOf, bruteForce, auditLog, userRateLimit } from '../security/security.js';
import { logger } from '@animaxia/common/logger.js';

const ACCESS_TTL_SEC = 15 * 60; // 15 minutes
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const authLimiter = userRateLimit({ scope: 'ip', max: 30, windowMs: 60000, key: 'auth' });

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
  };
}

export async function getUserById(id) {
  return one(`SELECT * FROM users WHERE id = $1`, [Number(id)]);
}

/* -------------------------------- token session ------------------------------- */
/* issueSession is exported per the BLUEPRINT §1 frozen surface (consumed by
   auth-service internals; the monolith kept it module-private). */

export async function issueSession(user, ip) {
  const accessToken = signJwt({ sub: Number(user.id), email: user.email, plan: user.plan || 'free', typ: 'access' });
  const refreshToken = crypto.randomBytes(48).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
  await rows(
    `INSERT INTO refreshtokens (userid, tokenhash, expiresat) VALUES ($1, $2, NOW() + ($3::text)::interval)`,
    [Number(user.id), tokenHash, `${Math.round(REFRESH_TTL_MS / 1000)} seconds`],
  );
  return { accessToken, refreshToken, expiresIn: ACCESS_TTL_SEC };
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
        if (row) req.user = publicUser(row);
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

    const session = await issueSession(inserted, ip);
    await auditLog({ userid: Number(inserted.id), action: 'auth.register', ip, meta: { role } });
    logger.info(`[auth] Registered ${inserted.email} (role=${role})`);
    return res.status(201).json({ ok: true, user: publicUser(inserted), ...session });
  } catch (err) {
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
    await rows(`UPDATE users SET lastloginat = NOW() WHERE id = $1`, [Number(row.id)]);
    const session = await issueSession(row, ip);
    await auditLog({ userid: Number(row.id), action: 'auth.login', ip, meta: {} });
    return res.json({ ok: true, user: publicUser(row), ...session });
  } catch (err) {
    return next(err);
  }
});

authRouter.post('/refresh', async (req, res, next) => {
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
    const session = await issueSession(user, clientIpOf(req));
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
         VALUES ($1, $2, NOW() + ($3::text)::interval)`,
        [Number(user.id), codeHash, `${RESET_CODE_TTL_MIN} minutes`],
      );
      if (!process.env.SMTPURL) sandboxCode = code; // no mailer → sandbox response
    }
    return res.json({
      ok: true,
      message: 'If an account exists for this email, a reset code has been issued.',
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
