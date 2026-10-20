/**
 * Optional PostgreSQL SHADOW catalog, not a replacement for SQLite writes.
 * Uses the durable SQLite outbox and parameterized PostgreSQL queries.
 * Actual cutover, sharding and authentication migration remain unimplemented.
 */
import pg from 'pg';
import { localDb } from '../local/sqlite.js';
import { projectContent } from '../search/opensearch-outbox.js';
import {
  ensurePgShadowOutbox,pgShadowPending,pgShadowAck,pgShadowRetry,
  pgShadowOutboxStatus,seedPgShadowOutbox,
} from './shadow-outbox.js';
import { logger } from '../../utils/logger.js';

const { Pool }=pg;
let pool=null;
let timer=null;
let busy=false;

export function pgShadowConfig(env=process.env) {
  const raw=env.ANIMAXIA_PG_SHADOW_DATABASE_URL;
  if(!raw)return {configured:false,enabled:false,storage:'postgresql-shadow'};
  let parsed;
  try{parsed=new URL(raw);}catch{
    throw Object.assign(new Error('Invalid PostgreSQL shadow URL'),{status:500});
  }
  if(!['postgresql:','postgres:'].includes(parsed.protocol) ||
    !parsed.hostname || !parsed.pathname || parsed.pathname==='/' ||
    parsed.search || parsed.hash || !parsed.username || !parsed.password) {
    throw Object.assign(new Error('PostgreSQL shadow URL needs a database, username and password without URL options'),{status:500});
  }
  const host=parsed.hostname;
  const loopback=['localhost','127.0.0.1','[::1]'].includes(host);
  const tls=env.ANIMAXIA_PG_SHADOW_TLS!=='false';
  if(!tls && (env.NODE_ENV==='production'||!loopback)) {
    throw Object.assign(new Error('PostgreSQL TLS may be disabled only for loopback development'),{status:500});
  }
  return {
    configured:true,enabled:env.ANIMAXIA_PG_SHADOW_WORKER==='true',
    storage:'postgresql-shadow',host,port:parsed.port||'5432',
    database:decodeURIComponent(parsed.pathname.slice(1)),
    tls,readOnlyProjection:true,
  };
}
function connectionPool(){
  const c=pgShadowConfig();
  if(!c.configured)throw Object.assign(new Error('PostgreSQL shadow is not configured'),{status:503});
  if(!pool){
    pool=new Pool({
      connectionString:process.env.ANIMAXIA_PG_SHADOW_DATABASE_URL,
      ssl:c.tls?{rejectUnauthorized:true}:false,
      max:3,connectionTimeoutMillis:4000,idleTimeoutMillis:8000,
      query_timeout:12000,statement_timeout:12000,
      application_name:'animaxia-shadow-catalog',
    });
    pool.on('error',(err)=>logger.warn('[pg-shadow] idle pool error: '+err.message));
  }
  return pool;
}
function executor(override){
  return override||connectionPool();
}
/** Use the connection pool for whitelisted internal SQL read operations. */
export async function shadowPgQuery(sql,params=[],{db}={}) {
  return executor(db).query(sql,params);
}

export async function setupPgShadow({db}={}) {
  if(!pgShadowConfig().configured)throw Object.assign(new Error('PostgreSQL shadow not configured'),{status:503});
  const client=executor(db);
  await client.query(`
    CREATE TABLE IF NOT EXISTS animaxia_shadow_content (
      id BIGINT PRIMARY KEY,
      externalid TEXT, title TEXT NOT NULL, type TEXT NOT NULL,
      year INTEGER, thumbnail TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      syncedat TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_animaxia_shadow_type_year
    ON animaxia_shadow_content(type,year DESC,id DESC)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_animaxia_shadow_metadata
    ON animaxia_shadow_content USING GIN(metadata)
  `);
  // Stable PostgreSQL full-text index for the admin-only shadow catalog.
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_animaxia_shadow_fts
    ON animaxia_shadow_content USING GIN (
      to_tsvector('simple'::regconfig,
        coalesce(title,'') || ' ' || coalesce(metadata->>'description',''))
    )
  `);
  ensurePgShadowOutbox();
  return {createdOrExisting:true,sourceOfTruth:'sqlite',replicaRole:'shadow',schemaVersion:1};
}
const UPSERT=`
  INSERT INTO animaxia_shadow_content
    (id,externalid,title,type,year,thumbnail,metadata)
  VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)
  ON CONFLICT(id) DO UPDATE SET
    externalid=EXCLUDED.externalid,title=EXCLUDED.title,
    type=EXCLUDED.type,year=EXCLUDED.year,
    thumbnail=EXCLUDED.thumbnail,metadata=EXCLUDED.metadata,syncedat=NOW()
