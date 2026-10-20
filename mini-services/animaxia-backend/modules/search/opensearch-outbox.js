/**
 * Optional OpenSearch durable SQLite change outbox.
 * Content triggers preserve mutations even while the remote search cluster
 * is down. Single writer SQLite; multiple worker replicas are NOT supported.
 */
import { localDb } from '../local/sqlite.js';
let schemaReady=false;
export function ensureOpenSearchOutbox(){
  if(schemaReady)return;
  localDb.exec(
    "CREATE TABLE IF NOT EXISTS search_index_outbox ("+
    "contentid INTEGER PRIMARY KEY, operation TEXT NOT NULL,"+
    "version INTEGER NOT NULL DEFAULT 1, attempts INTEGER NOT NULL DEFAULT 0,"+
    "nextattemptat INTEGER NOT NULL DEFAULT 0);"+
    "CREATE INDEX IF NOT EXISTS idx_search_index_outbox_due "+
    "ON search_index_outbox(nextattemptat,contentid);"+
    "CREATE TRIGGER IF NOT EXISTS search_index_outbox_ai AFTER INSERT ON Content BEGIN "+
    "INSERT INTO search_index_outbox(contentid,operation,version) VALUES(new.id,'index',1) "+
    "ON CONFLICT(contentid) DO UPDATE SET operation='index',version=version+1,"+
    "attempts=0,nextattemptat=0; END;"+
    "CREATE TRIGGER IF NOT EXISTS search_index_outbox_au AFTER UPDATE ON Content BEGIN "+
    "INSERT INTO search_index_outbox(contentid,operation,version) VALUES(new.id,'index',1) "+
    "ON CONFLICT(contentid) DO UPDATE SET operation='index',version=version+1,"+
    "attempts=0,nextattemptat=0; END;"+
    "CREATE TRIGGER IF NOT EXISTS search_index_outbox_ad AFTER DELETE ON Content BEGIN "+
    "INSERT INTO search_index_outbox(contentid,operation,version) VALUES(old.id,'delete',1) "+
    "ON CONFLICT(contentid) DO UPDATE SET operation='delete',version=version+1,"+
    "attempts=0,nextattemptat=0; END;"
  );
  schemaReady=true;
}
const text=(v,n)=>typeof v==='string'?v.slice(0,n):'';
const names=(v)=>Array.isArray(v)?v.filter((x)=>typeof x==='string').slice(0,40).map((x)=>x.slice(0,120))
  :typeof v==='string'?[v.slice(0,120)]:[];
