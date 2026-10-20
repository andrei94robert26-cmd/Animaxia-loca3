/**
 * Dedicated PG-only task worker. Does not load Express, Content, or SQLite.
 * Run with npm run worker:postgres-shadow after admin queue setup.
 */
import 'dotenv/config';
import {
  pgWorkerConfig,startPgDistributedWorker,stopPgDistributedWorker,
} from '../modules/postgres/distributed-pg-worker.js';

if(process.env.ANIMAXIA_PG_DISTRIBUTED_WORKER!=='true')
  throw new Error('Set ANIMAXIA_PG_DISTRIBUTED_WORKER=true explicitly');
if(!pgWorkerConfig().configured)
  throw new Error('Set ANIMAXIA_PG_SHADOW_DATABASE_URL to a secured PostgreSQL service');
if(!startPgDistributedWorker())throw new Error('Could not start PostgreSQL worker');
console.info('[animaxia] PostgreSQL-only worker started');
let shuttingDown=false;
async function shutdown(signal){
  if(shuttingDown)return;
  shuttingDown=true;
  console.info('[animaxia] '+signal+' received; closing worker');
  await stopPgDistributedWorker();
  process.exitCode=0;
}
process.once('SIGTERM',()=>void shutdown('SIGTERM'));
process.once('SIGINT',()=>void shutdown('SIGINT'));
// The independent worker runs until signalled.
await new Promise(()=>{});
