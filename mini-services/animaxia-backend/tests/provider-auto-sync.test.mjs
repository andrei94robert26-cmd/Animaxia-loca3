import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { initDb, query, getContentByExternalId, deleteContent } from '../db.js';
import { ensurePlatformSchema } from '../modules/platform/migrations.js';
import { installSourceManifest, setSourceEnabled, getSourceRecord } from '../modules/ingest/source-registry.js';
import { processNextMetadataJob } from '../modules/ingest/queue.js';
import { pollProviderTick, providerAutoSyncStatus, ensureProviderPollSchema, providerSupportsPollQuery } from '../modules/providers/auto-sync.js';

test('scheduler skips incompatible query modes before any outbound request', () => {
  for (const id of ['musicbrainz','omdb','itunes','cheapshark','gdelt','scryfall']) {
    assert.equal(providerSupportsPollQuery(id,''),false,id);
    assert.equal(providerSupportsPollQuery(id,'Queen'),true,id);
  }
  for (const id of ['pokeapi','openligadb','jolpica','opendota','freetogame']) {
    assert.equal(providerSupportsPollQuery(id,''),true,id);
    assert.equal(providerSupportsPollQuery(id,'Queen'),false,id);
  }
  assert.equal(providerSupportsPollQuery('kitsu','Naruto'),true);
});

test('periodic provider sync is opt-in and does not run without metadata worker', async () => {
  const keys = ['ANIMAXIA_PROVIDER_AUTO_SYNC_ENABLED','ANIMAXIA_METADATA_QUEUE_WORKER'];
  const old = Object.fromEntries(keys.map((k) => [k,process.env[k]]));
  try {
    delete process.env.ANIMAXIA_PROVIDER_AUTO_SYNC_ENABLED;
    assert.equal((await pollProviderTick()).skipped, 'disabled');
    process.env.ANIMAXIA_PROVIDER_AUTO_SYNC_ENABLED = 'true';
    delete process.env.ANIMAXIA_METADATA_QUEUE_WORKER;
    assert.equal((await pollProviderTick()).skipped, 'metadata-worker-disabled');
  } finally {
    for (const [k,v] of Object.entries(old)) {
      if(v===undefined) delete process.env[k]; else process.env[k]=v;
    }
  }
});

test('scheduler persists cadence, enqueues metadata, and retries failed upstream with cooldown', async () => {
  await initDb();
  await ensurePlatformSchema();
  ensureProviderPollSchema();
  const nonce = crypto.randomBytes(6).toString('hex');
  const keys = ['ANIMAXIA_PROVIDER_AUTO_SYNC_ENABLED','ANIMAXIA_METADATA_QUEUE_WORKER',
    'ANIMAXIA_PROVIDER_AUTO_SYNC_PROVIDERS','ANIMAXIA_PROVIDER_AUTO_SYNC_MINUTES',
    'ANIMAXIA_PROVIDER_AUTO_SYNC_QUERIES_JSON'];
  const old = Object.fromEntries(keys.map((k)=>[k,process.env[k]]));
  process.env.ANIMAXIA_PROVIDER_AUTO_SYNC_ENABLED = 'true';
  process.env.ANIMAXIA_METADATA_QUEUE_WORKER = 'true';
  process.env.ANIMAXIA_PROVIDER_AUTO_SYNC_PROVIDERS = 'unknown,kitsu,kitsu';
  process.env.ANIMAXIA_PROVIDER_AUTO_SYNC_MINUTES = '5';
  process.env.ANIMAXIA_PROVIDER_AUTO_SYNC_QUERIES_JSON = '{}';
  const source = {type:'api',id:'kitsu'};
  assert.equal(getSourceRecord(source),null,'requires disposable SQLite CI database');
  installSourceManifest({source,name:'Kitsu automatic CI',protocol:'json-push-v1'});
  setSourceEnabled(source,true);
  let calls=0;
  const mock = async (url, options) => {
    calls++;
    assert.equal(new URL(url).hostname,'kitsu.io');
    assert.equal(options.redirect,'error');
    return new Response(JSON.stringify({data:[{id:'ci-'+nonce,attributes:{
      canonicalTitle:'Scheduler Anime '+nonce,startDate:'2024-10-20',
      synopsis:'Fantasy series from mocked provider',
    }}]}),{status:200,headers:{'content-type':'application/vnd.api+json'}});
  };
  let importedId=null;
  try {
    const config=providerAutoSyncStatus();
    assert.deepEqual(config.providers,['kitsu']);
    assert.equal(config.intervalMinutes,15);
    assert.equal(config.distributed,false);
    const first=await pollProviderTick(mock);
    assert.equal(first.provider,'kitsu');
    assert.equal(first.status,'success');
    assert.equal(first.queued,true);
    assert.equal(calls,1);
    assert.ok(first.jobId);
    const again=await pollProviderTick(mock);
    assert.equal(again.skipped,'no-ready-provider-due');
    assert.equal(calls,1);
    const job=await processNextMetadataJob();
    assert.equal(job.id,first.jobId);
    assert.equal(job.status,'done');
    const record=await getContentByExternalId('api:kitsu:anime:ci-'+nonce);
    assert.equal(record.title,'Scheduler Anime '+nonce);
    importedId=record.id;
    assert.equal(providerAutoSyncStatus().states.find((s)=>s.id==='kitsu').lastStatus,'queued');

    // Force the next run due and simulate an upstream rate limit.
    await query("UPDATE provider_poll_state SET nextafter=datetime('now','-5 minutes') WHERE providerid=?", ['kitsu']);
    const rejected=await pollProviderTick(async()=>new Response(JSON.stringify({error:'rate limited'}),{
      status:503,headers:{'content-type':'application/json'}
    }));
    assert.equal(rejected.provider,'kitsu');
    assert.equal(rejected.status,'error');
    const fail=providerAutoSyncStatus().states.find((s)=>s.id==='kitsu');
    assert.equal(fail.failures,1);
    assert.equal(fail.lastStatus,'error');
    assert.ok(Date.parse(fail.nextAttemptAt)>Date.now());
    assert.equal((await pollProviderTick(mock)).skipped,'no-ready-provider-due');
    assert.equal(calls,1);
    setSourceEnabled(source,false);
    await query("UPDATE provider_poll_state SET nextafter=datetime('now','-5 minutes') WHERE providerid=?", ['kitsu']);
    assert.equal((await pollProviderTick(mock)).skipped,'no-ready-provider-due');
  } finally {
    if(importedId!==null) await deleteContent(importedId);
    await query("DELETE FROM metadata_sync_jobs WHERE sourcetype='api' AND sourceid=?",['kitsu']);
    await query("DELETE FROM metadata_ingest_sources WHERE sourcetype='api' AND sourceid=?",['kitsu']);
    await query("DELETE FROM provider_fetch_health WHERE providerid=?",['kitsu']);
    await query("DELETE FROM provider_poll_state WHERE providerid=?",['kitsu']);
    for(const [k,v] of Object.entries(old)){
      if(v===undefined) delete process.env[k]; else process.env[k]=v;
    }
  }
});
