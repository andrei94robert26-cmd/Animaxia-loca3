/**
 * Opt-in OpenSearch transport, mapping, idempotent bulk outbox and search.
 * Requires a real cluster to be configured. Default remains SQLite FTS5.
 */
import crypto from 'node:crypto';
import { normalizedType } from './sqlite-advanced.js';
import {
  ensureOpenSearchOutbox,projectContent,pendingChanges,ackChange,retryChange,outboxStatus,
} from './opensearch-outbox.js';
import { logger } from '../../utils/logger.js';

const INDEX=/^[a-z][a-z0-9._-]{2,62}$/;
let processing=false;
let timer=null;
export function distributedConfig(env=process.env){
  const name=env.ANIMAXIA_OPENSEARCH_INDEX||'animaxia-content-v1';
  if(!INDEX.test(name))throw Object.assign(new Error('Invalid OpenSearch index name'),{status:500});
  if(!env.ANIMAXIA_OPENSEARCH_URL)return {configured:false,index:name};
  const url=new URL(env.ANIMAXIA_OPENSEARCH_URL);
  if(url.username||url.password||url.search||url.hash||url.pathname!=='/' ||
    !['https:','http:'].includes(url.protocol))
    throw Object.assign(new Error('OpenSearch URL must be an HTTP(S) origin'),{status:500});
  const loopback=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if(url.protocol!=='https:'&&(!loopback||env.NODE_ENV==='production'))
    throw Object.assign(new Error('OpenSearch requires HTTPS except local development'),{status:500});
  const user=env.ANIMAXIA_OPENSEARCH_USERNAME||'';
  const password=env.ANIMAXIA_OPENSEARCH_PASSWORD||'';
  const apiKey=env.ANIMAXIA_OPENSEARCH_API_KEY||'';
  if(Boolean(user)!==Boolean(password)||(apiKey&&user))
    throw Object.assign(new Error('Invalid OpenSearch credentials'),{status:500});
  if(env.NODE_ENV==='production'&&!user&&!apiKey)
    throw Object.assign(new Error('OpenSearch production credentials are required'),{status:500});
  return {configured:true,origin:url.origin,index:name,user,password,apiKey};
}
function authHeaders(config){
  if(config.apiKey)return {Authorization:'ApiKey '+config.apiKey};
  if(config.user)return {Authorization:'Basic '+
    Buffer.from(config.user+':'+config.password).toString('base64')};
  return {};
}
async function boundedResponse(res){
  const limit=2_000_000;
  const contentLength=Number(res.headers?.get?.('content-length')||0);
  if(contentLength>limit)throw Object.assign(new Error('OpenSearch response too large'),{status:502});
  const parts=[];let size=0;
  if(!res.body?.getReader){
    const text=await res.text();
    if(Buffer.byteLength(text)>limit)throw Object.assign(new Error('OpenSearch response too large'),{status:502});
    try{return text?JSON.parse(text):{};}catch{throw Object.assign(new Error('Invalid OpenSearch JSON'),{status:502});}
  }
  const reader=res.body.getReader();
  try {
    while(true){
      const {done,value}=await reader.read();
      if(done)break;
      size+=value.byteLength;
      if(size>limit)throw Object.assign(new Error('OpenSearch response too large'),{status:502});
      parts.push(Buffer.from(value));
    }
  }finally{reader.releaseLock();}
  try{return JSON.parse(Buffer.concat(parts).toString('utf8')||'{}');}
  catch{throw Object.assign(new Error('Invalid OpenSearch JSON'),{status:502});}
}
export async function requestDistributed(path,{method='GET',body,ndjson=false,
  fetchImpl=globalThis.fetch}={}){
  const c=distributedConfig();
  if(!c.configured)throw Object.assign(new Error('OpenSearch is not configured'),{status:503});
  if(!/^\/[a-zA-Z0-9_./?=&-]+$/.test(path)||path.includes('..')||path.includes('//'))
    throw Object.assign(new Error('Invalid OpenSearch API path'),{status:400});
  const result=await fetchImpl(c.origin+path,{
    method,redirect:'error',signal:AbortSignal.timeout(12000),
    headers:{Accept:'application/json',...authHeaders(c),
      ...(body===undefined?{}:{'Content-Type':ndjson?'application/x-ndjson':'application/json'})},
    ...(body===undefined?{}:{body:ndjson?body:JSON.stringify(body)}),
  });
  // Parse bounded response only after HTTP status. Never leak remote response
  // bodies or potentially sensitive server headers to public API clients.
  if(!result.ok)throw Object.assign(new Error('OpenSearch HTTP '+result.status),
    {status:502,remoteStatus:result.status});
  return boundedResponse(result);
}
export function distributedIndexMapping(){
  return {
    settings:{index:{number_of_shards:3,number_of_replicas:1,refresh_interval:'5s'}},
    mappings:{dynamic:'strict',properties:{
      id:{type:'long'},title:{type:'text'},title_sort:{type:'keyword',ignore_above:512},
      type:{type:'keyword'},year:{type:'integer'},
      externalid:{type:'keyword',ignore_above:256},
      thumbnail:{type:'keyword',index:false,ignore_above:2048},
      description:{type:'text'},actors:{type:'text'},genres:{type:'text'},
      studios:{type:'text'},franchise:{type:'text'},trilogy:{type:'text'},
      collection:{type:'text'},posterId:{type:'keyword',ignore_above:256},
      sourceAttribution:{type:'keyword',ignore_above:256},
      rating:{type:'float'},
    }},
  };
}
export async function ensureDistributedIndex(options={}){
  const c=distributedConfig();
  if(!c.configured)throw Object.assign(new Error('OpenSearch is not configured'),{status:503});
  try{
    await requestDistributed('/'+c.index+'/_mapping',options);
    return {index:c.index,alreadyExists:true};
  }catch(err){if(err.remoteStatus!==404)throw err;}
  await requestDistributed('/'+c.index,{
    ...options,method:'PUT',body:distributedIndexMapping(),
  });
  return {index:c.index,created:true};
}
export function buildBulkPayload(entries,index){
  if(!INDEX.test(index))throw new Error('Invalid OpenSearch index');
  const lines=[];
  for(const row of entries){
    if(row.document){
      lines.push(JSON.stringify({index:{_index:index,_id:String(row.contentid)}}));
      lines.push(JSON.stringify(projectContent(row.document)));
    }else{
      lines.push(JSON.stringify({delete:{_index:index,_id:String(row.contentid)}}));
    }
  }
  return lines.join('\n')+'\n';
}
export async function flushDistributedOutbox({limit=40,fetchImpl=globalThis.fetch}={}){
  if(processing)return {skipped:'already-running'};
  const c=distributedConfig();
  if(!c.configured)throw Object.assign(new Error('OpenSearch is not configured'),{status:503});
  processing=true;
  try{
    const changes=pendingChanges(limit);
    if(!changes.length)return {processed:0,failed:0,pending:outboxStatus().pending};
    let result;
    try{
      result=await requestDistributed('/_bulk',{
        method:'POST',body:buildBulkPayload(changes,c.index),
        ndjson:true,fetchImpl,
      });
    }catch(err){
      for(const change of changes)retryChange(change);
      throw err;
    }
    if(!Array.isArray(result.items)||result.items.length!==changes.length){
      for(const change of changes)retryChange(change);
      throw Object.assign(new Error('Malformed OpenSearch bulk result'),{status:502});
    }
    let processed=0,failed=0;
    for(let i=0;i<changes.length;i++){
      const entry=result.items[i]?.index||result.items[i]?.delete;
      const status=Number(entry?.status);
      const ok=(status>=200&&status<300)||(!changes[i].document&&status===404);
      if(ok){ackChange(changes[i]);processed++;}
      else{retryChange(changes[i]);failed++;}
    }
    return {processed,failed,pending:outboxStatus().pending};
  }finally{processing=false;}
}
const short=(v,n=160)=>typeof v==='string'?v.trim().slice(0,n):'';
function filterQuery(params){
  const filters=[];
  const input=Object.fromEntries(
    ['q','type','category','genre','actor','studio','franchise','trilogy','collection',
      'description','posterId','year','sort'].map((key)=>[key,short(params[key])]));
  const category=normalizedType(input.type||input.category);
  if(category)filters.push({term:{type:category}});
  if(input.year){
    if(!/^[0-9]{4}$/.test(input.year))throw Object.assign(new Error('Invalid year'),{status:400});
    filters.push({term:{year:Number(input.year)}});
  }
  for(const [field,val] of Object.entries({
    actors:input.actor,genres:input.genre,studios:input.studio,
    franchise:input.franchise,trilogy:input.trilogy,collection:input.collection,
    description:input.description,
  }))if(val)filters.push({match_phrase:{[field]:val}});
  if(input.posterId)filters.push({term:{posterId:input.posterId}});
  const must=input.q?[{multi_match:{query:input.q,type:'best_fields',operator:'and',
    fields:['title^6','actors^3','genres^2','studios^2','franchise^3',
      'trilogy^2','collection^2','description']}}]:[];
  if(!must.length&&!filters.length)throw Object.assign(
    new Error('Provide q or at least one filter'),{status:400});
  return {input,query:{bool:{must,filter:filters}}};
}
function sigFor(input){
  return crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0,18);
}
export function buildDistributedSearch(params={}){
  const {input,query}=filterQuery(params);
  const limit=Math.max(1,Math.min(50,Number.parseInt(params.limit,10)||20));
  const sortType=['year','rating','title','score'].includes(input.sort)?input.sort:'score';
  const sort=sortType==='title'?[{title_sort:'asc'},{id:'asc'}]
    :sortType==='year'?[{year:{order:'desc',missing:'_last'}},{id:'desc'}]
    :sortType==='rating'?[{rating:{order:'desc',missing:'_last'}},{id:'desc'}]
    :input.q?[{_score:'desc'},{id:'desc'}]:[{id:'desc'}];
  const sig=sigFor({...input,sortType});
  let searchAfter;
  if(params.cursor){
    const raw=String(params.cursor);
    if(raw.length>512)throw Object.assign(new Error('Invalid search cursor'),{status:400});
    try{
      const parsed=JSON.parse(Buffer.from(raw,'base64url').toString('utf8'));
      if(parsed.sig!==sig||!Array.isArray(parsed.after)||parsed.after.length!==sort.length ||
        parsed.after.some((v)=>!(typeof v==='string'||Number.isFinite(v))))
        throw new Error('Invalid cursor');
      searchAfter=parsed.after;
    }catch{throw Object.assign(new Error('Invalid search cursor'),{status:400});}
  }
  // Exact totals at unbounded scale can be expensive; report >=10k honestly.
  return {body:{size:limit+1,track_total_hits:10000,query,sort,
    ...(searchAfter?{search_after:searchAfter}:{})},limit,sig};
}
export async function distributedSearch(params={},options={}){
  const c=distributedConfig();
  if(!c.configured)throw Object.assign(new Error('OpenSearch not configured'),{status:503});
  const {body,limit,sig}=buildDistributedSearch(params);
  const response=await requestDistributed('/'+c.index+'/_search',{
    method:'POST',body,fetchImpl:options.fetchImpl,
  });
  if(!Array.isArray(response.hits?.hits))
    throw Object.assign(new Error('Invalid OpenSearch hits'),{status:502});
  const raw=response.hits.hits.slice(0,limit);
  const data=raw.map((hit)=>{
    const s=hit._source||{};
    return {id:s.id,title:s.title,year:s.year,type:s.type,category:s.type,
      externalid:s.externalid,thumbnail:s.thumbnail,
      metadata:{overview:s.description,actors:s.actors,genres:s.genres,
        studios:s.studios,franchise:s.franchise,trilogy:s.trilogy,
        collection:s.collection,posterId:s.posterId,
        sourceAttribution:s.sourceAttribution,rating:s.rating},
      _score:Number(hit._score||0)};
  });
  const hasMore=response.hits.hits.length>limit;
  const last=raw.at(-1);
  const nextCursor=hasMore&&Array.isArray(last?.sort)?
    Buffer.from(JSON.stringify({sig,after:last.sort})).toString('base64url'):null;
  return {engine:'animaxia-opensearch-v1',searchMode:'opensearch',
    total:Number(response.hits.total?.value||0),
    totalRelation:response.hits.total?.relation||'eq',
    data,nextCursor,limit,paginationMode:'search_after',
    max_score:Number(response.hits.max_score||0)};
}
export function openSearchWorkerState(){
  return {...outboxStatus(),configured:distributedConfig().configured,
    enabled:process.env.ANIMAXIA_OPENSEARCH_WORKER==='true',
    workerActive:timer!==null,index:distributedConfig().index};
}
export function startOpenSearchWorker(){
  if(timer||process.env.ANIMAXIA_OPENSEARCH_WORKER!=='true')return false;
  const c=distributedConfig();
  if(!c.configured){logger.warn('[opensearch] no URL configured');return false;}
  ensureOpenSearchOutbox();
  timer=setInterval(()=>flushDistributedOutbox().catch(
    (err)=>logger.warn('[opensearch] outbox retries: '+err.message)),5000);
  timer.unref?.();
  logger.info('[opensearch] opt-in outbox enabled '+c.index);
  return true;
}
export function stopOpenSearchWorker(){if(timer)clearInterval(timer);timer=null;}
