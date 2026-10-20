/**
 * Stage 17: explicit PostgreSQL transactional queue for concurrent workers.
 * One SQLite feeder stages sanitized snapshots; N PostgreSQL-only workers can
 * apply tasks using FOR UPDATE SKIP LOCKED without sharing SQLite volumes.
 * The authoritative catalog / frontend reads remain on SQLite.
 */
import { localDb } from '../local/sqlite.js';
import { pgShadowConfig, projectPgShadow, shadowPgQuery } from './shadow.js';
import {workDistributedShadow,startPgDistributedWorker,stopPgDistributedWorker} from './distributed-pg-worker.js';
export {workDistributedShadow} from './distributed-pg-worker.js';
import { pgShadowPending,pgShadowAck,pgShadowRetry,pgShadowOutboxStatus } from './shadow-outbox.js';
import { logger } from '../../utils/logger.js';

let staging=false,feedTimer=null;
const positive=(v,max,name)=>{
  const n=Number(v);
  if(!Number.isSafeInteger(n)||n<1||n>max)
    throw Object.assign(new Error('Invalid '+name),{status:400});
  return n;
};
const INSERT_TASK=`
  INSERT INTO animaxia_shadow_tasks(contentid,operation,document)
  VALUES($1,$2,$3::jsonb)
  ON CONFLICT(contentid) DO UPDATE SET
    operation=EXCLUDED.operation,document=EXCLUDED.document,
    generation=animaxia_shadow_tasks.generation+1,
    attempts=0,next_run_at=NOW(),updated_at=NOW()
`;
const APPLY_UPSERT=`
  INSERT INTO animaxia_shadow_content(id,externalid,title,type,year,thumbnail,metadata)
  VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)
  ON CONFLICT(id) DO UPDATE SET
    externalid=EXCLUDED.externalid,title=EXCLUDED.title,
    type=EXCLUDED.type,year=EXCLUDED.year,thumbnail=EXCLUDED.thumbnail,
    metadata=EXCLUDED.metadata,syncedat=NOW()
`;
const APPLY_DELETE='DELETE FROM animaxia_shadow_content WHERE id=$1';
export async function setupDistributedShadow({db}={}){
  if(!pgShadowConfig().configured)throw Object.assign(
    new Error('PostgreSQL shadow not configured'),{status:503});
  await shadowPgQuery(`
    CREATE TABLE IF NOT EXISTS animaxia_shadow_tasks(
      contentid BIGINT PRIMARY KEY,
      operation TEXT NOT NULL CHECK(operation IN ('upsert','delete')),
      document JSONB,
      generation BIGINT NOT NULL DEFAULT 1,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK((operation='upsert' AND document IS NOT NULL) OR
        (operation='delete' AND document IS NULL))
    )
  `,[],{db});
  await shadowPgQuery(`
    CREATE INDEX IF NOT EXISTS idx_animaxia_shadow_tasks_due
    ON animaxia_shadow_tasks(next_run_at,contentid)
  `,[],{db});
  return {createdOrExisting:true,queue:'postgresql-shadow-tasks',
    workerCoordination:'transactional-skip-locked',sourceOfTruth:'sqlite'};
}
export async function stageDistributedShadow({limit=40,db}={}){
  if(staging)return {skipped:'already-staging'};
  if(process.env.ANIMAXIA_PG_SHADOW_WORKER==='true')throw Object.assign(
    new Error('Disable legacy PostgreSQL shadow worker before staging'),{status:409});
  if(!pgShadowConfig().configured)throw Object.assign(
    new Error('PostgreSQL shadow not configured'),{status:503});
  staging=true;
  try{
    const jobs=pgShadowPending(positive(limit,100,'stage limit'));
    let staged=0,failed=0,stale=0;
    for(const job of jobs){
      const row=localDb.prepare('SELECT * FROM Content WHERE id=?').get(job.contentid);
      const doc=row?projectPgShadow(row):null;
      try{
        // Commit in PostgreSQL BEFORE acknowledgement in SQLite. On crash,
        // SQLite repeats the same snapshot (idempotent PG one-row queue).
        await shadowPgQuery(INSERT_TASK,[
          job.contentid,doc?'upsert':'delete',doc?JSON.stringify(doc):null,
        ],{db});
        staged++;
        if(pgShadowAck(job)===0)stale++; // newer local event retained
      }catch(err){
        failed++;
        pgShadowRetry(job);
        logger.warn('[pg-distributed] staging retry: '+String(err.message).slice(0,140));
      }
    }
    return {staged,failed,stale,pendingLocal:pgShadowOutboxStatus().pending};
  }finally{staging=false;}
}
/** Apply each job and its acknowledgement in ONE PostgreSQL transaction.
 * The row lock prevents racing workers and publishers for the same contentid.
 * A crash rolls back both the catalog change and job deletion.
 */
export async function distributedShadowStatus({db}={}){
  const c=pgShadowConfig();
  if(!c.configured)return {configured:false,bridgeActive:false,workerActive:false};
  const result=await shadowPgQuery(`
    SELECT COUNT(*)::text AS pending,
      COALESCE(SUM(CASE WHEN attempts>0 THEN 1 ELSE 0 END),0)::text AS retries,
      COALESCE(MAX(attempts),0)::text AS max_attempts
    FROM animaxia_shadow_tasks
  `,[],{db});
  return {configured:true,bridgeActive:feedTimer!==null,
    workerEnabled:process.env.ANIMAXIA_PG_DISTRIBUTED_WORKER==='true',distributed:true,
    pending:Number(result.rows[0].pending),
    retrying:Number(result.rows[0].retries),maxAttempts:Number(result.rows[0].max_attempts),
    localPending:pgShadowOutboxStatus().pending,
    sourceOfTruth:'sqlite',workersShareOnly:'postgresql'};
}
export function startDistributedShadow(){
  if(!pgShadowConfig().configured)return false;
  if(process.env.ANIMAXIA_PG_DISTRIBUTED_BRIDGE==='true'){
    if(process.env.ANIMAXIA_PG_SHADOW_WORKER==='true')
      throw new Error('Legacy PG shadow worker and PG distributed bridge conflict');
    if(!feedTimer){
      feedTimer=setInterval(()=>stageDistributedShadow().catch(err=>
        logger.warn('[pg-distributed] bridge failed: '+err.message)),5000);
      feedTimer.unref?.();
    }
  }
  const pgWorkerActive=startPgDistributedWorker();
  return feedTimer!==null||pgWorkerActive;
}
export async function stopDistributedShadow(){
  if(feedTimer)clearInterval(feedTimer);
  feedTimer=null;
  await stopPgDistributedWorker();
}
