/**
 * Scan a bounded page of numeric OpenSearch IDs that are absent from the
 * authoritative SQLite Content catalog. No deletion occurs unless explicitly
 * requested and the outbox worker later processes the queued tombstone.
 */
import { localDb } from '../local/sqlite.js';
import { ensureOpenSearchOutbox,queueRemoteOrphanDeletes,outboxStatus } from './opensearch-outbox.js';
import { requestDistributed,distributedConfig } from './opensearch.js';

export function buildOrphanScanQuery({afterId=0,limit=25}={}) {
  const cursor=Number(afterId);
  const cap=Number(limit);
  if(!Number.isSafeInteger(cursor)||cursor<0)
    throw Object.assign(new Error('afterId must be a nonnegative integer'),{status:400});
  if(!Number.isInteger(cap)||cap<1||cap>50)
    throw Object.assign(new Error('limit must be 1..50'),{status:400});
  return {
    cursor,cap,
    body:{
      size:cap+1,track_total_hits:false,_source:false,
      query:{match_all:{}},sort:[{id:{order:'asc'}}],
      ...(cursor>0?{search_after:[cursor]}:{}),
    },
  };
}
export async function detectOpenSearchOrphans(
  {afterId=0,limit=25,dryRun=true}={},{fetchImpl=globalThis.fetch}={}
) {
  if(typeof dryRun!=='boolean')
    throw Object.assign(new Error('dryRun must be boolean'),{status:400});
  const {cursor,cap,body}=buildOrphanScanQuery({afterId,limit});
  const config=distributedConfig();
  if(!config.configured)
    throw Object.assign(new Error('OpenSearch is not configured'),{status:503});
  ensureOpenSearchOutbox();
  const response=await requestDistributed('/'+config.index+'/_search',{
    method:'POST',body,fetchImpl,
  });
  if(!Array.isArray(response.hits?.hits)||response.hits.hits.length>cap+1 ||
    response._shards?.failed>0||response.timed_out===true)
    throw Object.assign(new Error('Incomplete OpenSearch scan; no deletes queued'),{status:502});

  const scanned=response.hits.hits.slice(0,cap);
  const remoteIds=[];
  let previous=cursor;
  for(const hit of scanned){
    const id=Number(hit?._id);
    if(!Number.isSafeInteger(id)||id<=previous||id<=0 ||
      !Array.isArray(hit?.sort)||hit.sort.length!==1||hit.sort[0]!==id){
      throw Object.assign(new Error('Invalid remote ID or sort order; no deletes queued'),{status:502});
    }
    previous=id;remoteIds.push(id);
  }
  // Check the canonical source of truth before proposing a remote deletion.
  const exists=localDb.prepare('SELECT 1 AS present FROM Content WHERE id=?');
  const orphanIds=remoteIds.filter(id=>!exists.get(id));
  const repair=dryRun?{queued:0,skipped:0}:queueRemoteOrphanDeletes(orphanIds);
  const more=response.hits.hits.length>cap;
  return {
    scanned:scanned.length,
    present:scanned.length-orphanIds.length,
    orphaned:orphanIds.length,
    repairQueued:repair.queued,
    alreadyPendingOrRestored:repair.skipped,
    dryRun,
    nextAfterId:more?scanned.at(-1)?.sort[0]:null,
    finished:!more,
    pending:outboxStatus().pending,
    note:'Scans only indexed positive numeric content IDs. Deletes remain queued until worker flush; no cross-cluster snapshot guarantee.',
  };
}
