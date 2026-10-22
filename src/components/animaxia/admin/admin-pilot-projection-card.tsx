'use client';

import {useState} from 'react';
import {toast} from 'sonner';
import {authRequest} from '@/lib/animaxia/platform';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import {Card,CardHeader,CardTitle,CardDescription,CardContent} from '@/components/ui/card';

type PilotProjectionStatus={
  enabled:boolean;mode:string;publicCatalogUnchanged:boolean;
  pending:number;retrying:number;quarantined:number;maxAttempts:number;completed:number;
};
type PilotProjectionBatch={processed:number;failed:number;updated:number;deleted:number};
type ProjectedItem={
  id:number;externalid:string;title:string;type:string;
  year:number|null;revision:number;
};
type ProjectedPage={
  data:ProjectedItem[];hasMore:boolean;nextAfterId:number|null;
  publicCatalogUnchanged:boolean;
};
const endpoint=(path:string,query='')=>
  path+'?XTransformPort=4000'+(query?'&'+query:'');
export function AdminPilotProjectionCard(){
  const [status,setStatus]=useState<PilotProjectionStatus|null>(null);
  const [items,setItems]=useState<ProjectedPage|null>(null);
  const [query,setQuery]=useState('');
  const [working,setWorking]=useState(false);
  async function refresh(){
    setWorking(true);
    try{
      const result=await authRequest<PilotProjectionStatus>(
        endpoint('/api/migration/postgres/pilot/projection/status'));
      setStatus(result);
    }catch(err){
      toast.error(err instanceof Error?err.message:'Proiecția nu este configurată');
    }finally{setWorking(false);}
  }
  async function action(mode:'setup'|'flush'){
    if(working)return;
    if(mode==='setup'&&!window.confirm(
      'Inițializezi o proiecție izolată pentru evenimentele catalogului PostgreSQL pilot?'
    ))return;
    setWorking(true);
    try{
      if(mode==='setup'){
        await authRequest(endpoint('/api/migration/postgres/pilot/projection/setup'),{
          method:'POST',body:'{}',
        });
        toast.success('Proiecția PostgreSQL pilot este inițializată');
      }else{
        const result=await authRequest<PilotProjectionBatch>(
          endpoint('/api/migration/postgres/pilot/projection/flush'),{
            method:'POST',body:JSON.stringify({limit:20}),
          });
        toast.success(result.processed+' procesate · '+result.failed+' eșuate');
      }
      const latest=await authRequest<PilotProjectionStatus>(
        endpoint('/api/migration/postgres/pilot/projection/status'));
      setStatus(latest);
    }catch(err){
      toast.error(err instanceof Error?err.message:'Operația proiecției a eșuat');
    }finally{setWorking(false);}
  }
  async function search(next=false){
    if(working)return;
    setWorking(true);
    try{
      const params=new URLSearchParams({
        limit:'10',...(query.trim()?{q:query.trim()}:{}),
        ...(next&&items?.nextAfterId?{afterId:String(items.nextAfterId)}:{}),
      });
      const result=await authRequest<ProjectedPage>(
        endpoint('/api/migration/postgres/pilot/projection/items',params.toString()));
      setItems(result);
    }catch(err){
      toast.error(err instanceof Error?err.message:'Căutarea proiecției a eșuat');
    }finally{setWorking(false);}
  }
  return <Card className="border-white/10 bg-white/[0.03]">
    <CardHeader>
      <CardTitle>Proiecție de căutare PostgreSQL pilot</CardTitle>
      <CardDescription>
        Evenimentele native PG sunt procesate tranzacțional într-un index
        separat de metadate. Biblioteca publică Animaxia rămâne neschimbată.
        Necesită activarea explicită a funcției pe backend.
      </CardDescription>
    </CardHeader>
    <CardContent className="space-y-3 text-sm">
      {status&&<p role="status" className="text-zinc-300">
        Evenimente restante: {status.pending} · Retry: {status.retrying}
        {' · '}În carantină: {status.quarantined}
        {' · '}Prag: {status.maxAttempts}
        {' · '}Procesate: {status.completed}
      </p>}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={working} onClick={()=>void refresh()}>
          Verifică starea
        </Button>
        <Button variant="outline" disabled={working} onClick={()=>void action('setup')}>
          Creează proiecția
        </Button>
        <Button disabled={working||!status?.enabled} onClick={()=>void action('flush')}>
          Procesează 20 de evenimente
        </Button>
      </div>
      <Label htmlFor="pg-pilot-project-q">Caută metadate în proiecția izolată</Label>
      <Input id="pg-pilot-project-q" maxLength={120} value={query}
        onChange={e=>{setQuery(e.target.value);setItems(null);}}
        placeholder="Titlu sau descriere" />
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={working||!status?.enabled}
          onClick={()=>void search(false)}>Caută</Button>
        <Button variant="outline" disabled={working||!items?.nextAfterId}
          onClick={()=>void search(true)}>Următoarele 10</Button>
      </div>
      {items&&<div className="space-y-2" role="status">
        <p className="text-xs text-zinc-400">
          {items.data.length} titluri pe pagină
          {' · '}{items.hasMore?'Mai există rezultate':'Ultima pagină'}
        </p>
        {items.data.map(item=><div key={item.externalid}
          className="rounded border border-white/10 px-3 py-2">
          <p>{item.title}</p>
          <p className="text-xs text-zinc-400">
            PG ID {item.id} · {item.type} · Revizia {item.revision}
          </p>
        </div>)}
      </div>}
      <p className="text-xs text-zinc-400">
        Acest index este doar pentru teste administrative.
        Nu conține surse video și nu înlocuiește OpenSearch ori SQLite.
      </p>
    </CardContent>
  </Card>;
}
