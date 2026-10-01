'use client';

/**
 * ai-lab/panels-shield.tsx — FAZA 35 (WS5): AI Spoiler Shield.
 * Lipește comentarii (separate prin linie goală dublă) + titlu opțional →
 * filtrare spoilere: comentariile curate rămân vizibile, cele cu spoilere
 * sunt blur-ate cu buton de dezvăluire, bară de confidențialitate și termenii
 * potriviți. Badge provider onest.
 */

import { useState } from 'react';
import { Eye, Loader2, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/animaxia/api';
import type { AiLabShieldResultItem } from '@/lib/animaxia/types';
import { cn } from '@/lib/utils';
import { ContentPicker, LabCard, LabNote, LabProviderBadge, type PickedContent } from './lab-ui';

const SAMPLE = `Ultimul episod a fost incredibil, nu-mi venea să cred când a murit protagonistul!

Recomand acest serial oricui, are un ritm perfect și actorii joacă excelent.

Twist-ul final cu fratele său pierdut m-a șocat complet, nu-l văzusem deloc venind.

Un clasic, merită văzut măcar o dată în viață.`;

/** Normalizare onestă a confidenței: backend-ul live trimite 0..1
 *  (ex. 0.5 = 50%); contractul lăsa scara liberă — valorile >1 rămân 0..100. */
function pctOf(value: number): number {
  const v = Number.isFinite(value) ? value : 0;
  return Math.max(0, Math.min(100, v > 1 ? v : v * 100));
}

function ConfidenceBar({ value }: { value: number }) {
  const pct = pctOf(value);
  return (
    <div className="flex items-center gap-2">
      <div
        className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-white/10"
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Confidențialitate spoiler"
      >
        <div
          className={cn('h-full rounded-full', pct >= 80 ? 'bg-rose-500' : pct >= 50 ? 'bg-amber-500' : 'bg-emerald-500')}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="shrink-0 font-mono text-[10px] font-bold tabular-nums text-zinc-400">{pct.toFixed(0)}%</span>
    </div>
  );
}

function ResultRow({ r }: { r: AiLabShieldResultItem }) {
  const [revealed, setRevealed] = useState(false);
  const hidden = r.spoiler && !revealed;
  return (
    <div
      className={cn(
        'rounded-xl border p-3.5',
        r.spoiler ? 'border-rose-500/25 bg-rose-500/[0.05]' : 'border-emerald-500/20 bg-emerald-500/[0.03]',
      )}
    >
      {hidden ? (
        <div className="relative">
          <p className="select-none text-sm leading-relaxed text-zinc-300 blur-sm" aria-hidden>
            {r.body}
          </p>
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
            <p className="rounded-full border border-rose-500/30 bg-black/70 px-3 py-1 text-[11px] font-bold text-rose-200 backdrop-blur-sm">
              🛡️ Spoiler ascuns (confidențialitate {Math.round(pctOf(r.confidence))}%) —{' '}
              <button
                type="button"
                onClick={() => setRevealed(true)}
                className="underline underline-offset-2 hover:text-white"
              >
                Arată
              </button>
            </p>
          </div>
        </div>
      ) : (
        <p className="text-sm leading-relaxed text-zinc-200">{r.body}</p>
      )}
      <div className="mt-2.5 space-y-2">
        <ConfidenceBar value={r.confidence} />
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className={cn(
              'rounded-full border px-2 py-0.5 text-[10px] font-bold',
              r.spoiler ? 'border-rose-500/30 bg-rose-500/10 text-rose-300' : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
            )}
          >
            {r.spoiler ? '⚠️ spoiler' : '✓ curat'}
          </span>
          <span className="rounded-full border border-white/10 bg-white/[0.03] px-2 py-0.5 text-[10px] font-medium text-zinc-400">
            acțiune: {r.action}
          </span>
          {r.matched.map((m) => (
            <span
              key={m}
              className="max-w-full truncate rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-300"
              title={m}
            >
              „{m}"
            </span>
          ))}
          {r.spoiler && revealed ? (
            <button
              type="button"
              onClick={() => setRevealed(false)}
              className="text-[10px] font-semibold text-zinc-500 underline underline-offset-2 hover:text-zinc-300"
            >
              ascunde la loc
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function ShieldPanel() {
  const [text, setText] = useState('');
  const [picked, setPicked] = useState<PickedContent | null>(null);
  const [results, setResults] = useState<AiLabShieldResultItem[] | null>(null);
  const [provider, setProvider] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const texts = text
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);

  const filter = async () => {
    if (texts.length === 0 || loading) return;
    setLoading(true);
    setError(null);
    setResults(null);
    try {
      const r = await api.aiLabShieldFilter({
        contentId: picked?.id,
        texts: texts.map((b, i) => ({ id: `c${i + 1}`, body: b })),
      });
      setResults(r.results);
      setProvider(r.provider);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Filtrarea a eșuat');
    } finally {
      setLoading(false);
    }
  };

  const clean = results?.filter((r) => !r.spoiler).length ?? 0;
  const spoilers = results?.filter((r) => r.spoiler).length ?? 0;

  return (
    <div className="space-y-4">
      <LabCard
        title="Comentarii de verificat"
        hint="Separă comentariile cu o linie goală între ele. Titlul e opțional — ajută detectorul cu context."
      >
        <div className="space-y-3">
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={'Lipește aici comentariile…\n\nFiecare comentariu separat de o linie goală.'}
            className="min-h-36 text-sm"
            aria-label="Comentarii de filtrat"
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[11px] text-zinc-500">
              {texts.length > 0 ? `${texts.length} comentari${texts.length === 1 ? 'u' : 'i'} detectate` : 'Niciun comentariu încă'}
            </p>
            <button
              type="button"
              onClick={() => setText(SAMPLE)}
              className="text-[11px] font-semibold text-zinc-400 underline underline-offset-2 hover:text-zinc-200"
            >
              încearcă un exemplu
            </button>
          </div>
          <ContentPicker
            label="Titlu (opțional, pentru context)"
            placeholder="ex. Game of Thrones…"
            picked={picked}
            onPick={setPicked}
            onClear={() => setPicked(null)}
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => void filter()} disabled={texts.length === 0 || loading} className="h-11 bg-rose-600 font-bold hover:bg-rose-500">
              {loading ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <ShieldCheck className="mr-1.5 h-4 w-4" aria-hidden />
              )}
              Filtrează spoilerele
            </Button>
            {provider ? <LabProviderBadge provider={provider} /> : null}
          </div>
        </div>
      </LabCard>

      {error ? (
        <div role="alert" className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
          {error}
          <Button variant="outline" size="sm" className="ml-3 h-8" onClick={() => void filter()}>
            Reîncearcă
          </Button>
        </div>
      ) : null}

      {results ? (
        <LabCard
          title="Rezultate"
          action={
            <span className="flex items-center gap-1.5 text-[11px] font-semibold">
              <span className="text-emerald-300">{clean} curate</span>
              <span aria-hidden>·</span>
              <span className="text-rose-300">{spoilers} cu spoilere</span>
            </span>
          }
        >
          <div className="custom-scrollbar max-h-96 space-y-2.5 overflow-y-auto pr-1">
            {results.map((r) => (
              <ResultRow key={r.id} r={r} />
            ))}
          </div>
        </LabCard>
      ) : (
        <LabNote>
          🛡️ AI Spoiler Shield verifică fiecare comentariu înainte să-l citești: ce conține spoilere rămâne
          blur-at până când alegi să-l vezi. Confidențialitatea arată cât de sigur e detectorul de decizie.
        </LabNote>
      )}
    </div>
  );
}
