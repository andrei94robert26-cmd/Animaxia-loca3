/**
 * Real PostgreSQL 16 race regression: native catalog writers acquire the
 * SAME advisory transaction lock as pilot event projector.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import {
  setupPgCatalogPilot,upsertPgCatalogPilot,deletePgCatalogPilot,
  stopPgCatalogPilot,
} from '../modules/postgres/catalog-pilot.js';
import {
  setupPgPilotProjection,flushPgPilotProjection,stopPgPilotProjection,
} from '../modules/postgres/pilot-projection.js';
import {lockPgPilotExternalId} from '../modules/postgres/pilot-lock.js';

test('PG16 pilot writes/deletes wait for projector lock and eventually converge',async t=>{
  if(!process.env.ANIMAXIA_PG_SHADOW_DATABASE_URL){
    t.skip('Requires disposable PostgreSQL 16 CI service');return;
  }
  const previous={
    catalog:process.env.ANIMAXIA_PG_CATALOG_PILOT,
    projection:process.env.ANIMAXIA_PG_PILOT_PROJECTION,
  };
  process.env.ANIMAXIA_PG_CATALOG_PILOT='true';
  process.env.ANIMAXIA_PG_PILOT_PROJECTION='true';
  const pool=new pg.Pool({
    connectionString:process.env.ANIMAXIA_PG_SHADOW_DATABASE_URL,
    ssl:false,max:6,connectionTimeoutMillis:4000,
  });
  const key='stage22:lock:'+crypto.randomBytes(8).toString('hex');
  const other=key+':other';
  const locker=await pool.connect();
  let holding=false;
  try{
    await setupPgCatalogPilot();
    await setupPgPilotProjection();
    const old=await upsertPgCatalogPilot({
      externalid:key,title:'Previous title',type:'movie',
    });
    assert.equal((await flushPgPilotProjection({limit:10})).failed,0);

    await locker.query('BEGIN');
    holding=true;
    await lockPgPilotExternalId(locker,key);
    // The transaction-scoped lock simulates a projector reading an old
    // canonical snapshot while about to update the search model.
    const observed=await locker.query(
      'SELECT title FROM animaxia_pilot_catalog WHERE externalid=$1',[key]);
    assert.equal(observed.rows[0].title,'Previous title');
    let writeDone=false;
    const write=upsertPgCatalogPilot({
      externalid:key,title:'Latest after projector lock',type:'movie',
    }).then(row=>{writeDone=true;return row;});
    await new Promise(resolve=>setTimeout(resolve,150));
    assert.equal(writeDone,false,'Writer must block behind projector lock');

    // A different external ID must not be globally blocked.
    const parallel=await upsertPgCatalogPilot({
      externalid:other,title:'Independent title',type:'anime',
    });
    assert.equal(parallel.stored,true);
    await locker.query('COMMIT');
    holding=false;
    const changed=await write;
    assert.equal(changed.data.id,old.data.id);
    assert.equal(changed.data.revision,2);
    assert.equal((await flushPgPilotProjection({limit:10})).failed,0);
    const current=await pool.query(
      'SELECT title,revision FROM animaxia_pilot_search_projection WHERE externalid=$1',[key]);
    assert.equal(current.rows[0].title,'Latest after projector lock');
    assert.equal(current.rows[0].revision,'2');

    // A delete must also wait, otherwise the projector could resurrect
    // a deleted row by committing a stale snapshot after DELETE.
    await locker.query('BEGIN');
    holding=true;
    await lockPgPilotExternalId(locker,key);
    let deleteDone=false;
    const remove=deletePgCatalogPilot(key).then(row=>{deleteDone=true;return row;});
    await new Promise(resolve=>setTimeout(resolve,150));
    assert.equal(deleteDone,false,'DELETE must wait for projector lock');
    await locker.query('COMMIT');
    holding=false;
    assert.equal((await remove).deleted,true);
    assert.equal((await flushPgPilotProjection({limit:10})).failed,0);
    assert.equal((await pool.query(
      'SELECT externalid FROM animaxia_pilot_search_projection WHERE externalid=$1',[key]
    )).rowCount,0);
  }finally{
    if(holding)try{await locker.query('ROLLBACK');}catch{/* detached */}
    locker.release();
    for(const name of [key,other]){
      await pool.query('DELETE FROM animaxia_pilot_events WHERE externalid=$1',[name]);
      await pool.query('DELETE FROM animaxia_pilot_search_projection WHERE externalid=$1',[name]);
      await pool.query('DELETE FROM animaxia_pilot_catalog WHERE externalid=$1',[name]);
    }
    await stopPgPilotProjection();await stopPgCatalogPilot();await pool.end();
    for(const [k,v] of Object.entries({
      ANIMAXIA_PG_CATALOG_PILOT:previous.catalog,
      ANIMAXIA_PG_PILOT_PROJECTION:previous.projection,
    })){
      if(v===undefined)delete process.env[k];else process.env[k]=v;
    }
  }
});
