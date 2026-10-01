'use client';

/**
 * ai-suite/panels-health.tsx — FAZA 32: panouri pentru motoarele de sănătate
 * a catalogului — AI Metadata Dashboard, AI Analyzer Dashboard, AI Content
 * Scanner, AI Duplicate Detector, AI Poster Scanner. Date 100% reale de la
 * /api/ai/suite/<engine>/data.
 */

import { useState } from 'react';
import { RefreshCw, Wand2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/animaxia/api';
import { useApi } from '@/lib/animaxia/hooks';
import type {
  AiSuiteAnalyzerData,
  AiSuiteDuplicatesData,
  AiSuiteMetadataData,
  AiSuitePosterData,
  AiSuiteScannerData,
} from '@/lib/animaxia/types';
import { ErrorState } from '../states';
import {
  AiDigest,
  CountBar,
  KeyValueRow,
  NoteStrip,
  PanelSkeleton,
  PctBar,
  ProviderChip,
  StatCard,
} from './suite-ui';

/* ---------------------------- AI Metadata Dashboard ---------------------------- */

export function MetadataPanel() {
  const res = useApi('ai-suite-metadata', () => api.aiSuiteMetadata());
  if (res.loading) return <PanelSkeleton />;
  if (res.error) return <ErrorState message={res.error} onRetry={() => void res.refetch()} />;
  const d = res.data as AiSuiteMetadataData;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Titluri în catalog" value={d.total.toLocaleString('ro-RO')} />
        <StatCard
          label="Completitudine globală"
          value={`${d.overall}%`}
          tone={d.overall >= 80 ? 'good' : d.overall >= 50 ? 'warn' : 'bad'}
          hint="medie pe 9 câmpuri"
        />
        <StatCard label="Câmpuri monitorizate" value={d.fields.length} hint="title…thumbnail" />
        <StatCard label="Goluri critice" value={d.gaps.length} hint="titluri cu cele mai multe câmpuri lipsă" />
      </div>

      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
        <p className="mb-3 text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-500">Acoperire per câmp</p>
        <div className="space-y-2.5">
          {d.fields.map((f) => (
            <PctBar key={f.field} pct={f.pct} label={`${f.field} · ${f.covered.toLocaleString('ro-RO')}`} />
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
        <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-500">
          Top goluri metadata (acțiune de enrich)
        </p>
        <div className="space-y-1">
          {d.gaps.map((g) => (
            <div key={g.id} className="flex flex-wrap items-center gap-2 border-b border-white/5 py-1.5 last:border-0">
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-200">{g.title}</span>
              <span className="font-mono text-[10px] text-zinc-500">#{g.id} · {g.type}</span>
              {g.missing.map((m) => (
                <span key={m} className="rounded-full border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-[10px] font-bold text-rose-300">
                  {m} lipsă
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <ProviderChip provider={d.provider} />
        <span className="text-[11px] text-zinc-500">generat {new Date(d.generatedAt ?? '').toLocaleString('ro-RO')}</span>
      </div>
    </div>
  );
}

/* ---------------------------- AI Analyzer Dashboard ---------------------------- */

export function AnalyzerPanel() {
  const res = useApi('ai-suite-analyzer', () => api.aiSuiteAnalyzer());
  if (res.loading) return <PanelSkeleton />;
  if (res.error) return <ErrorState message={res.error} onRetry={() => void res.refetch()} />;
  const d = res.data as AiSuiteAnalyzerData;
  const maxBucket = Math.max(...d.distribution.map((b) => b.n), 1);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Scor mediu calitate" value={d.avgScore} tone={d.avgScore >= 70 ? 'good' : d.avgScore >= 45 ? 'warn' : 'bad'} />
        <StatCard label="Eșantion analizat" value={d.sampleSize} hint="aleatoriu din catalog" />
        <StatCard label="Tipuri de conținut" value={d.byType.length} />
        <StatCard label="Cei mai slabi" value={d.needsAttention.length} hint="necesită atenție" tone="warn" />
      </div>

      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
        <p className="mb-3 text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-500">Distribuția scorurilor</p>
        <div className="space-y-2.5">
          {d.distribution.map((b) => (
            <CountBar key={b.range} label={b.range} count={b.n} max={maxBucket} />
          ))}
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.04] p-4">
          <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.16em] text-emerald-300/80">Top 10 calitate</p>
          {d.top.map((t, i) => (
            <KeyValueRow key={t.id} k={`${i + 1}. ${t.title}`} v={`${t.score} · ⭐ ${t.rating ?? '—'}`} mono />
          ))}
        </div>
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.04] p-4">
          <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.16em] text-amber-300/80">Necesită atenție</p>
          {d.needsAttention.slice(0, 10).map((t) => (
            <KeyValueRow key={t.id} k={t.title} v={`${t.score} · ${t.type}`} mono />
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
        <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-500">Scor mediu pe tip</p>
        <div className="space-y-1">
          {d.byType.map((t) => (
            <KeyValueRow key={t.type} k={`${t.type} · ${t.n} titluri`} v={t.avgScore} mono />
          ))}
        </div>
      </div>
      <NoteStrip>{d.note}</NoteStrip>
      <ProviderChip provider={d.provider} />
    </div>
  );
}

/* ----------------------------- AI Content Scanner ----------------------------- */

export function ScannerPanel() {
  const res = useApi('ai-suite-scanner', () => api.aiSuiteScanner());
  if (res.loading) return <PanelSkeleton />;
  if (res.error) return <ErrorState message={res.error} onRetry={() => void res.refetch()} />;
  const d = res.data as AiSuiteScannerData;
  const severityTone = (s: string) => (s === 'ridicat' ? 'bad' : s === 'medie' ? 'warn' : 'default');
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          label="Scor sănătate catalog"
          value={d.healthScore}
          tone={d.healthScore >= 85 ? 'good' : d.healthScore >= 60 ? 'warn' : 'bad'}
        />
        <StatCard label="Eșantion scanat" value={d.sampleSize} />
        <StatCard label="Tipuri de issue" value={d.severity.length} />
        <StatCard label="Issue-uri grave" value={d.severity.filter((s) => s.severity === 'ridicat').reduce((a, s) => a + s.n, 0)} tone="bad" />
      </div>

      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
        <p className="mb-3 text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-500">Issue-uri după severitate</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {d.severity.map((s) => (
            <StatCard key={s.issue} label={s.issue} value={s.n} tone={severityTone(s.severity) as 'bad' | 'warn' | 'default'} hint={`severitate ${s.severity}`} />
          ))}
        </div>
      </div>

      {Object.entries(d.samples).map(([key, list]) =>
        list.length ? (
          <div key={key} className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
            <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-500">{key} — eșantion</p>
            <div className="space-y-1">
              {list.map((item) => (
                <KeyValueRow key={item.id} k={item.title} v={item.hint ?? (item.len !== undefined ? `${item.len} chars` : `#${item.id}`)} />
              ))}
            </div>
          </div>
        ) : null,
      )}
      <ProviderChip provider={d.provider} />
    </div>
  );
}

/* --------------------------- AI Duplicate Detector --------------------------- */

export function DuplicatesPanel() {
  const res = useApi('ai-suite-duplicates', () => api.aiSuiteDuplicates());
  if (res.loading) return <PanelSkeleton />;
  if (res.error) return <ErrorState message={res.error} onRetry={() => void res.refetch()} />;
  const d = res.data as AiSuiteDuplicatesData;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Titluri comparate" value={d.scanned.toLocaleString('ro-RO')} />
        <StatCard label="Candidați duplicat" value={d.candidatesFound} tone={d.candidatesFound > 0 ? 'warn' : 'good'} hint="scor ≥ 85%" />
        <StatCard label="Afișați" value={d.duplicates.length} hint="top perechi" />
        <StatCard label="Metodă" value="Jaccard+Lev" hint="50% + 50% pe titluri normalizate" />
      </div>

      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
        <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-500">Perechi candidate (A vs B)</p>
        {d.duplicates.length === 0 ? (
          <p className="py-4 text-center text-sm text-zinc-500">Zero duplicate detectate în eșantion — catalog curat. ✨</p>
        ) : (
          <div className="space-y-1.5 max-h-96 overflow-y-auto pr-1">
            {d.duplicates.map((dup, i) => (
              <div key={`${dup.a.id}-${dup.b.id}-${i}`} className="flex items-center gap-3 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2">
                <span
                  className="shrink-0 rounded-full px-2 py-0.5 font-mono text-[10px] font-bold"
                  style={{ background: `rgba(244, 63, 94, ${Math.min(0.35, (dup.score - 80) / 60)})`, color: '#fda4af' }}
                >
                  {dup.score}%
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-zinc-100">{dup.a.title}</p>
                  <p className="truncate text-xs text-zinc-500">vs {dup.b.title}</p>
                </div>
                <span className="shrink-0 font-mono text-[10px] text-zinc-500">{dup.type}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <NoteStrip>{d.note}</NoteStrip>
      <ProviderChip provider={d.provider} />
    </div>
  );
}

/* ----------------------------- AI Poster Scanner ----------------------------- */

export function PosterPanel() {
  const [busy, setBusy] = useState(false);
  const res = useApi('ai-suite-poster', () => api.aiSuitePoster(12));
  const run = async () => {
    setBusy(true);
    try {
      await api.aiSuitePoster(12);
      await res.refetch();
      toast.success('Scanare postere re-rulată', { description: 'Verificare HTTP reală pe eșantion nou.' });
    } catch {
      toast.error('Scanarea a eșuat');
    } finally {
      setBusy(false);
    }
  };
  if (res.loading) return <PanelSkeleton />;
  if (res.error) return <ErrorState message={res.error} onRetry={() => void res.refetch()} />;
  const d = res.data as AiSuitePosterData;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Postere verificate" value={d.checked} hint="HEAD real" />
        <StatCard label="Accesibile" value={d.reachable} tone="good" />
        <StatCard label="Lipsă thumbnail" value={d.missingThumbnail} tone={d.missingThumbnail > 0 ? 'warn' : 'good'} hint="în tot catalogul" />
        <StatCard label="Broken" value={d.broken} tone={d.broken > 0 ? 'bad' : 'good'} />
      </div>

      <AiDigest text={d.vlmSamples.map((v) => `${v.title}: ${v.description}`).join(' · ') || null} provider={d.aiProvider === 'mixed' ? 'z-ai' : undefined} />

      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-500">Rezultate HTTP</p>
          <Button size="sm" variant="outline" onClick={run} disabled={busy} className="h-8 border-white/15 bg-white/5 text-xs">
            {busy ? <RefreshCw className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden /> : <Wand2 className="mr-1.5 h-3.5 w-3.5" aria-hidden />}
            Re-scanare
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {d.results.map((r) => (
            <div key={r.id} className="overflow-hidden rounded-lg border border-white/10 bg-black/30">
              {r.thumbnail ? (
                <img src={r.thumbnail} alt={`Poster: ${r.title}`} className="aspect-[2/3] w-full object-cover" loading="lazy" />
              ) : null}
              <div className="p-2">
                <p className="truncate text-[11px] font-semibold text-zinc-200">{r.title}</p>
                <p className={`font-mono text-[10px] font-bold ${r.reachable ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {r.reachable ? '✓' : '✗'} HTTP {r.httpStatus}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
      <NoteStrip>{d.note}</NoteStrip>
      <ProviderChip provider={d.provider} />
    </div>
  );
}
