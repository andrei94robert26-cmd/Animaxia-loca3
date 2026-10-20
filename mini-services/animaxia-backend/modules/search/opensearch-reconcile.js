/**
 * Bounded source-of-truth to OpenSearch reconciliation.
 * Comparison is document-level, not only approximate total counts.
 * Admins choose dry run or explicitly queue repair.
 */
import { localDb } from '../local/sqlite.js';
import { projectContent, queueContentReindex, outboxStatus } from './opensearch-outbox.js';
import { requestDistributed, distributedConfig } from './opensearch.js';

function validCursor(value) {
  const n = Number(value);
  if(!Number.isSafeInteger(n)||n<0)throw Object.assign(
    new Error('afterId must be a nonnegative integer'),{status:400});
  return n;
}
function countLimit(value) {
  const n=Number(value);
  if(!Number.isInteger(n)||n<1||n>50)throw Object.assign(
    new Error('limit must be 1..50'),{status:400});
  return n;
}
function fieldsEqual(expected,actual) {
  if(!actual||typeof actual!=='object'||Array.isArray(actual))return false;
  for(const [key,value] of Object.entries(expected)) {
    if(JSON.stringify(value)!==JSON.stringify(actual[key]))return false;
  }
  return true;
}
export async function reconcileOpenSearchDocuments(
  {afterId=0,limit=25,dryRun=true}={},
  {fetchImpl=globalThis.fetch}={}
) {
  const cursor=validCursor(afterId);
  const cap=countLimit(limit);
  if(typeof dryRun!=='boolean')throw Object.assign(
    new Error('dryRun must be boolean'),{status:400});
  const cfg=distributedConfig();
  if(!cfg.configured)throw Object.assign(
    new Error('OpenSearch is not configured'),{status:503});
  const rows=localDb.prepare(
    'SELECT * FROM Content WHERE id>? ORDER BY id ASC LIMIT ?'
  ).all(cursor,cap);
  if(rows.length===0)return {
    scanned:0,matched:0,missing:0,mismatched:0,repairCandidates:0,
    repairQueued:0,alreadyPending:0,dryRun,nextAfterId:null,finished:true,
    pending:outboxStatus().pending,
    note:'Local keyset sample only; remote-only orphaned documents are not enumerated.',
  };
  const remote=await requestDistributed('/'+cfg.index+'/_mget',{
    method:'POST',body:{ids:rows.map((row)=>String(row.id))},fetchImpl,
  });
  if(!Array.isArray(remote.docs)||remote.docs.length!==rows.length)throw Object.assign(
    new Error('Incomplete OpenSearch mget response; no repair queued'),{status:502});
  // Validate the complete batch BEFORE enqueuing anything. A shard failure
  // or reordered response must not be mislabeled as a missing document.
  const results=[];
  for(let i=0;i<rows.length;i++){
    const doc=remote.docs[i];
    if(!doc||doc._id!==String(rows[i].id)||doc.error||typeof doc.found!=='boolean') {
      throw Object.assign(new Error('Invalid or partial OpenSearch mget response'),{status:502});
    }
    const expected=projectContent(rows[i]);
    if(!doc.found){
      results.push({id:rows[i].id,status:'missing'});
      continue;
    }
    if(!doc._source||typeof doc._source!=='object')throw Object.assign(
      new Error('OpenSearch mget response missing _source'),{status:502});
    results.push({id:rows[i].id,
      status:fieldsEqual(expected,doc._source)?'matched':'mismatched'});
  }
  const ids=results.filter((item)=>item.status!=='matched').map((item)=>item.id);
  const repaired=dryRun?{queued:0,alreadyPending:0}:queueContentReindex(ids);
  return {
    scanned:rows.length,
    matched:results.filter((item)=>item.status==='matched').length,
    missing:results.filter((item)=>item.status==='missing').length,
    mismatched:results.filter((item)=>item.status==='mismatched').length,
    repairCandidates:ids.length,repairQueued:repaired.queued,
    alreadyPending:repaired.alreadyPending,dryRun,
    nextAfterId:rows.length===cap?rows.at(-1).id:null,
    finished:rows.length<cap,
    pending:outboxStatus().pending,
    note:'Local keyset sample only; remote-only orphaned documents are not enumerated.',
  };
}
