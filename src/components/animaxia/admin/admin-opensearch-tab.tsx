'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useAuth } from '../auth-provider';
import { authRequest } from '@/lib/animaxia/platform';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type Status = {
  configured: boolean; enabled: boolean; workerActive: boolean;
  durable: boolean; distributed: boolean; pending: number;
  maxAttempts: number; index: string;
};
type Backfill = {scanned: number; nextAfterId: number | null; finished: boolean};
type Flush = {processed: number; failed: number; pending: number};
const backend = (path: string) => path + '?XTransformPort=4000';

export function AdminOpenSearchTab() {
  const { initializing, isAdmin } = useAuth();
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cursor, setCursor] = useState('0');
  const [error, setError] = useState<string | null>(null);
  const refresh=useCallback(async()=>{
    if(!isAdmin)return;
    setLoading(true);
    try {
      setStatus(await authRequest<Status>(backend('/api/search/opensearch/status')));
      setError(null);
    }catch(e){setError(e instanceof Error?e.message:'Nu se poate citi starea OpenSearch');}
    finally{setLoading(false);}
  },[isAdmin]);
  useEffect(()=>{if(!initializing&&isAdmin)void refresh();},[isAdmin,initializing,refresh]);
  const post=async<T,>(path:string,body:unknown)=>authRequest<T>(backend(path),{
    method:'POST',body:JSON.stringify(body),
  });
  async function initialize(){
    if(!window.confirm('Creezi indexul în clusterul OpenSearch configurat?'))return;
    setBusy(true);
    try{
      const result=await post<{index:string,created?:boolean}>('/api/search/opensearch/setup',{});
      toast.success(result.created?'Index OpenSearch creat':'Index OpenSearch existent');
      await refresh();
    }catch(e){toast.error(e instanceof Error?e.message:'Crearea indexului a eșuat');}
    finally{setBusy(false);}
  }
  async function backfill(){
    const afterId=Number(cursor);
    if(!Number.isSafeInteger(afterId)||afterId<0){
      toast.error('Cursorul trebuie să fie un întreg pozitiv');return;
    }
    setBusy(true);
    try{
      const result=await post<Backfill>('/api/search/opensearch/backfill',{
        afterId,limit:500,
      });
      if(result.nextAfterId!==null)setCursor(String(result.nextAfterId));
      toast.success(result.scanned+' înregistrări analizate; '+
        (result.finished?'backfill complet':'mai există pagini'));
      await refresh();
    }catch(e){toast.error(e instanceof Error?e.message:'Backfill eșuat');}
    finally{setBusy(false);}
  }
  async function flush(){
    setBusy(true);
    try{
      const result=await post<Flush>('/api/search/opensearch/flush',{limit:40});
      toast.success(result.processed+' indexate, '+result.failed+' eșuate');
      await refresh();
    }catch(e){toast.error(e instanceof Error?e.message:'Trimitere eșuată');}
    finally{setBusy(false);}
  }
  if(initializing)return <p>Se verifică permisiunile…</p>;
  if(!isAdmin)return <p role="alert">Administrarea OpenSearch necesită rolul de administrator.</p>;
  return (
    <div className="space-y-4">
      <Card className="border-white/10 bg-white/[0.03]">
        <CardHeader>
          <CardTitle>OpenSearch — motor distribuit opțional</CardTitle>
          <CardDescription>
            Catalogul SQLite rămâne sursa datelor. OpenSearch este o copie
            indexată asincron, nu o infrastructură deja activată sau verificată
            pentru un miliard de titluri.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p>Configurație: {status?.configured?'Disponibilă':'Neconfigurată'} · Index: {status?.index??'—'}</p>
          <p>Worker: {status?.workerActive?'Activ':'Oprit'} · Mod: SQLite outbox → OpenSearch</p>
          <p>Modificări în așteptare: <strong>{status?.pending??'—'}</strong> · Maxim reîncercări: {status?.maxAttempts??'—'}</p>
          <p className="text-xs text-zinc-400">
            Workerul și schimbarea căutării publice se activează numai prin
            variabile de mediu și după verificarea indexului. Un buton de aici
            nu modifică automat configurația serverului.
          </p>
          {error&&<p role="alert" className="text-rose-400">{error}</p>}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={loading||busy} onClick={()=>void refresh()}>
              {loading?'Se verifică…':'Reîncarcă'}
            </Button>
            <Button disabled={busy||!status?.configured} onClick={()=>void initialize()}>
              Inițializează indexul
            </Button>
          </div>
        </CardContent>
      </Card>
      <Card className="border-white/10 bg-white/[0.03]">
        <CardHeader><CardTitle>Backfill controlat</CardTitle>
          <CardDescription>Maximum 500 de titluri pe pas. Salvează cursorul afișat înainte de a închide pagina.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Label htmlFor="open-search-cursor">Ultimul ID analizat</Label>
          <Input id="open-search-cursor" value={cursor}
            onChange={(event)=>setCursor(event.target.value)} inputMode="numeric" />
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy||!status?.configured} onClick={()=>void backfill()}>
              Adaugă următoarele 500 în outbox
            </Button>
            <Button variant="outline" disabled={busy||!status?.configured}
              onClick={()=>void flush()}>
              Trimite cel mult 40 către OpenSearch
            </Button>
          </div>
          <p className="text-xs text-zinc-400">
            Nu activa ANIMAXIA_SEARCH_BACKEND=opensearch înainte ca întregul catalog
            să fie sincronizat, verificat și monitorizat în cluster.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
