/**
 * Durable, canonical Content -> PostgreSQL shadow change outbox.
 * All writes are triggered in the same SQLite transaction as Content writes.
 * One SQLite backend writer / one PG projection worker (no distributed locks).
 */
import { localDb } from '../local/sqlite.js';

let ready = false;
export function ensurePgShadowOutbox() {
  if (ready) return;
  // Keep change revisions monotonic even after outbox ACK. A persistent
  // SQLite clock avoids reusing revision=1 for later changes to the same ID.
  // Recreate these triggers on startup to migrate existing stage-15 installs.
  localDb.exec(`
    CREATE TABLE IF NOT EXISTS pg_shadow_outbox (
      contentid INTEGER PRIMARY KEY,
      operation TEXT NOT NULL CHECK(operation IN ('upsert','delete')),
      revision INTEGER NOT NULL DEFAULT 1,
      attempts INTEGER NOT NULL DEFAULT 0,
      nextattemptat INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS pg_shadow_change_clock (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      revision INTEGER NOT NULL CHECK(revision >= 0)
    );
    INSERT OR IGNORE INTO pg_shadow_change_clock(singleton,revision)
      VALUES(1,0);
    UPDATE pg_shadow_change_clock SET revision=MAX(
      revision,(SELECT COALESCE(MAX(revision),0) FROM pg_shadow_outbox)
    ) WHERE singleton=1;
    CREATE INDEX IF NOT EXISTS idx_pg_shadow_due
      ON pg_shadow_outbox(nextattemptat, contentid);
    DROP TRIGGER IF EXISTS pg_shadow_content_ai;
    DROP TRIGGER IF EXISTS pg_shadow_content_au;
    DROP TRIGGER IF EXISTS pg_shadow_content_ad;
    CREATE TRIGGER pg_shadow_content_ai AFTER INSERT ON Content BEGIN
      UPDATE pg_shadow_change_clock SET revision=revision+1 WHERE singleton=1;
      INSERT INTO pg_shadow_outbox(contentid,operation,revision)
      VALUES(new.id,'upsert',(SELECT revision FROM pg_shadow_change_clock WHERE singleton=1))
      ON CONFLICT(contentid) DO UPDATE SET operation='upsert',
        revision=excluded.revision,attempts=0,nextattemptat=0;
    END;
    CREATE TRIGGER pg_shadow_content_au AFTER UPDATE ON Content BEGIN
      UPDATE pg_shadow_change_clock SET revision=revision+1 WHERE singleton=1;
      INSERT INTO pg_shadow_outbox(contentid,operation,revision)
      VALUES(new.id,'upsert',(SELECT revision FROM pg_shadow_change_clock WHERE singleton=1))
      ON CONFLICT(contentid) DO UPDATE SET operation='upsert',
        revision=excluded.revision,attempts=0,nextattemptat=0;
    END;
    CREATE TRIGGER pg_shadow_content_ad AFTER DELETE ON Content BEGIN
      UPDATE pg_shadow_change_clock SET revision=revision+1 WHERE singleton=1;
      INSERT INTO pg_shadow_outbox(contentid,operation,revision)
      VALUES(old.id,'delete',(SELECT revision FROM pg_shadow_change_clock WHERE singleton=1))
      ON CONFLICT(contentid) DO UPDATE SET operation='delete',
        revision=excluded.revision,attempts=0,nextattemptat=0;
    END;
  `);
  ready = true;
}
const positiveInt = (v, max, field) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 1 || n > max)
    throw Object.assign(new Error('Invalid '+field),{status:400});
  return n;
};
export function pgShadowPending(limit=50) {
  ensurePgShadowOutbox();
  const cap=positiveInt(limit,100,'outbox batch limit');
  const lookup=localDb.prepare('SELECT * FROM Content WHERE id=?');
  return localDb.prepare(`
    SELECT contentid,operation,revision,attempts FROM pg_shadow_outbox
    WHERE nextattemptat<=unixepoch()
    ORDER BY contentid LIMIT ?
  `).all(cap).map((job)=>({...job,document:lookup.get(job.contentid)||null}));
}
export function pgShadowAck(job) {
  ensurePgShadowOutbox();
  return localDb.prepare(
    'DELETE FROM pg_shadow_outbox WHERE contentid=? AND revision=?'
  ).run(job.contentid,job.revision).changes;
}
export function pgShadowRetry(job) {
  ensurePgShadowOutbox();
  const delay=Math.min(3600,5*2**Math.min(Number(job.attempts)||0,9));
  return localDb.prepare(`
    UPDATE pg_shadow_outbox SET attempts=attempts+1,
      nextattemptat=unixepoch()+?
    WHERE contentid=? AND revision=?
  `).run(delay,job.contentid,job.revision).changes;
}
export function pgShadowOutboxStatus() {
  ensurePgShadowOutbox();
  const s=localDb.prepare(`
    SELECT COUNT(*) AS pending,
      SUM(CASE WHEN operation='delete' THEN 1 ELSE 0 END) AS deletes,
      MAX(attempts) AS retries FROM pg_shadow_outbox
  `).get();
  return {storage:'sqlite',durable:true,distributed:false,
    pending:Number(s.pending||0),deletes:Number(s.deletes||0),
    maxRetries:Number(s.retries||0)};
}
export function seedPgShadowOutbox({afterId=0,limit=500}={}) {
  ensurePgShadowOutbox();
  const cursor=Number(afterId),cap=positiveInt(limit,1000,'backfill limit');
  if(!Number.isSafeInteger(cursor)||cursor<0)
    throw Object.assign(new Error('Invalid backfill cursor'),{status:400});
  const rows=localDb.prepare(
    'SELECT id FROM Content WHERE id>? ORDER BY id ASC LIMIT ?'
  ).all(cursor,cap);
  const insert=localDb.prepare(`
    INSERT INTO pg_shadow_outbox(contentid,operation,revision)
    VALUES(?,'upsert',(SELECT revision FROM pg_shadow_change_clock WHERE singleton=1))
    ON CONFLICT(contentid) DO NOTHING
  `);
  // node:sqlite DatabaseSync has no transaction(fn) API.
  // SQLite's BEGIN IMMEDIATE / COMMIT ensures a bounded, atomic backfill.
  localDb.exec('BEGIN IMMEDIATE');
  try {
    for(const row of rows)insert.run(row.id);
    localDb.exec('COMMIT');
  } catch(err) {
    localDb.exec('ROLLBACK');
    throw err;
  }
  return {scanned:rows.length,nextAfterId:rows.length===cap?rows.at(-1).id:null,
    finished:rows.length<cap};
}

/**
 * Repair missing or stale projected rows without overwriting a newer
 * existing outbox event. Rejects nonexistent canonical Content IDs.
 */
export function queuePgShadowRepair(ids) {
  ensurePgShadowOutbox();
  if(!Array.isArray(ids)||ids.length>50||ids.some(
    (id)=>!Number.isSafeInteger(id)||id<=0
  ))throw Object.assign(new Error('Invalid PostgreSQL shadow repair IDs'),{status:400});
  const distinct=[...new Set(ids)];
  const statement=localDb.prepare(
    "INSERT INTO pg_shadow_outbox(contentid,operation,revision) "+
    "SELECT id,'upsert',(SELECT revision FROM pg_shadow_change_clock WHERE singleton=1) "+
    "FROM Content WHERE id=? ON CONFLICT(contentid) DO NOTHING"
  );
  let queued=0;
  localDb.exec('BEGIN IMMEDIATE');
  try{
    for(const id of distinct)queued+=statement.run(id).changes;
    localDb.exec('COMMIT');
  }catch(err){localDb.exec('ROLLBACK');throw err;}
  return {requested:distinct.length,queued,alreadyPendingOrMissing:distinct.length-queued};
}
