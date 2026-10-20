import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { initDb,upsertContent,deleteContent } from '../db.js';
import { localDb } from '../modules/local/sqlite.js';
import {
  ensureOpenSearchOutbox,projectContent,pendingChanges,ackChange,
} from '../modules/search/opensearch-outbox.js';
import { reconcileOpenSearchDocuments } from '../modules/search/opensearch-reconcile.js';

test('OpenSearch reconciliation detects missing and stale content despite matching counts',async()=>{
  const old = Object.fromEntries(
    ['ANIMAXIA_OPENSEARCH_URL','ANIMAXIA_OPENSEARCH_INDEX',
      'ANIMAXIA_OPENSEARCH_API_KEY','NODE_ENV'].map(k=>[k,process.env[k]]));
  process.env.ANIMAXIA_OPENSEARCH_URL='https://reconcile.example.test';
  process.env.ANIMAXIA_OPENSEARCH_INDEX='animaxia-ci';
  process.env.ANIMAXIA_OPENSEARCH_API_KEY='ci-only';
  delete process.env.NODE_ENV;
  const tag=crypto.randomBytes(7).toString('hex');
  let records=[];
  try{
    await initDb();
    ensureOpenSearchOutbox();
    for(let i=0;i<3;i++){
      const result=await upsertContent({
        externalid:'reconcile-'+tag+'-'+i,
        title:'Reconcile '+tag+' '+i,
        type:'movie',
        metadata:{overview:'Snapshot '+i,actors:['Actor '+i],year:2026},
      });
      records.push(result.record);
      // Simulate success before a later index reset / drift.
      const pending=pendingChanges(100).find(x=>x.contentid===result.record.id);
      assert.ok(pending);
      assert.equal(ackChange(pending),1);
    }
    records.sort((a,b)=>a.id-b.id);
    const from=records[0].id-1;
    const data=records.map(r=>localDb.prepare('SELECT * FROM Content WHERE id=?').get(r.id));
    let calls=0;
    const mock=async(url,options)=>{
      calls++;
      assert.equal(url,'https://reconcile.example.test/animaxia-ci/_mget');
      assert.equal(options.method,'POST');
      assert.equal(options.redirect,'error');
      assert.equal(options.headers.Authorization,'ApiKey ci-only');
      const payload=JSON.parse(options.body);
      assert.deepEqual(payload.ids,records.map(r=>String(r.id)));
      return new Response(JSON.stringify({docs:[
        {_id:String(records[0].id),found:false},
        {_id:String(records[1].id),found:true,_source:{
          ...projectContent(data[1]),title:'Old remote title',
        }},
        {_id:String(records[2].id),found:true,_source:projectContent(data[2])},
      ]}),{status:200,headers:{'content-type':'application/json'}});
    };
    const dry=await reconcileOpenSearchDocuments({afterId:from,limit:3},
      {fetchImpl:mock});
    assert.equal(calls,1);
    assert.equal(dry.scanned,3);
    assert.deepEqual([dry.missing,dry.mismatched,dry.matched],[1,1,1]);
    assert.equal(dry.repairCandidates,2);
    assert.equal(dry.repairQueued,0);
    assert.equal(dry.dryRun,true);
    assert.equal(localDb.prepare('SELECT COUNT(*) AS n FROM search_index_outbox').get().n,0);
    assert.equal(dry.nextAfterId,records[2].id);
    const broken=async(_url,_opts)=>new Response(JSON.stringify({docs:[
      {_id:String(records[0].id),found:false},
      {_id:String(records[1].id),error:{type:'shard_failed'},found:false},
      {_id:String(records[2].id),found:true,_source:projectContent(data[2])},
    ]}),{status:200});
    await assert.rejects(
      reconcileOpenSearchDocuments({afterId:from,limit:3,dryRun:false},{fetchImpl:broken}),
      /partial OpenSearch mget/);
    assert.equal(localDb.prepare('SELECT COUNT(*) AS n FROM search_index_outbox').get().n,0);
    const repair=await reconcileOpenSearchDocuments(
      {afterId:from,limit:3,dryRun:false},{fetchImpl:mock});
    assert.equal(repair.repairQueued,2);
    assert.equal(repair.alreadyPending,0);
    const missingJob=pendingChanges(100).find(x=>x.contentid===records[0].id);
    const staleJob=pendingChanges(100).find(x=>x.contentid===records[1].id);
    assert.equal(missingJob.operation,'index');
    assert.equal(staleJob.operation,'index');
    const again=await reconcileOpenSearchDocuments(
      {afterId:from,limit:3,dryRun:false},{fetchImpl:mock});
    assert.equal(again.repairQueued,0);
    assert.equal(again.alreadyPending,2);
    assert.equal(pendingChanges(100).find(x=>x.contentid===records[1].id).version,
      staleJob.version,'reconciliation cannot replace a newer pending update');
    assert.throws(()=>reconcileOpenSearchDocuments({limit:200}),/limit/);
    await assert.rejects(reconcileOpenSearchDocuments(
      {afterId:from,limit:3,dryRun:'false'},{fetchImpl:mock}),/dryRun/);
    const finished=await reconcileOpenSearchDocuments(
      {afterId:records[2].id,limit:3},{fetchImpl:mock});
    assert.equal(finished.scanned,0);
    assert.equal(finished.finished,true);
  }finally{
    for(const row of records){
      await deleteContent(row.id);
      localDb.prepare('DELETE FROM search_index_outbox WHERE contentid=?').run(row.id);
    }
    for(const [k,v] of Object.entries(old)){
      if(v===undefined)delete process.env[k];else process.env[k]=v;
    }
  }
});
