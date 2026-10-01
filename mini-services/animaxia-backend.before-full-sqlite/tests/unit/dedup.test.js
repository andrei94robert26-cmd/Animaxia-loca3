/**
 * tests/unit/dedup.test.js — TS3 unit tests for the source-normalization half
 * of the ingest dedup registry (modules/ingest/dedup.js → normalizeSource).
 * Pure function: URL canonics (youtube/vimeo/dailymotion), tracking-param
 * stripping, host lowercasing, trailing-slash folding — the properties the
 * urlhash (sha256 of the canonical form) dedups on. No DB, no server.
 */

import { describe, expect, test } from 'bun:test';
import { normalizeSource } from '../../modules/ingest/dedup.js';

describe('normalizeSource — platform canonics', () => {
  test('youtu.be/ID and youtube.com/watch?v=ID normalize to the SAME canonical (same urlhash)', () => {
    const short = normalizeSource('https://youtu.be/dQw4w9WgXcQ');
    const watch = normalizeSource('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    const nocookie = normalizeSource('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
    expect(short.kind).toBe('youtube');
    expect(short.url).toBe(watch.url);
    expect(short.url).toBe(nocookie.url);
    expect(short.urlhash).toBe(watch.urlhash);
  });

  test('different youtube ids stay different', () => {
    const a = normalizeSource('https://youtu.be/dQw4w9WgXcQ');
    const b = normalizeSource('https://youtu.be/abcdefghijk');
    expect(a.urlhash).not.toBe(b.urlhash);
  });
});

describe('normalizeSource — generic URL hygiene', () => {
  test('utm_* tracking params are stripped, other params kept + sorted', () => {
    const dirty = normalizeSource('https://example.com/video/1?utm_source=news&id=2&utm_campaign=x');
    const clean = normalizeSource('https://example.com/video/1?id=2');
    expect(dirty.url).toBe(clean.url);
    expect(dirty.url).not.toContain('utm_');
  });

  test('host is case-insensitive (lowercased)', () => {
    const a = normalizeSource('https://Example.COM/video/1');
    const b = normalizeSource('https://example.com/video/1');
    expect(a.url).toBe(b.url);
    expect(a.urlhash).toBe(b.urlhash);
  });

  test('trailing slash folds away on non-root paths', () => {
    const a = normalizeSource('https://example.com/video/1/');
    const b = normalizeSource('https://example.com/video/1');
    expect(a.url).toBe(b.url);
  });

  test('different paths stay different (no over-normalization)', () => {
    const a = normalizeSource('https://example.com/video/1');
    const b = normalizeSource('https://example.com/video/2');
    expect(a.urlhash).not.toBe(b.urlhash);
  });
});

describe('normalizeSource — non-URL inputs', () => {
  test('empty input → null', () => {
    expect(normalizeSource('')).toBe(null);
    expect(normalizeSource(null)).toBe(null);
    expect(normalizeSource(undefined)).toBe(null);
  });

  test('embed/iframe blobs extract src="…" when present', () => {
    const embed = normalizeSource('<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>');
    expect(embed.kind).toBe('youtube');
    expect(embed.url).toBe('youtube:dQw4w9WgXcQ');
  });

  test('plain string (no scheme) is hashed as a link, never crashes', () => {
    const out = normalizeSource('magnet:?xt=urn:btih:abc123');
    expect(out).not.toBe(null);
    expect(out.urlhash).toMatch(/^[0-9a-f]{64}$/);
  });
});
