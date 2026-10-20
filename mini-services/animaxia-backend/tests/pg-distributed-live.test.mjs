/** Live PostgreSQL concurrency test: multiple workers, no duplicate task claims. */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import pg from 'pg';
import {initDb,upsertContent,deleteContent} from '../db.js';
import {localDb} from '../modules/local/sqlite.js';
import {setupPgShadow,stopPgShadowWorker} from '../modules/postgres/shadow.js';
import {setupDistributedShadow,stageDistributedShadow,workDistributedShadow,
  distributedShadowStatus} from '../modules/postgres/distributed-shadow.js';

test('PostgreSQL 16 queue: feeder, SKIP LOCKED concurrency, retry, snapshot refresh',async(t)=>{
  if(!process.env.ANIMAXIA_PG_SHADOW_DATABASE_URL){
    t.skip('Requires ephemeral PostgreSQL CI service');return;
  }
  const prior={
    ANIMAXIA_PG_DISTRIBUTED_BRIDGE:process.env.ANIMAXIA_PG_DISTRIBUTED_BRIDGE,
    ANIMAXIA_PG_SHADOW_WORKER:process.env.ANIMAXIA_PG_SHADOW_WORKER,
  };
  delete process.env.ANIMAXIA_PG_SHADOW_WORKER;
  process.env.ANIMAXIA_PG_DISTRIBUTED_BRIDGE='true';
  const db=new pg.Pool({
    connectionString:process.env.ANIMAXIA_PG_SHADOW_DATABASE_URL,
    ssl:false,max:5,
  });
  const nonce=crypto.randomBytes(6).toString('hex');
  const records=[];
  try{
    await initDb();
    await setupPgShadow();
    await setupDistributedShadow();
    assert.equal((await distributedShadowStatus()).configured,true);
    assert.equal((await distributedShadowStatus()).distributed,true);
    for(let i=0;i<8;i++){
      const added=await upsertContent({
        externalid:'pg-distributed-'+nonce+'-'+i,
        title:'Distributed Test '+nonce+' '+i,type:i%2?'tv':'movie',
        metadata:{overview:'Durable PostgreSQL distributed metadata',
          actors:['Worker CI'],sourceAttribution:'Testing',
          privateKey:'do not mirror',
          player:{sources:[{url:'https://secret.invalid/private.m3u8'}]}},
      });
      records.push(added.record.id);
    }
    const staged=await stageDistributedShadow({limit:100});
    assert.ok(staged.staged>=8);
    assert.equal(staged.failed,0);
    assert.equal(staged.pendingLocal,0);

    // A separate JS module instance simulates an independently running PG
    // worker process; both share only their PostgreSQL task table.
    const independent=await import('../modules/postgres/distributed-pg-worker.js?ci-worker=2');
    const [workerA,workerB]=await Promise.all([
      workDistributedShadow({limit:40}),
      independent.workDistributedShadow({limit:40}),
    ]);
    assert.equal(workerA.failed+workerB.failed,0);
    assert.equal(workerA.processed+workerB.processed,staged.staged);
    const entries=await db.query(
      'SELECT id::text,title,metadata FROM animaxia_shadow_content WHERE id=ANY($1::bigint[])',
      [records.map(String)]);
    assert.equal(entries.rows.length,8);
    assert.ok(entries.rows.every(v=>!JSON.stringify(v).includes('private.m3u8')));
    assert.ok(entries.rows.every(v=>!JSON.stringify(v).includes('do not mirror')));
    let tasks=await db.query('SELECT contentid FROM animaxia_shadow_tasks');
    assert.equal(tasks.rowCount,0);

    // A job claimed by a different transaction is SKIPPED, not duplicated.
    // Rolling back a crashed claimant makes it available again.
    await upsertContent({
      externalid:'pg-distributed-'+nonce+'-3',
      title:'Locked task recovery '+nonce,type:'tv',
      metadata:{actors:['Recovery CI']},
    });
    assert.ok((await stageDistributedShadow({limit:10})).staged>=1);
    const lockClient=await db.connect();
    try{
      await lockClient.query('BEGIN');
      const hold=await lockClient.query(
        'SELECT contentid FROM animaxia_shadow_tasks WHERE contentid=$1 FOR UPDATE',
        [records[3]]);
      assert.equal(hold.rowCount,1);
      const skipping=await workDistributedShadow({limit:1});
      assert.equal(skipping.processed,0,'A locked task must not be claimed twice');
      assert.equal(skipping.failed,0);
      await lockClient.query('ROLLBACK'); // simulate crash before commit
    }finally{lockClient.release();}
    const recovery=await workDistributedShadow({limit:1});
    assert.equal(recovery.processed,1,'Rolled-back task should be claimable again');
    assert.equal((await db.query(
      'SELECT title FROM animaxia_shadow_content WHERE id=$1',[records[3]]
    )).rows[0].title,'Locked task recovery '+nonce);

    // PostgreSQL transactional claim failure must preserve the task and
    // assign backoff atomically; no competing worker acknowledges it.
    const poison=records[0];
    await db.query(`
      INSERT INTO animaxia_shadow_tasks(contentid,operation,document)
      VALUES($1,'upsert','{}'::jsonb)
    `,[poison]);
    const broken=await workDistributedShadow({limit:1});
    assert.equal(broken.failed,1);
    let stuck=await db.query(
      'SELECT attempts,next_run_at>NOW() AS later FROM animaxia_shadow_tasks WHERE contentid=$1',
      [poison]);
    assert.equal(stuck.rows[0].attempts,1);
    assert.equal(stuck.rows[0].later,true);
    // Refresh the poison row with the latest authoritative snapshot.
    await upsertContent({
      externalid:'pg-distributed-'+nonce+'-0',
      title:'Distributed Updated '+nonce,type:'movie',
      metadata:{actors:['Updated Worker'],overview:'No stale catalog allowed'},
    });
    const queued=await stageDistributedShadow({limit:100});
    assert.ok(queued.staged>=1);
    const retry=await workDistributedShadow({limit:10});
    assert.equal(retry.failed,0);
    assert.ok(retry.processed>=1);
    const updated=await db.query(
      'SELECT title,metadata FROM animaxia_shadow_content WHERE id=$1',[poison]);
    assert.equal(updated.rows[0].title,'Distributed Updated '+nonce);
    assert.deepEqual(updated.rows[0].metadata.actors,['Updated Worker']);

    // Canonical delete is carried through PG tasks, not applied directly
    // by the feeder. PG workers replay the deletion transactionally.
    await deleteContent(records[1]);
    const deleted=await stageDistributedShadow({limit:100});
    assert.ok(deleted.staged>=1);
    assert.equal((await workDistributedShadow({limit:10})).failed,0);
    assert.equal((await db.query(
      'SELECT id FROM animaxia_shadow_content WHERE id=$1',[records[1]]
    )).rowCount,0);

    // A completely separate Node process uses ONLY PostgreSQL and applies
    // queued tasks. No SQLite Content import or shared SQLite volume needed.
    await upsertContent({
      externalid:'pg-distributed-'+nonce+'-2',
      title:'Applied by standalone PG worker '+nonce,
      type:'movie',metadata:{actors:['Standalone Worker']},
    });
    assert.ok((await stageDistributedShadow({limit:100})).staged>=1);
    const child=spawn(process.execPath,['cli/postgres-shadow-worker.mjs'],{
      cwd:process.cwd(),
      env:{...process.env,ANIMAXIA_PG_DISTRIBUTED_WORKER:'true',
        ANIMAXIA_PG_DISTRIBUTED_BRIDGE:'false'},
      stdio:['ignore','pipe','pipe'],
    });
    let stdout='',stderr='';
    child.stdout.on('data',chunk=>{stdout+=chunk.toString();});
    child.stderr.on('data',chunk=>{stderr+=chunk.toString();});
    const childExit=new Promise((resolve,reject)=>{
      child.once('error',reject);
      child.once('exit',(code,signal)=>resolve({code,signal}));
    });
    try{
      let complete=false;
      for(let attempt=0;attempt<48;attempt++){
        await new Promise(resolve=>setTimeout(resolve,250));
        const check=await db.query(
          'SELECT title FROM animaxia_shadow_content WHERE id=$1',[records[2]]);
        if(check.rows[0]?.title==='Applied by standalone PG worker '+nonce){
          complete=true;break;
        }
      }
      assert.equal(complete,true,'Standalone PostgreSQL-only process did not apply queued job');
    }finally{
      child.kill('SIGTERM');
      const exit=await childExit;
      assert.equal(exit.code,0,'Standalone worker exit: '+stderr);
    }
    assert.match(stdout,/PostgreSQL-only worker started/);
  }finally{
    for(const id of records){
      try{await deleteContent(id);}catch{/* already deleted */}
    }
    // Fully clean disposable CI PostgreSQL shadow records and jobs.
    await db.query('DELETE FROM animaxia_shadow_tasks WHERE contentid=ANY($1::bigint[])',
      [records.map(String)]);
    await db.query('DELETE FROM animaxia_shadow_content WHERE id=ANY($1::bigint[])',
      [records.map(String)]);
    for(const id of records)localDb.prepare(
      'DELETE FROM pg_shadow_outbox WHERE contentid=?').run(id);
    for(const [k,v] of Object.entries(prior)){
      if(v===undefined)delete process.env[k];else process.env[k]=v;
    }
    await stopPgShadowWorker(); await db.end();
  }
});
