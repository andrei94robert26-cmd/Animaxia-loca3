/**
 * Independent PostgreSQL-only native pilot event projection worker.
 * No imports of SQLite, HTTP server, player, or Content DB.
 */
import 'dotenv/config';
import {
  startPgPilotProjection,stopPgPilotProjection,
} from '../modules/postgres/pilot-projection.js';

if(process.env.ANIMAXIA_PG_CATALOG_PILOT!=='true' ||
   process.env.ANIMAXIA_PG_PILOT_PROJECTION!=='true' ||
   process.env.ANIMAXIA_PG_PILOT_PROJECTION_WORKER!=='true')
  throw new Error('Enable all three explicit native pilot projection flags');
if(!startPgPilotProjection({keepAlive:true}))
  throw new Error('PostgreSQL pilot event projection worker could not start');
console.info('[animaxia] PostgreSQL-only native pilot projection worker started');
let shuttingDown=false;
let resolveShutdown;
const stopped=new Promise(resolve=>{resolveShutdown=resolve;});
async function shutdown(signal){
  if(shuttingDown)return;
  shuttingDown=true;
  try{
    console.info('[animaxia] '+signal+' received; stopping native projection');
    await stopPgPilotProjection();
    process.exitCode=0;
  }catch(err){
    console.error('[animaxia] worker shutdown failed:',err.message);
    process.exitCode=1;
  }finally{resolveShutdown();}
}
process.once('SIGINT',()=>void shutdown('SIGINT'));
process.once('SIGTERM',()=>void shutdown('SIGTERM'));
await stopped;
