/** Real PostgreSQL 16: native catalog CRUD + atomic event log + FTS. */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import {
  setupPgCatalogPilot,upsertPgCatalogPilot,deletePgCatalogPilot,
  listPgCatalogPilot,getPgCatalogPilotByExternalId,pgCatalogPilotStatus,stopPgCatalogPilot,
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
    const before=await pgCatalogPilotStatus();
    assert.equal(before.enabled,true);
    assert.equal(before.initialized,false);
    const setup=await setupPgCatalogPilot();
    assert.equal(setup.authoritativeForPublicCatalog,false);
    assert.equal((await pgCatalogPilotStatus()).initialized,true);
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
    const indexed=await getPgCatalogPilotByExternalId(first);
    assert.equal(indexed.found,true);
    assert.equal(indexed.data.id,id);
    assert.equal(indexed.data.title,item.title);
    assert.equal(indexed.data.revision,1);
    assert.equal(indexed.data.metadata.actors[0],'Real PG Actor');
    assert.equal((await getPgCatalogPilotByExternalId(prefix+'absent')).found,false);
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

    // Revision-aware native pilot writes protect against lost updates.
    // Two writers using the same previously read revision must not both win.
    const versioned=prefix+'versioned:4';
    const itemForVersion={
      externalid:versioned,title:'Create once '+nonce,type:'movie',
      expectedRevision:0,metadata:{genres:['Concurrency']},
    };
    // A positive revision cannot silently create a new record.
    const unknown=prefix+'missing-with-revision';
    await assert.rejects(upsertPgCatalogPilot({
      ...itemForVersion,externalid:unknown,expectedRevision:7,
    }),(err)=>err?.status===409);
    assert.equal((await pool.query(
      'SELECT id FROM animaxia_pilot_catalog WHERE externalid=$1',[unknown]
    )).rowCount,0);
    assert.equal((await pool.query(
      'SELECT eventid FROM animaxia_pilot_events WHERE externalid=$1',[unknown]
    )).rowCount,0);
    const createdVersion=await upsertPgCatalogPilot(itemForVersion);
    assert.equal(createdVersion.data.revision,1);
    await assert.rejects(
      upsertPgCatalogPilot({...itemForVersion,title:'Stale create '+nonce}),
      (err)=>err?.status===409
    );
    const attempts=await Promise.allSettled([
      upsertPgCatalogPilot({...itemForVersion,expectedRevision:1,title:'Version writer A'}),
      upsertPgCatalogPilot({...itemForVersion,expectedRevision:1,title:'Version writer B'}),
    ]);
    assert.equal(attempts.filter(x=>x.status==='fulfilled').length,1);
    assert.equal(attempts.filter(x=>x.status==='rejected').length,1);
    assert.equal(attempts.find(x=>x.status==='rejected').reason.status,409);
    const winner=await pool.query(
      'SELECT revision::text AS revision,title FROM animaxia_pilot_catalog WHERE externalid=$1',
      [versioned]
    );
    assert.equal(winner.rows[0].revision,'2');
    assert.match(winner.rows[0].title,/^Version writer [AB]$/);
    await assert.rejects(
      upsertPgCatalogPilot({...itemForVersion,expectedRevision:1,
        title:'Must not replace winner'}),
      (err)=>err?.status===409
    );
    const loserDelete=await assert.rejects(
      deletePgCatalogPilot(versioned,{expectedRevision:1}),
      (err)=>err?.status===409
    );
    void loserDelete;
    const winnerDelete=await deletePgCatalogPilot(versioned,{expectedRevision:2});
    assert.equal(winnerDelete.deleted,true);
    assert.equal((await deletePgCatalogPilot(versioned,{expectedRevision:0})).deleted,false);
    const versionEvents=await pool.query(
      'SELECT operation,revision::text AS revision FROM animaxia_pilot_events WHERE externalid=$1 ORDER BY eventid',
      [versioned]
    );
    assert.deepEqual(versionEvents.rows.map(x=>[x.operation,x.revision]),[
      ['upsert','1'],['upsert','2'],['delete','2'],
    ]);

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
    assert.equal((await getPgCatalogPilotByExternalId(first)).found,false);
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
