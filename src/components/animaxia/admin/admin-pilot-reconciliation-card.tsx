'use client';

import {useState} from 'react';
import {toast} from 'sonner';
import {authRequest} from '@/lib/animaxia/platform';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import {Card,CardContent,CardDescription,CardHeader,CardTitle} from '@/components/ui/card';

type AuditScope='catalog'|'orphans';
type AuditReport={
  scope:AuditScope;scanned:number;matched:number;missing:number;
  mismatched:number;orphaned:number;repairCandidates:number;
  repairQueued:number;alreadyPendingOrResolved:number;dryRun:boolean;
  nextAfterId:number|null;nextAfterExternalId:string|null;finished:boolean;
  note:string;
};
const endpoint='/api/migration/postgres/pilot/projection/reconcile?XTransformPort=4000';

export function AdminPilotReconciliationCard(){
  const [scope,setScope]=useState<AuditScope>('catalog');
  const [afterId,setAfterId]=useState('0');
  const [afterExternalId,setAfterExternalId]=useState('');
  const [report,setReport]=useState<AuditReport|null>(null);
  const [working,setWorking]=useState(false);
  async function run(dryRun:boolean){
    if(working)return;
    const cursor=Number(afterId);
    if(scope==='catalog'&&(!Number.isSafeInteger(cursor)||cursor<0)){
      toast.error('Cursorul catalogului trebuie să fie un întreg nenegativ');
      return;
    }
    if(scope==='orphans'&&afterExternalId.length>220){
      toast.error('Cursorul extern depășește 220 de caractere');
      return;
    }
    if(!dryRun&&!window.confirm(
      scope==='catalog'
        ? 'Adaugi în jurnal evenimente pentru metadatele lipsă sau învechite din proiecția pilot?'
        : 'Adaugi în jurnal evenimente de ștergere pentru documentele orfane din proiecția pilot?'
    ))return;
    setWorking(true);
    try{
      const result=await authRequest<AuditReport>(endpoint,{
        method:'POST',
        body:JSON.stringify({
          scope,limit:25,dryRun,
          ...(scope==='catalog'?{afterId:cursor}:{afterExternalId}),
        }),
      });
      setReport(result);
      toast.success(result.scanned+' verificate · '+result.repairCandidates+
        ' diferențe · '+result.repairQueued+' evenimente noi');
    }catch(err){
      toast.error(err instanceof Error?err.message:'Auditul proiecției PostgreSQL a eșuat');
    }finally{setWorking(false);}
  }
  function next(){
    if(!report)return;
    if(scope==='catalog'&&report.nextAfterId!==null)
      setAfterId(String(report.nextAfterId));
    if(scope==='orphans'&&report.nextAfterExternalId!==null)
      setAfterExternalId(report.nextAfterExternalId);
    setReport(null);
  }
  const hasNext=scope==='catalog'
    ?report?.nextAfterId!==null&&report?.nextAfterId!==undefined
    :report?.nextAfterExternalId!==null&&report?.nextAfterExternalId!==undefined;
  return <Card className="border-white/10 bg-white/[0.03]">
    <CardHeader>
      <CardTitle>Audit de integritate — proiecție PostgreSQL pilot</CardTitle>
      <CardDescription>
        Compară catalogul PostgreSQL pilot cu indexul său de căutare.
        Poate detecta metadate lipsă/învechite sau documente orfane.
        Verificarea nu afectează biblioteca publică SQLite.
      </CardDescription>
    </CardHeader>
    <CardContent className="space-y-3 text-sm">
      <div className="flex flex-wrap gap-2">
        <Button variant={scope==='catalog'?'default':'outline'} disabled={working}
          onClick={()=>{setScope('catalog');setReport(null);}}>
          Lipsă sau învechite
        </Button>
        <Button variant={scope==='orphans'?'default':'outline'} disabled={working}
          onClick={()=>{setScope('orphans');setReport(null);}}>
          Orfane în index
        </Button>
      </div>
      {scope==='catalog'?<div className="space-y-1">
        <Label htmlFor="pg-pilot-reconcile-id">Ultimul ID catalog verificat</Label>
        <Input id="pg-pilot-reconcile-id" value={afterId} inputMode="numeric"
          onChange={e=>{setAfterId(e.target.value);setReport(null);}} />
      </div>:<div className="space-y-1">
        <Label htmlFor="pg-pilot-reconcile-external">Ultimul ID extern din index</Label>
        <Input id="pg-pilot-reconcile-external" value={afterExternalId}
          maxLength={220} placeholder="Pornește de la început dacă este gol"
          onChange={e=>{setAfterExternalId(e.target.value);setReport(null);}} />
      </div>}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={working}
          onClick={()=>void run(true)}>
          Verifică 25 fără modificări
        </Button>
        <Button variant="destructive" disabled={working}
          onClick={()=>void run(false)}>
          Programează repararea diferențelor
        </Button>
        <Button variant="outline" disabled={working||!hasNext}
          onClick={next}>Următoarea pagină</Button>
      </div>
      {report&&<p role="status" className="text-xs text-zinc-300">
        Verificate: {report.scanned}
        {' · '}Conforme: {report.matched}
        {' · '}Lipsă: {report.missing}
        {' · '}Învechite: {report.mismatched}
        {' · '}Orfane: {report.orphaned}
        {' · '}Evenimente noi: {report.repairQueued}
        {' · '}Deja programate sau rezolvate: {report.alreadyPendingOrResolved}
        {' · '}{report.finished?'Ultima pagină':'Mai există pagini'}
      </p>}
      <p className="text-xs text-zinc-400">
        Repararea necesită confirmare și introduce evenimente în jurnal.
        Proiectorul aplică ulterior starea curentă a catalogului pilot.
        Acest audit este paginat și nu oferă un snapshot global consistent.
      </p>
    </CardContent>
  </Card>;
}
