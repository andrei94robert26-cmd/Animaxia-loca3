import express from 'express';
import crypto from 'node:crypto';
import { localOne, localAll, localRun } from '../local/sqlite.js';
import { userRateLimit } from '../security/security.js';
import { requireAuth, requireAdmin } from '../users/auth.js';
const wrap=(fn)=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
const limiter=userRateLimit({scope:'ip',max:30,windowMs:60000,key:'ingest-register'});
const sha=(s)=>crypto.createHash('sha256').update(String(s),'utf8').digest('hex');
const tracking=(k)=>k.startsWith('utm_')||['fbclid','gclid','ref','ref_src','spm','si'].includes(k);
const onDomain=(host,domain)=>host===domain||host.endsWith('.'+domain);
function youtube(u){const h=u.hostname.toLowerCase().replace(/^www\./,'');let id=null;if(h==='youtu.be')id=u.pathname.split('/').filter(Boolean)[0];else if(onDomain(h,'youtube.com')||onDomain(h,'youtube-nocookie.com')){id=u.searchParams.get('v');if(!id){const p=u.pathname.split('/').filter(Boolean);if(['embed','shorts','live'].includes(p[0]))id=p[1];}}return id&&/^[A-Za-z0-9_-]{11}$/.test(id)?id:null;}
export function normalizeSource(raw){const input=String(raw??'').trim();if(!input||input.length>4096)return null;const m=/src\s*=\s*["']([^"']+)["']/i.exec(input);if(m)return normalizeSource(m[1]);let u;try{u=new URL(input);}catch{}if(!u||!['http:','https:'].includes(u.protocol)||u.username||u.password)return null;const y=youtube(u);if(y){const c=`youtube:${y}`;return{url:c,originalurl:input,kind:'youtube',urlhash:sha(c)}}for(const k of [...u.searchParams.keys()])if(tracking(k.toLowerCase()))u.searchParams.delete(k);u.hash='';if(u.pathname.length>1)u.pathname=u.pathname.replace(/\/+$/,'');const pairs=[...u.searchParams.entries()].sort((a,b)=>a[0].localeCompare(b[0])||a[1].localeCompare(b[1]));u.search='';for(const [k,v] of pairs)u.searchParams.append(k,v);const url=u.toString();const p=u.pathname.toLowerCase();const kind=p.endsWith('.mp4')?'mp4':p.endsWith('.m3u8')?'m3u8':p.endsWith('.mpd')?'dash':onDomain(u.hostname.toLowerCase(),'rumble.com')?'rumble':
onDomain(u.hostname.toLowerCase(),'odysee.com')?'odysee':
onDomain(u.hostname.toLowerCase(),'vimeo.com')?'vimeo':
onDomain(u.hostname.toLowerCase(),'dailymotion.com')||onDomain(u.hostname.toLowerCase(),'dai.ly')?'dailymotion':
onDomain(u.hostname.toLowerCase(),'ok.ru')?'okru':
onDomain(u.hostname.toLowerCase(),'vk.com')||onDomain(u.hostname.toLowerCase(),'vkvideo.ru')?'vk':'link';return{url,originalurl:input,kind,urlhash:sha(url)}}
const parse=(s)=>{try{return JSON.parse(s||'{}')}catch{return{}}};
function row(r){return r?{id:Number(r.id),urlhash:r.urlhash,url:r.url,originalurl:r.originalurl??null,kind:r.kind,contentid:r.contentid==null?null:Number(r.contentid),hits:Number(r.hits||1),metadata:parse(r.metadata),createdat:r.createdat,lastseenat:r.lastseenat}:null}
export async function registerSource({url, kind, contentId, metadata}={}) {
  const n = normalizeSource(url);
  if (!n) return {ok:false,registered:false,duplicate:false,source:null,error:'invalid http/https source'};
  const numericId = contentId == null ? null : Number(contentId);
  if (contentId != null && (!Number.isSafeInteger(numericId) || numericId <= 0)) {
    return {ok:false,registered:false,duplicate:false,source:null,error:'invalid content ID'};
  }
  if (numericId != null && !localOne('SELECT id FROM Content WHERE id=?',[numericId])) {
    return {ok:false,registered:false,duplicate:false,source:null,error:'content not found'};
  }
  const body = JSON.stringify(metadata || {});
  if (body.length > 32768) {
    return {ok:false,registered:false,duplicate:false,source:null,error:'metadata exceeds 32KB'};
  }
  let r = localOne('SELECT * FROM contentsources WHERE urlhash=?',[n.urlhash]);
  if (r) {
    // A later miner pass can enrich a previously unlinked source, without
    // overwriting a canonical association with a different content item.
    localRun(`UPDATE contentsources
      SET hits=hits+1, lastseenat=CURRENT_TIMESTAMP,
          contentid=COALESCE(contentid,?)
      WHERE urlhash=?`,[numericId,n.urlhash]);
    return {ok:true,registered:false,duplicate:true,
      source:row(localOne('SELECT * FROM contentsources WHERE urlhash=?',[n.urlhash]))};
  }
  localRun('INSERT INTO contentsources(contentid,urlhash,url,originalurl,kind,metadata) VALUES(?,?,?,?,?,?)',
    [numericId,n.urlhash,n.url,n.originalurl,kind || n.kind,body]);
  return {ok:true,registered:true,duplicate:false,
    source:row(localOne('SELECT * FROM contentsources WHERE urlhash=?',[n.urlhash]))};
}

const router=express.Router();
router.post('/check',wrap(async(req,res)=>{const n=normalizeSource(req.body?.url);if(!n)return res.status(400).json({error:'Missing required field: url'});const source=row(localOne('SELECT * FROM contentsources WHERE urlHash=?',[n.urlhash]));const content=source?.contentid!=null?localOne('SELECT * FROM Content WHERE id=?',[source.contentid]):null;res.json({ok:true,exists:!!source,duplicate:!!source,source,content,storage:'local-sqlite'})}));
router.post('/register',requireAuth,requireAdmin,limiter,wrap(async(req,res)=>{
  const result = await registerSource(req.body || {});
  return res.status(result.ok ? 200 : 400).json(result);
}));
router.get('/sources',requireAuth,requireAdmin,wrap(async(req,res)=>{const limit=Math.min(100,Math.max(1,parseInt(req.query.limit,10)||50)),page=Math.max(1,parseInt(req.query.page,10)||1),offset=(page-1)*limit;const data=localAll('SELECT * FROM contentsources ORDER BY lastSeenAt DESC,id DESC LIMIT ? OFFSET ?',[limit,offset]).map(row);const total=Number(localOne('SELECT COUNT(*) n FROM contentsources')?.n||0);res.json({data,total,page,storage:'local-sqlite'})}));
router.get('/stats',wrap(async(_req,res)=>{const total=Number(localOne('SELECT COUNT(*) n FROM contentsources')?.n||0),duplicatesBlocked=Number(localOne('SELECT COUNT(*) n FROM contentsources WHERE hits>1')?.n||0),linkedContents=Number(localOne('SELECT COUNT(*) n FROM contentsources WHERE contentId IS NOT NULL')?.n||0);const byKind=Object.fromEntries(localAll('SELECT kind,COUNT(*) n FROM contentsources GROUP BY kind').map(r=>[r.kind,Number(r.n)]));res.json({total,byKind,duplicatesBlocked,linkedContents,storage:'local-sqlite'})}));
export default router;
