
/**
 * Stage 19: durable native PostgreSQL catalog-event -> search read model.
 *
 * No SQLite and no external HTTP. Each event is claimed with SKIP LOCKED;
 * projected metadata and event ACK are committed in a single PG transaction.
 * We read the latest canonical pilot row after a per-externalid advisory lock,
 * so out-of-order event workers converge to the latest state instead of
 * replaying stale event snapshots. No exact event delivery claims outside PG.
 */
import pg from 'pg';
import { pgWorkerConfig } from './distributed-pg-worker.js';
import { pgCatalogPilotEnabled, setupPgCatalogPilot } from './catalog-pilot.js';

const { Pool }=pg;
let pool=null,working=false,timer=null;
const invalid=(message)=>Object.assign(new Error(message),{status:400});
/** Maximum retries before an operator must inspect the quarantined event. */
export function pgPilotMaxAttempts(env=process.env){
  const raw=env.ANIMAXIA_PG_PILOT_MAX_ATTEMPTS??'8';
  if(!/^[1-9][0-9]?$|^100$/.test(String(raw)))
    throw new Error('ANIMAXIA_PG_PILOT_MAX_ATTEMPTS must be between 1 and 100');
  return Number(raw);
}
const safeErrorCode=(error)=>/^[A-Z0-9]{5}$/.test(String(error?.code||''))
  ?String(error.code):'WORKER_ERROR';
