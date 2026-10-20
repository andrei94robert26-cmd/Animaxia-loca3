import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import { initDb,upsertContent,deleteContent } from '../db.js';
import { localDb } from '../modules/local/sqlite.js';
import {
  ensureOpenSearchOutbox,projectContent,pendingChanges,ackChange,
  outboxStatus,seedOpenSearchOutbox,
} from '../modules/search/opensearch-outbox.js';
import {
  distributedConfig,distributedIndexMapping,buildDistributedSearch,
  buildBulkPayload,flushDistributedOutbox,ensureDistributedIndex,
  distributedSearch,
} from '../modules/search/opensearch.js';
import metadataRouter from '../modules/search/metadata.js';

const vars=['ANIMAXIA_OPENSEARCH_URL','ANIMAXIA_OPENSEARCH_INDEX',
  'ANIMAXIA_SEARCH_BACKEND','ANIMAXIA_OPENSEARCH_API_KEY','NODE_ENV'];
test('OpenSearch options fail closed for unsafe URL and prod without TLS/auth', () => {
  assert.equal(distributedConfig({}).configured,false);
  assert.throws(()=>distributedConfig({ANIMAXIA_OPENSEARCH_URL:'http://1.1.1.1:9200'}),
    /requires HTTPS/);
  assert.throws(()=>distributedConfig({ANIMAXIA_OPENSEARCH_URL:'https://search.example.test/a'}),
    /HTTP\(S\) origin/);
  assert.throws(()=>distributedConfig({
    ANIMAXIA_OPENSEARCH_URL:'http://127.0.0.1:9200',NODE_ENV:'production',
  }),/requires HTTPS/);
  assert.throws(()=>distributedConfig({
    ANIMAXIA_OPENSEARCH_URL:'https://example.test',NODE_ENV:'production',
  }),/credentials are required/);
  const ok=distributedConfig({
    ANIMAXIA_OPENSEARCH_URL:'https://search.example.test',
    ANIMAXIA_OPENSEARCH_API_KEY:'non-public-test-key',
    ANIMAXIA_OPENSEARCH_INDEX:'animaxia-ci',
    NODE_ENV:'production',
  });
  assert.equal(ok.configured,true);
  assert.equal(ok.origin,'https://search.example.test');
  assert.equal(ok.index,'animaxia-ci');
  const mapping=distributedIndexMapping();
  assert.equal(mapping.mappings.properties.title.type,'text');
  assert.equal(mapping.mappings.properties.category,undefined);
  assert.equal(mapping.mappings.properties.type.type,'keyword');
  assert.equal(mapping.mappings.dynamic,'strict');
});
test('OpenSearch query DSL is filter-bound and cursor-safe', () => {
  const q=buildDistributedSearch({
    q:'Adventure',category:'filme',actor:'Actor One',year:'2026',
    genre:'Fantasy',sort:'title',limit:'10',
  });
  assert.equal(q.body.size,11);
  assert.equal(q.body.query.bool.must[0].multi_match.query,'Adventure');
  assert.ok(q.body.query.bool.filter.some((x)=>x.term?.type==='movie'));
  assert.ok(q.body.query.bool.filter.some((x)=>x.term?.year===2026));
  assert.equal(q.body.sort[0].title_sort,'asc');
  assert.throws(()=>buildDistributedSearch({q:'hello',cursor:'notbase64'}),/cursor/);
  assert.throws(()=>buildDistributedSearch({year:'190000'}),/year/);
  assert.throws(()=>buildDistributedSearch({}),/Provide q/);
  assert.throws(()=>buildDistributedSearch({q:'hello',cursor:Buffer.from(JSON.stringify({
    sig:q.sig,after:['wrong'],foo:1,
  })).toString('base64url')}),/cursor/);
});
test('SQLite outbox tracks insert, update, delete and remote bulk partial failures', async () => {
  const original=Object.fromEntries(vars.map((k)=>[k,process.env[k]]));
  const nonce=crypto.randomBytes(5).toString('hex');
  process.env.ANIMAXIA_OPENSEARCH_URL='https://search.example.test';
  process.env.ANIMAXIA_OPENSEARCH_INDEX='animaxia-ci';
  process.env.ANIMAXIA_OPENSEARCH_API_KEY='non-public-test-key';
  delete process.env.NODE_ENV;
  await initDb();
  ensureOpenSearchOutbox();
  const externalid='os-ci-'+nonce;
  let recordId=null;
  let server=null;
  const fakeSearch=(url,options)=>{
    assert.match(url,/^https:\/\/search\.example\.test\//);
    assert.equal(options.redirect,'error');
    assert.ok(options.headers.Authorization.startsWith('ApiKey '));
    if(url.endsWith('/_search')){
      return Promise.resolve(new Response(JSON.stringify({
        hits:{total:{value:2,relation:'eq'},max_score:3,hits:[
          {_id:'1',_score:3,sort:[3,120],_source:{
            id:120,title:'First Film',type:'movie',year:2026,description:'Adventure',
            actors:['Actor One'],genres:['Fantasy'],
          }},
          {_id:'2',_score:1,sort:[1,119],_source:{id:119,title:'Second Film',type:'movie'}},
        ]},
      }),{status:200,headers:{'content-type':'application/json'}}));
    }
    if(url.endsWith('/_mapping'))
      return Promise.resolve(new Response('{"error":"missing"}',{status:404}));
    if(url.endsWith('/animaxia-ci')&&options.method==='PUT')
      return Promise.resolve(new Response('{"acknowledged":true}',{status:200}));
    throw new Error('Unexpected mocked OpenSearch route '+url);
  };
  try {
    // Existing catalog items can be backfilled explicitly with bounded cursor.
    const backfill=seedOpenSearchOutbox({afterId:0,limit:1});
    assert.equal(backfill.scanned,0);
    const inserted=await upsertContent({
      externalid,type:'movie',title:'Index Trigger '+nonce,
      metadata:{actors:['Actor One'],overview:'Adventure',rating:7.8,
        player:{sources:[{url:'https://example.org/private.mp4',type:'mp4'}]}},
    });
    recordId=inserted.record.id;
    let pending=pendingChanges().find((x)=>x.contentid===recordId);
    assert.ok(pending);
    assert.ok(pending.document);
    const projection=projectContent(pending.document);
    assert.equal(projection.title,'Index Trigger '+nonce);
    assert.deepEqual(projection.actors,['Actor One']);
    assert.equal(projection.player,undefined);
    assert.equal(JSON.stringify(projection).includes('private.mp4'),false);

    await upsertContent({
      externalid,type:'movie',title:'Updated Index '+nonce,
      metadata:{actors:['New Person'],overview:'Changed'},
    });
    const updated=pendingChanges().find((x)=>x.contentid===recordId);
    assert.ok(updated.version>pending.version);
    assert.equal(ackChange(pending),0,'old version must not consume a new update');
    const payload=buildBulkPayload([updated],'animaxia-ci');
    assert.ok(payload.endsWith('\n'));
    assert.ok(payload.includes('Updated Index'));
    assert.ok(!payload.includes('private.mp4'));

    assert.deepEqual(await ensureDistributedIndex({fetchImpl:fakeSearch}),
      {index:'animaxia-ci',created:true});
    const search=await distributedSearch({
      q:'Adventure',category:'filme',limit:'1',
    },{fetchImpl:fakeSearch});
    assert.equal(search.engine,'animaxia-opensearch-v1');
    assert.equal(search.data.length,1);
    assert.ok(search.nextCursor);
    const follow=buildDistributedSearch({
      q:'Adventure',category:'filme',limit:'1',cursor:search.nextCursor,
    });
    assert.deepEqual(follow.body.search_after,[3,120]);
    assert.equal(search.total,2);
    const app=express();
    app.use('/api/search',metadataRouter);
    server=app.listen(0,'127.0.0.1');
    await new Promise((resolve)=>server.listening?resolve():server.once('listening',resolve));

    let failures=0;
    const partial=async(url,options)=>{
      assert.ok(url.endsWith('/_bulk'));
      assert.equal(options.headers['Content-Type'],'application/x-ndjson');
      const actions=options.body.trim().split('\n');
      assert.equal(actions.length,2);
      failures++;
      return new Response(JSON.stringify({
        errors:failures===1,items:[{index:{status:failures===1?429:201}}],
      }),{status:200,headers:{'content-type':'application/json'}});
    };
    const first=await flushDistributedOutbox({fetchImpl:partial});
    assert.equal(first.failed,1);
    assert.ok(outboxStatus().pending>=1);
    localDb.prepare('UPDATE search_index_outbox SET nextattemptat=0 WHERE contentid=?')
      .run(recordId);
    const second=await flushDistributedOutbox({fetchImpl:partial});
    assert.equal(second.processed,1);
    assert.ok(!pendingChanges().find((x)=>x.contentid===recordId));

    await deleteContent(recordId);
    const gone=pendingChanges().find((x)=>x.contentid===recordId);
    assert.ok(gone);
    assert.equal(gone.document,null);
    const deletePayload=buildBulkPayload([gone],'animaxia-ci');
    assert.ok(deletePayload.includes('"delete"'));
    assert.equal(deletePayload.trim().split('\n').length,1);
    recordId=null;
    ackChange(gone);
  }finally{
    if(server)await new Promise((resolve)=>server.close(resolve));
    if(recordId!=null)await deleteContent(recordId);
    localDb.prepare("DELETE FROM search_index_outbox WHERE contentid NOT IN (SELECT id FROM Content)")
      .run();
    for(const [key,value] of Object.entries(original)){
      if(value===undefined)delete process.env[key];else process.env[key]=value;
    }
  }
});
