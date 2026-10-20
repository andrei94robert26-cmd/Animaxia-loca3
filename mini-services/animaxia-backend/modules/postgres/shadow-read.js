/**
 * Read-only PostgreSQL shadow catalog preview.
 * Strictly admin-only route; never joins SQLite player URLs with mirrored rows.
 * Keyset pagination avoids offset scans and huge total-count queries.
 */
import crypto from 'node:crypto';
import { normalizedType } from '../search/sqlite-advanced.js';
import { pgShadowConfig, shadowPgQuery } from './shadow.js';

const badInput=(message)=>Object.assign(new Error(message),{status:400});
const limitedText=(value,max=160)=>{
  if(value===undefined||value===null)return '';
  if(typeof value!=='string')throw badInput('Invalid text filter');
  if(value.length>max)throw badInput('Filter is too long');
  return value.trim();
};
const keyFilterFields=Object.freeze({
  actor:'actors',genre:'genres',studio:'studios',
});
const textFilterFields=Object.freeze({
  franchise:'franchise',trilogy:'trilogy',collection:'collection',
  description:'description',posterId:'posterId',
});
function parseCursor(raw,sig) {
  if(!raw)return null;
  if(typeof raw!=='string'||raw.length>512)throw badInput('Invalid shadow cursor');
  try {
    const data=JSON.parse(Buffer.from(raw,'base64url').toString('utf8'));
    if(!Number.isSafeInteger(data.id)||data.id<=0||data.sig!==sig)
      throw new Error('invalid');
    return data.id;
  }catch{throw badInput('Invalid shadow cursor for current filters');}
}
export function buildPgShadowCatalogQuery(params={}) {
  const q=limitedText(params.q,120);
  const category=normalizedType(limitedText(params.category||params.type,80));
  const yearText=params.year===undefined||params.year===null?'':String(params.year);
  if(yearText&&!/^[12]\d{3}$/.test(yearText))throw badInput('Invalid year');
  const year=yearText?Number(yearText):null;
  const n=Number(params.limit??20);
  if(!Number.isSafeInteger(n)||n<1||n>50)throw badInput('limit must be between 1 and 50');
  const filters={q,category,year};
  for(const field of Object.keys(keyFilterFields))filters[field]=limitedText(params[field]);
  for(const field of Object.keys(textFilterFields))filters[field]=limitedText(params[field]);
  // Filter signature includes all normalized user inputs that affect results.
  const sig=crypto.createHash('sha256').update(JSON.stringify(filters)).digest('hex').slice(0,24);
  const cursor=parseCursor(params.cursor,sig);
  const where=[];
  const values=[];
  const bind=(value)=>{values.push(value);return '$'+values.length;};
  if(category)where.push('type = '+bind(category));
  if(year!==null)where.push('year = '+bind(year));
  if(q) {
    const term=bind(q);
    where.push(
      "to_tsvector('simple'::regconfig, coalesce(title,'') || ' ' || "+
      "coalesce(metadata->>'description','')) @@ plainto_tsquery('simple'::regconfig, "+term+")"
    );
  }
  for(const [field,key] of Object.entries(keyFilterFields)){
    if(!filters[field])continue;
    const term=bind(filters[field]);
    where.push(
      "EXISTS (SELECT 1 FROM jsonb_array_elements_text("+
      "CASE WHEN jsonb_typeof(metadata->'"+key+"') = 'array' "+
      "THEN metadata->'"+key+"' ELSE '[]'::jsonb END"+
      ") AS e(value) WHERE e.value ILIKE '%' || "+term+" || '%')"
    );
  }
  for(const [field,key] of Object.entries(textFilterFields)){
    if(!filters[field])continue;
    const term=bind(filters[field]);
    where.push("(metadata->>'"+key+"') ILIKE '%' || "+term+" || '%'");
  }
  if(cursor!==null)where.push('id < '+bind(cursor));
  const sql="SELECT id::text AS id,title,year,type,externalid,thumbnail,metadata "+
    "FROM animaxia_shadow_content"+
    (where.length?' WHERE '+where.join(' AND '):'')+
    ' ORDER BY id DESC LIMIT '+bind(n+1);
  return {sql,values,limit:n,sig,filters,cursor};
}
export async function readPgShadowCatalog(params={},options={}) {
  if(!pgShadowConfig().configured)throw Object.assign(
    new Error('PostgreSQL shadow is not configured'),{status:503});
  const {sql,values,limit,sig}=buildPgShadowCatalogQuery(params);
  const result=await shadowPgQuery(sql,values,options);
  if(!Array.isArray(result.rows))throw Object.assign(
    new Error('Invalid PostgreSQL shadow response'),{status:502});
  const all=result.rows;
  if(all.length>limit+1)throw Object.assign(
    new Error('Unbounded PostgreSQL shadow response'),{status:502});
  const page=all.slice(0,limit);
  const data=page.map((row)=>{
    const id=Number(row.id);
    if(!Number.isSafeInteger(id)||id<1)throw Object.assign(
      new Error('Invalid PostgreSQL content ID'),{status:502});
    const meta=typeof row.metadata==='object'&&row.metadata&&!Array.isArray(row.metadata)
      ?row.metadata:{};
    // Whitelist fields again. Never pass through arbitrary JSON or media URLs.
    return {
      id,title:String(row.title||''),year:row.year===null?null:Number(row.year),
      type:String(row.type||'content'),category:String(row.type||'content'),
      externalid:row.externalid||null,thumbnail:row.thumbnail||null,
      metadata:{
        description:typeof meta.description==='string'?meta.description:'',
        actors:Array.isArray(meta.actors)?meta.actors:[],
        genres:Array.isArray(meta.genres)?meta.genres:[],
        studios:Array.isArray(meta.studios)?meta.studios:[],
        franchise:meta.franchise||'',trilogy:meta.trilogy||'',
        collection:meta.collection||'',posterId:meta.posterId||'',
        sourceAttribution:meta.sourceAttribution||'',
        rating:typeof meta.rating==='number'?meta.rating:null,
      },
    };
  });
  const hasMore=all.length>limit;
  const nextCursor=hasMore&&data.length
    ?Buffer.from(JSON.stringify({id:data.at(-1).id,sig})).toString('base64url')
    :null;
  return {engine:'postgresql-shadow-v1',shadow:true,
    sourceOfTruth:'sqlite',authoritative:false,
    data,limit,hasMore,nextCursor,
    pagination:'keyset-id-desc',
    note:'Read-only preview. Video playback and user reads still use SQLite.',
  };
}
