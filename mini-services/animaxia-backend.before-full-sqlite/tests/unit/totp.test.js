/**
 * tests/unit/totp.test.js — TS3 unit tests for the RFC 6238 TOTP module
 * (modules/users/totp.js — pure node:crypto, no DB, no server needed).
 *
 * Reference vectors: RFC 6238 Appendix B with the standard SHA-1 test secret
 * '12345678901234567890' (base32 GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ). The RFC
 * table lists 8-digit codes (94287082 / 07081804) — the last 6 digits are the
 * 6-digit truncation every authenticator app shows (287082 / 081804).
 */

import { describe, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import { base32Decode, base32Encode, generateSecret, totpCode, verifyTotp } from '../../modules/users/totp.js';

const RFC_SECRET_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // = ASCII '12345678901234567890'

describe('RFC 6238 reference vectors (HMAC-SHA1, 6 digits, 30s step)', () => {
  test('T=59 → 287082', () => {
    expect(totpCode(RFC_SECRET_B32, Math.floor(59 / 30))).toBe('287082');
  });

  test('T=1111111109 → 081804', () => {
    expect(totpCode(RFC_SECRET_B32, Math.floor(1111111109 / 30))).toBe('081804');
  });

  test('T=1111111111 → 050471 (third vector, 6-digit truncation of 14050471)', () => {
    expect(totpCode(RFC_SECRET_B32, Math.floor(1111111111 / 30))).toBe('050471');
  });

  test('codes are always 6 chars zero-padded', () => {
    const step = Math.floor(1111111109 / 30);
    for (let d = -3; d <= 3; d += 1) {
      expect(totpCode(RFC_SECRET_B32, step + d)).toMatch(/^\d{6}$/);
    }
  });
});

describe('base32 (RFC 4648)', () => {
  test('decode of the RFC test secret is the ASCII seed', () => {
    expect(Buffer.from(base32Decode(RFC_SECRET_B32)).toString()).toBe('12345678901234567890');
  });

  test('encode∘decode round-trip (lengths multiple of 5 — every real secret size)', () => {
    // Unpadded RFC 4648 base32 drops the incomplete trailing bits of a partial
    // 5-byte group by design (authenticator apps behave the same) — TOTP
    // secrets are therefore 5-byte multiples (20 bytes = 4 groups) and always
    // round-trip byte-exactly.
    for (const len of [5, 10, 15, 20, 25]) {
      const buf = crypto.randomBytes(len);
      expect(Buffer.from(base32Decode(base32Encode(buf))).equals(buf)).toBe(true);
    }
  });

  test('invalid characters throw', () => {
    expect(() => base32Decode('ABC1!')).toThrow();
  });
});

describe('generateSecret', () => {
  test('format: 32 base32 chars (20 random bytes)', () => {
    expect(generateSecret()).toMatch(/^[A-Z2-7]{32}$/);
    expect(generateSecret()).toMatch(/^[A-Z2-7]{32}$/);
  });

  test('secrets are random (two draws differ, practically always)', () => {
    const seen = new Set(Array.from({ length: 8 }, () => generateSecret()));
    expect(seen.size).toBe(8);
  });
});

describe('verifyTotp (window ±1 step)', () => {
  test('accepts the current code', () => {
    const secret = generateSecret();
    expect(verifyTotp(secret, totpCode(secret))).toBe(true);
  });

  test('accepts codes from the previous and next step (±30s drift)', () => {
    const secret = generateSecret();
    const step = Math.floor(Date.now() / 1000 / 30);
    expect(verifyTotp(secret, totpCode(secret, step - 1))).toBe(true);
    expect(verifyTotp(secret, totpCode(secret, step + 1))).toBe(true);
  });

  test('rejects codes outside the window and malformed input', () => {
    const secret = generateSecret();
    const step = Math.floor(Date.now() / 1000 / 30);
    const prev2 = totpCode(secret, step - 2);
    const next2 = totpCode(secret, step + 2);
    const inWindow = new Set([totpCode(secret, step - 1), totpCode(secret, step), totpCode(secret, step + 1)]);
    if (!inWindow.has(prev2)) expect(verifyTotp(secret, prev2)).toBe(false);
    if (!inWindow.has(next2)) expect(verifyTotp(secret, next2)).toBe(false);
    expect(verifyTotp(secret, '0000000')).toBe(false); // 7 digits — format reject
    expect(verifyTotp(secret, 'abcdef')).toBe(false); // non-numeric
    expect(verifyTotp(secret, '')).toBe(false);
    expect(verifyTotp('', '123456')).toBe(false);
  });
});
