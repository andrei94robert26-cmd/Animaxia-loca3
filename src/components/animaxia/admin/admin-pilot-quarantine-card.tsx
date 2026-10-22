'use client';

import {useState} from 'react';
import {toast} from 'sonner';
import {authRequest} from '@/lib/animaxia/platform';
import {Button} from '@/components/ui/button';
import {Card,CardContent,CardDescription,CardHeader,CardTitle} from '@/components/ui/card';

type QuarantinedEvent={
  eventid:number;externalid:string;operation:'upsert'|'delete';
  attempts:number;errorCode:string|null;quarantinedAt:string;
};
type QuarantinePage={
  data:QuarantinedEvent[];hasMore:boolean;nextAfterEventId:number|null;
  publicCatalogUnchanged:boolean;
};
type RetryResult={retried:boolean;eventid:number;publicCatalogUnchanged:boolean};
const route=(path:string,params?:URLSearchParams)=>
  path+'?XTransformPort=4000'+(params?'&'+params.toString():'');

export function AdminPilotQuarantineCard(){
  const [page,setPage]=useState<QuarantinePage|null>(null);
  const [busy,setBusy]=useState(false);
  const [cursor,setCursor]=useState<number|null>(null);
  async function load(after:number|null=null){
    if(busy)return;
    setBusy(true);
    try{
      const params=new URLSearchParams({limit:'20'});
      if(after!==null)params.set('afterEventId',String(after));
      const result=await authRequest<QuarantinePage>(
        route('/api/migration/postgres/pilot/projection/quarantine',params));
      setPage(result);
      setCursor(after);
    }catch(err){
      toast.error(err instanceof Error?err.message:'Nu pot încărca evenimentele izolate');
    }finally{setBusy(false);}
  }
  async function retry(item:QuarantinedEvent){
    if(busy||!window.confirm(
      'Reintroduci evenimentul '+item.eventid+' în coada de procesare? '+
      'Proiectorul va reciti starea curentă din catalogul pilot.'
    ))return;
    setBusy(true);
    try{
      const result=await authRequest<RetryResult>(route(
        '/api/migration/postgres/pilot/projection/quarantine/'+item.eventid+'/retry'
      ),{method:'POST',body:'{}'});
      toast[result.retried?'success':'info'](
        result.retried?'Evenimentul a fost reactivat':'Evenimentul nu mai este în carantină'
      );
      const params=new URLSearchParams({limit:'20'});
      if(cursor!==null)params.set('afterEventId',String(cursor));
      setPage(await authRequest<QuarantinePage>(route(
        '/api/migration/postgres/pilot/projection/quarantine',params
      )));
    }catch(err){
      toast.error(err instanceof Error?err.message:'Reluarea a eșuat');
    }finally{setBusy(false);}
  }
  return <Card className="border-white/10 bg-white/[0.03]">
    <CardHeader>
      <CardTitle>Carantină evenimente PostgreSQL pilot</CardTitle>
      <CardDescription>
        Evenimentele care depășesc pragul de încercări nu se mai procesează
        automat. Nu sunt șterse și pot fi reluate manual după remedierea
        erorii. Biblioteca publică SQLite nu este modificată.
      </CardDescription>
    </CardHeader>
    <CardContent className="space-y-3 text-sm">
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={busy} onClick={()=>void load()}>
          {busy?'Se verifică…':'Verifică evenimentele izolate'}
        </Button>
        <Button variant="outline" disabled={busy||!page?.nextAfterEventId}
          onClick={()=>void load(page?.nextAfterEventId??null)}>
          Următoarele 20
        </Button>
      </div>
      {page&&<div role="status" className="space-y-2">
        <p className="text-xs text-zinc-400">
          {page.data.length} evenimente afișate ·
          {page.hasMore?' Mai există pagini':' Ultima pagină'}
        </p>
        {page.data.map(item=><div key={item.eventid}
          className="flex flex-wrap items-center justify-between gap-3 rounded border border-white/10 p-3">
          <div className="min-w-0">
            <p className="break-all font-medium">{item.externalid}</p>
            <p className="text-xs text-zinc-400">
              Eveniment {item.eventid} · {item.operation} ·
              {' '}Încercări: {item.attempts} ·
              {' '}Cod: {item.errorCode??'necunoscut'}
            </p>
          </div>
          <Button variant="outline" disabled={busy} onClick={()=>void retry(item)}>
            Reîncearcă explicit
          </Button>
        </div>)}
        {page.data.length===0&&
          <p className="text-zinc-400">Nu există evenimente în carantină pe această pagină.</p>}
      </div>}
      <p className="text-xs text-zinc-400">
        Codurile de eroare nu includ mesaje SQL complete ori date secrete.
        Reluarea este limitată la evenimente neconfirmate și deja izolate.
        Remediază cauza înainte să reîncerci.
      </p>
    </CardContent>
  </Card>;
}
