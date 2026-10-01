'use client';

/**
 * ai-lab/panels-recap.tsx — FAZA 35 (WS5): AI Recap („Ce ai ratat").
 * Picker de titlu tv/anime + recap pe baza istoricului personal (auth —
 * 401 onest pentru anonimi → prompt de conectare). Lista episoadelor
 * urmărite cu bare de progres + narațiune recap + link „Urmărește episodul nou".
 */

import { useState } from 'react';
import { Loader2, Play, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api, ApiError } from '@/lib/animaxia/api';
import { navigate } from '@/lib/animaxia/router';
import type { AiLabRecapResponse } from '@/lib/animaxia/types';
import { ContentPicker, LabAiDigest, LabCard, LabLoginPrompt, LabNote, LabProviderBadge, type PickedContent } from './lab-ui';

/** Doar seriale + anime au „ce ai ratat". */
const RECAP_TYPES = ['tv', 'anime'];

function formatWhen(iso: string | null): string {
  if (!iso) return 'recent';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return 'recent';
    return d.toLocaleDateString('ro-RO', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return 'recent';
  }
}

export function RecapPanel() {
  const [picked, setPicked] = useState<PickedContent | null>(null);
  const [res, setRes] = useState<AiLabRecapResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needLogin, setNeedLogin] = useState(false);

  const run = async () => {
    if (!picked || loading) return;
    setLoading(true);
    setError(null);
    setNeedLogin(false);
    setRes(null);
    try {
      const r = await api.aiLabRecap(picked.id);
      setRes(r);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setNeedLogin(true);
      } else {
        setError(e instanceof Error ? e.message : 'Recap-ul a eșuat');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <ContentPicker
        label="Alege un serial sau anime"
        placeholder="Caută un serial/anime…"
        types={RECAP_TYPES}
        picked={picked}
        onPick={(c) => {
          setPicked(c);
          setRes(null);
          setError(null);
          setNeedLogin(false);
        }}
        onClear={() => {
          setPicked(null);
          setRes(null);
        }}
      />

      {picked ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            onClick={() => void run()}
            disabled={loading}
            className="h-11 bg-rose-600 font-bold hover:bg-rose-500"
          >
            {loading ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden /> : <Sparkles className="mr-1.5 h-4 w-4" aria-hidden />}
            Ce ai ratat la „{picked.title}"?
          </Button>
          {res ? <LabProviderBadge provider={res.provider} /> : null}
        </div>
      ) : (
        <LabNote>
          ⏪ AI Recap îți rezumă ce s-a întâmplat în episoadele pe care le-ai văzut — pe baza istoricului
          tău real de vizionare — ca să sari direct la episodul nou. Funcționează pentru seriale și anime.
        </LabNote>
      )}

      {loading ? (
        <LabCard title="Se generează recap-ul…">
          <p className="flex items-center gap-2 py-4 text-sm text-zinc-400">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            Analizăm istoricul tău de vizionare și compunem rezumatul…
          </p>
        </LabCard>
      ) : null}

      {needLogin ? (
        <LabLoginPrompt
          title="Recap-ul are nevoie de istoricul tău"
          message="Pentru a ști ce ai urmărit și ce ai ratat, AI Recap citește istoricul tău de vizionare — disponibil doar conectat. După conectare revino și apasă din nou butonul."
        />
      ) : null}

      {error ? (
        <div role="alert" className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
          {error}
        </div>
      ) : null}

      {res ? (
        <div className="space-y-4">
          {res.recap ? <LabAiDigest text={res.recap} provider={res.provider} label="Recap — ce ai ratat" /> : null}
          {res.note ? (
            <div className="rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-4 py-3 text-sm leading-relaxed text-amber-100/90">
              ℹ️ {res.note}
            </div>
          ) : null}

          {res.watched.length > 0 ? (
            <LabCard title={`Episoade urmărite (${res.watched.length})`}>
              <div className="custom-scrollbar max-h-96 space-y-2.5 overflow-y-auto pr-1">
                {res.watched.map((w, i) => {
                  const pct = Math.max(0, Math.min(100, w.progressPct));
                  return (
                    <div key={`${w.title}-${i}`} className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
                      <div className="mb-1.5 flex items-baseline justify-between gap-2">
                        <p className="min-w-0 truncate text-sm font-semibold text-zinc-100">{w.title}</p>
                        <span className="shrink-0 text-[11px] text-zinc-500">
                          {formatWhen(w.watchedAt)} · {pct}%
                        </span>
                      </div>
                      <div
                        className="h-1.5 overflow-hidden rounded-full bg-white/10"
                        role="progressbar"
                        aria-valuenow={pct}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-label={`Progres ${w.title}`}
                      >
                        <div className="h-full rounded-full bg-gradient-to-r from-teal-500 to-emerald-500" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
              <Button
                onClick={() => navigate(`/player/${res.contentId}`)}
                className="mt-3 h-11 bg-rose-600 font-bold hover:bg-rose-500"
              >
                <Play className="mr-1.5 h-4 w-4 fill-white" aria-hidden />
                Urmărește episodul nou
              </Button>
            </LabCard>
          ) : (
            <LabCard>
              <p className="py-3 text-center text-sm text-zinc-500">
                Nu am găsit episoade urmărite pentru acest titlu{res.recap ? '' : ' — recap-ul va apărea după ce începi serialul'}.
              </p>
            </LabCard>
          )}
        </div>
      ) : null}
    </div>
  );
}
