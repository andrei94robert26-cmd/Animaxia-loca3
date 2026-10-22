/** PostgreSQL 16 real: bidirectional native pilot projection drift audit. */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import {
  setupPgCatalogPilot,upsertPgCatalogPilot,stopPgCatalogPilot,
} from '../modules/postgres/catalog-pilot.js';
import {
  setupPgPilotProjection,flushPgPilotProjection,stopPgPilotProjection,
} from '../modules/postgres/pilot-projection.js';
import {
  reconcilePgPilotProjection,stopPgPilotReconciliation,
} from '../modules/postgres/pilot-reconciliation.js';

test('real PG16: detect missing/stale projected titles and orphan-only records; repair via durable events',async t=>{
  if(!process.env.ANIMAXIA_PG_SHADOW_DATABASE_URL){
    t.skip('Requires ephemeral PostgreSQL CI service');return;
  }
  const prev={catalog:process.env.ANIMAXIA_PG_CATALOG_PILOT,
    projection:process.env.ANIMAXIA_PG_PILOT_PROJECTION};
  process.env.ANIMAXIA_PG_CATALOG_PILOT='true';
  process.env.ANIMAXIA_PG_PILOT_PROJECTION='true';
  const pool=new pg.Pool({
    connectionString:process.env.ANIMAXIA_PG_SHADOW_DATABASE_URL,
    ssl:false,max:4,connectionTimeoutMillis:4000,
  });
  const nonce=crypto.randomBytes(7).toString('hex');
  const first='stage20:'+nonce+':a';
  const second='stage20:'+nonce+':b';
  const orphan='zzstage20:'+nonce+':orphan';
  const orphanCursor='zzstage20:'+nonce+':';
  const orphanId=2_100_000_000+crypto.randomBytes(3).readUIntBE(0,3);
  try{
    await setupPgCatalogPilot();await setupPgPilotProjection();
    const original=await upsertPgCatalogPilot({
      externalid:first,title:'Stage20 original '+nonce,type:'movie',
      year:2026,metadata:{description:'Canonical from pilot',genres:['Sci Fi']},
    });
    const id=original.data.id;
    assert.equal((await flushPgPilotProjection({limit:10})).failed,0);
    const opts={scope:'catalog',afterId:id-1,limit:1};
    const pristine=await reconcilePgPilotProjection(opts);
    assert.equal(pristine.matched,1);
    assert.equal(pristine.missing,0);
    assert.equal(pristine.mismatched,0);
    await pool.query(
      'UPDATE animaxia_pilot_search_projection SET title=$1 WHERE externalid=$2',
      ['Outdated projection',first]
    );
    const before=(await pool.query(
      'SELECT COUNT(*)::int AS count FROM animaxia_pilot_events WHERE externalid=$1',
      [first]
    )).rows[0].count;
    const stale=await reconcilePgPilotProjection(opts);
    assert.equal(stale.mismatched,1);
    assert.equal(stale.repairQueued,0);
    assert.equal((await pool.query(
      'SELECT COUNT(*)::int AS count FROM animaxia_pilot_events WHERE externalid=$1',
      [first]
    )).rows[0].count,before,'dry-run may not change events');

    const queued=await reconcilePgPilotProjection({...opts,dryRun:false});
    assert.equal(queued.repairQueued,1);
    const duplicate=await reconcilePgPilotProjection({...opts,dryRun:false});
    assert.equal(duplicate.repairQueued,0,'pending event should coalesce repeated repair');
    assert.equal(duplicate.alreadyPendingOrResolved,1);
    assert.equal((await flushPgPilotProjection({limit:10})).failed,0);
    assert.equal((await reconcilePgPilotProjection(opts)).matched,1);
    const correct=(await pool.query(
      'SELECT title FROM animaxia_pilot_search_projection WHERE externalid=$1',
      [first]
    )).rows[0].title;
    assert.equal(correct,'Stage20 original '+nonce);

    // A missing indexed document is also repairable without changes to
    // the canonical native pilot catalog.
    await pool.query(
      'DELETE FROM animaxia_pilot_search_projection WHERE externalid=$1',[first]);
    assert.equal((await reconcilePgPilotProjection(opts)).missing,1);
    assert.equal((await reconcilePgPilotProjection({...opts,dryRun:false})).repairQueued,1);
    assert.equal((await flushPgPilotProjection({limit:10})).failed,0);
    assert.equal((await reconcilePgPilotProjection(opts)).matched,1);

    // Keyset pagination remains limited even with multiple pilot records.
    const extra=await upsertPgCatalogPilot({
      externalid:second,title:'Stage20 next '+nonce,type:'tv',
    });
    assert.ok(extra.data.id>id);
    assert.equal((await flushPgPilotProjection({limit:10})).failed,0);
    const firstPage=await reconcilePgPilotProjection(opts);
    assert.equal(firstPage.scanned,1);
    assert.equal(firstPage.nextAfterId,id);
    assert.equal(firstPage.finished,false);
    const secondPage=await reconcilePgPilotProjection({
      scope:'catalog',afterId:id,limit:1,
    });
    assert.equal(secondPage.scanned,1);
    assert.equal(secondPage.matched,1);

    // A row existing ONLY in the search projection is an orphan.
    await pool.query(`
      INSERT INTO animaxia_pilot_search_projection
      (externalid,contentid,title,type,metadata,revision)
      VALUES($1,$2,$3,'movie','{}'::jsonb,1)
    `,[orphan,String(orphanId),'Orphan stage20 '+nonce]);
    const check={scope:'orphans',afterExternalId:orphanCursor,limit:20};
    const orphanDry=await reconcilePgPilotProjection(check);
    assert.equal(orphanDry.orphaned,1);
    assert.equal(orphanDry.repairQueued,0);
    const orphanQueued=await reconcilePgPilotProjection({...check,dryRun:false});
    assert.equal(orphanQueued.repairQueued,1);
    const noDup=await reconcilePgPilotProjection({...check,dryRun:false});
    assert.equal(noDup.repairQueued,0);
    assert.equal((await flushPgPilotProjection({limit:10})).failed,0);
    assert.equal((await pool.query(
      'SELECT externalid FROM animaxia_pilot_search_projection WHERE externalid=$1',
      [orphan]
    )).rowCount,0);

    // If canonical content appears after detection, an ordinary native
    // event causes projection of that newest state, never blind deletion.
    await pool.query(`
      INSERT INTO animaxia_pilot_search_projection
      (externalid,contentid,title,type,metadata,revision)
      VALUES($1,$2,$3,'movie','{}'::jsonb,1)
    `,[orphan,String(orphanId),'Candidate race']);
    assert.equal((await reconcilePgPilotProjection(check)).orphaned,1);
    const reborn=await upsertPgCatalogPilot({
      externalid:orphan,title:'Recreated before repair '+nonce,type:'movie',
    });
    const race=await reconcilePgPilotProjection({...check,dryRun:false});
    assert.equal(race.repairQueued,0);
    await flushPgPilotProjection({limit:10});
    const row=await pool.query(
      'SELECT contentid::text AS contentid,title FROM animaxia_pilot_search_projection WHERE externalid=$1',
      [orphan]
    );
    assert.equal(row.rowCount,1);
    assert.equal(row.rows[0].contentid,String(reborn.data.id));
    assert.equal(row.rows[0].title,'Recreated before repair '+nonce);
  }finally{
    // Test data is isolated by a random nonce and always removed.
    for(const name of [first,second,orphan]){
      await pool.query('DELETE FROM animaxia_pilot_events WHERE externalid=$1',[name]);
      await pool.query('DELETE FROM animaxia_pilot_search_projection WHERE externalid=$1',[name]);
      await pool.query('DELETE FROM animaxia_pilot_catalog WHERE externalid=$1',[name]);
    }
    await stopPgPilotReconciliation();
    await stopPgPilotProjection();
    await stopPgCatalogPilot();
    await pool.end();
    if(prev.catalog===undefined)delete process.env.ANIMAXIA_PG_CATALOG_PILOT;
    else process.env.ANIMAXIA_PG_CATALOG_PILOT=prev.catalog;
    if(prev.projection===undefined)delete process.env.ANIMAXIA_PG_PILOT_PROJECTION;
    else process.env.ANIMAXIA_PG_PILOT_PROJECTION=prev.projection;
  }
});
