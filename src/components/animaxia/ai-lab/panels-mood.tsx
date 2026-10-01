'use client';

/**
 * ai-lab/panels-mood.tsx — FAZA 35 (WS5): AI Mood Playlist.
 * Grilă cu cele 6 stări de spirit (relaxat, captivant, nostalgic, energic,
 * misterios, romantic) + limită (8/12/16) + generare playlist reală cu
 * narațiune, „Amestecă din nou" (seed nou) și itemi care trimit la #/content/:id.
 */

import { useState } from 'react';
import { Loader2, Shuffle, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/animaxia/api';
import { useApi } from '@/lib/animaxia/hooks';
import type { AiLabMoodGenerateResponse } from '@/lib/animaxia/types';
import { ErrorState } from '../states';
import { cn } from '@/lib/utils';
import { LabAiDigest, LabCard, LabItemGrid, LabProviderBadge } from './lab-ui';

const LIMIT_OPTIONS = [8, 12, 16];

function randomSeed(): string {
  return Math.random().toString(36).slice(2, 9);
}

export function MoodPanel() {
  const moodsRes = useApi('ai-lab-moods', () => api.aiLabMoods());
  const [moodKey, setMoodKey] = useState<string | null>(null);
  const [limit, setLimit] = useState(12);
  const [res, setRes] = useState<AiLabMoodGenerateResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generate = async (mood: string, seed: string) => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.aiLabMoodGenerate(mood, limit, seed);
      setRes(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Generarea playlist-ului a eșuat');
    } finally {
      setLoading(false);
    }
  };

  if (moodsRes.loading) {
    return (
      <div className="space-y-3" aria-busy="true">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-12 rounded-xl" />
      </div>
    );
  }
  if (moodsRes.error) {
    return <ErrorState message={moodsRes.error} onRetry={() => void moodsRes.refetch()} />;
  }
  const moods = moodsRes.data?.moods ?? [];
  const selected = moods.find((m) => m.key === moodKey) ?? null;
  const labelOf = (key: string) => moods.find((m) => m.key === key)?.label ?? key;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3" role="radiogroup" aria-label="Starea de spirit">
        {moods.map((m) => {
          const active = m.key === moodKey;
          return (
            <button
              key={m.key}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => {
                setMoodKey(m.key);
                setRes(null);
              }}
              className={cn(
                'min-h-11 rounded-xl border p-3.5 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60',
                active
                  ? 'border-emerald-500/50 bg-emerald-500/10'
                  : 'border-white/10 bg-white/[0.02] hover:border-white/25 hover:bg-white/[0.04]',
              )}
            >
              <p className="flex items-center gap-2 text-sm font-bold text-zinc-100">
                <span className="text-lg leading-none" aria-hidden>
                  {m.emoji}
                </span>
                {m.label ?? m.key}
              </p>
              <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-zinc-500">{m.tagline ?? m.description}</p>
              {m.genres.length > 0 ? (
                <p className="mt-1.5 truncate text-[10px] text-zinc-600">{m.genres.slice(0, 4).join(' · ')}</p>
              ) : null}
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <label htmlFor="mood-limit" className="text-xs font-semibold text-zinc-400">
            Câte titluri:
          </label>
          <Select
            value={String(limit)}
            onValueChange={(v) => {
              setLimit(Number(v));
              setRes(null);
            }}
          >
            <SelectTrigger id="mood-limit" className="h-11 w-[92px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LIMIT_OPTIONS.map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n} titluri
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button
          onClick={() => selected && void generate(selected.key, randomSeed())}
          disabled={!selected || loading}
          className="h-11 bg-rose-600 font-bold hover:bg-rose-500"
        >
          {loading ? (
            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Sparkles className="mr-1.5 h-4 w-4" aria-hidden />
          )}
          Generează playlist
        </Button>
        {res ? <LabProviderBadge provider={res.provider} /> : null}
      </div>

      {!selected ? (
        <p className="rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3 text-sm text-zinc-500">
          🎭 Alege o stare de spirit — AI-ul compune un playlist real din catalog, cu genurile potrivite stării tale.
        </p>
      ) : null}

      {error ? (
        <div role="alert" className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
          {error}
          <Button variant="outline" size="sm" className="ml-3 h-8" onClick={() => selected && void generate(selected.key, randomSeed())}>
            Reîncearcă
          </Button>
        </div>
      ) : null}

      {loading ? (
        <LabCard title={`Se compune playlist-ul „${selected ? (selected.label ?? selected.key) : ''}"…`}>
          <p className="flex items-center gap-2 py-4 text-sm text-zinc-400">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            Selectăm titlurile potrivite și scriem narațiunea…
          </p>
        </LabCard>
      ) : null}

      {res ? (
        <div className="space-y-4">
          <LabAiDigest text={res.narrative} provider={res.provider} label={`Playlist ${labelOf(res.mood)}`} />
          <LabCard title={`${res.items.length} titluri pentru starea „${labelOf(res.mood)}"`}>
            <LabItemGrid items={res.items} empty="Niciun titlu găsit pentru această dispoziție — încearcă alta." />
            <Button
              variant="outline"
              onClick={() => selected && void generate(selected.key, randomSeed())}
              disabled={loading}
              className="mt-3 h-11 border-white/15 bg-white/5 font-semibold text-zinc-200 hover:bg-white/10"
            >
              <Shuffle className="mr-1.5 h-4 w-4" aria-hidden />
              Amestecă din nou
            </Button>
          </LabCard>
        </div>
      ) : null}
    </div>
  );
}
