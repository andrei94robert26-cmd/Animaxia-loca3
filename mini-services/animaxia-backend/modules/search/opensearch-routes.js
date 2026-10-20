/**
 * OpenSearch operations: admin-only, no arbitrary URLs and no public writes.
 * The SQLite catalog stays the write source of truth.
 */
import express from 'express';
import { requireAuth,requireAdmin } from '../users/auth.js';
import { userRateLimit } from '../security/security.js';
import { seedOpenSearchOutbox } from './opensearch-outbox.js';
import { localDb } from '../local/sqlite.js';
import {
  openSearchWorkerState,ensureDistributedIndex,flushDistributedOutbox,
  requestDistributed,distributedConfig,
} from './opensearch.js';

const router=express.Router();
router.use('/opensearch',requireAuth,requireAdmin);
const limit=userRateLimit({scope:'ip',max:10,windowMs:60_000,key:'opensearch-control'});
router.get('/opensearch/status',(_req,res,next)=>{
  try{return res.json(openSearchWorkerState());}
  catch(err){return next(err);}
});
router.get('/opensearch/compare',limit,async(_req,res,next)=>{
  try {
    const c=distributedConfig();
    if(!c.configured) return res.status(503).json({error:'OpenSearch is not configured'});
    const localCount=Number(localDb.prepare('SELECT COUNT(*) AS n FROM Content').get().n);
    const remote=await requestDistributed('/'+c.index+'/_count');
    if(!Number.isSafeInteger(remote.count)||remote.count<0)
      throw Object.assign(new Error('Invalid OpenSearch count'),{status:502});
    const state=openSearchWorkerState();
    return res.json({
      localCount,remoteCount:remote.count,delta:localCount-remote.count,
      pending:state.pending,
      countAligned:localCount===remote.count&&state.pending===0,
      note:'Equal counts do not prove document identity or full index consistency.',
    });
  }catch(err){return next(err);}
});
router.post('/opensearch/setup',limit,async(_req,res,next)=>{
  try{return res.json(await ensureDistributedIndex());}
  catch(err){return next(err);}
});
router.post('/opensearch/backfill',limit,(req,res,next)=>{
  try{
    if(!process.env.ANIMAXIA_OPENSEARCH_URL)
      return res.status(503).json({error:'OpenSearch is not configured'});
    return res.json(seedOpenSearchOutbox({
      afterId:req.body?.afterId??0,limit:req.body?.limit??500,
    }));
  }catch(err){return next(err);}
});
router.post('/opensearch/flush',limit,async(req,res,next)=>{
  try{return res.json(await flushDistributedOutbox({limit:req.body?.limit??40}));}
  catch(err){return next(err);}
});
export default router;
