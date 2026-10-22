/** Administrator-only shadow PostgreSQL migration operations. */
import express from 'express';
import { readPgShadowCatalog } from './shadow-read.js';
import { setupPgPilotProjection,flushPgPilotProjection,pgPilotProjectionStatus,getPgPilotProjectedItems } from './pilot-projection.js';
import { verifyPgShadow } from './shadow-verify.js';
import {
  setupPgCatalogPilot,upsertPgCatalogPilot,deletePgCatalogPilot,
  listPgCatalogPilot,pgCatalogPilotStatus,
} from './catalog-pilot.js';
import {setupDistributedShadow,stageDistributedShadow,workDistributedShadow,distributedShadowStatus} from './distributed-shadow.js';
import { requireAuth, requireAdmin } from '../users/auth.js';
import { userRateLimit } from '../security/security.js';
import {
  pgShadowStatus,setupPgShadow,flushPgShadow,
  comparePgShadow,seedPgShadowOutbox,
} from './shadow.js';

const router=express.Router();
router.use(requireAuth,requireAdmin);
const limiter=userRateLimit({
  scope:'ip',max:8,windowMs:60_000,key:'postgres-shadow-ops',
});
router.get('/distributed/status',async(_req,res,next)=>{
  try{return res.json(await distributedShadowStatus());}
  catch(err){return next(err);}
});
router.post('/distributed/setup',limiter,async(_req,res,next)=>{
  try{
    await setupPgShadow();
    return res.json(await setupDistributedShadow());
  }catch(err){return next(err);}
});
router.post('/distributed/stage',limiter,async(req,res,next)=>{
  try{return res.json(await stageDistributedShadow({limit:req.body?.limit??40}));}
  catch(err){return next(err);}
});
router.post('/distributed/process',limiter,async(req,res,next)=>{
  try{return res.json(await workDistributedShadow({limit:req.body?.limit??10}));}
  catch(err){return next(err);}
});
// All pilot routes inherit requireAuth+requireAdmin from this router.
router.get('/pilot/projection/status',limiter,async(_req,res,next)=>{
  try{return res.json(await pgPilotProjectionStatus());}
  catch(err){return next(err);}
});
router.post('/pilot/projection/setup',limiter,async(_req,res,next)=>{
  try{return res.json(await setupPgPilotProjection());}
  catch(err){return next(err);}
});
router.post('/pilot/projection/flush',limiter,async(req,res,next)=>{
  try{return res.json(await flushPgPilotProjection({limit:req.body?.limit??20}));}
  catch(err){return next(err);}
});
router.get('/pilot/projection/items',limiter,async(req,res,next)=>{
  try{return res.json(await getPgPilotProjectedItems(req.query));}
  catch(err){return next(err);}
});
router.get('/pilot/status',limiter,async(_req,res,next)=>{
  try{return res.json(await pgCatalogPilotStatus());}
  catch(err){return next(err);}
});
router.post('/pilot/setup',limiter,async(_req,res,next)=>{
  try{return res.json(await setupPgCatalogPilot());}
  catch(err){return next(err);}
});
router.get('/pilot/items',limiter,async(req,res,next)=>{
  try{return res.json(await listPgCatalogPilot(req.query));}
  catch(err){return next(err);}
});
router.post('/pilot/items',limiter,async(req,res,next)=>{
  try{return res.status(200).json(await upsertPgCatalogPilot(req.body));}
  catch(err){return next(err);}
});
router.delete('/pilot/items/:externalid',limiter,async(req,res,next)=>{
  try{return res.json(await deletePgCatalogPilot(req.params.externalid));}
  catch(err){return next(err);}
});
router.get('/status',(_req,res,next)=>{
  try{return res.json(pgShadowStatus());}
  catch(err){return next(err);}
});
router.get('/catalog',limiter,async(req,res,next)=>{
  try { return res.json(await readPgShadowCatalog(req.query)); }
  catch(err){ return next(err); }
});
router.post('/verify',limiter,async(req,res,next)=>{
  try{
    return res.json(await verifyPgShadow({
      afterId:req.body?.afterId??0,
      limit:req.body?.limit??25,
      dryRun:req.body?.dryRun??true,
    }));
  }catch(err){return next(err);}
});
router.post('/setup',limiter,async(_req,res,next)=>{
  try{return res.json(await setupPgShadow());}
  catch(err){return next(err);}
});
router.post('/backfill',limiter,(req,res,next)=>{
  try{
    if(!pgShadowStatus().configured)return res.status(503).json({
      error:'PostgreSQL shadow is not configured',
    });
    return res.json(seedPgShadowOutbox({
      afterId:req.body?.afterId??0,limit:req.body?.limit??500,
    }));
  }catch(err){return next(err);}
});
router.post('/flush',limiter,async(req,res,next)=>{
  try{return res.json(await flushPgShadow({limit:req.body?.limit??40}));}
  catch(err){return next(err);}
});
router.get('/compare',limiter,async(_req,res,next)=>{
  try{return res.json(await comparePgShadow());}
  catch(err){return next(err);}
});
export default router;
