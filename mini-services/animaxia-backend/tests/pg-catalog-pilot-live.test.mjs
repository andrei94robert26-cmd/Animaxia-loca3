/** Real PostgreSQL 16: native catalog CRUD + atomic event log + FTS. */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import {
  setupPgCatalogPilot,upsertPgCatalogPilot,deletePgCatalogPilot,
  listPgCatalogPilot,pgCatalogPilotStatus,stopPgCatalogPilot,
} from '../modules/postgres/catalog-pilot.js';

test('PostgreSQL native catalog pilot: writes, concurrent upsert, rollback and FTS',async t=>{
  if(!process.env.ANIMAXIA_PG_SHADOW_DATABASE_URL){
    t.skip('Needs PostgreSQL 16 CI service');return;
  }
  const old=process.env.ANIMAXIA_PG_CATALOG_PILOT;
  process.env.ANIMAXIA_PG_CATALOG_PILOT='true';
  const pool=new pg.Pool({
    connectionString:process.env.ANIMAXIA_PG_SHADOW_DATABASE_URL,
    ssl:false,max:6,
  });
  const nonce=crypto.randomBytes(8).toString('hex');
  const prefix='pilot-ci:'+nonce+':';
  const first=prefix+'movie:1';
  const second=prefix+'movie:2';
  const third=prefix+'tv:3';
  const blocked=prefix+'blocked';
  let constraintAdded=false;
  try{
    const setup=await setupPgCatalogPilot();
    assert.equal(setup.authoritativeForPublicCatalog,false);
    const item={
      externalid:first,title:'PilotStageEighteen Alpha '+nonce,
      type:'movie',year:2026,
      metadata:{
        description:'Native PostgreSQL catalog search canary',
        actors:['Real PG Actor'],genres:['Adventure'],
        rating:7.1,sourceAttribution:'CI',
        player:{sources:[{url:'https://example.invalid/secret.mp4'}]},
        secretKey:'DO_NOT_COPY',
      },
    };
    const inserted=await upsertPgCatalogPilot(item);
    const id=inserted.data.id;
    assert.ok(id>0);
    assert.equal(inserted.data.revision,1);
    assert.equal(inserted.publicCatalogUnchanged,true);
    assert.equal(inserted.data.metadata.actors[0],'Real PG Actor');
    assert.ok(!JSON.stringify(inserted).includes('secret.mp4'));
    assert.ok(!JSON.stringify(inserted).includes('DO_NOT_COPY'));

    const updated=await upsertPgCatalogPilot({
      ...item,title:'PilotStageEighteen Updated '+nonce,
      metadata:{actors:['New Person'],genres:['Science Fiction'],rating:8.9},
    });
    assert.equal(updated.data.id,id);
    assert.equal(updated.data.revision,2);
    const simultaneous=await Promise.all(
      Array.from({length:8},(_,i)=>upsertPgCatalogPilot({
        ...item,title:'PilotStageEighteen Parallel '+i+' '+nonce,
      }))
    );
    assert.ok(simultaneous.every(row=>row.data.id===id));
    const dbrow=await pool.query(
      'SELECT COUNT(*)::integer AS count,MAX(revision)::integer AS revision '+
      'FROM animaxia_pilot_catalog WHERE externalid=$1',[first]);
    assert.equal(dbrow.rows[0].count,1);
    assert.equal(dbrow.rows[0].revision,10);

    const created=await Promise.all([
      upsertPgCatalogPilot({
        externalid:second,title:'PilotStageEighteen Beta '+nonce,
        type:'movie',year:2026,metadata:{actors:['Search CI'],description:'Canary explorer'},
      }),
      upsertPgCatalogPilot({
        externalid:third,title:'PilotStageEighteen Series '+nonce,
        type:'tv',year:2026,metadata:{actors:['Search CI']},
      }),
    ]);
    assert.equal(created.length,2);
    const listed=await listPgCatalogPilot({
      q:'PilotStageEighteen',type:'movie',year:'2026',limit:'1',
    });
    assert.equal(listed.data.length,1);
    assert.equal(listed.hasMore,true);
    assert.ok(Number.isSafeInteger(listed.nextAfterId));
    const following=await listPgCatalogPilot({
      q:'PilotStageEighteen',type:'movie',year:'2026',limit:'1',
      afterId:String(listed.nextAfterId),
    });
    assert.equal(following.data.length,1);
    assert.equal(following.hasMore,false);
    assert.notEqual(listed.data[0].externalid,following.data[0].externalid);
    assert.ok([listed.data[0].externalid,following.data[0].externalid].every(
      v=>[first,second].includes(v)));
    assert.equal((await listPgCatalogPilot({
      q:'PilotStageEighteen',type:'tv',year:'2026',
    })).data.length,1);

    const allEvents=await pool.query(
      'SELECT operation,revision FROM animaxia_pilot_events WHERE externalid=$1 ORDER BY eventid',
      [first]);
    assert.equal(allEvents.rowCount,10);
    assert.equal(allEvents.rows[0].revision,'1');
    assert.equal(allEvents.rows.at(-1).revision,'10');
    assert.ok(allEvents.rows.every(row=>row.operation==='upsert'));

    // Verify that if the audit event cannot be saved, the UPSERT is
    // rolled back: PostgreSQL never exposes a change without its event.
    await pool.query(
      'ALTER TABLE animaxia_pilot_events ADD CONSTRAINT pilot_ci_block_event '+
      'CHECK (externalid <> $1)',[blocked]
    ).catch(async()=>{
      // PostgreSQL does not accept prepared parameters in DDL expressions.
      // The value below is generated hex and has no untrusted characters.
      await pool.query(
        "ALTER TABLE animaxia_pilot_events ADD CONSTRAINT pilot_ci_block_event "+
        "CHECK (externalid <> '"+blocked+"')"
      );
    });
    constraintAdded=true;
    await assert.rejects(upsertPgCatalogPilot({
      externalid:blocked,title:'Should Roll Back',type:'movie',
      metadata:{description:'blocked transaction'},
    }));
    assert.equal((await pool.query(
      'SELECT id FROM animaxia_pilot_catalog WHERE externalid=$1',[blocked]
    )).rowCount,0);

    const deleted=await deletePgCatalogPilot(first);
    assert.equal(deleted.deleted,true);
    assert.equal((await deletePgCatalogPilot(first)).deleted,false);
    const log=await pool.query(
      'SELECT operation FROM animaxia_pilot_events WHERE externalid=$1 ORDER BY eventid DESC LIMIT 1',
      [first]);
    assert.equal(log.rows[0].operation,'delete');
    assert.equal((await listPgCatalogPilot({type:'movie',q:'PilotStageEighteen'}))
      .data.some(v=>v.externalid===first),false);

    const status=await pgCatalogPilotStatus();
    assert.equal(status.enabled,true);
    assert.ok(status.events>=13);
  }finally{
    if(constraintAdded)await pool.query(
      'ALTER TABLE animaxia_pilot_events DROP CONSTRAINT IF EXISTS pilot_ci_block_event');
    await pool.query('DELETE FROM animaxia_pilot_events WHERE externalid LIKE $1',[prefix+'%']);
    await pool.query('DELETE FROM animaxia_pilot_catalog WHERE externalid LIKE $1',[prefix+'%']);
    await stopPgCatalogPilot();
    await pool.end();
    if(old===undefined)delete process.env.ANIMAXIA_PG_CATALOG_PILOT;
    else process.env.ANIMAXIA_PG_CATALOG_PILOT=old;
  }
});
