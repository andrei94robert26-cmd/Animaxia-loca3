import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {reconcilePgPilotProjection} from '../modules/postgres/pilot-reconciliation.js';
import routes from '../modules/postgres/routes.js';

const names=['ANIMAXIA_PG_CATALOG_PILOT','ANIMAXIA_PG_PILOT_PROJECTION',
  'ANIMAXIA_PG_SHADOW_DATABASE_URL'];
const snapshot=()=>Object.fromEntries(names.map(k=>[k,process.env[k]]));
const restore=old=>{
  for(const [k,v] of Object.entries(old)){
    if(v===undefined)delete process.env[k];else process.env[k]=v;
  }
};
test('pilot projection reconciliation fails closed and bounds each scan',async()=>{
  const old=snapshot();
  try{
    delete process.env.ANIMAXIA_PG_PILOT_PROJECTION;
    await assert.rejects(reconcilePgPilotProjection(),/disabled/);
    process.env.ANIMAXIA_PG_CATALOG_PILOT='true';
    process.env.ANIMAXIA_PG_PILOT_PROJECTION='true';
    process.env.ANIMAXIA_PG_SHADOW_DATABASE_URL='postgresql://ci:pass@localhost/test';
    for(const opts of [
      {scope:'invalid'},{limit:0},{limit:51},{dryRun:'false'},
      {afterId:-1},{afterExternalId:'x'.repeat(221)},
    ]){
      await assert.rejects(reconcilePgPilotProjection(opts),/Invalid|limit|boolean/i);
    }
  }finally{restore(old);}
});
test('reconciliation dry-run is read only and selective repair is parameterized',async()=>{
  const old=snapshot();
  try{
    process.env.ANIMAXIA_PG_CATALOG_PILOT='true';
    process.env.ANIMAXIA_PG_PILOT_PROJECTION='true';
    process.env.ANIMAXIA_PG_SHADOW_DATABASE_URL='postgresql://ci:pass@localhost/test';
    const calls=[];
    const db={query:async(sql,values)=>{
      calls.push({sql,values});
      if(sql.includes('FROM animaxia_pilot_catalog c')&&sql.includes('LEFT JOIN')){
        assert.deepEqual(values,[10,3]);
        return {rows:[
          {id:'11',externalid:'pilot:qa:11',title:'Missing',type:'movie',
            year:2026,thumbnail:null,metadata:{},revision:'1',
            projectedid:null,projectedtitle:null},
          {id:'12',externalid:'pilot:qa:12',title:'Stale',type:'movie',
            year:2026,thumbnail:null,metadata:{},revision:'2',
            projectedid:'12',projectedtitle:'Old',projectedtype:'movie',
            projectedyear:2026,projectedthumbnail:null,projectedmetadata:{},
            projectedrevision:'1'},
        ]};
      }
      if(sql.includes('INSERT INTO animaxia_pilot_events')){
        assert.ok(sql.includes('NOT EXISTS'));
        assert.deepEqual(values,[['pilot:qa:11','pilot:qa:12']]);
        return {rows:[{eventid:'42'}]};
      }
      throw Error('Unexpected SQL');
    }};
    const opts={afterId:10,limit:2};
    const dry=await reconcilePgPilotProjection(opts,{db});
    assert.deepEqual([dry.scanned,dry.missing,dry.mismatched,dry.repairQueued],[2,1,1,0]);
    assert.equal(calls.length,1,'dry-run must not insert any event');
    assert.equal(dry.finished,true);
    const fixed=await reconcilePgPilotProjection({...opts,dryRun:false},{db});
    assert.equal(fixed.repairCandidates,2);
    assert.equal(fixed.repairQueued,1);
    assert.equal(fixed.alreadyPendingOrResolved,1);
    assert.equal(calls.length,3);
    assert.equal(calls[2].values[0].length,2);
  }finally{restore(old);}
});
test('orphan scan accepts only ordered external IDs, queues guarded deletes',async()=>{
  const old=snapshot();
  try{
    process.env.ANIMAXIA_PG_CATALOG_PILOT='true';
    process.env.ANIMAXIA_PG_PILOT_PROJECTION='true';
    process.env.ANIMAXIA_PG_SHADOW_DATABASE_URL='postgresql://ci:pass@localhost/test';
    let updates=0;
    const db={query:async(sql,args)=>{
      if(sql.includes('FROM animaxia_pilot_search_projection p')){
        assert.deepEqual(args,['pilot:before',3]);
        return {rows:[
          {externalid:'pilot:orphan:1',contentid:'100',nativeid:null},
          {externalid:'pilot:orphan:2',contentid:'101',nativeid:'101'},
        ]};
      }
      if(sql.includes('INSERT INTO animaxia_pilot_events')){
        updates++;
        assert.ok(sql.includes('NOT EXISTS'));
        assert.deepEqual(args,[['pilot:orphan:1']]);
        return {rows:[{eventid:'99'}]};
      }
      throw Error('Unexpected SQL');
    }};
    const result=await reconcilePgPilotProjection({
      scope:'orphans',afterExternalId:'pilot:before',limit:2,dryRun:false,
    },{db});
    assert.equal(result.orphaned,1);
    assert.equal(result.matched,1);
    assert.equal(result.repairQueued,1);
    assert.equal(updates,1);
    const bad={query:async()=>({rows:[
      {externalid:'pilot:z',contentid:'1',nativeid:null},
      {externalid:'pilot:a',contentid:'2',nativeid:null},
    ]})};
    await assert.rejects(reconcilePgPilotProjection({
      scope:'orphans',limit:2,dryRun:false,
    },{db:bad}),/order/);
  }finally{restore(old);}
});
test('reconciliation endpoint rejects anonymous users',async()=>{
  const app=express();app.use(express.json());
  app.use('/api/migration/postgres',routes);
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.listening?resolve():server.once('listening',resolve));
  try{
    const response=await fetch('http://127.0.0.1:'+server.address().port+
      '/api/migration/postgres/pilot/projection/reconcile',{
        method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({dryRun:false}),
      });
    assert.equal(response.status,401);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
