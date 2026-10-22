import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {
  pgCatalogPilotEnabled,validatePgPilotItem,pgPilotExpectedRevision,pgPilotIdempotencyKey,
  buildPgCatalogPilotSearch,listPgCatalogPilot,getPgCatalogPilotByExternalId,pgCatalogPilotStatus,
  upsertPgCatalogPilot,
} from '../modules/postgres/catalog-pilot.js';
import pgRoutes from '../modules/postgres/routes.js';

test('PG catalog pilot is opt-in; metadata projection cannot leak playback/secrets',async()=>{
  assert.equal(pgCatalogPilotEnabled({}),false);
  const item=validatePgPilotItem({
    externalid:'api:tmdb:movie:123',
    title:'Sample Pilot Movie',type:'movie',year:2026,
    thumbnail:'https://images.example.org/123.jpg',
    metadata:{description:'A story',actors:['Alice','Alice','Bob'],
      genres:['Fantasy'],studios:['Test'],rating:7.5,
      sourceAttribution:'TMDB',
      player:{sources:[{url:'https://private.example.org/video.m3u8'}]},
      privateApiToken:'test-secret',embedcode:'<iframe>'},
  });
  assert.deepEqual(item.metadata.actors,['Alice','Bob']);
  assert.equal(item.metadata.rating,7.5);
  assert.ok(!JSON.stringify(item).includes('video.m3u8'));
  assert.ok(!JSON.stringify(item).includes('test-secret'));
  assert.ok(!JSON.stringify(item).includes('<iframe>'));
  assert.throws(()=>validatePgPilotItem({
    externalid:'x',title:'Bad',type:'movie',
  }),/externalid/);
  assert.throws(()=>validatePgPilotItem({
    externalid:'valid:123',title:'Bad',type:'unrecognized',
  }),/type/);
  assert.throws(()=>validatePgPilotItem({
    externalid:'valid:123',title:'Bad',type:'movie',year:5000,
  }),/year/);
  assert.throws(()=>validatePgPilotItem({
    externalid:'valid:123',title:'Bad',type:'movie',
    thumbnail:'http://localhost/internal',
  }),/Thumbnail/);
  const old=process.env.ANIMAXIA_PG_CATALOG_PILOT;
  try{
    delete process.env.ANIMAXIA_PG_CATALOG_PILOT;
    await assert.rejects(upsertPgCatalogPilot(item),/disabled/);
    await assert.rejects(listPgCatalogPilot({q:'Pilot'}),/disabled/);
  }finally{
    if(old===undefined)delete process.env.ANIMAXIA_PG_CATALOG_PILOT;
    else process.env.ANIMAXIA_PG_CATALOG_PILOT=old;
  }
});
test('pilot revision preconditions require safe integers and reject stale/unsafe forms',()=>{
  assert.equal(pgPilotExpectedRevision(undefined),null);
  assert.equal(pgPilotExpectedRevision(0),0);
  assert.equal(pgPilotExpectedRevision('0'),0);
  assert.equal(pgPilotExpectedRevision('42'),42);
  assert.equal(pgPilotExpectedRevision(Number.MAX_SAFE_INTEGER),Number.MAX_SAFE_INTEGER);
  for(const value of [-1,1.2,'-1','01','1.2','1e3',' 1','',
    '9007199254740993',null,true,{},[]]){
    assert.throws(()=>pgPilotExpectedRevision(value),/expectedRevision/);
  }
  const row=validatePgPilotItem({
    externalid:'api:test:versioned',title:'Versioned',type:'movie',
    expectedRevision:3,
  });
  assert.equal(row.expectedRevision,3);
  assert.equal(row.metadata.rating,null);
  assert.throws(()=>validatePgPilotItem({
    externalid:'api:test:versioned',title:'Versioned',type:'movie',
    expectedRevision:'not-a-number',
  }),/expectedRevision/);
});

test('pilot idempotency keys reject malformed or ambiguous client values',()=>{
  assert.equal(pgPilotIdempotencyKey(undefined),null);
  assert.equal(pgPilotIdempotencyKey('pilot:retry:123'), 'pilot:retry:123');
  assert.equal(pgPilotIdempotencyKey('a1234567'),'a1234567');
  for(const bad of [null,'',1,{},[],true,'short',' contains whitespace ',
    'x'.repeat(129),'https://bad/path','\u0000not-valid']){
    assert.throws(()=>pgPilotIdempotencyKey(bad),/idempotencyKey/);
  }
});

