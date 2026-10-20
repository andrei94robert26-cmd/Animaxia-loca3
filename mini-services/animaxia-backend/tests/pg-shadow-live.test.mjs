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