export function projectContent(row){
  if(!row||!Number.isSafeInteger(Number(row.id)))throw new Error('Invalid content row');
  let m={};try{m=typeof row.metadata==='string'?JSON.parse(row.metadata):row.metadata||{};}catch{/* legacy */}
  return {
    id:Number(row.id),title:text(row.title,300),title_sort:text(row.title,300).toLowerCase(),
    type:text(row.type,60).toLowerCase(),year:row.year==null?null:Number(row.year),
    externalid:text(row.externalid,220),thumbnail:text(row.thumbnail,2000),
    description:text(m.overview||m.description||m.synopsis,5000),
    actors:names(m.actors),genres:names(m.genres),studios:names(m.studios),
    franchise:text(m.franchise,160),trilogy:text(m.trilogy,160),
    collection:text(m.collection,160),posterId:text(m.posterId,160),
    sourceAttribution:text(m.sourceAttribution,160),
    rating:Number.isFinite(Number(m.rating))&&m.rating!=null&&Number(m.rating)>=0&&Number(m.rating)<=10
      ?Number(m.rating):null,
  };
}
export function seedOpenSearchOutbox({afterId=0,limit=500}={}){
  ensureOpenSearchOutbox();
  const cursor=Number(afterId),cap=Number(limit);
  if(!Number.isSafeInteger(cursor)||cursor<0||!Number.isInteger(cap)||cap<1||cap>1000)
    throw Object.assign(new Error('Invalid backfill cursor or limit'),{status:400});
  const rows=localDb.prepare('SELECT id FROM Content WHERE id>? ORDER BY id ASC LIMIT ?').all(cursor,cap);
  const insert=localDb.prepare(
    "INSERT INTO search_index_outbox(contentid,operation,version) VALUES(?,'index',1) "+
    'ON CONFLICT(contentid) DO NOTHING');
  for(const row of rows)insert.run(row.id);
  return {scanned:rows.length,nextAfterId:rows.length===cap?rows.at(-1).id:null,
    finished:rows.length<cap};
}
export function outboxStatus(){
  ensureOpenSearchOutbox();
  const row=localDb.prepare(
    'SELECT COUNT(*) AS pending,MAX(attempts) AS maxAttempts FROM search_index_outbox').get();
  return {pending:Number(row.pending||0),maxAttempts:Number(row.maxAttempts||0),
    durable:true,distributed:false};
}
export function pendingChanges(limit=40){
  ensureOpenSearchOutbox();
  const cap=Number(limit);
  if(!Number.isInteger(cap)||cap<1||cap>100)
    throw Object.assign(new Error('Invalid batch limit'),{status:400});
  const lookup=localDb.prepare('SELECT * FROM Content WHERE id=?');
  return localDb.prepare(
    'SELECT contentid,operation,version,attempts FROM search_index_outbox '+
    'WHERE nextattemptat<=unixepoch() ORDER BY contentid LIMIT ?'
  ).all(cap).map((row)=>({...row,document:lookup.get(row.contentid)||null}));
}
export function ackChange(change){
  ensureOpenSearchOutbox();
  return localDb.prepare('DELETE FROM search_index_outbox WHERE contentid=? AND version=?')
    .run(change.contentid,change.version).changes;
}
export function retryChange(change){
  ensureOpenSearchOutbox();
  const delay=Math.min(3600,5*Math.pow(2,Math.min(Number(change.attempts)||0,9)));
  localDb.prepare(
    'UPDATE search_index_outbox SET attempts=attempts+1,nextattemptat=unixepoch()+? '+
    'WHERE contentid=? AND version=?'
  ).run(delay,change.contentid,change.version);
}

/**
 * Queue specific canonical content records for another indexing attempt.
 * Existing, newer live-change jobs retain their version and precedence.
 * IDs are always selected from Content, so a deleted row cannot be
 * accidentally resurrected by a reconciliation operation.
 */
export function queueContentReindex(ids) {
  ensureOpenSearchOutbox();
  if(!Array.isArray(ids)||ids.length>50||ids.some(
    (id)=>!Number.isSafeInteger(id)||id<=0
  ))throw Object.assign(new Error('Invalid reconciliation IDs'),{status:400});
  const statement=localDb.prepare(
    "INSERT INTO search_index_outbox(contentid,operation,version) "+
    "SELECT id,'index',1 FROM Content WHERE id=? "+
    "ON CONFLICT(contentid) DO NOTHING"
  );
  let queued=0;
  for(const id of new Set(ids))queued+=statement.run(id).changes;
  return {requested:new Set(ids).size,queued,alreadyPending:new Set(ids).size-queued};
}

/**
 * Safely queue remote-only numeric content IDs for eventual deletion.
 * The SELECT NOT EXISTS Content check executes inside SQLite; if canonical
 * content is reinserted, the existing insert trigger switches this to index.
 * Existing outbox rows are NEVER replaced by a reconciliation request.
 */
export function queueRemoteOrphanDeletes(ids) {
  ensureOpenSearchOutbox();
  if(!Array.isArray(ids)||ids.length>50||ids.some(
    (id)=>!Number.isSafeInteger(id)||id<=0
  ))throw Object.assign(new Error('Invalid remote-orphan IDs'),{status:400});
  const distinct=[...new Set(ids)];
  const statement=localDb.prepare(
    "INSERT INTO search_index_outbox(contentid,operation,version) "+
    "SELECT ?,'delete',1 WHERE NOT EXISTS (SELECT 1 FROM Content WHERE id=?) "+
    "ON CONFLICT(contentid) DO NOTHING"
  );
  let queued=0;
  for(const id of distinct)queued+=statement.run(id,id).changes;
  return {requested:distinct.length,queued,skipped:distinct.length-queued};
}
