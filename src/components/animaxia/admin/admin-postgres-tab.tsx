'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useAuth } from '../auth-provider';
import { authRequest } from '@/lib/animaxia/platform';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type ShadowStatus={
  configured:boolean;workerEnabled:boolean;workerActive:boolean;
  pending:number;deletes:number;maxRetries:number;
  host:string|null;database:string|null;tls:boolean|null;
  authoritative:string;mode:string;
};
type Backfill={scanned:number;nextAfterId:number|null;finished:boolean};
type Flush={processed:number;failed:number;pending:number};
type CountComparison={
  localCount:number;remoteCount:number;delta:number;
  pending:number;countsAligned:boolean;note:string;
};
type PreviewItem={
  id:number;title:string;year:number|null;type:string;externalid:string|null;
  metadata:{actors?:string[];genres?:string[];franchise?:string;description?:string;rating?:number|null};
};
type PreviewPage={
  engine:string;shadow:boolean;sourceOfTruth:string;authoritative:boolean;
  data:PreviewItem[];hasMore:boolean;nextCursor:string|null;
};

const endpoint=(path:string)=>path+'?XTransformPort=4000';

export function AdminPostgresTab(){
  const {initializing,isAdmin}=useAuth();
  const [status,setStatus]=useState<ShadowStatus|null>(null);
  const [comparison,setComparison]=useState<CountComparison|null>(null);
  const [cursor,setCursor]=useState('0');
  const [working,setWorking]=useState(false);
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const [previewQuery,setPreviewQuery]=useState('');
  const [previewCategory,setPreviewCategory]=useState('');
  const [previewYear,setPreviewYear]=useState('');
  const [preview,setPreview]=useState<PreviewPage|null>(null);
  const [previewLoading,setPreviewLoading]=useState(false);

  const refresh=useCallback(async()=>{
    if(!isAdmin)return;
    setLoading(true);
    try{
      setStatus(await authRequest<ShadowStatus>(endpoint('/api/migration/postgres/status')));
      setError(null);
    }catch(err){
      setError(err instanceof Error?err.message:'PostgreSQL indisponibil');
    }finally{setLoading(false);}
  },[isAdmin]);
  useEffect(()=>{
    if(!initializing&&isAdmin)void refresh();
  },[initializing,isAdmin,refresh]);
  async function action<T,>(path:string,body:unknown):Promise<T>{
    return authRequest<T>(endpoint(path),{method:'POST',body:JSON.stringify(body)});
  }
  async function setup(){
    if(working||!window.confirm(
      'Inițializezi tabelele și indexurile într-o bază PostgreSQL configurată?'
    ))return;
    setWorking(true);
    try{
      await action('/api/migration/postgres/setup',{});
      toast.success('Schema PostgreSQL shadow este pregătită');
      await refresh();
    }catch(err){toast.error(err instanceof Error?err.message:'Inițializarea a eșuat');}
    finally{setWorking(false);}
  }
  async function backfill(){
    const afterId=Number(cursor);
    if(!Number.isSafeInteger(afterId)||afterId<0){
      toast.error('Cursorul trebuie să fie un număr întreg pozitiv');return;
    }
    setWorking(true);
    try{
      const data=await action<Backfill>('/api/migration/postgres/backfill',{
        afterId,limit:500,
      });
      if(data.nextAfterId!==null)setCursor(String(data.nextAfterId));
      toast.success(data.scanned+' titluri analizate · '+
        (data.finished?'ultimul lot':'continuă din cursor'));
      await refresh();
    }catch(err){toast.error(err instanceof Error?err.message:'Backfill eșuat');}
    finally{setWorking(false);}
  }
  async function flush(){
    setWorking(true);
    try{
      const data=await action<Flush>('/api/migration/postgres/flush',{limit:40});
      toast.success(data.processed+' sincronizate · '+data.failed+' eșuate');
      await refresh();
    }catch(err){toast.error(err instanceof Error?err.message:'Sincronizarea a eșuat');}
    finally{setWorking(false);}
  }
  async function compare(){
    setWorking(true);
    try{
      setComparison(await authRequest<CountComparison>(
        endpoint('/api/migration/postgres/compare')));
    }catch(err){toast.error(err instanceof Error?err.message:'Compararea a eșuat');}
    finally{setWorking(false);}
  }
  async function previewCatalog(next=false){
    const year=previewYear.trim();
    if(year&&!/^[12][0-9]{3}$/.test(year)){
      toast.error('Anul trebuie să aibă patru cifre');return;
    }
    const params=new URLSearchParams({
      XTransformPort:'4000',limit:'10',
      ...(previewQuery.trim()?{q:previewQuery.trim()}:{}),
      ...(previewCategory.trim()?{category:previewCategory.trim()}:{}),
      ...(year?{year}:{}),
    });
    if(next&&preview?.nextCursor)params.set('cursor',preview.nextCursor);
    setPreviewLoading(true);
    try{
      setPreview(await authRequest<PreviewPage>(
        '/api/migration/postgres/catalog?'+params.toString()));
    }catch(err){toast.error(err instanceof Error?err.message:'Citirea PostgreSQL a eșuat');}
    finally{setPreviewLoading(false);}
  }

  if(initializing)return <p className="text-sm text-zinc-400">Se verifică sesiunea…</p>;
  if(!isAdmin)return <p role="alert">Administrarea PostgreSQL necesită rolul de administrator.</p>;
  return (
    <div className="space-y-5">
      <Card className="border-white/10 bg-white/[0.03]">
        <CardHeader>
          <CardTitle>PostgreSQL — copie de migrare a metadatelor</CardTitle>
          <CardDescription>
            Biblioteca SQLite rămâne sursa de adevăr. PostgreSQL stochează
            doar o copie controlată a metadatelor, fără surse video sau embed.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p>Conexiune: {status?.configured?'Configurată':'Neconfigurată'}
            {' · '}TLS: {status?.tls?'activ':'—'}
            {' · '}Server: {status?.host||'—'}</p>
          <p>Worker: {status?.workerActive?'Activ':'Oprit'}
            {' · '}Joburi în așteptare: <strong>{status?.pending??'—'}</strong>
            {' · '}Ștergeri: {status?.deletes??'—'}
            {' · '}Retry maxim: {status?.maxRetries??'—'}</p>
          <p className="text-xs text-zinc-400">
            Această secțiune nu migrează autentificarea, uploadul sau
            biblioteca principală. Workerul trebuie activat explicit pe server.
          </p>
          {error&&<p role="alert" className="text-rose-400">{error}</p>}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={working||loading}
              onClick={()=>void refresh()}>{loading?'Se verifică…':'Reîmprospătează'}</Button>
            <Button disabled={working||!status?.configured}
              onClick={()=>void setup()}>Inițializează PostgreSQL</Button>
            <Button variant="outline" disabled={working||!status?.configured}
              onClick={()=>void compare()}>Compară numărul de titluri</Button>
          </div>
          {comparison&&<p role="status" className="text-xs text-zinc-300">
            SQLite: {comparison.localCount} · PostgreSQL: {comparison.remoteCount}
            {' · '}Diferență: {comparison.delta}
            {' · '}Restanțe: {comparison.pending}
            {' · '}{comparison.countsAligned?'Număr aliniat':'Necesită sincronizare'}.
            Numerele egale nu confirmă identitatea documentelor.
          </p>}
        </CardContent>
      </Card>
      <Card className="border-white/10 bg-white/[0.03]">
        <CardHeader><CardTitle>Backfill și sincronizare controlată</CardTitle>
          <CardDescription>
            Copiază titlurile în loturi de 500 în coada SQLite,
            apoi proiectează maximum 40 de modificări per cerere.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Label htmlFor="postgres-shadow-cursor">Ultimul ID SQLite parcurs</Label>
          <Input id="postgres-shadow-cursor" inputMode="numeric" value={cursor}
            onChange={(event)=>setCursor(event.target.value)} />
          <div className="flex flex-wrap gap-2">
            <Button disabled={working||!status?.configured}
              onClick={()=>void backfill()}>Adaugă următoarele 500 în coadă</Button>
            <Button variant="outline" disabled={working||!status?.configured}
              onClick={()=>void flush()}>Trimite 40 către PostgreSQL</Button>
          </div>
          <p className="text-xs text-zinc-400">
            Nu schimba baza de date principală fără migrarea completă a
            modulelor, verificare de integritate, backup și teste de încărcare.
          </p>
        </CardContent>
      </Card>
      <Card className="border-white/10 bg-white/[0.03]">
        <CardHeader>
          <CardTitle>Catalog PostgreSQL — citire de verificare</CardTitle>
          <CardDescription>
            Caută în copia PostgreSQL folosind un index real, filtre și
            paginare după ID. Rezultatele nu conțin surse video și nu
            înlocuiesc biblioteca publică SQLite.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 md:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor="pg-preview-q">Titlu sau descriere</Label>
              <Input id="pg-preview-q" maxLength={120} value={previewQuery}
                onChange={e=>{setPreviewQuery(e.target.value);setPreview(null);}}
                placeholder="Ex.: Star Wars" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="pg-preview-category">Categorie</Label>
              <Input id="pg-preview-category" maxLength={80} value={previewCategory}
                onChange={e=>{setPreviewCategory(e.target.value);setPreview(null);}}
                placeholder="Ex.: filme, seriale, anime" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="pg-preview-year">An</Label>
              <Input id="pg-preview-year" value={previewYear} inputMode="numeric"
                onChange={e=>{setPreviewYear(e.target.value);setPreview(null);}}
                placeholder="2026" maxLength={4} />
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button disabled={previewLoading||!status?.configured}
              onClick={()=>void previewCatalog(false)}>
              {previewLoading?'Se caută…':'Caută în PostgreSQL'}
            </Button>
            <Button variant="outline"
              disabled={previewLoading||!preview?.nextCursor}
              onClick={()=>void previewCatalog(true)}>Următoarele 10</Button>
          </div>
          {preview&&<div className="space-y-2" role="status">
            <p className="text-xs text-zinc-400">
              Motor: {preview.engine} · {preview.data.length} rezultate pe pagină
              {' · '}{preview.hasMore?'Mai există rezultate':'Ultima pagină'}
              {' · '}Copie de verificare, nu catalogul principal.
            </p>
            {preview.data.map(item=>(
              <div key={item.id} className="rounded border border-white/10 p-3 text-sm">
                <p className="font-medium">{item.title}</p>
                <p className="text-xs text-zinc-400">
                  ID {item.id} · {item.type} · {item.year??'an necunoscut'}
                  {item.metadata?.actors?.length
                    ? ' · '+item.metadata.actors.slice(0,3).join(', ')
                    : ''}
                </p>
              </div>
            ))}
            {preview.data.length===0&&<p className="text-sm text-zinc-400">
              Nu există metadate pentru filtrele selectate.</p>}
          </div>}
        </CardContent>
      </Card>
    </div>
  );
}
