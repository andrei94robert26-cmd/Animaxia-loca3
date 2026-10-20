import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { initDb,upsertContent,deleteContent } from '../db.js';
import { localDb } from '../modules/local/sqlite.js';
import { ensurePgShadowOutbox,pgShadowPending,pgShadowAck } from '../modules/postgres/shadow-outbox.js';
import { projectPgShadow } from '../modules/postgres/shadow.js';
import { verifyPgShadow } from '../modules/postgres/shadow-verify.js';

test('PostgreSQL integrity audit rejects invalid cursors and unsupported repair mode',async()=>{
  await assert.rejects(verifyPgShadow({afterId:-1}),/afterId/);
  await assert.rejects(verifyPgShadow({limit:100}),/limit/);
  await assert.rejects(verifyPgShadow({dryRun:'false'}),/dryRun/);
});
test('PostgreSQL dry-run audit cannot write; explicit repair never replaces pending revisions',async()=>{
  const original=process.env.ANIMAXIA_PG_SHADOW_DATABASE_URL;
  process.env.ANIMAXIA_PG_SHADOW_DATABASE_URL='postgresql://ci:example@pg.example.test/catalog';
  const nonce=crypto.randomBytes(7).toString('hex');
  let id=null;
  try{
    await initDb();ensurePgShadowOutbox();
    const record=await upsertContent({
      externalid:'pg-verify-'+nonce,title:'PG verify '+nonce,
      type:'movie',metadata:{actors:['Verified Actor']},
    });
    id=record.record.id;
    let job=pgShadowPending(100).find(x=>x.contentid===id);
    assert.ok(job);
    assert.equal(pgShadowAck(job),1);
    const expected=projectPgShadow(localDb.prepare('SELECT * FROM Content WHERE id=?').get(id));
    const fakeDb={query:async(sql,params)=>{
      assert.ok(sql.includes('WHERE id = ANY($1::bigint[])'));
      assert.deepEqual(params,[[String(id)]]);
      return {rows:[{...expected,id:String(id),title:'Stale replica title'}]};
    }};
    const opts={afterId:id-1,limit:1};
    const dry=await verifyPgShadow(opts,{db:fakeDb});
    assert.equal(dry.scanned,1);
    assert.equal(dry.mismatched,1);
    assert.equal(dry.repairQueued,0);
    assert.equal(pgShadowPending(100).find(x=>x.contentid===id),undefined);
    const fixed=await verifyPgShadow({...opts,dryRun:false},{db:fakeDb});
    assert.equal(fixed.repairQueued,1);
    job=pgShadowPending(100).find(x=>x.contentid===id);
    assert.ok(job);
    assert.equal(job.operation,'upsert');
    const again=await verifyPgShadow({...opts,dryRun:false},{db:fakeDb});
    assert.equal(again.repairQueued,0);
    assert.equal(again.alreadyPendingOrMissing,1);
    assert.equal(pgShadowPending(100).find(x=>x.contentid===id).revision,job.revision);
    const badDb={query:async()=>({rows:[{id:'99999999999',title:'Unexpected'}]})};
    await assert.rejects(verifyPgShadow({...opts,dryRun:false},{db:badDb}),/Unexpected/);
    assert.equal(pgShadowPending(100).find(x=>x.contentid===id).revision,job.revision);
    const empty=await verifyPgShadow({afterId:id,limit:2},{db:fakeDb});
    assert.equal(empty.scanned,0);
    assert.equal(empty.finished,true);
  }finally{
    if(id!==null){
      await deleteContent(id);
      localDb.prepare('DELETE FROM pg_shadow_outbox WHERE contentid=?').run(id);
    }
    if(original===undefined)delete process.env.ANIMAXIA_PG_SHADOW_DATABASE_URL;
    else process.env.ANIMAXIA_PG_SHADOW_DATABASE_URL=original;
  }
});
