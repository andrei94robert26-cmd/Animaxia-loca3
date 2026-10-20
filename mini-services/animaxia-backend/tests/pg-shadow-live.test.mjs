/**
 * REAL PostgreSQL integration. GitHub Actions runs postgres:16 as service.
 * No mocks: verifies CREATE TABLE, JSONB, upsert/update/delete and reconciliation.
 * Run with ANIMAXIA_PG_SHADOW_DATABASE_URL set to a disposable test database.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { initDb,upsertContent,deleteContent,countContent } from '../db.js';
import { localDb } from '../modules/local/sqlite.js';
import { pgShadowOutboxStatus,seedPgShadowOutbox } from '../modules/postgres/shadow-outbox.js';
import { readPgShadowCatalog } from '../modules/postgres/shadow-read.js';
import { verifyPgShadow } from '../modules/postgres/shadow-verify.js';
import {
  setupPgShadow,flushPgShadow,comparePgShadow,stopPgShadowWorker,
} from '../modules/postgres/shadow.js';

test('live PostgreSQL 16 shadow: schema, backfill, update, delete and JSONB projection',async(t)=>{
  if(!process.env.ANIMAXIA_PG_SHADOW_DATABASE_URL) {
    t.skip('Requires disposable PostgreSQL CI service');
    return;
  }
  const { Pool }=pg;
  const db=new Pool({
    connectionString:process.env.ANIMAXIA_PG_SHADOW_DATABASE_URL,
    ssl:false,max:2,connectionTimeoutMillis:4000,
  });
  const nonce=crypto.randomBytes(6).toString('hex');
  let id=null;
  try {
    await initDb();
    const setup=await setupPgShadow(); // real network call (no query mocks)
    assert.equal(setup.schemaVersion,1);
    const initial=await upsertContent({
      externalid:'pg-live-'+nonce,title:'PG live movie '+nonce,
      type:'movie',
      metadata:{year:2026,actors:['Postgres CI Actor'],
        overview:'Live SQL JSONB projection test',rating:8.3,
        player:{sources:[{url:'https://media.example.invalid/private.mp4',type:'mp4'}]},
        privateSecret:'do-not-copy'},
    });
    id=initial.record.id;
    // Bounded keyset backfill of catalog existing before outbox installation.
    let afterId=0;
    for(let n=0;n<30;n++){
      const page=seedPgShadowOutbox({afterId,limit:200});
      if(page.finished)break;
      assert.ok(page.nextAfterId>afterId);
      afterId=page.nextAfterId;
      if(n===29)assert.fail('Catalog too large for this isolated smoke test');
    }
    for(let n=0;n<80&&pgShadowOutboxStatus().pending>0;n++){
      const result=await flushPgShadow({limit:100});
      assert.equal(result.failed,0,'Real PG sync failed');
    }
    assert.equal(pgShadowOutboxStatus().pending,0);
    let remote=await db.query('SELECT * FROM animaxia_shadow_content WHERE id=$1',[id]);
    assert.equal(remote.rowCount,1);
    assert.equal(remote.rows[0].title,'PG live movie '+nonce);
    assert.deepEqual(remote.rows[0].metadata.actors,['Postgres CI Actor']);
    assert.equal(remote.rows[0].metadata.rating,8.3);
    assert.equal(JSON.stringify(remote.rows[0]).includes('private.mp4'),false);
    assert.equal(JSON.stringify(remote.rows[0]).includes('do-not-copy'),false);
    const aligned=await comparePgShadow();
    assert.equal(aligned.localCount,await countContent());
    assert.equal(aligned.remoteCount,aligned.localCount);
    assert.equal(aligned.pending,0);
    assert.equal(aligned.countsAligned,true);

    // Real database drift: alter PG row outside the SQLite write path,
    // detect mismatch, queue repair without mutation, then restore it.
    const auditPage={afterId:id-1,limit:1};
    const cleanAudit=await verifyPgShadow(auditPage);
    assert.equal(cleanAudit.matched,1);
    assert.equal(cleanAudit.repairQueued,0);
    await db.query('UPDATE animaxia_shadow_content SET title=$1 WHERE id=$2',
      ['Remote drift that should be repaired',id]);
    const drift=await verifyPgShadow(auditPage);
    assert.equal(drift.mismatched,1);
    assert.equal(drift.repairQueued,0);
    const repair=await verifyPgShadow({...auditPage,dryRun:false});
    assert.equal(repair.repairQueued,1);
    const replicated=await flushPgShadow();
    assert.equal(replicated.failed,0);
    assert.equal((await verifyPgShadow(auditPage)).matched,1);
    assert.equal((await verifyPgShadow(auditPage)).mismatched,0);

    // LIVE PostgreSQL 16 read path, with GIN FTS, JSONB filters and keysets.
    const paged=[];const lookupExternalIds=[];
    try{
      for(let i=0;i<3;i++){
        const item=await upsertContent({
          externalid:'pg-read-'+nonce+'-'+i,
          title:'CanaryStageSixteen '+nonce+' test '+i,
          type:i===2?'tv':'movie',
          metadata:{year:2026,overview:'A catalog migration search test',
            actors:i<2?['Admin QA Actor']:['Other'],
            genres:['Adventure'],studios:['Stage16 Studio'],
            franchise:'Migration Franchise',rating:8},
        });
        lookupExternalIds.push(item.record.id);
      }
      const queued=await flushPgShadow({limit:40});
      assert.equal(queued.failed,0);
      const first=await readPgShadowCatalog({
        q:'CanaryStageSixteen',category:'filme',year:'2026',
        actor:'QA Actor',genre:'Adventure',studio:'Stage16',limit:1,
      });
      assert.equal(first.data.length,1);
      assert.equal(first.hasMore,true);
      assert.ok(first.nextCursor);
      assert.equal(first.data[0].type,'movie');
      assert.equal(first.data[0].metadata.franchise,'Migration Franchise');
      const second=await readPgShadowCatalog({
        q:'CanaryStageSixteen',category:'filme',year:'2026',
        actor:'QA Actor',genre:'Adventure',studio:'Stage16',limit:1,
        cursor:first.nextCursor,
      });
      assert.equal(second.data.length,1);
      assert.equal(second.hasMore,false);
      assert.ok(first.data[0].id>second.data[0].id);
      assert.ok(!second.data.some((v)=>v.type==='tv'));
      await assert.rejects(readPgShadowCatalog({
        q:'Different',category:'filme',year:'2026',
        actor:'QA Actor',genre:'Adventure',studio:'Stage16',
        cursor:first.nextCursor,
      }),/cursor/);
    }finally{
      for(const recId of lookupExternalIds)await deleteContent(recId);
      const clean=await flushPgShadow({limit:100});
      assert.equal(clean.failed,0);
    }

    await upsertContent({
      externalid:'pg-live-'+nonce,title:'PG live movie UPDATED '+nonce,
      type:'movie',metadata:{actors:['New PG Actor'],overview:'Updated projection'},
    });
    assert.ok(pgShadowOutboxStatus().pending>0);
    assert.equal((await flushPgShadow()).failed,0);
    remote=await db.query('SELECT * FROM animaxia_shadow_content WHERE id=$1',[id]);
    assert.equal(remote.rows[0].title,'PG live movie UPDATED '+nonce);
    assert.deepEqual(remote.rows[0].metadata.actors,['New PG Actor']);

    await deleteContent(id);
    assert.ok(pgShadowOutboxStatus().pending>0);
    assert.equal((await flushPgShadow()).failed,0);
    remote=await db.query('SELECT id FROM animaxia_shadow_content WHERE id=$1',[id]);
    assert.equal(remote.rowCount,0);
    id=null;
    assert.equal((await comparePgShadow()).countsAligned,true);
  }finally{
    if(id!==null){
      await deleteContent(id);
      localDb.prepare('DELETE FROM pg_shadow_outbox WHERE contentid=?').run(id);
    }
    await stopPgShadowWorker();
    await db.end();
  }
});