const disabled=()=>Object.assign(new Error('PostgreSQL pilot projection is disabled'),{status:503});
const requireConfig=()=>{
  if(!pgCatalogPilotEnabled()||process.env.ANIMAXIA_PG_PILOT_PROJECTION!=='true')
    throw disabled();
  if(!pgWorkerConfig().configured)
    throw Object.assign(new Error('PostgreSQL connection is not configured'),{status:503});
};
function connection(){
  requireConfig();
  if(!pool){
    const c=pgWorkerConfig();
    pool=new Pool({
      connectionString:process.env.ANIMAXIA_PG_SHADOW_DATABASE_URL,
      ssl:c.tls?{rejectUnauthorized:true}:false,
      max:4,connectionTimeoutMillis:4000,idleTimeoutMillis:8000,
      query_timeout:12000,statement_timeout:12000,
      application_name:'animaxia-pilot-projection',
    });
    pool.on('error',err=>console.warn('[pg-pilot-projection] pool:',err.message));
  }
  return pool;
}
const runner=options=>options?.db||connection();
export async function setupPgPilotProjection(options={}){
  requireConfig();
  const db=runner(options);
  await setupPgCatalogPilot({db});
  await db.query(`
    CREATE TABLE IF NOT EXISTS animaxia_pilot_search_projection (
      externalid TEXT PRIMARY KEY,
      contentid BIGINT NOT NULL,
      title TEXT NOT NULL,
      type TEXT NOT NULL,
      year INTEGER,
      thumbnail TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      revision BIGINT NOT NULL,
      syncedat TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_animaxia_pilot_projection_type_year
    ON animaxia_pilot_search_projection(type,year DESC,contentid DESC)
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_animaxia_pilot_projection_fts
    ON animaxia_pilot_search_projection USING GIN(
      to_tsvector('simple'::regconfig,
        coalesce(title,'') || ' ' || coalesce(metadata->>'description',''))
    )
  `);
  // Newly inserted native pilot events are pending by default. This upgrade
  // also safely includes preexisting events, without lossy ID cursors.
  await db.query(`
    ALTER TABLE animaxia_pilot_events
    ADD COLUMN IF NOT EXISTS projection_applied_at TIMESTAMPTZ
  `);
  await db.query(`
    ALTER TABLE animaxia_pilot_events
    ADD COLUMN IF NOT EXISTS projection_attempts INTEGER NOT NULL DEFAULT 0
  `);
  await db.query(`
    ALTER TABLE animaxia_pilot_events
    ADD COLUMN IF NOT EXISTS projection_next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  `);
  await db.query(`
    ALTER TABLE animaxia_pilot_events
    ADD COLUMN IF NOT EXISTS projection_quarantined_at TIMESTAMPTZ
  `);
  await db.query(`
    ALTER TABLE animaxia_pilot_events
    ADD COLUMN IF NOT EXISTS projection_error_code TEXT
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_animaxia_pilot_projection_events_due
    ON animaxia_pilot_events(projection_next_run_at,eventid)
    WHERE projection_applied_at IS NULL
  `);
  // Keep a smaller due-only index that excludes operator-quarantined jobs.
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_animaxia_pilot_projection_events_ready
    ON animaxia_pilot_events(projection_next_run_at,eventid)
    WHERE projection_applied_at IS NULL AND projection_quarantined_at IS NULL
  `);
  // Repair auditing checks whether this external ID already has an
  // outstanding native event. Index only the pending subset.
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_animaxia_pilot_projection_pending_external
    ON animaxia_pilot_events(externalid)
    WHERE projection_applied_at IS NULL
  `);
  return {schemaVersion:1,projection:'postgresql-pilot-search',
    sourceOfTruth:'isolated-native-pilot',publicCatalogUnchanged:true};
}
const UPDATE_MODEL=`
  INSERT INTO animaxia_pilot_search_projection
    (externalid,contentid,title,type,year,thumbnail,metadata,revision)
  VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
  ON CONFLICT(externalid) DO UPDATE SET
    contentid=EXCLUDED.contentid,title=EXCLUDED.title,type=EXCLUDED.type,
    year=EXCLUDED.year,thumbnail=EXCLUDED.thumbnail,
    metadata=EXCLUDED.metadata,revision=EXCLUDED.revision,syncedat=NOW()
`;
export async function flushPgPilotProjection({limit=20,db}={}){
  requireConfig();
  const cap=Number(limit);
  if(!Number.isSafeInteger(cap)||cap<1||cap>100)
    throw invalid('Projection limit must be 1..100');
  if(working)return {skipped:'same-process-worker-running'};
  working=true;
  try{
    let processed=0,failed=0,updated=0,deleted=0;
    for(let i=0;i<cap;i++){
      const client=await (db||connection()).connect();
      try{
        await client.query('BEGIN');
        let active=true;
        try{
          const claimed=await client.query(`
            SELECT eventid::text AS eventid,externalid
            FROM animaxia_pilot_events
            WHERE projection_applied_at IS NULL AND projection_quarantined_at IS NULL
              AND projection_next_run_at<=NOW()
            ORDER BY projection_next_run_at,eventid LIMIT 1
            FOR UPDATE SKIP LOCKED
          `);
          if(!claimed.rows.length){
            await client.query('COMMIT');
            active=false;break;
          }
          const event=claimed.rows[0];
          await client.query('SAVEPOINT project_event');
          let mutation='none';
          try{
            // Serialize projection of a given external ID across PG workers;
            // take the lock BEFORE reading the current native catalog.
            await client.query(
              'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 89241))',
              [event.externalid]
            );
            const latest=await client.query(`
              SELECT id::text AS id,externalid,title,type,year,thumbnail,
                metadata,revision::text AS revision
              FROM animaxia_pilot_catalog WHERE externalid=$1
            `,[event.externalid]);
            if(latest.rows.length===1){
              const d=latest.rows[0];
              await client.query(UPDATE_MODEL,[
                d.externalid,d.id,d.title,d.type,d.year,d.thumbnail,
                JSON.stringify(d.metadata),d.revision,
              ]);
              mutation='updated';
            }else if(latest.rows.length===0){
              await client.query(
                'DELETE FROM animaxia_pilot_search_projection WHERE externalid=$1',
                [event.externalid]
              );
              mutation='deleted';
            }else throw new Error('Invalid native pilot lookup');
            await client.query(`
              UPDATE animaxia_pilot_events SET projection_applied_at=NOW()
              WHERE eventid=$1 AND projection_applied_at IS NULL
            `,[event.eventid]);
            await client.query('RELEASE SAVEPOINT project_event');
            await client.query('COMMIT');active=false;processed++;
            if(mutation==='updated')updated++;
            if(mutation==='deleted')deleted++;
          }catch(err){
            // Roll back all side effects, but persist a retry delay.
            await client.query('ROLLBACK TO SAVEPOINT project_event');
            await client.query(`
              UPDATE animaxia_pilot_events
              SET projection_attempts=projection_attempts+1,
                projection_next_run_at=NOW()+
                  LEAST(3600,5*POWER(2,LEAST(projection_attempts,9)))*
                  INTERVAL '1 second',
                projection_quarantined_at=CASE
                  WHEN projection_attempts+1 >= $2 THEN NOW()
                  ELSE NULL END,
                projection_error_code=$3
              WHERE eventid=$1 AND projection_applied_at IS NULL
            `,[event.eventid,pgPilotMaxAttempts(),safeErrorCode(err)]);
            await client.query('COMMIT');active=false;failed++;
            console.warn('[pg-pilot-projection] retry:',String(err.message).slice(0,140));
          }
        }catch(err){
          if(active)try{await client.query('ROLLBACK');}catch{/* disconnected */}
          throw err;
        }
      }finally{client.release();}
    }
    return {processed,failed,updated,deleted};
  }finally{working=false;}
}
export async function pgPilotProjectionStatus({db}={}){
  requireConfig();
  const result=await runner({db}).query(`
    SELECT COUNT(*) FILTER (
        WHERE projection_applied_at IS NULL AND projection_quarantined_at IS NULL
      )::text AS pending,
      COUNT(*) FILTER (
        WHERE projection_applied_at IS NULL AND projection_quarantined_at IS NULL
          AND projection_attempts>0
      )::text AS retrying,
      COUNT(*) FILTER (WHERE projection_quarantined_at IS NOT NULL AND projection_applied_at IS NULL)::text AS quarantined,
      COUNT(*) FILTER (WHERE projection_applied_at IS NOT NULL)::text AS completed
    FROM animaxia_pilot_events
  `);
  const row=result.rows[0];
  return {enabled:true,mode:'isolated-native-pilot',publicCatalogUnchanged:true,
    pending:Number(row.pending),retrying:Number(row.retrying),
    quarantined:Number(row.quarantined),maxAttempts:pgPilotMaxAttempts(),
    completed:Number(row.completed)};
}
/**
 * Bounded administrative review. Error messages and event payloads are
 * deliberately excluded; only safe SQLSTATE/fixed error codes are returned.
 */
