/**
 * Stage 18: isolated, PostgreSQL-native catalog write canary.
 * Writes DO NOT modify SQLite Content or any user-facing player endpoint.
 * Explicitly enabled by ANIMAXIA_PG_CATALOG_PILOT=true and admin-only routes.
 * This module intentionally imports NO SQLite database or backend Content API.
 */
import pg from 'pg';
import {pgWorkerConfig} from './distributed-pg-worker.js';
import {lockPgPilotExternalId} from './pilot-lock.js';

const {Pool}=pg;
let pool=null;
const invalid=(msg)=>Object.assign(new Error(msg),{status:400});
const disabled=()=>Object.assign(new Error('PostgreSQL catalog pilot is disabled'),{status:503});
const types=new Set([
  'movie','tv','anime','cartoon','sport','music','documentary',
  'gaming','news','entertainment','showbiz','telenovela',
]);
const safeText=(input,max=300)=>{
  if(typeof input!=='string'||input.length>max)return '';
  return input.trim();
};
const allowedNameList=(input)=>{
  if(input===undefined)return [];
  if(!Array.isArray(input)||input.length>40)throw invalid('Invalid metadata names');
  return [...new Set(input.map(v=>{
    const name=safeText(v,120);
    if(!name)throw invalid('Invalid metadata name');
    return name;
  }))];
};
// Optional optimistic concurrency precondition. Missing means legacy
// last-write-wins; 0 means create-only; a positive revision means update
// exactly that revision. All checks run under the per-externalid PG lock.
export function pgPilotExpectedRevision(value){
  if(value===undefined)return null;
  if(typeof value!=='number'&&typeof value!=='string')
    throw invalid('Invalid expectedRevision');
  if(typeof value==='string'&&!/^(0|[1-9][0-9]*)$/.test(value))
    throw invalid('Invalid expectedRevision');
  const revision=Number(value);
  if(!Number.isSafeInteger(revision)||revision<0)
    throw invalid('Invalid expectedRevision');
  return revision;
}
const staleConflict=()=>Object.assign(new Error('Pilot catalog revision conflict'),{status:409});
async function checkExpectedRevision(client,externalid,revision){
  if(revision===null)return;
  const current=await client.query(
    'SELECT revision::text AS revision FROM animaxia_pilot_catalog WHERE externalid=$1',
    [externalid]);
  if(!Array.isArray(current.rows)||current.rows.length>1)
    throw Object.assign(new Error('Invalid pilot revision lookup'),{status:502});
  const currentRevision=current.rows.length?Number(current.rows[0].revision):0;
  if(!Number.isSafeInteger(currentRevision)||currentRevision<0)
    throw Object.assign(new Error('Invalid pilot revision value'),{status:502});
  if(currentRevision!==revision)throw staleConflict();
}
const projection=(input)=>{
  if(!input||typeof input!=='object'||Array.isArray(input))
    throw invalid('Invalid catalog item');
  const externalid=safeText(input.externalid,220);
  const title=safeText(input.title,300);
  const type=safeText(input.type,50).toLowerCase();
  if(!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,219}$/.test(externalid))
    throw invalid('Invalid stable externalid');
  if(!title)throw invalid('Title is required');
  if(!types.has(type))throw invalid('Unsupported content type');
  const year=input.year===undefined||input.year===null?null:Number(input.year);
  if(year!==null&&(!Number.isInteger(year)||year<1880||year>2200))
    throw invalid('Invalid catalog year');
  let thumbnail=null;
  if(input.thumbnail!==undefined&&input.thumbnail!==null&&input.thumbnail!==''){
    const raw=safeText(input.thumbnail,2048);
    try{
      const url=new URL(raw);
      if(url.protocol!=='https:'||url.username||url.password)throw Error('invalid');
      thumbnail=url.toString();
    }catch{throw invalid('Thumbnail must be a credential-free HTTPS URL');}
  }
  const m=input.metadata===undefined?{}:input.metadata;
  if(!m||typeof m!=='object'||Array.isArray(m))throw invalid('Invalid metadata');
  const names={};
  for(const key of ['actors','genres','studios'])names[key]=allowedNameList(m[key]);
  const strings={};
  for(const key of ['description','franchise','trilogy','collection','posterId','sourceAttribution']){
    const limit=key==='description'?5000:160;
    if(m[key]!==undefined&&typeof m[key]!=='string')throw invalid('Invalid metadata text: '+key);
    strings[key]=m[key]===undefined?'':safeText(m[key],limit);
  }
  let rating=null;
  if(m.rating!==undefined&&m.rating!==null){
    rating=Number(m.rating);
    if(!Number.isFinite(rating)||rating<0||rating>10)throw invalid('Invalid rating');
  }
  // Whitelist: source URLs, embeds, auth headers, arbitrary JSON are ignored.
  return {externalid,title,type,year,thumbnail,
    expectedRevision:pgPilotExpectedRevision(input.expectedRevision),
    metadata:{...names,...strings,rating}};
};
export {projection as validatePgPilotItem};
export function pgCatalogPilotEnabled(env=process.env){
  return env.ANIMAXIA_PG_CATALOG_PILOT==='true';
}
function connection(){
  if(!pgCatalogPilotEnabled())throw disabled();
  const cfg=pgWorkerConfig();
  if(!cfg.configured)throw Object.assign(new Error('PostgreSQL is not configured'),{status:503});
  if(!pool){
    pool=new Pool({connectionString:process.env.ANIMAXIA_PG_SHADOW_DATABASE_URL,
      ssl:cfg.tls?{rejectUnauthorized:true}:false,max:4,
      connectionTimeoutMillis:4000,idleTimeoutMillis:8000,
      statement_timeout:12000,query_timeout:12000,
      application_name:'animaxia-pg-catalog-pilot'});
    pool.on('error',err=>console.warn('[pg-catalog-pilot] connection: '+err.message));
  }
  return pool;
}
const runner=({db}={})=>db||connection();
const table='animaxia_pilot_catalog';
export async function setupPgCatalogPilot(options={}){
  if(!pgCatalogPilotEnabled())throw disabled();
  const db=runner(options);
  await db.query(`
    CREATE TABLE IF NOT EXISTS animaxia_pilot_catalog (
      id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      externalid TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      type TEXT NOT NULL,
      year INTEGER,
      thumbnail TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      revision BIGINT NOT NULL DEFAULT 1,
      updatedat TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_animaxia_pilot_catalog_type_year
    ON animaxia_pilot_catalog(type,year DESC,id DESC)
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_animaxia_pilot_catalog_fts
    ON animaxia_pilot_catalog USING GIN(
      to_tsvector('simple'::regconfig,coalesce(title,'') || ' ' ||
        coalesce(metadata->>'description',''))
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS animaxia_pilot_events (
      eventid BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      contentid BIGINT NOT NULL,
      externalid TEXT NOT NULL,
      operation TEXT NOT NULL CHECK(operation IN ('upsert','delete')),
      revision BIGINT NOT NULL,
      createdat TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_animaxia_pilot_events_content
    ON animaxia_pilot_events(contentid,eventid DESC)
  `);
  // A stable external ID must NEVER reuse an earlier content revision after
  // DELETE + re-create. Seed from live rows AND historical events so an
  // upgrade also protects rows deleted before the ledger existed.
  await db.query(`
    CREATE TABLE IF NOT EXISTS animaxia_pilot_revision_ledger (
      externalid TEXT PRIMARY KEY,
      revision BIGINT NOT NULL CHECK(revision>=1)
    )
  `);
  await db.query(`
    INSERT INTO animaxia_pilot_revision_ledger(externalid,revision)
    SELECT externalid,MAX(revision) FROM (
      SELECT externalid,revision FROM animaxia_pilot_catalog
      UNION ALL
      SELECT externalid,revision FROM animaxia_pilot_events
    ) versions GROUP BY externalid
    ON CONFLICT(externalid) DO UPDATE SET
      revision=GREATEST(animaxia_pilot_revision_ledger.revision,EXCLUDED.revision)
  `);
  return {schemaVersion:1,mode:'postgresql-isolated-pilot',
    authoritativeForPublicCatalog:false};
}
const toPublic=(row)=>{
  const id=Number(row.id);
  if(!Number.isSafeInteger(id)||id<=0)throw Object.assign(
    new Error('Invalid PostgreSQL pilot content ID'),{status:502});
  return {id,externalid:row.externalid,title:row.title,type:row.type,
    category:row.type,year:row.year,thumbnail:row.thumbnail,
    revision:Number(row.revision),metadata:row.metadata};
};
/** Indexed lookup of a single pilot record by stable external ID.
 * Exposed only through the administrator router. No SQLite/media access.
 */
