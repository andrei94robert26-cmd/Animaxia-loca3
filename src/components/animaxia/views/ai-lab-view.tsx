'use client';

/**
 * ai-lab-view.tsx — FAZA 35 (PLAN 100X · WS5): panoul unic AI LAB — cele 8
 * capabilități AI noi (#/ai-lab/<cap>): companion, recap, mood, shield,
 * dubbing, curation, voice, editor. Registry live cu comutatoare persistente,
 * navigare orizontală între capabilități, panou detaliu per capabilitate.
 * 100% aditiv — AI Suite (FAZA 32), AI Hub (FAZA 16) și AI Home (FAZA 15)
 * rămân neatinse și funcționale în paralel.
 */

import { useMemo, useState } from 'react';
import { ChevronDown, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Switch } from '@/components/ui/switch';
import { api, ApiError } from '@/lib/animaxia/api';
import { useApi } from '@/lib/animaxia/hooks';
import { navigate, type AppRoute } from '@/lib/animaxia/router';
import { AI_LAB_CAPS } from '@/lib/animaxia/menu';
import type { AiLabStatusResponse } from '@/lib/animaxia/types';
import { Container, PageHeader } from '../section';
import { cn } from '@/lib/utils';
import { CompanionPanel } from '../ai-lab/panels-companion';
import { RecapPanel } from '../ai-lab/panels-recap';
import { MoodPanel } from '../ai-lab/panels-mood';
import { ShieldPanel } from '../ai-lab/panels-shield';
import { DubbingPanel } from '../ai-lab/panels-dubbing';
import { CurationPanel } from '../ai-lab/panels-curation';
import { VoicePanel } from '../ai-lab/panels-voice';
import { EditorPanel } from '../ai-lab/panels-editor';

/* --------------------------------- registry -------------------------------- */

