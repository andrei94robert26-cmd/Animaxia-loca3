import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {
  setupPgPilotProjection,flushPgPilotProjection,pgPilotProjectionStatus,
  getPgPilotProjectedItems,startPgPilotProjection,
  pgPilotMaxAttempts,listPgPilotQuarantine,retryPgPilotQuarantine,
} from '../modules/postgres/pilot-projection.js';
import pgRoutes from '../modules/postgres/routes.js';

const names=['ANIMAXIA_PG_CATALOG_PILOT','ANIMAXIA_PG_PILOT_PROJECTION',
  'ANIMAXIA_PG_SHADOW_DATABASE_URL','ANIMAXIA_PG_PILOT_PROJECTION_WORKER'];
const save=()=>Object.fromEntries(names.map(k=>[k,process.env[k]]));
const restore=old=>{
  for(const [k,v] of Object.entries(old)){
    if(v===undefined)delete process.env[k];
    else process.env[k]=v;
  }
};

test('native pilot projection is opt-in and validates pagination/query bounds',async()=>{
  const old=save();
  try{
    delete process.env.ANIMAXIA_PG_CATALOG_PILOT;
    delete process.env.ANIMAXIA_PG_PILOT_PROJECTION;
    assert.equal(startPgPilotProjection(),false);
    await assert.rejects(setupPgPilotProjection(),/disabled/);
    await assert.rejects(flushPgPilotProjection(),/disabled/);
    await assert.rejects(pgPilotProjectionStatus(),/disabled/);
    await assert.rejects(getPgPilotProjectedItems(),/disabled/);
    process.env.ANIMAXIA_PG_CATALOG_PILOT='true';
    process.env.ANIMAXIA_PG_PILOT_PROJECTION='true';
    process.env.ANIMAXIA_PG_SHADOW_DATABASE_URL='postgresql://test:pass@127.0.0.1/ci';
    await assert.rejects(flushPgPilotProjection({limit:0}),/limit/);
    await assert.rejects(flushPgPilotProjection({limit:101}),/limit/);
    await assert.rejects(getPgPilotProjectedItems({q:'x'.repeat(121)}),/search term/);
    await assert.rejects(getPgPilotProjectedItems({limit:55}),/page size/);
    await assert.rejects(getPgPilotProjectedItems({afterId:-1}),/cursor/);
  }finally{restore(old);}
});
test('native pilot projection filters are parameterized and metadata does not leak',async()=>{
  const old=save();
  try{
    process.env.ANIMAXIA_PG_CATALOG_PILOT='true';
    process.env.ANIMAXIA_PG_PILOT_PROJECTION='true';
    process.env.ANIMAXIA_PG_SHADOW_DATABASE_URL='postgresql://test:pass@127.0.0.1/ci';
    const query="movie' OR true --";
    const result=await getPgPilotProjectedItems({
      q:query,limit:1,afterId:10,
    },{db:{query:async(sql,values)=>{
      assert.ok(sql.includes('plainto_tsquery'));
      assert.ok(sql.includes('ORDER BY contentid DESC'));
      assert.ok(!sql.includes(query));
      assert.ok(values.includes(query));
      assert.ok(values.includes(10));
      return {rows:[
        {id:'9',externalid:'pilot:test:123',title:'Safe',type:'movie',
          year:2026,thumbnail:null,metadata:{actors:['Example']},
          revision:'2'},
        {id:'8',externalid:'pilot:test:124',title:'Other',type:'movie',
          year:2026,thumbnail:null,metadata:{genres:['Example']},
          revision:'1'},
      ]};
    }}});
    assert.equal(result.data.length,1);
    assert.equal(result.hasMore,true);
    assert.equal(result.nextAfterId,9);
    assert.equal(result.publicCatalogUnchanged,true);
  }finally{restore(old);}
});
test('pilot projection quarantine is opt-in, bounded, paginated and manually replayed',async()=>{
  const old=save();
  try{
    assert.equal(pgPilotMaxAttempts({}),8);
    assert.equal(pgPilotMaxAttempts({ANIMAXIA_PG_PILOT_MAX_ATTEMPTS:'100'}),100);
    for(const value of ['0','101','1.5','-1','abc','01']){
      assert.throws(()=>pgPilotMaxAttempts({
        ANIMAXIA_PG_PILOT_MAX_ATTEMPTS:value,
      }),/between 1 and 100/);
    }
    delete process.env.ANIMAXIA_PG_PILOT_PROJECTION;
    await assert.rejects(listPgPilotQuarantine(),/disabled/);
    await assert.rejects(retryPgPilotQuarantine(10),/disabled/);
    process.env.ANIMAXIA_PG_CATALOG_PILOT='true';
    process.env.ANIMAXIA_PG_PILOT_PROJECTION='true';
    process.env.ANIMAXIA_PG_SHADOW_DATABASE_URL='postgresql://test:pass@127.0.0.1/ci';
    await assert.rejects(listPgPilotQuarantine({limit:51}),/limit/);
    await assert.rejects(listPgPilotQuarantine({afterEventId:-1}),/cursor/);
    await assert.rejects(retryPgPilotQuarantine('abc'),/event ID/);
    let calls=0;
    const db={query:async(sql,values)=>{
      calls++;
      if(sql.includes('SELECT eventid::text')){
        assert.ok(sql.includes('projection_quarantined_at IS NOT NULL'));
        assert.deepEqual(values,[12,2]);
        return {rows:[
          {eventid:'11',externalid:'native:test:11',operation:'upsert',
            attempts:8,errorcode:'23514',quarantinedat:'2026-01-01T00:00:00Z'},
          {eventid:'10',externalid:'native:test:10',operation:'delete',
            attempts:8,errorcode:'WORKER_ERROR',quarantinedat:'2026-01-01T00:00:00Z'},
        ]};
      }
      assert.ok(sql.includes('projection_quarantined_at IS NOT NULL'));
      assert.deepEqual(values,[11]);
      return {rows:[{eventid:'11'}]};
    }};
    const page=await listPgPilotQuarantine({afterEventId:12,limit:1},{db});
    assert.equal(page.data.length,1);
    assert.equal(page.data[0].eventid,11);
    assert.equal(page.data[0].errorCode,'23514');
    assert.equal(page.hasMore,true);
    assert.equal(page.nextAfterEventId,11);
    const retry=await retryPgPilotQuarantine(11,{db});
    assert.equal(retry.retried,true);
    assert.equal(retry.publicCatalogUnchanged,true);
    assert.equal(calls,2);
  }finally{restore(old);}
});
test('native PostgreSQL pilot projection routes reject anonymous operations',async()=>{
  const app=express();
  app.use(express.json());
  app.use('/api/migration/postgres',pgRoutes);
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.listening?resolve():server.once('listening',resolve));
  try{
    const url='http://127.0.0.1:'+server.address().port+'/api/migration/postgres/pilot/projection';
    const responses=await Promise.all([
      fetch(url+'/status'),
      fetch(url+'/items?q=movie'),
      fetch(url+'/setup',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}),
      fetch(url+'/flush',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}),
      fetch(url+'/quarantine'),
      fetch(url+'/quarantine/12/retry',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}),
    ]);
    for(const response of responses)assert.equal(response.status,401);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
