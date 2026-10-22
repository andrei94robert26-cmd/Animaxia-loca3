
/** Real PostgreSQL 16: native catalog transactional event projection. */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import pg from 'pg';
import {
  setupPgCatalogPilot,upsertPgCatalogPilot,deletePgCatalogPilot,
  stopPgCatalogPilot,
} from '../modules/postgres/catalog-pilot.js';
import {
  setupPgPilotProjection,flushPgPilotProjection,pgPilotProjectionStatus,
  getPgPilotProjectedItems,stopPgPilotProjection,
} from '../modules/postgres/pilot-projection.js';

test('PG16 durable event projection: concurrent claims, retries, current state, deletes',async(t)=>{
  if(!process.env.ANIMAXIA_PG_SHADOW_DATABASE_URL){
    t.skip('Requires disposable PostgreSQL 16 CI service');return;
  }
  const prev={pilot:process.env.ANIMAXIA_PG_CATALOG_PILOT,
    projection:process.env.ANIMAXIA_PG_PILOT_PROJECTION};
  process.env.ANIMAXIA_PG_CATALOG_PILOT='true';
  process.env.ANIMAXIA_PG_PILOT_PROJECTION='true';
  const pool=new pg.Pool({
    connectionString:process.env.ANIMAXIA_PG_SHADOW_DATABASE_URL,
    ssl:false,max:6,connectionTimeoutMillis:4000,
  });
  const nonce=crypto.randomBytes(8).toString('hex');
  const prefix='pilot-project-ci:'+nonce+':';
  const ids=[prefix+'movie:1',prefix+'tv:2',prefix+'movie:3',prefix+'blocked:4'];
  let constraintAdded=false;
  const restore=async()=>{
    if(constraintAdded)await pool.query(
      'ALTER TABLE animaxia_pilot_search_projection DROP CONSTRAINT IF EXISTS pilot_projection_ci_block');
    await pool.query('DELETE FROM animaxia_pilot_events WHERE externalid LIKE $1',[prefix+'%']);
    await pool.query('DELETE FROM animaxia_pilot_search_projection WHERE externalid LIKE $1',[prefix+'%']);
    await pool.query('DELETE FROM animaxia_pilot_catalog WHERE externalid LIKE $1',[prefix+'%']);
    await stopPgPilotProjection();
    await stopPgCatalogPilot();
    await pool.end();
    if(prev.pilot===undefined)delete process.env.ANIMAXIA_PG_CATALOG_PILOT;
    else process.env.ANIMAXIA_PG_CATALOG_PILOT=prev.pilot;
    if(prev.projection===undefined)delete process.env.ANIMAXIA_PG_PILOT_PROJECTION;
    else process.env.ANIMAXIA_PG_PILOT_PROJECTION=prev.projection;
  };
  try{
    assert.equal((await setupPgPilotProjection()).schemaVersion,1);
    assert.equal((await setupPgPilotProjection()).schemaVersion,1,'DDL should be re-runnable');
    for(const [index,externalid] of ids.slice(0,3).entries()){
      await upsertPgCatalogPilot({
        externalid,title:'ProjectionStageNineteen '+nonce+' '+index,
        type:index===1?'tv':'movie',year:2026,
        metadata:{
          description:'Event projection full text canary',
          actors:['Event QA'],genres:['Adventure'],
          player:{sources:[{url:'https://private.invalid/stream.m3u8'}]},
          secretToken:'PROJECTION_SECRET_NEVER_MIRROR',
        },
      });
    }
    const before=await pgPilotProjectionStatus();
    assert.ok(before.pending>=3);
    const concurrent=await import('../modules/postgres/pilot-projection.js?worker=two');
    const [one,two]=await Promise.all([
      flushPgPilotProjection({limit:2}),
      concurrent.flushPgPilotProjection({limit:3}),
    ]);
    assert.equal(one.failed+two.failed,0);
    assert.ok(one.processed+two.processed>=3);
    const projected=await pool.query(
      'SELECT externalid,title,metadata FROM animaxia_pilot_search_projection WHERE externalid LIKE $1',
      [prefix+'%']);
    assert.equal(projected.rowCount,3);
    assert.ok(projected.rows.every(x=>!JSON.stringify(x).includes('stream.m3u8')));
    assert.ok(projected.rows.every(x=>!JSON.stringify(x).includes('PROJECTION_SECRET')));
    const search=await getPgPilotProjectedItems({
      q:'ProjectionStageNineteen',limit:1,
    });
    assert.equal(search.data.length,1);
    assert.equal(search.hasMore,true);
    assert.ok(search.nextAfterId>0);
    const next=await getPgPilotProjectedItems({
      q:'ProjectionStageNineteen',limit:1,afterId:search.nextAfterId,
    });
    assert.equal(next.data.length,1);
    assert.ok(search.data[0].id>next.data[0].id);

    // Two native updates create distinct events; both workers must converge
    // to the latest canonical title, regardless of which event claims first.
    await upsertPgCatalogPilot({
      externalid:ids[0],title:'Intermediate title '+nonce,type:'movie',
      metadata:{description:'Old snapshot'},
    });
    await upsertPgCatalogPilot({
      externalid:ids[0],title:'Latest canonical title '+nonce,type:'movie',
      metadata:{description:'Latest search metadata'},
    });
    const changes=await Promise.all([
      flushPgPilotProjection({limit:1}),
      concurrent.flushPgPilotProjection({limit:5}),
    ]);
    assert.equal(changes.reduce((v,x)=>v+x.failed,0),0);
    const current=await pool.query(
      'SELECT title,metadata,revision FROM animaxia_pilot_search_projection WHERE externalid=$1',
      [ids[0]]);
    assert.equal(current.rows[0].title,'Latest canonical title '+nonce);
    assert.equal(current.rows[0].metadata.description,'Latest search metadata');
    assert.equal(current.rows[0].revision,'3');

    // Claim rollback emulates worker death before COMMIT, then another
    // worker can claim same durable event and successfully ACK.
    await upsertPgCatalogPilot({
      externalid:ids[2],title:'Reclaim after rollback '+nonce,type:'movie',
    });
    const lock=await pool.connect();
    try{
      await lock.query('BEGIN');
      const held=await lock.query(
        'SELECT eventid FROM animaxia_pilot_events WHERE externalid=$1 AND projection_applied_at IS NULL FOR UPDATE',
        [ids[2]]);
      assert.equal(held.rowCount,1);
      const skipped=await flushPgPilotProjection({limit:1});
      assert.equal(skipped.processed,0);
      await lock.query('ROLLBACK');
    }finally{lock.release();}
    const recovered=await flushPgPilotProjection({limit:5});
    assert.ok(recovered.processed>=1);
    const regained=await pool.query(
      'SELECT title FROM animaxia_pilot_search_projection WHERE externalid=$1',
      [ids[2]]);
    assert.equal(regained.rows[0].title,'Reclaim after rollback '+nonce);

    // A failed target write rolls back the projection and records retry
    // atomically; fixing the target permits eventual delivery.
    const blockTitle='PilotProjectionBlocked-'+nonce;
    await pool.query(
      'ALTER TABLE animaxia_pilot_search_projection ADD CONSTRAINT pilot_projection_ci_block '+
      "CHECK (title <> '"+blockTitle+"')"
    );
    constraintAdded=true;
    await upsertPgCatalogPilot({
      externalid:ids[3],title:blockTitle,type:'movie',
      metadata:{description:'Poison task for retry'},
    });
    const failure=await flushPgPilotProjection({limit:5});
    assert.equal(failure.failed,1);
    assert.equal(failure.updated,0,'Failed transactions are not successful updates');
    assert.equal(failure.deleted,0,'Failed transactions are not committed deletes');
    const retry=await pool.query(
      'SELECT projection_attempts,projection_next_run_at>NOW() AS delayed,projection_applied_at FROM animaxia_pilot_events WHERE externalid=$1 ORDER BY eventid DESC LIMIT 1',
      [ids[3]]);
    assert.equal(retry.rows[0].projection_attempts,1);
    assert.equal(retry.rows[0].delayed,true);
    assert.equal(retry.rows[0].projection_applied_at,null);
    assert.equal((await pool.query(
      'SELECT externalid FROM animaxia_pilot_search_projection WHERE externalid=$1',
      [ids[3]])).rowCount,0);
    await pool.query(
      'ALTER TABLE animaxia_pilot_search_projection DROP CONSTRAINT pilot_projection_ci_block');
    constraintAdded=false;
    await pool.query(
      'UPDATE animaxia_pilot_events SET projection_next_run_at=NOW() WHERE externalid=$1',
      [ids[3]]);
    const success=await flushPgPilotProjection({limit:5});
    assert.equal(success.failed,0);
    assert.equal(success.processed,1);
    assert.equal((await pool.query(
      'SELECT externalid FROM animaxia_pilot_search_projection WHERE externalid=$1',
      [ids[3]])).rowCount,1);

    // Delete and re-create same stable external ID: projection must use the
    // current native ID, not resurrect stale ID from old append-only events.
    const existing=await pool.query(
      'SELECT contentid::text AS id FROM animaxia_pilot_search_projection WHERE externalid=$1',
      [ids[1]]);
    assert.equal((await deletePgCatalogPilot(ids[1])).deleted,true);
    const deletion=await flushPgPilotProjection({limit:10});
    assert.equal(deletion.failed,0);
    assert.equal((await pool.query(
      'SELECT externalid FROM animaxia_pilot_search_projection WHERE externalid=$1',
      [ids[1]])).rowCount,0);
    const recreated=await upsertPgCatalogPilot({
      externalid:ids[1],title:'Recreated identity '+nonce,type:'tv',
    });
    assert.notEqual(String(recreated.data.id),existing.rows[0].id);
    assert.equal((await flushPgPilotProjection({limit:10})).failed,0);
    const refreshed=await pool.query(
      'SELECT contentid::text AS id,title FROM animaxia_pilot_search_projection WHERE externalid=$1',
      [ids[1]]);
    assert.equal(refreshed.rows[0].id,String(recreated.data.id));
    assert.equal(refreshed.rows[0].title,'Recreated identity '+nonce);
    assert.equal((await pgPilotProjectionStatus()).pending,0);

    // The next event is applied by a totally separate Node process:
    // no SQLite backend imports and no in-process manual flush.
    await upsertPgCatalogPilot({
      externalid:ids[2],title:'Standalone pilot projection '+nonce,
      type:'movie',metadata:{description:'Worker process canary'},
    });
    const child=spawn(process.execPath,['cli/postgres-pilot-projection-worker.mjs'],{
      cwd:process.cwd(),
      env:{
        ...process.env,ANIMAXIA_PG_CATALOG_PILOT:'true',
        ANIMAXIA_PG_PILOT_PROJECTION:'true',
        ANIMAXIA_PG_PILOT_PROJECTION_WORKER:'true',
      },
      stdio:['ignore','pipe','pipe'],
    });
    let stdout='',stderr='';
    child.stdout.on('data',data=>{stdout+=String(data);});
    child.stderr.on('data',data=>{stderr+=String(data);});
    const childExit=new Promise((resolve,reject)=>{
      child.once('error',reject);
      child.once('exit',(code,signal)=>resolve({code,signal}));
    });
    try{
      let ready=false;
      for(let attempt=0;attempt<48;attempt++){
        await new Promise(resolve=>setTimeout(resolve,250));
        const query=await pool.query(
          'SELECT title FROM animaxia_pilot_search_projection WHERE externalid=$1',
          [ids[2]]
        );
        if(query.rows[0]?.title==='Standalone pilot projection '+nonce){
          ready=true;break;
        }
      }
      assert.equal(ready,true,'Standalone pilot projector failed to deliver native event');
    }finally{
      child.kill('SIGTERM');
      const result=await childExit;
      assert.equal(result.code,0,'Standalone pilot projector exit: '+stderr);
    }
    assert.match(stdout,/PostgreSQL-only native pilot projection worker started/);
    assert.equal((await pgPilotProjectionStatus()).pending,0);
  }finally{await restore();}
});