export async function listPgPilotQuarantine({afterEventId=0,limit=20}={},options={}){
  requireConfig();
  const cursor=Number(afterEventId),cap=Number(limit);
  if(!Number.isSafeInteger(cursor)||cursor<0)throw invalid('Invalid quarantined event cursor');
  if(!Number.isSafeInteger(cap)||cap<1||cap>50)throw invalid('Quarantine limit must be 1..50');
  const result=await runner(options).query(`
    SELECT eventid::text AS eventid,externalid,operation,projection_attempts AS attempts,
      projection_error_code AS errorcode,projection_quarantined_at AS quarantinedat
    FROM animaxia_pilot_events
    WHERE projection_applied_at IS NULL AND projection_quarantined_at IS NOT NULL
      AND ($1::bigint=0 OR eventid<$1::bigint)
    ORDER BY eventid DESC LIMIT $2
  `,[cursor,cap+1]);
  if(!Array.isArray(result.rows)||result.rows.length>cap+1)
    throw Object.assign(new Error('Invalid PostgreSQL quarantine result'),{status:502});
  const data=result.rows.slice(0,cap).map(row=>{
    const eventid=Number(row.eventid);
    if(!Number.isSafeInteger(eventid)||eventid<=0)
      throw Object.assign(new Error('Invalid PostgreSQL event ID'),{status:502});
    return {eventid,externalid:row.externalid,operation:row.operation,
      attempts:Number(row.attempts),errorCode:row.errorcode||null,
      quarantinedAt:row.quarantinedat};
  });
  return {data,hasMore:result.rows.length>cap,
    nextAfterEventId:result.rows.length>cap?data.at(-1).eventid:null,
    sourceOfTruth:'isolated-native-pilot',publicCatalogUnchanged:true};
}
/** Explicit operator retry; cannot replay an already acknowledged event. */
export async function retryPgPilotQuarantine(eventid,options={}){
  requireConfig();
  const id=Number(eventid);
  if(!Number.isSafeInteger(id)||id<=0)throw invalid('Invalid quarantined event ID');
  const result=await runner(options).query(`
    UPDATE animaxia_pilot_events
    SET projection_quarantined_at=NULL,projection_attempts=0,
      projection_error_code=NULL,projection_next_run_at=NOW()
    WHERE eventid=$1 AND projection_applied_at IS NULL
      AND projection_quarantined_at IS NOT NULL
    RETURNING eventid
  `,[id]);
  return {retried:result.rows.length===1,eventid:id,
    publicCatalogUnchanged:true};
}
export async function getPgPilotProjectedItems({q='',limit=20,afterId=0}={},options={}){
  requireConfig();
  if(typeof q!=='string'||q.length>120)throw invalid('Invalid projection search term');
  const cap=Number(limit),after=Number(afterId);
  if(!Number.isSafeInteger(cap)||cap<1||cap>50)throw invalid('Invalid projection page size');
  if(!Number.isSafeInteger(after)||after<0)throw invalid('Invalid projection cursor');
  const terms=[],values=[];
  const bind=v=>{values.push(v);return '$'+values.length;};
  if(q.trim())terms.push(`to_tsvector('simple'::regconfig,coalesce(title,'') || ' ' ||
    coalesce(metadata->>'description','')) @@ plainto_tsquery('simple'::regconfig,${bind(q.trim())})`);
  if(after)terms.push('contentid<'+bind(after));
  const sql=`SELECT contentid::text AS id,externalid,title,type,year,thumbnail,metadata,
    revision::text AS revision FROM animaxia_pilot_search_projection`+
    (terms.length?' WHERE '+terms.join(' AND '):'')+
    ' ORDER BY contentid DESC LIMIT '+bind(cap+1);
  const result=await runner(options).query(sql,values);
  if(!Array.isArray(result.rows)||result.rows.length>cap+1)
    throw Object.assign(new Error('Invalid pilot projection response'),{status:502});
  const all=result.rows.slice(0,cap);
  const data=all.map(row=>{
    const id=Number(row.id);
    if(!Number.isSafeInteger(id)||id<1)throw Object.assign(
      new Error('Invalid projected content ID'),{status:502});
    return {id,externalid:row.externalid,title:row.title,type:row.type,
      year:row.year,thumbnail:row.thumbnail,revision:Number(row.revision),
      metadata:row.metadata};
  });
  return {mode:'postgresql-pilot-search-projection',publicCatalogUnchanged:true,
    data,hasMore:result.rows.length>cap,
    nextAfterId:result.rows.length>cap?data.at(-1)?.id:null};
}
export function startPgPilotProjection({keepAlive=false}={}){
  if(timer||process.env.ANIMAXIA_PG_PILOT_PROJECTION_WORKER!=='true')return false;
  requireConfig();
  timer=setInterval(()=>flushPgPilotProjection().catch(err=>
    console.warn('[pg-pilot-projection] poll:',err.message)),3000);
  if(!keepAlive)timer.unref?.();
  return true;
}
export async function stopPgPilotProjection(){
  if(timer)clearInterval(timer);
  timer=null;
  if(pool){const previous=pool;pool=null;await previous.end();}
}
