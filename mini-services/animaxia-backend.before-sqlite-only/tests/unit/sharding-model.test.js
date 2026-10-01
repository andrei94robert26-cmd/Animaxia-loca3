/**
 * tests/unit/sharding-model.test.js — TS3 unit tests for the logical sharding
 * model (modules/sharding/model.js — pure functions, no DB). Known cases:
 * the RANGE rule (id < 1B → shard 0, id ≥ 1B → shard floor(id/1B) % 4) and the
 * tenant FNV-1a hash rule (deterministic, well distributed over [0, 4)).
 *
 * AR10M: SHARDCOUNT is pinned to 4 HERE on purpose so the wrap-around
 * expectations below are deterministic — the platform default is now 15
 * (AR10M 15-shard; fost 30/30B simulat — eliminat), and ambient .env values
 * must not change what this suite proves about the pure RANGE/hash rules.
 */

import { describe, expect, test } from 'bun:test';

// Pin the topology under test BEFORE any model call (shardCount() reads env lazily).
process.env.SHARDCOUNT = '4';

import { computeShardIdFromContentId, computeShardIdFromTenant, fnv1a, shardCount } from '../../modules/sharding/model.js';

describe('computeShardIdFromContentId (RANGE rule, SHARDCOUNT=4)', () => {
  test('small ids (< 1B) live on shard 0 — legacy SERIAL compatibility', () => {
    expect(computeShardIdFromContentId(0)).toBe(0);
    expect(computeShardIdFromContentId(1)).toBe(0);
    expect(computeShardIdFromContentId(999_999_999)).toBe(0);
  });

  test('id 1e9 crosses into shard 1', () => {
    expect(computeShardIdFromContentId(1_000_000_000)).toBe(1);
    expect(computeShardIdFromContentId(1_999_999_999)).toBe(1);
  });

  test('ranges map to shards 2 and 3, then wrap to 0', () => {
    expect(computeShardIdFromContentId(2_000_000_000)).toBe(2);
    expect(computeShardIdFromContentId(3_000_000_000)).toBe(3);
    expect(computeShardIdFromContentId(4_000_000_000)).toBe(0); // 4 % 4
    expect(computeShardIdFromContentId(5_000_000_000)).toBe(1);
  });

  test('non-finite and negative ids clamp to shard 0', () => {
    expect(computeShardIdFromContentId(-5)).toBe(0);
    expect(computeShardIdFromContentId('not-a-number')).toBe(0);
    expect(computeShardIdFromContentId(NaN)).toBe(0);
    expect(computeShardIdFromContentId(Infinity)).toBe(0);
  });

  test('string ids that parse as numbers behave like numbers', () => {
    expect(computeShardIdFromContentId('1500000000')).toBe(1);
  });
});

describe('computeShardIdFromTenant (FNV-1a hash rule)', () => {
  test('deterministic: same input → same shard, every time', () => {
    const first = computeShardIdFromTenant('acme');
    for (let i = 0; i < 5; i += 1) {
      expect(computeShardIdFromTenant('acme')).toBe(first);
    }
  });

  test('always inside [0, shardCount)', () => {
    for (const t of ['a', 'b', 'acme', 'globex', 'initech', 'umbrella', 'tenant-42', 'x'.repeat(50)]) {
      const s = computeShardIdFromTenant(t);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(shardCount());
    }
  });

  test('different tenants spread over the shards (no single-shard collapse)', () => {
    const shards = new Set(Array.from({ length: 40 }, (_, i) => computeShardIdFromTenant(`tenant-${i}`)));
    expect(shards.size).toBeGreaterThanOrEqual(3); // 4 shards, 40 tenants — expect real spread
  });

  test('fnv1a is the pinned FNV-1a 32-bit algorithm (reference values)', () => {
    expect(fnv1a('')).toBe(0x811c9dc5); // offset basis for the empty string
    expect(fnv1a('a')).toBe(0xe40c292c); // well-known FNV-1a("a")
    expect(fnv1a('foobar')).toBe(0xbf9cf968); // well-known FNV-1a("foobar")
  });
});
