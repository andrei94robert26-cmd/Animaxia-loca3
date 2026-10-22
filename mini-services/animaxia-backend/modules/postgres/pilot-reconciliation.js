/**
 * Stage 20: bidirectional consistency audit for the isolated PG-native
 * catalog and its PostgreSQL search projection. No SQLite or media access.
 * Bounded, keyset-paginated checks; repair enqueues ordinary native events
 * rather than directly changing the projection.
 */
import { isDeepStrictEqual } from 'node:util';
import pg from 'pg';
import {pgWorkerConfig} from './distributed-pg-worker.js';
import {pgCatalogPilotEnabled} from './catalog-pilot.js';

const {Pool}=pg;
let pool=null;
const invalid=(message)=>Object.assign(new Error(message),{status:400});
function configured(){
  if(!pgCatalogPilotEnabled()||process.env.ANIMAXIA_PG_PILOT_PROJECTION!=='true')
    throw Object.assign(new Error('PostgreSQL pilot reconciliation is disabled'),{status:503});
  if(!pgWorkerConfig().configured)
    throw Object.assign(new Error('PostgreSQL is not configured'),{status:503});
}
function connection(){
  configured();
  if(!pool){
    const config=pgWorkerConfig();
    pool=new Pool({
      connectionString:process.env.ANIMAXIA_PG_SHADOW_DATABASE_URL,
      ssl:config.tls?{rejectUnauthorized:true}:false,max:3,
      connectionTimeoutMillis:4000,idleTimeoutMillis:8000,
      query_timeout:12000,statement_timeout:12000,
      application_name:'animaxia-pilot-reconciliation',
    });
    pool.on('error',err=>console.warn('[pilot-reconcile] idle PG connection:',err.message));
  }
  return pool;
}
function parseOptions({scope='catalog',afterId=0,afterExternalId='',limit=25,dryRun=true}={}){
  if(scope!=='catalog'&&scope!=='orphans')throw invalid('Invalid reconciliation scope');
  const cap=Number(limit);
  if(!Number.isInteger(cap)||cap<1||cap>50)throw invalid('Reconciliation limit must be 1..50');
  if(typeof dryRun!=='boolean')throw invalid('dryRun must be a boolean');
  const cursor=Number(afterId);
  if(!Number.isSafeInteger(cursor)||cursor<0)throw invalid('Invalid catalog afterId');
  if(typeof afterExternalId!=='string'||afterExternalId.length>220)
    throw invalid('Invalid orphan afterExternalId');
  return {scope,afterId:cursor,afterExternalId,limit:cap,dryRun};
}
const toId=value=>{
  const id=Number(value);
  if(!Number.isSafeInteger(id)||id<1)
    throw Object.assign(new Error('Invalid PostgreSQL pilot row ID'),{status:502});
  return id;
};
const equalValues=(native,replica)=>isDeepStrictEqual({
  contentid:String(native.id),
  externalid:native.externalid,title:native.title,
  type:native.type,year:native.year,thumbnail:native.thumbnail,
  revision:String(native.revision),metadata:native.metadata,
},{
  contentid:String(replica.contentid),
  externalid:replica.externalid,title:replica.title,
  type:replica.type,year:replica.year,thumbnail:replica.thumbnail,
  revision:String(replica.revision),metadata:replica.metadata,
});
const sourceQuery=`
  SELECT c.id::text AS id,c.externalid,c.title,c.type,c.year,
    c.thumbnail,c.metadata,c.revision::text AS revision,
    p.contentid::text AS projectedid,p.title AS projectedtitle,
    p.type AS projectedtype,p.year AS projectedyear,
    p.thumbnail AS projectedthumbnail,p.metadata AS projectedmetadata,
    p.revision::text AS projectedrevision
  FROM animaxia_pilot_catalog c
  LEFT JOIN animaxia_pilot_search_projection p ON p.externalid=c.externalid
  WHERE c.id>$1 ORDER BY c.id ASC LIMIT $2
`;
const orphanQuery=`
  SELECT p.externalid,p.contentid::text AS contentid,
    c.id::text AS nativeid
  FROM animaxia_pilot_search_projection p
  LEFT JOIN animaxia_pilot_catalog c ON c.externalid=p.externalid
  WHERE p.externalid>$1 ORDER BY p.externalid ASC LIMIT $2
`;
const queueCatalog=`
  INSERT INTO animaxia_pilot_events(contentid,externalid,operation,revision)
  SELECT c.id,c.externalid,'upsert',c.revision
  FROM animaxia_pilot_catalog c
  WHERE c.externalid=ANY($1::text[])
    AND NOT EXISTS(
      SELECT 1 FROM animaxia_pilot_events e
      WHERE e.externalid=c.externalid AND e.projection_applied_at IS NULL
    )
  RETURNING eventid
`;
const queueOrphans=`
  INSERT INTO animaxia_pilot_events(contentid,externalid,operation,revision)
  SELECT p.contentid,p.externalid,'delete',p.revision
  FROM animaxia_pilot_search_projection p
  WHERE p.externalid=ANY($1::text[])
    AND NOT EXISTS(
      SELECT 1 FROM animaxia_pilot_catalog c WHERE c.externalid=p.externalid
    )
    AND NOT EXISTS(
      SELECT 1 FROM animaxia_pilot_events e
      WHERE e.externalid=p.externalid AND e.projection_applied_at IS NULL
    )
  RETURNING eventid
`;
export async function reconcilePgPilotProjection(opts={}, {db}={}){
  const o=parseOptions(opts);
  configured();
  const client=db||connection();
  // One bounded read in a single PostgreSQL statement, not a global snapshot.
  const scan=o.scope==='catalog'
    ?await client.query(sourceQuery,[o.afterId,o.limit+1])
    :await client.query(orphanQuery,[o.afterExternalId,o.limit+1]);
  if(!Array.isArray(scan?.rows)||scan.rows.length>o.limit+1)
    throw Object.assign(new Error('Invalid PostgreSQL reconciliation result'),{status:502});
  const page=scan.rows.slice(0,o.limit);
  let missing=0,mismatched=0,matched=0,orphaned=0;
  const fix=[];
  let lastNumeric=o.afterId,lastExternal=o.afterExternalId;
  for(const row of page){
    if(o.scope==='catalog'){
      const id=toId(row.id);
      if(id<=lastNumeric||typeof row.externalid!=='string')
        throw Object.assign(new Error('Invalid PostgreSQL catalog scan order'),{status:502});
      lastNumeric=id;
      if(row.projectedid===null){
        missing++;fix.push(row.externalid);
      }else{
        const native={id:row.id,externalid:row.externalid,title:row.title,
          type:row.type,year:row.year,thumbnail:row.thumbnail,
          metadata:row.metadata,revision:row.revision};
        const replica={contentid:row.projectedid,externalid:row.externalid,
          title:row.projectedtitle,type:row.projectedtype,
          year:row.projectedyear,thumbnail:row.projectedthumbnail,
          metadata:row.projectedmetadata,revision:row.projectedrevision};
        if(equalValues(native,replica))matched++;
        else{mismatched++;fix.push(row.externalid);}
      }
    }else{
      if(typeof row.externalid!=='string'||row.externalid<=lastExternal)
        throw Object.assign(new Error('Invalid PostgreSQL orphan scan order'),{status:502});
      lastExternal=row.externalid;
      toId(row.contentid);
      if(row.nativeid===null){orphaned++;fix.push(row.externalid);}
      else matched++;
    }
  }
  let queued=0;
  if(!o.dryRun&&fix.length){
    const write=await client.query(o.scope==='catalog'?queueCatalog:queueOrphans,[fix]);
    if(!Array.isArray(write.rows)||write.rows.length>fix.length)
      throw Object.assign(new Error('Invalid PostgreSQL repair response'),{status:502});
    queued=write.rows.length;
  }
  return {
    scope:o.scope,scanned:page.length,matched,missing,mismatched,orphaned,
    repairCandidates:fix.length,repairQueued:queued,
    alreadyPendingOrResolved:fix.length-queued,dryRun:o.dryRun,
    nextAfterId:o.scope==='catalog'&&scan.rows.length>o.limit?lastNumeric:null,
    nextAfterExternalId:o.scope==='orphans'&&scan.rows.length>o.limit?lastExternal:null,
    finished:scan.rows.length<=o.limit,
    note:'Bounded administrator audit of isolated PostgreSQL pilot only; writes may change between audit and repair.',
  };
}
export async function stopPgPilotReconciliation(){
  if(pool){const old=pool;pool=null;await old.end();}
}
