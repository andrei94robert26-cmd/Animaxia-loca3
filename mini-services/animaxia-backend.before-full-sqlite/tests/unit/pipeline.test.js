/**
 * tests/unit/pipeline.test.js — TS3 unit tests for the FAZA-18 search pipeline
 * (modules/search/pipeline.js) through its PUBLIC interface with an INJECTED
 * mock executor (layer 10 is a closure by design — no DB, no FTS, no server
 * needed). The protected FTS engine itself is exercised live by the smoke /
 * stress suites; here we verify the orchestration contract:
 *   execute() → { body, source } · PipelineRejection(429/503) · layer stats.
 *
 * Each test uses a distinct synthetic client id (the layer-2 token bucket is
 * per-client, capacity 30) so the tests stay independent of each other.
 */

import { describe, expect, test } from 'bun:test';
import { pipeline, PipelineRejection } from '../../modules/search/pipeline.js';

describe('pipeline public surface', () => {
  test('exports the 10-layer config snapshot', () => {
    expect(pipeline.config.maxConcurrency).toBeGreaterThan(0);
    expect(pipeline.config.maxQueueLength).toBeGreaterThan(0);
    expect(pipeline.config.maxRatePerSec).toBeGreaterThan(0);
    expect(typeof pipeline.execute).toBe('function');
    expect(typeof pipeline.stagesSnapshot).toBe('function');
    expect(typeof pipeline.perStageCounts).toBe('function');
  });

  test('stagesSnapshot lists all 10 stages', () => {
    const stages = pipeline.stagesSnapshot();
    expect(Array.isArray(stages)).toBe(true);
    expect(stages.length).toBe(10);
  });
});

describe('pipeline.execute with a mock executor', () => {
  test('runs the executor and returns { body, source: "miss" }', async () => {
    const out = await pipeline.execute({
      kind: 'search',
      client: 'unit-miss-1',
      query: 'frieren',
      params: { limit: 3 },
      executor: async () => ({ total: 1, results: [{ id: 1 }] }),
    });
    expect(out.source).toBe('miss');
    expect(out.body.total).toBe(1);
    expect(out.body.results[0].id).toBe(1);
  });

  test('identical retry inside the 10s cooldown is served from the layer-9 cache (executor runs once)', async () => {
    let executions = 0;
    const exec = async () => {
      executions += 1;
      return { total: executions };
    };
    const first = await pipeline.execute({ kind: 'search', client: 'unit-cache-1', query: 'dune', executor: exec });
    const second = await pipeline.execute({ kind: 'search', client: 'unit-cache-1', query: 'dune', executor: exec });
    expect(first.source).toBe('miss');
    expect(second.source).toBe('cooldown');
    expect(second.body.total).toBe(1); // cached body, not a re-execution
    expect(executions).toBe(1);
  });

  test('layer 1 anti-spam: >256-char query → 429 PipelineRejection', async () => {
    try {
      await pipeline.execute({
        kind: 'search',
        client: 'unit-spam-1',
        query: 'x'.repeat(300),
        executor: async () => ({ total: 0 }),
      });
      throw new Error('expected the pipeline to reject the oversized query');
    } catch (err) {
      expect(err).toBeInstanceOf(PipelineRejection);
      expect(err.status).toBe(429);
      expect(err.body.error).toBe('anti-spam');
      expect(err.body.layer).toBe(1);
    }
  });

  test('layer 1 anti-spam: control characters → 429', async () => {
    try {
      await pipeline.execute({
        kind: 'search',
        client: 'unit-spam-2',
        query: 'bad\x00query\x1f',
        executor: async () => ({ total: 0 }),
      });
      throw new Error('expected the pipeline to reject control characters');
    } catch (err) {
      expect(err).toBeInstanceOf(PipelineRejection);
      expect(err.status).toBe(429);
      expect(err.body.layer).toBe(1);
    }
  });

  test('layer 2 rate limit: exhausting the per-client bucket → 429 with retry info', async () => {
    const client = 'unit-rl-1';
    let limited = null;
    // capacity 30 + refill 0.5/s — 35 rapid takes must hit the ceiling.
    for (let i = 0; i < 35 && !limited; i += 1) {
      try {
        await pipeline.execute({ kind: 'search', client, query: `q${i}`, executor: async () => ({ total: 0 }) });
      } catch (err) {
        limited = err;
      }
    }
    expect(limited).toBeInstanceOf(PipelineRejection);
    expect(limited.status).toBe(429);
    expect(limited.body.error).toBe('rate-limit');
    expect(limited.body.layer).toBe(2);
    expect(limited.headers['Retry-After']).toBeTruthy();
  });

  test('missing executor → honest rejection', async () => {
    const out = pipeline.execute({ kind: 'search', client: 'unit-noexec', query: 'x' });
    await expect(out).rejects.toThrow('pipeline.execute requires an executor function');
  });
});
