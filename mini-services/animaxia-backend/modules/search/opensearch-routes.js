/**
 * OpenSearch operations: admin-only, no arbitrary URLs and no public writes.
 * The SQLite catalog stays the write source of truth.
 */
import express from 'express';
import { requireAuth,requireAdmin } from '../users/auth.js';
import { userRateLimit } from '../security/security.js';
import { seedOpenSearchOutbox } from './opensearch-outbox.js';
import {
  openSearchWorkerState,ensureDistributedIndex,flushDistributedOutbox,
} from './opensearch.js';

const router=express.Router();
router.use('/opensearch',requireAuth,requireAdmin);
const limit=userRateLimit({scope:'ip',max:10,windowMs:60_000,key:'opensearch-control'});
router.get('/opensearch/status',(_req,res,next)=>{
  try{return res.json(openSearchWorkerState());}
  catch(err){return next(err);}
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
