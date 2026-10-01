'use client';

/**
 * ai-suite-view.tsx — FAZA 32 (AI SUITE 100X): panoul unic al celor 18 motoare
 * AI noi (#/ai-suite/<engine>). Registry live cu comutatoare persistente
 * (aisettings `suite:*`), navigare horizontală între motoare, panou detaliu
 * per motor. 100% aditiv — AI Hub (FAZA 16) și AI Home (FAZA 15) rămân
 * neatinse și funcționale în paralel.
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
import { AI_SUITE_ENGINES } from '@/lib/animaxia/menu';
import type { AiSuiteStatusResponse } from '@/lib/animaxia/types';
import { Container, PageHeader } from '../section';
import { cn } from '@/lib/utils';
import { AnalyzerPanel, DuplicatesPanel, MetadataPanel, PosterPanel, ScannerPanel } from '../ai-suite/panels-health';
import { FeedsPanel, NewsPanel, SocialPanel, TrendsPanel, WatchPartyPanel } from '../ai-suite/panels-live';
import { FranchisePanel, InfinitePanel, RecommendationsPanel, TaxonomyPanel } from '../ai-suite/panels-intelligence';
import { AdminPanel, DiscoveryPanel, MinerPanel, StatsPanel } from '../ai-suite/panels-ops';

/* --------------------------------- registry -------------------------------- */

function EngineSwitch({
  engineKey,
  enabled,
  onToggleRefresh,
}: {
  engineKey: string;
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
      await api.aiSuiteSettings(engineKey, next);
      toast.success(`${engineKey} ${next ? 'pornit' : 'oprit'}`, {
        description: next ? 'Motorul rulează din nou la cerere.' : 'Endpoint-urile motorului vor răspunde 503.',
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
  return <Switch checked={isOn} onCheckedChange={toggle} disabled={busy} aria-label={`Comută ${engineKey}`} />;
}

function RegistryBar({ onToggleRefresh }: { onToggleRefresh: () => void }) {
  const res = useApi('ai-suite-status', () => api.aiSuiteStatus());
  const [open, setOpen] = useState(false);
  if (res.loading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3 text-sm text-zinc-500">
        <RefreshCw className="h-4 w-4 animate-spin" aria-hidden /> Se încarcă registry-ul celor 18 motoare…
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
  const d = res.data as AiSuiteStatusResponse;
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-xl border border-white/10 bg-white/[0.02]">
      <div className="flex items-center gap-3 px-4 py-3">
        <span className="text-lg leading-none" aria-hidden>🤖</span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-zinc-100">
            Registry AI SUITE — {d.totals.enabled}/{d.totals.total} motoare active
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
          {d.engines.map((e) => (
            <div
              key={e.key}
              className={cn(
                'flex items-center gap-3 rounded-lg border px-3 py-2.5 transition',
                e.enabled ? 'border-white/10 bg-white/[0.02]' : 'border-white/5 bg-transparent opacity-60',
              )}
            >
              <span className="text-base leading-none" aria-hidden>{e.emoji}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-bold text-zinc-100">{e.name}</p>
                <p className="truncate text-[10px] text-zinc-500">
                  {e.stats.runs > 0 ? `${e.stats.runs} rulări · ${e.stats.lastProvider ?? '—'}` : 'nicht rulat încă'}
                </p>
              </div>
              <EngineSwitch engineKey={e.key} enabled={e.enabled} onToggleRefresh={onToggleRefresh} />
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/* ------------------------------- engine panels ------------------------------ */

function EnginePanel({ engine }: { engine: string }) {
  switch (engine) {
    case 'miner':
      return <MinerPanel />;
    case 'metadata':
      return <MetadataPanel />;
    case 'analyzer':
      return <AnalyzerPanel />;
    case 'news':
      return <NewsPanel />;
    case 'social':
      return <SocialPanel />;
    case 'watchparty':
      return <WatchPartyPanel />;
    case 'recommendations':
      return <RecommendationsPanel />;
    case 'franchise':
      return <FranchisePanel />;
    case 'taxonomy':
      return <TaxonomyPanel />;
    case 'stats':
      return <StatsPanel />;
    case 'infinite':
      return <InfinitePanel />;
    case 'scanner':
      return <ScannerPanel />;
    case 'discovery':
      return <DiscoveryPanel />;
    case 'duplicates':
      return <DuplicatesPanel />;
    case 'poster':
      return <PosterPanel />;
    case 'trends':
      return <TrendsPanel />;
    case 'feeds':
      return <FeedsPanel />;
    case 'admin':
      return <AdminPanelOnRoute />;
    default:
      return (
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-8 text-center">
          <p className="text-sm text-zinc-400">Motor necunoscut: {engine}</p>
          <Button onClick={() => navigate('/ai-suite/miner')} variant="outline" size="sm" className="mt-3">
            Înapoi la AI Miner
          </Button>
        </div>
      );
  }
}

/* Admin panel with registry refresh wiring (route-level). */
function AdminPanelOnRoute() {
  const [refreshKey, setRefreshKey] = useState(0);
  return (
    <div key={refreshKey}>
      <AdminPanel onToggleRefresh={() => setRefreshKey((k) => k + 1)} />
    </div>
  );
}

/* ---------------------------------- the view -------------------------------- */

export function AiSuiteView({ route }: { route: AppRoute }) {
  const engineParam = route.params[0];
  const validKeys = useMemo(() => AI_SUITE_ENGINES.map((e) => e.key), []);
  const engine = engineParam && validKeys.includes(engineParam) ? engineParam : 'miner';
  const meta = AI_SUITE_ENGINES.find((e) => e.key === engine);
  const [registryKey, setRegistryKey] = useState(0);

  return (
    <Container className="pb-16">
      <PageHeader title="AI SUITE 100X 🧠" subtitle="Cele 18 motoare AI ale Animaxia 2.0 — date 100% reale, provideri etichetați onest, zero simulări." />

      <div className="mb-4">
        <RegistryBar key={registryKey} onToggleRefresh={() => setRegistryKey((k) => k + 1)} />
      </div>

      {/* Horizontal engine navigation */}
      <nav aria-label="Navigare motoare AI" className="mb-5 flex gap-2 overflow-x-auto pb-2">
        {AI_SUITE_ENGINES.map((e) => (
          <button
            key={e.key}
            type="button"
            onClick={() => navigate(`/ai-suite/${e.key}`)}
            aria-current={e.key === engine ? 'page' : undefined}
            className={cn(
              'flex shrink-0 items-center gap-1.5 rounded-full border px-3.5 py-2 text-xs font-bold transition',
              e.key === engine
                ? 'border-rose-500/50 bg-rose-500/15 text-rose-200'
                : 'border-white/10 bg-white/[0.03] text-zinc-400 hover:border-white/25 hover:text-zinc-100',
            )}
          >
            <span aria-hidden>{e.emoji}</span>
            {e.label}
          </button>
        ))}
      </nav>

      <section aria-label={meta?.label ?? engine}>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <h2 className="text-xl font-black text-white">
            <span aria-hidden className="mr-2">{meta?.emoji}</span>
            {meta?.label ?? engine}
          </h2>
        </div>
        <EnginePanel engine={engine} />
      </section>
    </Container>
  );
}