function CapabilitySwitch({
  capKey,
  enabled,
  onToggleRefresh,
}: {
  capKey: string;
  enabled: boolean;
  onToggleRefresh: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const isOn = optimistic ?? enabled;
  const toggle = async (next: boolean) => {
    setBusy(true);
    setOptimistic(next);
    try {
      await api.aiLabSettings(capKey, next);
      toast.success(`${capKey} ${next ? 'pornită' : 'oprită'}`, {
        description: next ? 'Capabilitatea răspunde din nou la cerere.' : 'Endpoint-urile capabilității vor răspunde 503.',
      });
      onToggleRefresh();
    } catch (e) {
      setOptimistic(null);
      toast.error('Comutarea a eșuat', {
        description: e instanceof ApiError ? e.message : 'backend-ul nu răspunde',
      });
    } finally {
      setBusy(false);
      setOptimistic(null);
    }
  };
  return <Switch checked={isOn} onCheckedChange={toggle} disabled={busy} aria-label={`Comută ${capKey}`} />;
}

function RegistryBar({ onToggleRefresh }: { onToggleRefresh: () => void }) {
  const res = useApi('ai-lab-status', () => api.aiLabStatus());
  const [open, setOpen] = useState(false);
  if (res.loading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3 text-sm text-zinc-500">
        <RefreshCw className="h-4 w-4 animate-spin" aria-hidden /> Se încarcă registry-ul celor 8 capabilități…
      </div>
    );
  }
  if (res.error) {
    return (
      <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
        Registry indisponibil: {res.error}
      </div>
    );
  }
  const d = res.data as AiLabStatusResponse;
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-xl border border-white/10 bg-white/[0.02]">
      <div className="flex items-center gap-3 px-4 py-3">
        <span className="text-lg leading-none" aria-hidden>🧪</span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-zinc-100">
            Registry AI LAB — {d.totals.enabled}/{d.totals.total} capabilități active
          </p>
          <p className="text-[11px] text-zinc-500">{d.suite} · {d.faza} · persistență în aisettings</p>
        </div>
        <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-emerald-300">
          {d.totals.disabled === 0 ? 'TOATE ON' : `${d.totals.disabled} oprite`}
        </Badge>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="h-8 gap-1 px-2 text-xs text-zinc-400">
            {open ? 'Ascunde' : 'Comutatoare'}
            <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} aria-hidden />
          </Button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent>
        <div className="grid gap-2 border-t border-white/5 p-3 sm:grid-cols-2 lg:grid-cols-3">
          {d.capabilities.map((c) => (
            <div
              key={c.key}
              className={cn(
                'flex items-center gap-3 rounded-lg border px-3 py-2.5 transition',
                c.enabled ? 'border-white/10 bg-white/[0.02]' : 'border-white/5 bg-transparent opacity-60',
              )}
            >
              <span className="text-base leading-none" aria-hidden>{c.emoji}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-bold text-zinc-100">{c.name}</p>
                <p className="truncate text-[10px] text-zinc-500">
                  {c.stats.runs > 0
                    ? `${c.stats.runs} rulări · ${c.stats.lastProvider ?? '—'}`
                    : 'nerulată încă'}
                </p>
              </div>
              <CapabilitySwitch capKey={c.key} enabled={c.enabled} onToggleRefresh={onToggleRefresh} />
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/* ----------------------------- capability panels ---------------------------- */

function CapabilityPanel({ cap }: { cap: string }) {
  switch (cap) {
    case 'companion':
      return <CompanionPanel />;
    case 'recap':
      return <RecapPanel />;
    case 'mood':
      return <MoodPanel />;
    case 'shield':
      return <ShieldPanel />;
    case 'dubbing':
      return <DubbingPanel />;
    case 'curation':
      return <CurationPanel />;
    case 'voice':
      return <VoicePanel />;
    case 'editor':
      return <EditorPanel />;
    default:
      return (
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-8 text-center">
          <p className="text-sm text-zinc-400">Capabilitate necunoscută: {cap}</p>
          <Button onClick={() => navigate('/ai-lab/companion')} variant="outline" size="sm" className="mt-3">
            Înapoi la AI Companion
          </Button>
        </div>
      );
  }
}

/* ---------------------------------- the view -------------------------------- */

export function AiLabView({ route }: { route: AppRoute }) {
  const capParam = route.params[0];
  const validKeys = useMemo(() => AI_LAB_CAPS.map((c) => c.key), []);
  const cap = capParam && validKeys.includes(capParam) ? capParam : 'companion';
  const meta = AI_LAB_CAPS.find((c) => c.key === cap);
  const [registryKey, setRegistryKey] = useState(0);

  return (
    <Container className="pb-16">
      <PageHeader
        title="AI Lab 🧪"
        subtitle="FAZA 35 · 8 capabilități AI noi — Companion, Recap, Mood, Spoiler Shield, Dubbing, Curation, Voice și Playlist Editor. Date 100% reale, provideri etichetați onest."
      />

      <div className="mb-4">
        <RegistryBar key={registryKey} onToggleRefresh={() => setRegistryKey((k) => k + 1)} />
      </div>

      {/* Navigare orizontală între capabilități (scroll pe mobil — ca la AI Suite) */}
      <nav aria-label="Navigare capabilități AI Lab" className="mb-5 flex gap-2 overflow-x-auto pb-2">
        {AI_LAB_CAPS.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => navigate(`/ai-lab/${c.key}`)}
            aria-current={c.key === cap ? 'page' : undefined}
            className={cn(
              'flex shrink-0 items-center gap-1.5 rounded-full border px-3.5 py-2 text-xs font-bold transition',
              c.key === cap
                ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-200'
                : 'border-white/10 bg-white/[0.03] text-zinc-400 hover:border-white/25 hover:text-zinc-100',
            )}
          >
            <span aria-hidden>{c.emoji}</span>
            {c.label}
          </button>
        ))}
      </nav>

      <section aria-label={meta?.label ?? cap}>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <h2 className="text-xl font-black text-white">
            <span aria-hidden className="mr-2">{meta?.emoji}</span>
            {meta?.label ?? cap}
          </h2>
        </div>
        <CapabilityPanel cap={cap} />
      </section>
    </Container>
  );
}
