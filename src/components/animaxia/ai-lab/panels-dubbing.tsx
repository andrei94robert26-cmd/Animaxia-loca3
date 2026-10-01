'use client';

/**
 * ai-lab/panels-dubbing.tsx — FAZA 35 (WS5): AI Dubbing.
 * Admin-aware: administratorii văd fluxul complet — lista titlurilor fără
 * subtitrare RO, generare traducere REALĂ z-ai (30-60s, progres onest cu
 * cronometru), editor de cue-uri cu corecturi și publicare (subtitleId).
 * Utilizatorii non-admin văd lista read-only + explicația.
 */

import { useEffect, useState } from 'react';
import { CheckCircle2, Loader2, Mic, Save, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { api, ApiError } from '@/lib/animaxia/api';
import { useApi } from '@/lib/animaxia/hooks';
import { useAuth } from '../auth-provider';
import type { AiLabDubbingCue, AiLabDubbingDraft, AiLabDubbingMissingItem } from '@/lib/animaxia/types';
import { ErrorState } from '../states';
import { cn } from '@/lib/utils';
import { LabCard, LabNote, LabProviderBadge } from './lab-ui';

function fmtSec(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

/* ------------------------------ admin workflow ----------------------------- */

function DubbingWorkbench({ item, onPublished }: { item: AiLabDubbingMissingItem; onPublished: () => void }) {
  const [draft, setDraft] = useState<AiLabDubbingDraft | null>(null);
  const [draftLoading, setDraftLoading] = useState(true);
  const [draftMissing, setDraftMissing] = useState(false);
  const [cues, setCues] = useState<AiLabDubbingCue[]>([]);
  const [generating, setGenerating] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishedId, setPublishedId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  /* Cronometru onest în timpul generării reale z-ai (30-60s). */
  useEffect(() => {
    if (!generating) return undefined;
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [generating]);

  /* La selectare: verificăm dacă există deja un draft (404 onest = nu există). */
  useEffect(() => {
    let cancelled = false;
    setDraftLoading(true);
    setDraftMissing(false);
    setError(null);
    setPublishedId(null);
    (async () => {
      try {
        const r = await api.aiLabDubbingDraft(item.contentId);
        if (!cancelled) {
          setDraft(r.draft);
          setCues(r.draft.cues);
        }
      } catch (e) {
        if (!cancelled) {
          if (e instanceof ApiError && e.status === 404) {
            setDraft(null);
            setDraftMissing(true);
          } else {
            setError(e instanceof Error ? e.message : 'Draft-ul nu a putut fi încărcat');
          }
        }
      } finally {
        if (!cancelled) setDraftLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [item.contentId]);

  const generate = async () => {
    if (generating) return;
    setGenerating(true);
    setElapsed(0);
    setError(null);
    try {
      const r = await api.aiLabDubbingGenerate(item.contentId);
      setDraft(r.draft);
      setCues(r.draft.cues);
      toast.success('Traducere generată', {
        description: `${r.draft.cues.length} cue-uri traduse de ${r.draft.provider} în ${elapsed + 1}s.`,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Generarea a eșuat';
      setError(msg);
      toast.error('Generarea traducerii a eșuat', { description: msg });
    } finally {
      setGenerating(false);
    }
  };

  const saveCorrections = async () => {
    if (!draft || saving) return;
    setSaving(true);
    setError(null);
    try {
      const r = await api.aiLabDubbingSaveDraft(draft.contentId, cues);
      setDraft(r.draft);
      toast.success('Corecturile au fost salvate', { description: `${r.draft.cues.length} cue-uri actualizate.` });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Salvarea a eșuat';
      setError(msg);
      toast.error('Salvarea corecturilor a eșuat', { description: msg });
    } finally {
      setSaving(false);
    }
  };

  const publish = async () => {
    if (!draft || publishing) return;
    setPublishing(true);
    setError(null);
    try {
      const r = await api.aiLabDubbingPublish(draft.contentId);
      setPublishedId(r.subtitleId);
      toast.success('Subtitrarea a fost publicată', { description: `Pista RO #${r.subtitleId} este acum live.` });
      onPublished();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Publicarea a eșuat';
      setError(msg);
      toast.error('Publicarea a eșuat', { description: msg });
    } finally {
      setPublishing(false);
    }
  };

  const dirty = draft ? cues.some((c, i) => c.text !== draft.cues[i]?.text) : false;

  return (
    <LabCard
      title={`Atelier traducere — ${item.title}`}
      hint={`#${item.contentId} · ${item.type}${item.year ? ` · ${item.year}` : ''}`}
      action={draft ? <LabProviderBadge provider={draft.provider} /> : undefined}
    >
      {draftLoading ? (
        <p className="flex items-center gap-2 py-3 text-sm text-zinc-400">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Verificăm dacă există un draft salvat…
        </p>
      ) : null}

      {!draftLoading && !draft ? (
        <div className="space-y-3">
          <LabNote>
            🎙️ Generarea traduce pista EN existentă ({item.enSubtitleId != null ? `pista #${item.enSubtitleId}` : 'pistă EN'})
            cu modelul AI real. Apelul durează tipic <span className="font-bold text-zinc-300">30-60 de secunde</span> —
            cronometrul arată timpul scurs real, nu o animație falsă.
          </LabNote>
          <Button onClick={() => void generate()} disabled={generating} className="h-11 bg-rose-600 font-bold hover:bg-rose-500">
            {generating ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden /> : <Mic className="mr-1.5 h-4 w-4" aria-hidden />}
            {generating ? `Se generează… ${elapsed}s` : 'Generează traducere AI'}
          </Button>
        </div>
      ) : null}

      {generating && draft ? (
        <p className="mt-2 flex items-center gap-2 text-sm text-zinc-400">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Regenerare în curs… {elapsed}s
        </p>
      ) : null}

      {draft ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[11px] text-zinc-500">
              {draft.cues.length} cue-uri · generate {new Date(draft.generatedAt).toLocaleString('ro-RO')}
              {draft.corrected ? ' · corectate manual ✓' : ''}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void generate()}
              disabled={generating}
              className="h-9 border-white/15 bg-white/5 text-xs font-semibold text-zinc-300 hover:bg-white/10"
            >
              {generating ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
              Regenerează de la zero
            </Button>
          </div>
          <div className="custom-scrollbar max-h-96 space-y-2 overflow-y-auto pr-1" aria-label="Editor cue-uri subtitrare">
            {cues.map((c, i) => (
              <div key={i} className="flex gap-2.5 rounded-lg border border-white/10 bg-white/[0.02] p-2.5">
                <span className="shrink-0 rounded-md border border-white/10 bg-black/30 px-1.5 py-0.5 font-mono text-[10px] font-bold tabular-nums text-teal-300">
                  {fmtSec(c.start)}→{fmtSec(c.end)}
                </span>
                <div className="min-w-0 flex-1">
                  <Textarea
                    value={c.text}
                    onChange={(e) => {
                      const next = [...cues];
                      next[i] = { ...c, text: e.target.value };
                      setCues(next);
                    }}
                    rows={2}
                    className="min-h-11 text-[13px] leading-snug"
                    aria-label={`Text cue ${i + 1}`}
                  />
                  <p className="mt-0.5 text-[9px] text-zinc-600">sursă: {c.source}</p>
                </div>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => void saveCorrections()}
              disabled={saving || !dirty}
              variant="outline"
              className="h-11 border-white/15 bg-white/5 font-semibold text-zinc-200 hover:bg-white/10"
            >
              {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden /> : <Save className="mr-1.5 h-4 w-4" aria-hidden />}
              Salvează corecturile{dirty ? '' : ' (fără modificări)'}
            </Button>
            <Button
              onClick={() => void publish()}
              disabled={publishing || dirty}
              className="h-11 bg-emerald-600 font-bold hover:bg-emerald-500"
              title={dirty ? 'Salvează mai întâi corecturile' : undefined}
            >
              {publishing ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden /> : <Upload className="mr-1.5 h-4 w-4" aria-hidden />}
              Publică subtitrarea
            </Button>
          </div>
          {publishedId != null ? (
            <div className="flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm font-semibold text-emerald-200">
              <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />
              Publicat! Pista RO <span className="font-mono">#{publishedId}</span> este live în player pentru acest titlu.
            </div>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <div role="alert" className="mt-3 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
          {error}
        </div>
      ) : null}
    </LabCard>
  );
}

/* ---------------------------------- panel ---------------------------------- */

export function DubbingPanel() {
  const { isAdmin } = useAuth();
  const missingRes = useApi('ai-lab-dubbing-missing', () => api.aiLabDubbingMissing(12));
  const [selected, setSelected] = useState<AiLabDubbingMissingItem | null>(null);

  if (missingRes.loading) {
    return (
      <div className="space-y-2" aria-busy="true">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-16 animate-pulse rounded-xl bg-white/[0.03]" />
        ))}
      </div>
    );
  }
  if (missingRes.error) {
    return <ErrorState message={missingRes.error} onRetry={() => void missingRes.refetch()} />;
  }
  const d = missingRes.data;
  if (!d) return null;

  return (
    <div className="space-y-4">
      <LabNote>
        🎙️ AI Dubbing generează subtitrări românești prin traducerea pistelor EN existente, cu modelul AI real.
        {isAdmin
          ? ' Ca administrator, poți genera, corecta și publica traduceri.'
          : ' Lista titlurilor lipsă e publică; generarea și publicarea necesită drepturi de administrator.'}
      </LabNote>

      <LabCard
        title={`Titluri fără subtitrare RO (${d.items.length}${d.total != null ? ` din ${d.total}` : ''})`}
        hint="hasEn = există pistă engleză care poate fi tradusă"
      >
        {d.items.length === 0 ? (
          <p className="py-4 text-center text-sm text-zinc-500">Toate titlurile au subtitrare RO. 🎉</p>
        ) : (
          <div className="custom-scrollbar max-h-96 space-y-2 overflow-y-auto pr-1">
            {d.items.map((it) => {
              const active = selected?.contentId === it.contentId;
              return (
                <button
                  key={it.contentId}
                  type="button"
                  onClick={() => isAdmin && setSelected(it)}
                  disabled={!isAdmin}
                  className={cn(
                    'flex min-h-11 w-full items-center gap-3 rounded-xl border p-3 text-left transition',
                    active
                      ? 'border-rose-500/50 bg-rose-500/10'
                      : 'border-white/10 bg-white/[0.02] hover:border-white/25 hover:bg-white/[0.04]',
                    !isAdmin && 'cursor-default',
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-bold text-zinc-100">{it.title}</p>
                    <p className="text-[11px] text-zinc-500">
                      #{it.contentId} · {it.type}
                      {it.year ? ` · ${it.year}` : ''}
                    </p>
                  </div>
                  <span
                    className={cn(
                      'shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-bold',
                      it.hasEn
                        ? 'border-teal-500/30 bg-teal-500/10 text-teal-300'
                        : 'border-zinc-500/30 bg-zinc-500/10 text-zinc-400',
                    )}
                  >
                    {it.hasEn ? `EN ✓${it.enSubtitleId != null ? ` #${it.enSubtitleId}` : ''}` : 'fără EN'}
                  </span>
                  {isAdmin ? (
                    <span className="shrink-0 text-[10px] font-bold uppercase tracking-wider text-rose-300">
                      {active ? 'selectat' : 'lucrează →'}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        )}
      </LabCard>

      {isAdmin && selected ? (
        <DubbingWorkbench
          key={selected.contentId}
          item={selected}
          onPublished={() => {
            setSelected(null);
            void missingRes.refetch();
          }}
        />
      ) : null}
    </div>
  );
}
