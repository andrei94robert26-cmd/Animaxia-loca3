/**
 * modules/users/totp.js — TS3: RFC 6238 TOTP (Time-based One-Time Password)
 * implemented with node:crypto ONLY — zero new dependencies.
 *
 *   • HMAC-SHA1 over the 8-byte big-endian counter (RFC 4226 dynamic truncation)
 *   • 6 digits, 30-second time step, verification window ±1 step (±30s clock
 *     drift tolerance — the standard authenticator-app default)
 *   • Base32 (RFC 4648, no padding) encode/decode for the shared secret
 *
 * Exports:
 *   generateSecret()             20 random bytes → 32-char base32 secret
 *   totpCode(secret, timeStep)   current/forced-step 6-digit code (string)
 *   verifyTotp(secret, code)     window ±1 verification (constant-time compare)
 *   base32Encode / base32Decode  RFC 4648 helpers (exported for tests)
 *
 * Verified against the RFC 6238 Appendix B reference vectors with the standard
 * test secret '12345678901234567890' (base32 GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ):
 * T=59 → 287082 and T=1111111109 → 081804 (see tests/unit/totp.test.js).
 */

import crypto from 'node:crypto';

const STEP_SECONDS = 30;
const DIGITS = 6;
const VERIFY_WINDOW = 1; // ±1 step (±30s)

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 encode (no padding). @param {Buffer|Uint8Array} buf */
export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of Buffer.from(buf)) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

/** RFC 4648 base32 decode (ignores padding/whitespace, case-insensitive). */
export function base32Decode(str) {
  const clean = String(str || '').toUpperCase().replace(/[=\s]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`Invalid base32 character: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Fresh secret: 20 random bytes (160-bit, the SHA-1 native size) as base32. */
export function generateSecret(bytes = 20) {
  return base32Encode(crypto.randomBytes(bytes));
}

/**
 * HOTP/TOTP code for an explicit time step (RFC 4226 §5.3 dynamic truncation).
 * @param {string} secret  base32 secret
 * @param {number} timeStep  counter = floor(unixSeconds / 30); defaults to now
 * @returns {string} 6-digit zero-padded code
 */
export function totpCode(secret, timeStep = Math.floor(Date.now() / 1000 / STEP_SECONDS)) {
  const key = base32Decode(secret);
  const counter = Buffer.alloc(8);
  counter.writeUInt32BE(0, 0);
  counter.writeUInt32BE(Number(timeStep) >>> 0, 4); // big-endian 64-bit (high 32 bits stay 0 until year ~6053)
  const digest = crypto.createHmac('sha1', key).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  const code = binary % 10 ** DIGITS;
  return String(code).padStart(DIGITS, '0');
}

/**
 * Verify a code against the secret with a ±1 step window (±30s drift).
 * Constant-time comparison via crypto.timingSafeEqual.
 * @param {string} secret base32 secret
 * @param {string} code   6-digit code from the user's authenticator app
 * @returns {boolean}
 */
export function verifyTotp(secret, code) {
  if (!secret || !code) return false;
  const given = String(code).trim();
  if (!/^\d{6}$/.test(given)) return false;
  const currentStep = Math.floor(Date.now() / 1000 / STEP_SECONDS);
  for (let drift = -VERIFY_WINDOW; drift <= VERIFY_WINDOW; drift += 1) {
    const expected = totpCode(secret, currentStep + drift);
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(given, 'utf8');
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  return false;
}

export default { generateSecret, totpCode, verifyTotp, base32Encode, base32Decode };
