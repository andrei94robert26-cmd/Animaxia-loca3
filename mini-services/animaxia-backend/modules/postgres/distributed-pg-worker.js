/** PostgreSQL-only queue runner: no SQLite, no webserver imports. */
import pg from 'pg';
const {Pool}=pg;
let pool=null,timer=null,busy=false;
export function pgWorkerConfig(env=process.env){
  const raw=env.ANIMAXIA_PG_SHADOW_DATABASE_URL;
  if(!raw)return {configured:false};
  let url;try{url=new URL(raw);}catch{throw new Error('Invalid PostgreSQL worker URL');}
  if(!['postgresql:','postgres:'].includes(url.protocol)||!url.hostname||
    !url.username||!url.password||url.pathname==='/'||url.search||url.hash)
    throw new Error('Invalid PostgreSQL worker configuration');
  const local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  const tls=env.ANIMAXIA_PG_SHADOW_TLS!=='false';
  if(!tls&&(env.NODE_ENV==='production'||!local))
    throw new Error('PostgreSQL worker requires TLS outside loopback development');
  return {configured:true,tls};
}
function connected(){
  const c=pgWorkerConfig();
  if(!c.configured)throw Object.assign(new Error('PostgreSQL worker not configured'),{status:503});
  if(!pool){
    pool=new Pool({connectionString:process.env.ANIMAXIA_PG_SHADOW_DATABASE_URL,
      ssl:c.tls?{rejectUnauthorized:true}:false,max:4,
      connectionTimeoutMillis:4000,idleTimeoutMillis:8000,
      query_timeout:12000,statement_timeout:12000,
      application_name:'animaxia-pg-distributed-worker'});
    pool.on('error',err=>console.error('[pg-worker] connection:',err.message));
  }
  return pool;
}
const UPSERT=`
  INSERT INTO animaxia_shadow_content(id,externalid,title,type,year,thumbnail,metadata)
  VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)
  ON CONFLICT(id) DO UPDATE SET
  externalid=EXCLUDED.externalid,title=EXCLUDED.title,type=EXCLUDED.type,
  year=EXCLUDED.year,thumbnail=EXCLUDED.thumbnail,metadata=EXCLUDED.metadata,
  syncedat=NOW()
`;
export async function workDistributedShadow({limit=10,db}={}){
  const cap=Number(limit);
  if(!Number.isSafeInteger(cap)||cap<1||cap>100)
    throw Object.assign(new Error('Invalid worker limit'),{status:400});
  if(busy)return {skipped:'same-process-worker-running'};
  if(!pgWorkerConfig().configured)throw Object.assign(new Error('PostgreSQL worker not configured'),{status:503});
  busy=true;
  try{
    let processed=0,failed=0;
    for(let i=0;i<cap;i++){
      const client=await (db||connected()).connect();
      try{
        await client.query('BEGIN');
        let active=true;
        try{
          const next=await client.query(`
            SELECT contentid::text AS contentid,operation,document,generation
            FROM animaxia_shadow_tasks WHERE next_run_at<=NOW()
            ORDER BY next_run_at,contentid LIMIT 1
            FOR UPDATE SKIP LOCKED
          `);
          if(!next.rows.length){
            await client.query('COMMIT');active=false;break;
          }
          const task=next.rows[0];
          await client.query('SAVEPOINT apply_one');
          try{
            if(task.operation==='upsert'){
              const d=task.document;
              if(!d||typeof d!=='object'||String(d.id)!==task.contentid)
                throw new Error('Invalid queued catalog snapshot');
              await client.query(UPSERT,[
                task.contentid,d.externalid,d.title,d.type,d.year,d.thumbnail,
                JSON.stringify(d.metadata||{}),
              ]);
            }else if(task.operation==='delete'){
              await client.query('DELETE FROM animaxia_shadow_content WHERE id=$1',[task.contentid]);
            }else throw new Error('Invalid distributed task operation');
            await client.query(
              'DELETE FROM animaxia_shadow_tasks WHERE contentid=$1 AND generation=$2',
              [task.contentid,task.generation]);
            await client.query('RELEASE SAVEPOINT apply_one');
            await client.query('COMMIT');active=false;processed++;
          }catch(err){
            await client.query('ROLLBACK TO SAVEPOINT apply_one');
            await client.query(`
              UPDATE animaxia_shadow_tasks SET attempts=attempts+1,
                next_run_at=NOW()+LEAST(3600,5*POWER(2,LEAST(attempts,9)))*INTERVAL '1 second',
                updated_at=NOW() WHERE contentid=$1 AND generation=$2
            `,[task.contentid,task.generation]);
            await client.query('COMMIT');active=false;failed++;
            console.warn('[pg-worker] retry:',String(err.message).slice(0,120));
          }
        }catch(err){
          if(active)try{await client.query('ROLLBACK');}catch{/* disconnected */}
          throw err;
        }
      }finally{client.release();}
    }
    return {processed,failed};
  }finally{busy=false;}
}
export function startPgDistributedWorker(){
  if(timer||process.env.ANIMAXIA_PG_DISTRIBUTED_WORKER!=='true')return false;
  if(!pgWorkerConfig().configured)return false;
  timer=setInterval(()=>workDistributedShadow().catch(err=>
    console.warn('[pg-worker] polling error:',err.message)),2500);
  timer.unref?.();return true;
}
export async function stopPgDistributedWorker(){
  if(timer)clearInterval(timer);timer=null;
  if(pool){const old=pool;pool=null;await old.end();}
}
