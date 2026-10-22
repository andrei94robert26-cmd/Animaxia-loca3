/**
 * Read-only or explicitly repairable SQLite→PostgreSQL shadow audit.
 * Uses bounded keyset windows and parameterized PostgreSQL reads.
 * SQL count alignment alone is insufficient for a safe catalog cutover.
 */
import { isDeepStrictEqual } from 'node:util';
import { localDb } from '../local/sqlite.js';
import { pgShadowConfig,shadowPgQuery,projectPgShadow } from './shadow.js';
import { queuePgShadowRepair,pgShadowOutboxStatus } from './shadow-outbox.js';

const invalid=(message)=>Object.assign(new Error(message),{status:400});
export async function verifyPgShadow(
  {afterId=0,limit=25,dryRun=true}={},{db}={}
) {
  const cursor=Number(afterId),cap=Number(limit);
  if(!Number.isSafeInteger(cursor)||cursor<0)throw invalid('Invalid shadow audit afterId');
  if(!Number.isInteger(cap)||cap<1||cap>50)throw invalid('Shadow audit limit must be 1..50');
  if(typeof dryRun!=='boolean')throw invalid('dryRun must be boolean');
  if(!pgShadowConfig().configured)
    throw Object.assign(new Error('PostgreSQL shadow not configured'),{status:503});
  const records=localDb.prepare(
    'SELECT * FROM Content WHERE id>? ORDER BY id ASC LIMIT ?'
  ).all(cursor,cap);
  if(!records.length)return {
    scanned:0,matched:0,missing:0,mismatched:0,repairCandidates:0,
    repairQueued:0,alreadyPendingOrMissing:0,afterId:cursor,
    nextAfterId:null,finished:true,dryRun,pending:pgShadowOutboxStatus().pending,
    note:'Local-only keyset audit; remote-only orphaned PostgreSQL rows are not enumerated.',
  };
  const ids=records.map((row)=>String(row.id));
  const result=await shadowPgQuery(
    'SELECT id::text AS id,externalid,title,type,year,thumbnail,metadata '+
    'FROM animaxia_shadow_content WHERE id = ANY($1::bigint[])',
    [ids],{db});
  if(!Array.isArray(result?.rows)||result.rows.length>records.length)
    throw Object.assign(new Error('Invalid PostgreSQL shadow audit result'),{status:502});
  const byId=new Map();
  for(const row of result.rows){
    if(typeof row.id!=='string'||!ids.includes(row.id)||byId.has(row.id)){
      throw Object.assign(new Error('Unexpected or duplicate PostgreSQL shadow row'),{status:502});
    }
    byId.set(row.id,row);
  }
  let matched=0,missing=0,mismatched=0;
  const repairIds=[];
  for(const canonical of records){
    const id=String(canonical.id);
    const replica=byId.get(id);
    if(!replica){missing++;repairIds.push(canonical.id);continue;}
    const expected=projectPgShadow(canonical);
    const actual={
      id:Number(replica.id),externalid:replica.externalid,
      title:replica.title,type:replica.type,
      year:replica.year===null?null:Number(replica.year),
      thumbnail:replica.thumbnail,metadata:replica.metadata,
    };
    if(isDeepStrictEqual(expected,actual))matched++;
    else{mismatched++;repairIds.push(canonical.id);}
  }
  const repair=dryRun?{queued:0,alreadyPendingOrMissing:0}:queuePgShadowRepair(repairIds);
  return {
    scanned:records.length,matched,missing,mismatched,
    repairCandidates:repairIds.length,repairQueued:repair.queued,
    alreadyPendingOrMissing:repair.alreadyPendingOrMissing,
    afterId:cursor,nextAfterId:records.length===cap?records.at(-1).id:null,
    finished:records.length<cap,dryRun,
    pending:pgShadowOutboxStatus().pending,
    note:'Local-only keyset audit; remote-only orphaned PostgreSQL rows are not enumerated.',
  };
}
