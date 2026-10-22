import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { initDb,upsertContent,deleteContent } from '../db.js';
import { localDb } from '../modules/local/sqlite.js';
import {
  ensureOpenSearchOutbox,pendingChanges,ackChange,queueRemoteOrphanDeletes,
} from '../modules/search/opensearch-outbox.js';
import {
  buildOrphanScanQuery,detectOpenSearchOrphans,
} from '../modules/search/opensearch-orphans.js';

test('remote-only documents: dry-run, bounded pagination, safe deletion and invalid responses',async()=>{
  const keys=['ANIMAXIA_OPENSEARCH_URL','ANIMAXIA_OPENSEARCH_INDEX',
    'ANIMAXIA_OPENSEARCH_API_KEY','NODE_ENV'];
  const previous=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  process.env.ANIMAXIA_OPENSEARCH_URL='https://orphan-search.example.test';
  process.env.ANIMAXIA_OPENSEARCH_INDEX='animaxia-ci';
  process.env.ANIMAXIA_OPENSEARCH_API_KEY='ci-test-only';
  delete process.env.NODE_ENV;
  await initDb();ensureOpenSearchOutbox();
  const nonce=crypto.randomBytes(7).toString('hex');
  let id=null,orphanId=null,extraId=null;
  try{
    const row=await upsertContent({
      externalid:'orphans-'+nonce,title:'Canonical '+nonce,
      type:'movie',metadata:{year:2026},
    });
    id=row.record.id;
    const job=pendingChanges(100).find(x=>x.contentid===id);
    assert.ok(job);ackChange(job);
    orphanId=2_100_000_000+crypto.randomBytes(3).readUIntBE(0,3);
    extraId=orphanId+1;
    assert.ok(orphanId>id);
    assert.equal(localDb.prepare('SELECT id FROM Content WHERE id=?').get(orphanId),undefined);

    const hits=[
      {_id:String(id),sort:[id]},
      {_id:String(orphanId),sort:[orphanId]},
      {_id:String(extraId),sort:[extraId]},
    ];
    let checks=0;
    const mock=async(url,options)=>{
      checks++;
      assert.equal(url,'https://orphan-search.example.test/animaxia-ci/_search');
      assert.equal(options.method,'POST');
      assert.equal(options.redirect,'error');
      assert.equal(options.headers.Authorization,'ApiKey ci-test-only');
      const query=JSON.parse(options.body);
      assert.equal(query.track_total_hits,false);
      assert.equal(query._source,false);
      assert.deepEqual(query.sort,[{id:{order:'asc'}}]);
      return new Response(JSON.stringify({
        _shards:{failed:0},timed_out:false,
        hits:{hits:query.search_after?hits.slice(2):hits},
      }),{status:200,headers:{'content-type':'application/json'}});
    };
    const plan=buildOrphanScanQuery({afterId:0,limit:2});
    assert.equal(plan.body.size,3);
    assert.equal(plan.body.search_after,undefined);
    const dry=await detectOpenSearchOrphans({limit:2},{fetchImpl:mock});
    assert.deepEqual([dry.scanned,dry.present,dry.orphaned],[2,1,1]);
    assert.equal(dry.repairQueued,0);
    assert.equal(dry.nextAfterId,orphanId);
    assert.equal(dry.finished,false);
    assert.equal(localDb.prepare(
      'SELECT 1 FROM search_index_outbox WHERE contentid=?').get(orphanId),undefined);

    const repaired=await detectOpenSearchOrphans(
      {limit:2,dryRun:false},{fetchImpl:mock});
    assert.equal(repaired.repairQueued,1);
    const tombstone=pendingChanges(100).find(x=>x.contentid===orphanId);
    assert.ok(tombstone);
    assert.equal(tombstone.operation,'delete');
    assert.equal(tombstone.document,null);
    const again=await detectOpenSearchOrphans(
      {limit:2,dryRun:false},{fetchImpl:mock});
    assert.equal(again.repairQueued,0);
    assert.equal(again.alreadyPendingOrRestored,1);
    // An existing canonical ID is never scheduled for remote deletion.
    const safe=queueRemoteOrphanDeletes([id,orphanId]);
    assert.equal(safe.queued,0);
    assert.equal(safe.skipped,2);
    assert.equal(pendingChanges(100).find(x=>x.contentid===orphanId).version,
      tombstone.version,'repeated repair must not clobber an existing tombstone');
    const next=await detectOpenSearchOrphans(
      {afterId:orphanId,limit:2},{fetchImpl:mock});
    assert.equal(next.orphaned,1);
    assert.equal(next.finished,true);
    assert.equal(next.nextAfterId,null);

    assert.throws(()=>buildOrphanScanQuery({afterId:-1}),/afterId/);
    assert.throws(()=>buildOrphanScanQuery({limit:51}),/limit/);
    await assert.rejects(detectOpenSearchOrphans({dryRun:'false'}),/dryRun/);
    const badShards=async()=>new Response(JSON.stringify({
      _shards:{failed:1},hits:{hits:[hits[0],hits[1]]},
    }),{status:200});
    await assert.rejects(detectOpenSearchOrphans(
      {limit:2,dryRun:false},{fetchImpl:badShards}),/Incomplete/);
    const badSort=async()=>new Response(JSON.stringify({
      _shards:{failed:0},hits:{hits:[hits[1],hits[0]]},
    }),{status:200});
    await assert.rejects(detectOpenSearchOrphans(
      {limit:2,dryRun:false},{fetchImpl:badSort}),/Invalid remote/);
    assert.equal(checks,4);
  }finally{
    if(id!=null)await deleteContent(id);
    for(const k of [id,orphanId,extraId]){
      if(k!=null)localDb.prepare('DELETE FROM search_index_outbox WHERE contentid=?').run(k);
    }
    for(const [k,v] of Object.entries(previous)){
      if(v===undefined)delete process.env[k];else process.env[k]=v;
    }
  }
});
