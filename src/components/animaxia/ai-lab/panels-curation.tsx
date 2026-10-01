'use client';

/**
 * ai-lab/panels-curation.tsx — FAZA 35 (WS5): AI Curation.
 * „De ce îți recomandăm?" — picker titlu → notă explicativă + lista de
 * semnale reale cu bare de greutate (label, valoare, weight) + badge provider.
 */

import { useState } from 'react';
import { Loader2, Target } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/animaxia/api';
import type { AiLabCurationResponse } from '@/lib/animaxia/types';
import { ContentPicker, LabAiDigest, LabCard, LabNote, LabProviderBadge, type PickedContent } from './lab-ui';
import { cn } from '@/lib/utils';

export function CurationPanel() {
  const [picked, setPicked] = useState<PickedContent | null>(null);
  const [res, setRes] = useState<AiLabCurationResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const why = async () => {
    if (!picked || loading) return;
    setLoading(true);
    setError(null);
    setRes(null);
    try {
      const r = await api.aiLabCurationWhy(picked.id);
      setRes(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Explicația a eșuat');
    } finally {
      setLoading(false);
    }
  };

  /* Barele se normalizează la semnalul maxim (weight poate fi 0..1 sau 0..100). */
  const maxWeight = res ? Math.max(...res.signals.map((s) => s.weight), 1) : 1;

  return (
    <div className="space-y-4">
      <ContentPicker
        label="Despre ce titlu vrei explicația?"
        picked={picked}
        onPick={(c) => {
          setPicked(c);
          setRes(null);
          setError(null);
        }}
        onClear={() => {
          setPicked(null);
          setRes(null);
        }}
      />

      {picked ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => void why()} disabled={loading} className="h-11 bg-rose-600 font-bold hover:bg-rose-500">
            {loading ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden /> : <Target className="mr-1.5 h-4 w-4" aria-hidden />}
            De ce îți recomandăm „{picked.title}"?
          </Button>
          {res ? <LabProviderBadge provider={res.provider} /> : null}
        </div>
      ) : (
        <LabNote>
          🎯 AI Curation explică recomandările în limbaj natural: ce semnale reale (istoric, genuri, notă,
          popularitate) au contribuit și cu ce greutate — transparență totală, fără „cutie neagră".
        </LabNote>
      )}

      {loading ? (
        <LabCard title="Se explică recomandarea…">
          <p className="flex items-center gap-2 py-4 text-sm text-zinc-400">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            Agregăm semnalele și compunem explicația…
          </p>
        </LabCard>
      ) : null}

      {error ? (
        <div role="alert" className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
          {error}
          <Button variant="outline" size="sm" className="ml-3 h-8" onClick={() => void why()}>
            Reîncearcă
          </Button>
        </div>
      ) : null}

      {res ? (
        <div className="space-y-4">
          <LabAiDigest text={res.note} provider={res.provider} label={`De ce „${res.title}”`} />
          <LabCard title={`Semnale de recomandare (${res.signals.length})`}>
            <div className="space-y-3">
              {res.signals.map((s) => {
                const pct = Math.max(3, Math.min(100, (s.weight / maxWeight) * 100));
                return (
                  <div key={s.key}>
                    <div className="mb-1 flex items-baseline justify-between gap-2">
                      <span className="min-w-0 truncate text-xs font-semibold text-zinc-200">{s.label}</span>
                      <span className="shrink-0 font-mono text-[11px] font-bold tabular-nums text-zinc-400">
                        {s.value} <span className="text-zinc-600">· w {s.weight}</span>
                      </span>
                    </div>
                    <div
                      className="h-2 overflow-hidden rounded-full bg-white/10"
                      role="progressbar"
                      aria-valuenow={Math.round(pct)}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-label={`Greutate semnal ${s.label}`}
                    >
                      <div
                        className={cn(
                          'h-full rounded-full',
                          s.weight / maxWeight >= 0.66
                            ? 'bg-gradient-to-r from-rose-500 to-fuchsia-500'
                            : s.weight / maxWeight >= 0.33
                              ? 'bg-gradient-to-r from-amber-500 to-rose-500'
                              : 'bg-white/25',
                        )}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </LabCard>
        </div>
      ) : null}
    </div>
  );
}