export async function getPgCatalogPilotByExternalId(externalid,options={}){
  if(!pgCatalogPilotEnabled())throw disabled();
  const key=safeText(externalid,220);
  if(!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,219}$/.test(key))
    throw invalid('Invalid stable externalid');
  const result=await runner(options).query(`
    SELECT id::text,externalid,title,type,year,thumbnail,metadata,
      revision::text
    FROM animaxia_pilot_catalog WHERE externalid=$1 LIMIT 1
  `,[key]);
  if(!Array.isArray(result.rows)||result.rows.length>1)
    throw Object.assign(new Error('Invalid native pilot lookup'),{status:502});
  return {found:result.rows.length===1,
    data:result.rows.length?toPublic(result.rows[0]):null,
    mode:'postgresql-isolated-pilot',publicCatalogUnchanged:true};
}
export async function upsertPgCatalogPilot(input,options={}){
  if(!pgCatalogPilotEnabled())throw disabled();
  const d=projection(input);
  const client=await runner(options).connect();
  try{
    await client.query('BEGIN');
    await lockPgPilotExternalId(client,d.externalid);
    await checkExpectedRevision(client,d.externalid,d.expectedRevision);
    // Advance inside the same transaction and the same advisory lock as
    // Content + event write. Rollback undoes this allocation as well.
    const reserved=await client.query(`
      INSERT INTO animaxia_pilot_revision_ledger(externalid,revision)
      VALUES($1,1)
      ON CONFLICT(externalid) DO UPDATE SET
        revision=animaxia_pilot_revision_ledger.revision+1
      RETURNING revision::text AS revision
    `,[d.externalid]);
    const nextRevision=reserved.rows[0]?.revision;
    if(!Number.isSafeInteger(Number(nextRevision))||Number(nextRevision)<1)
      throw Object.assign(new Error('Invalid pilot revision allocation'),{status:502});
    const write=await client.query(`
      INSERT INTO animaxia_pilot_catalog
        (externalid,title,type,year,thumbnail,metadata,revision)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)
      ON CONFLICT(externalid) DO UPDATE SET
        title=EXCLUDED.title,type=EXCLUDED.type,year=EXCLUDED.year,
        thumbnail=EXCLUDED.thumbnail,metadata=EXCLUDED.metadata,
        revision=EXCLUDED.revision,
        updatedat=NOW()
      RETURNING id::text,externalid,title,type,year,thumbnail,metadata,revision::text
    `,[d.externalid,d.title,d.type,d.year,d.thumbnail,JSON.stringify(d.metadata),nextRevision]);
    const row=write.rows[0];
    await client.query(`
      INSERT INTO animaxia_pilot_events(contentid,externalid,operation,revision)
      VALUES($1,$2,'upsert',$3)
    `,[row.id,row.externalid,row.revision]);
    await client.query('COMMIT');
    return {stored:true,mode:'postgresql-isolated-pilot',
      publicCatalogUnchanged:true,data:toPublic(row)};
  }catch(err){try{await client.query('ROLLBACK');}catch{/* failed connection */}throw err;}
  finally{client.release();}
}
export async function deletePgCatalogPilot(externalid,options={}){
  if(!pgCatalogPilotEnabled())throw disabled();
  const id=safeText(externalid,220);
  if(!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,219}$/.test(id))
    throw invalid('Invalid stable externalid');
  const expectedRevision=pgPilotExpectedRevision(options.expectedRevision);
  const client=await runner(options).connect();
  try{
    await client.query('BEGIN');
    await lockPgPilotExternalId(client,id);
    await checkExpectedRevision(client,id,expectedRevision);
    const removed=await client.query(`
      DELETE FROM animaxia_pilot_catalog WHERE externalid=$1
      RETURNING id::text,externalid,revision::text
    `,[id]);
    if(removed.rows.length){
      const row=removed.rows[0];
      await client.query(`
        INSERT INTO animaxia_pilot_events(contentid,externalid,operation,revision)
        VALUES($1,$2,'delete',$3)
      `,[row.id,row.externalid,row.revision]);
    }
    await client.query('COMMIT');
    return {deleted:removed.rows.length===1,mode:'postgresql-isolated-pilot',
      publicCatalogUnchanged:true};
  }catch(err){try{await client.query('ROLLBACK');}catch{/* disconnected */}throw err;}
  finally{client.release();}
}
export function buildPgCatalogPilotSearch(params={}){
  const q=params.q===undefined?'':safeText(params.q,120);
  if(params.q!==undefined&&typeof params.q==='string'&&params.q.length>120)
    throw invalid('Search term too long');
  const type=params.type===undefined?'':safeText(params.type,50).toLowerCase();
  if(type&&!types.has(type))throw invalid('Invalid category');
  const year=params.year===undefined?'':String(params.year);
  if(year&&!/^[12][0-9]{3}$/.test(year))throw invalid('Invalid year');
  const limit=params.limit===undefined?20:Number(params.limit);
  if(!Number.isSafeInteger(limit)||limit<1||limit>50)throw invalid('Invalid page size');
  const after=params.afterId===undefined?0:Number(params.afterId);
  if(!Number.isSafeInteger(after)||after<0)throw invalid('Invalid pagination cursor');
  const where=[],values=[];
  const bind=v=>{values.push(v);return '$'+values.length;};
  if(q)where.push(`
    to_tsvector('simple'::regconfig,coalesce(title,'') || ' ' ||
      coalesce(metadata->>'description',''))
    @@ plainto_tsquery('simple'::regconfig,`+bind(q)+')');
  if(type)where.push('type='+bind(type));
  if(year)where.push('year='+bind(Number(year)));
  if(after)where.push('id<'+bind(after));
  const sql=`
    SELECT id::text,externalid,title,type,year,thumbnail,metadata,revision::text
    FROM animaxia_pilot_catalog`+
    (where.length?' WHERE '+where.join(' AND '):'')+
    ' ORDER BY id DESC LIMIT '+bind(limit+1);
  return {sql,values,limit};
}
export async function listPgCatalogPilot(params={},options={}){
  if(!pgCatalogPilotEnabled())throw disabled();
  const {sql,values,limit}=buildPgCatalogPilotSearch(params);
  const result=await runner(options).query(sql,values);
  if(!Array.isArray(result.rows)||result.rows.length>limit+1)
    throw Object.assign(new Error('Invalid PostgreSQL pilot response'),{status:502});
  const data=result.rows.slice(0,limit).map(toPublic);
  return {mode:'postgresql-isolated-pilot',publicCatalogUnchanged:true,
    data,hasMore:result.rows.length>limit,
    nextAfterId:result.rows.length>limit?data.at(-1)?.id:null};
}
export async function pgCatalogPilotStatus(options={}){
  if(!pgCatalogPilotEnabled())return {enabled:false,initialized:false,publicCatalogUnchanged:true};
  try{
    const result=await runner(options).query(`
      SELECT
        (SELECT COUNT(*)::text FROM animaxia_pilot_catalog) AS documents,
        (SELECT COUNT(*)::text FROM animaxia_pilot_events) AS events
    `);
    return {enabled:true,initialized:true,mode:'postgresql-isolated-pilot',
      publicCatalogUnchanged:true,documents:Number(result.rows[0].documents),
      events:Number(result.rows[0].events)};
  }catch(err){
    // A brand new installation must allow the administrator to create the
    // schema. Do not swallow failed authentication/connection or SQL errors.
    if(err?.code==='42P01')return {enabled:true,initialized:false,
      mode:'postgresql-isolated-pilot',publicCatalogUnchanged:true,
      documents:0,events:0};
    throw err;
  }
}
export async function stopPgCatalogPilot(){
  if(pool){const old=pool;pool=null;await old.end();}
}