test('pilot status accepts missing schema but propagates other PG errors',async()=>{
  const prior=process.env.ANIMAXIA_PG_CATALOG_PILOT;
  process.env.ANIMAXIA_PG_CATALOG_PILOT='true';
  try{
    const absent=Object.assign(new Error('relation missing'),{code:'42P01'});
    const status=await pgCatalogPilotStatus({
      db:{query:async()=>{throw absent;}},
    });
    assert.equal(status.enabled,true);
    assert.equal(status.initialized,false);
    await assert.rejects(pgCatalogPilotStatus({
      db:{query:async()=>{throw Object.assign(new Error('connection refused'),{code:'08006'});}},
    }),/connection refused/);
  }finally{
    if(prior===undefined)delete process.env.ANIMAXIA_PG_CATALOG_PILOT;
    else process.env.ANIMAXIA_PG_CATALOG_PILOT=prior;
  }
});
test('pilot lookup is indexed, bound, safe and never exposes player data',async()=>{
  const before=process.env.ANIMAXIA_PG_CATALOG_PILOT;
  process.env.ANIMAXIA_PG_CATALOG_PILOT='true';
  try{
    await assert.rejects(getPgCatalogPilotByExternalId('invalid / path'),/externalid/);
    const item=await getPgCatalogPilotByExternalId('api:test:movie:123',{
      db:{query:async(sql,values)=>{
        assert.match(sql,/WHERE externalid=\$1 LIMIT 1/);
        assert.deepEqual(values,['api:test:movie:123']);
        return {rows:[{
          id:'33',externalid:'api:test:movie:123',
          title:'Indexed Film',type:'movie',year:2026,thumbnail:null,
          metadata:{actors:['Tester'],rating:8.4},revision:'5',
        }]};
      }},
    });
    assert.equal(item.found,true);
    assert.equal(item.data.id,33);
    assert.equal(item.data.revision,5);
    assert.equal(item.publicCatalogUnchanged,true);
    const absent=await getPgCatalogPilotByExternalId('api:test:movie:123',{
      db:{query:async()=>({rows:[]})},
    });
    assert.equal(absent.found,false);
    assert.equal(absent.data,null);
  }finally{
    if(before===undefined)delete process.env.ANIMAXIA_PG_CATALOG_PILOT;
    else process.env.ANIMAXIA_PG_CATALOG_PILOT=before;
  }
});

test('PG pilot queries use bound FTS/category/year and keyset pagination',()=>{
  const q=buildPgCatalogPilotSearch({
    q:'Adventure',type:'movie',year:'2026',afterId:'120',limit:10,
  });
  assert.ok(q.sql.includes('plainto_tsquery'));
  assert.ok(q.sql.includes(' ORDER BY id DESC LIMIT $'));
  assert.ok(!q.sql.includes('OFFSET'));
  assert.ok(q.values.includes('Adventure'));
  assert.ok(q.values.includes('movie'));
  assert.ok(q.values.includes(2026));
  assert.ok(q.values.includes(120));
  assert.ok(q.values.includes(11));
  assert.throws(()=>buildPgCatalogPilotSearch({limit:51}),/page size/);
  assert.throws(()=>buildPgCatalogPilotSearch({afterId:-1}),/cursor/);
  assert.throws(()=>buildPgCatalogPilotSearch({year:'twenty'}),/year/);
  assert.throws(()=>buildPgCatalogPilotSearch({type:'unknown'}),/category/);
  assert.throws(()=>buildPgCatalogPilotSearch({q:'x'.repeat(121)}),/long/);
});
test('PG pilot HTTP routes reject anonymous reads, writes and setup',async()=>{
  const app=express();
  app.use(express.json());
  app.use('/api/migration/postgres',pgRoutes);
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.listening?resolve():server.once('listening',resolve));
  try{
    const base='http://127.0.0.1:'+server.address().port+'/api/migration/postgres/pilot/';
    const calls=[
      fetch(base+'status'),
      fetch(base+'items?q=movie'),
      fetch(base+'items/api%3Atest%3Amovie%3A123'),
      fetch(base+'setup',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}),
      fetch(base+'items',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}),
      fetch(base+'items/api%3Atest%3Amovie%3A1',{method:'DELETE'}),
    ];
    for(const response of await Promise.all(calls))assert.equal(response.status,401);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
