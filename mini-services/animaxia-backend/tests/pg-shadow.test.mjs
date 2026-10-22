import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import { initDb,upsertContent,deleteContent,getContentById } from '../db.js';
import { localDb } from '../modules/local/sqlite.js';
import {
  ensurePgShadowOutbox,pgShadowPending,pgShadowAck,
  pgShadowRetry,pgShadowOutboxStatus,seedPgShadowOutbox,
} from '../modules/postgres/shadow-outbox.js';
import {
  pgShadowConfig,projectPgShadow,setupPgShadow,flushPgShadow,
  comparePgShadow,pgShadowStatus,
} from '../modules/postgres/shadow.js';
import routes from '../modules/postgres/routes.js';

const envNames=['ANIMAXIA_PG_SHADOW_DATABASE_URL',
  'ANIMAXIA_PG_SHADOW_TLS','ANIMAXIA_PG_SHADOW_WORKER','NODE_ENV'];
const restore=(saved)=>{
  for(const [key,value] of Object.entries(saved)){
    if(value===undefined)delete process.env[key];else process.env[key]=value;
  }
};
test('PostgreSQL shadow is opt-in, TLS-configured and rejects unsafe connections',()=>{
  assert.equal(pgShadowConfig({}).configured,false);
  for(const url of ['http://host/db','postgresql://host/db',
    'postgresql://user:pass@host/','postgresql://user:pass@host/db?sslmode=disable']) {
    assert.throws(()=>pgShadowConfig({ANIMAXIA_PG_SHADOW_DATABASE_URL:url}),/PostgreSQL shadow URL/);
  }
  const secret='postgresql://ci:secret@pg.example.test:5432/catalog';
  const config=pgShadowConfig({ANIMAXIA_PG_SHADOW_DATABASE_URL:secret,
    NODE_ENV:'production'});
  assert.equal(config.configured,true);
  assert.equal(config.tls,true);
  assert.equal(config.host,'pg.example.test');
  assert.equal(JSON.stringify(config).includes('secret'),false);
  assert.throws(()=>pgShadowConfig({
    ANIMAXIA_PG_SHADOW_DATABASE_URL:secret,ANIMAXIA_PG_SHADOW_TLS:'false',
    NODE_ENV:'production',
  }),/TLS/);
  assert.equal(pgShadowConfig({
    ANIMAXIA_PG_SHADOW_DATABASE_URL:'postgresql://ci:local@127.0.0.1/test',
    ANIMAXIA_PG_SHADOW_TLS:'false',NODE_ENV:'test',
  }).tls,false);
});
test('durable PostgreSQL shadow outbox, replay, revision safety and API protection',async()=>{
  const saved=Object.fromEntries(envNames.map((k)=>[k,process.env[k]]));
  process.env.ANIMAXIA_PG_SHADOW_DATABASE_URL='postgresql://ci:secret@pg.example.test:5432/catalog';
  delete process.env.ANIMAXIA_PG_SHADOW_WORKER;
  delete process.env.NODE_ENV;
  const nonce=crypto.randomBytes(6).toString('hex');
  let id=null;
  try{
    await initDb();
    ensurePgShadowOutbox();
    const calls=[];
    let failNext=false;
    let raceOnce=false;
    const db={query:async(sql,params=[])=>{
      calls.push({sql,params});
      if(failNext&&sql.includes('INSERT INTO animaxia_shadow_content')){
        failNext=false;throw new Error('Simulated PostgreSQL outage');
      }
      if(raceOnce&&sql.includes('INSERT INTO animaxia_shadow_content')){
        raceOnce=false;
        localDb.prepare('UPDATE Content SET title=? WHERE id=?')
          .run('Updated while PG request in progress '+nonce,id);
      }
      if(sql.includes('COUNT(*)::text')){
        return {rows:[{count:'123'}]};
      }
      return {rowCount:1,rows:[]};
    }};
    const setup=await setupPgShadow({db});
    assert.equal(setup.replicaRole,'shadow');
    assert.ok(calls.some((c)=>c.sql.includes('metadata JSONB')));
    assert.ok(calls.some((c)=>c.sql.includes('USING GIN')));
    const result=await upsertContent({
      externalid:'pg-shadow-ci-'+nonce,type:'movie',
      title:'PostgreSQL Mirror '+nonce,
      metadata:{actors:['Actor CI'],overview:'Adventure',rating:7,
        player:{sources:[{url:'https://private.example/video.m3u8',type:'m3u8'}]},
        secretToken:'do-not-copy'},
    });
    id=result.record.id;
    const projected=projectPgShadow(localDb.prepare('SELECT * FROM Content WHERE id=?').get(id));
    assert.equal(projected.type,'movie');
    assert.deepEqual(projected.metadata.actors,['Actor CI']);
    assert.equal(JSON.stringify(projected).includes('video.m3u8'),false);
    assert.equal(JSON.stringify(projected).includes('do-not-copy'),false);
    let job=pgShadowPending(100).find((r)=>r.contentid===id);
    assert.ok(job);
    assert.equal(job.operation,'upsert');
    const seeded=seedPgShadowOutbox({afterId:id-1,limit:1});
    assert.equal(seeded.scanned,1);
    assert.equal(pgShadowPending(100).find((r)=>r.contentid===id).revision,job.revision);

    failNext=true;
    const unsuccessful=await flushPgShadow({db});
    assert.ok(unsuccessful.failed>=1);
    assert.equal(pgShadowPending(100).find((r)=>r.contentid===id),undefined);
    assert.equal(pgShadowOutboxStatus().pending>=1,true);
    localDb.prepare('UPDATE pg_shadow_outbox SET nextattemptat=0 WHERE contentid=?').run(id);
    const old=pgShadowPending(100).find((r)=>r.contentid===id);
    raceOnce=true;
    const raced=await flushPgShadow({db});
    assert.ok(raced.processed>=0);
    const stillPending=pgShadowPending(100).find((r)=>r.contentid===id);
    assert.ok(stillPending);
    assert.ok(stillPending.revision>old.revision);
    assert.equal(pgShadowAck(old),0);
    const replay=await flushPgShadow({db});
    assert.ok(replay.processed>=1);
    assert.equal(pgShadowPending(100).find((r)=>r.contentid===id),undefined);
    const writes=calls.filter((c)=>c.sql.includes('INSERT INTO animaxia_shadow_content'));
    assert.ok(writes.length>=3);
    assert.ok(writes.some((c)=>c.params[2].startsWith('Updated while PG')));
    assert.ok(writes.every((c)=>!JSON.stringify(c.params).includes('private.example')));

    const comparison=await comparePgShadow({db});
    assert.equal(comparison.remoteCount,123);
    assert.equal(comparison.countsAligned,false);
    assert.equal(pgShadowStatus().authoritative,'sqlite');

    const serverApp=express();
    serverApp.use(express.json());
    serverApp.use('/api/migration/postgres',routes);
    const server=serverApp.listen(0,'127.0.0.1');
    await new Promise((resolve)=>server.listening?resolve():server.once('listening',resolve));
    try{
      const res=await fetch('http://127.0.0.1:'+server.address().port+
        '/api/migration/postgres/status');
      assert.equal(res.status,401);
    }finally{await new Promise((resolve)=>server.close(resolve));}

    await deleteContent(id);
    const gone=pgShadowPending(100).find((r)=>r.contentid===id);
    assert.equal(gone.operation,'delete');
    assert.equal(gone.document,null);
    const deleted=await flushPgShadow({db});
    assert.ok(deleted.processed>=1);
    assert.ok(calls.some((c)=>c.sql.includes('DELETE FROM animaxia_shadow_content') &&
      c.params[0]===id));
    id=null;
    assert.throws(()=>seedPgShadowOutbox({limit:1001}),/limit/);
    assert.throws(()=>pgShadowPending(101),/limit/);
  }finally{
    if(id!=null)await deleteContent(id);
    if(id!=null)localDb.prepare('DELETE FROM pg_shadow_outbox WHERE contentid=?').run(id);
    restore(saved);
  }
});