`;
const DELETE='DELETE FROM animaxia_shadow_content WHERE id=$1';
export function projectPgShadow(row){
  const projected=projectContent(row); // omit URL, player/embedcode, secrets
  return {
    id:projected.id,externalid:projected.externalid,title:projected.title,
    type:projected.type,year:projected.year,thumbnail:projected.thumbnail,
    metadata:{
      description:projected.description,actors:projected.actors,
      genres:projected.genres,studios:projected.studios,
      franchise:projected.franchise,trilogy:projected.trilogy,
      collection:projected.collection,posterId:projected.posterId,
      sourceAttribution:projected.sourceAttribution,rating:projected.rating,
    },
  };
}
export async function flushPgShadow({limit=40,db}={}) {
  if(busy)return {skipped:'already-running'};
  if(!pgShadowConfig().configured)throw Object.assign(new Error('PostgreSQL shadow not configured'),{status:503});
  busy=true;
  try{
    const pgdb=executor(db);
    const jobs=pgShadowPending(limit);
    let processed=0,failed=0;
    for(const job of jobs){
      // Always reread authoritative Content: a delete is never applied if
      // a canonical row currently exists.
      const current=localDb.prepare('SELECT * FROM Content WHERE id=?').get(job.contentid);
      try{
        if(current){
          const doc=projectPgShadow(current);
          await pgdb.query(UPSERT,[
            doc.id,doc.externalid,doc.title,doc.type,doc.year,doc.thumbnail,
            JSON.stringify(doc.metadata),
          ]);
        }else{
          await pgdb.query(DELETE,[job.contentid]);
        }
        processed+=pgShadowAck(job);
      }catch(err){
        pgShadowRetry(job);
        failed++;
        logger.warn('[pg-shadow] projection failed (will retry): '+String(err.message).slice(0,140));
      }
    }
    return {processed,failed,pending:pgShadowOutboxStatus().pending};
  }finally{busy=false;}
}
export async function comparePgShadow({db}={}) {
  if(!pgShadowConfig().configured)throw Object.assign(new Error('PostgreSQL shadow not configured'),{status:503});
  const client=executor(db);
  const localCount=Number(localDb.prepare('SELECT COUNT(*) AS n FROM Content').get().n);
  const result=await client.query('SELECT COUNT(*)::text AS count FROM animaxia_shadow_content');
  const remoteCount=Number(result.rows?.[0]?.count);
  if(!Number.isSafeInteger(remoteCount)||remoteCount<0)throw Object.assign(
    new Error('Invalid PostgreSQL shadow count'),{status:502});
  const pending=pgShadowOutboxStatus().pending;
  return {localCount,remoteCount,delta:localCount-remoteCount,pending,
    countsAligned:localCount===remoteCount&&pending===0,
    note:'Equal counts do not prove row equality; PostgreSQL is not yet authoritative.'};
}
export function pgShadowStatus(){
  const config=pgShadowConfig();
  return {...pgShadowOutboxStatus(),configured:config.configured,
    workerEnabled:config.enabled,workerActive:timer!==null,
    host:config.host||null,database:config.database||null,
    tls:config.tls??null,mode:'read-only-shadow',authoritative:'sqlite'};
}
export function startPgShadowWorker(){
  if(timer||process.env.ANIMAXIA_PG_SHADOW_WORKER!=='true')return false;
  if(!pgShadowConfig().configured){logger.warn('[pg-shadow] disabled: no database URL');return false;}
  ensurePgShadowOutbox();
  timer=setInterval(()=>{
    flushPgShadow({limit:40}).catch((err)=>logger.warn('[pg-shadow] delayed: '+err.message));
  },5000);
  timer.unref?.();
  logger.info('[pg-shadow] optional projection worker active');
  return true;
}
export async function stopPgShadowWorker(){
  if(timer)clearInterval(timer);
  timer=null;
  if(pool){const old=pool;pool=null;await old.end();}
}
export { seedPgShadowOutbox };
