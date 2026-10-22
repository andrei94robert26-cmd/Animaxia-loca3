import test from 'node:test';
import assert from 'node:assert/strict';
import { initDb } from '../db.js';
import { ensurePlatformSchema } from '../modules/platform/migrations.js';
import { ensureMinerSchema } from '../modules/miner/miner-migrations.js';
import { autoSyncConfig, autoSyncTick, autoSyncProviderStatus } from '../modules/miner/auto-sync.js';

test('miner auto-sync is opt-in, rejects unknown providers, skips missing credentials', async () => {
  await initDb();
  await ensurePlatformSchema();
  await ensureMinerSchema();
  const keys = ['ANIMAXIA_AUTO_SYNC_ENABLED','ANIMAXIA_AUTO_SYNC_PROVIDERS',
    'ANIMAXIA_AUTO_SYNC_MINUTES','TMDBAPIKEY'];
  const original = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    delete process.env.ANIMAXIA_AUTO_SYNC_ENABLED;
    assert.equal((await autoSyncTick()).skipped, 'disabled');
    process.env.ANIMAXIA_AUTO_SYNC_ENABLED = 'true';
    process.env.ANIMAXIA_AUTO_SYNC_PROVIDERS = 'unknown,tmdb,tmdb';
    process.env.ANIMAXIA_AUTO_SYNC_MINUTES = '2';
    delete process.env.TMDBAPIKEY;
    const config = autoSyncConfig();
    assert.deepEqual(config.providers, ['tmdb']);
    assert.equal(config.intervalMinutes, 15);
    const tick = await autoSyncTick();
    assert.equal(tick.results.length, 1);
    assert.deepEqual(tick.results[0], { provider: 'tmdb', status: 'not-configured' });
    const status = await autoSyncProviderStatus();
    assert.equal(status.enabled, true);
    assert.equal(status.storage, 'miner_jobs (SQLite)');
    assert.equal(status.distributed, false);
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
