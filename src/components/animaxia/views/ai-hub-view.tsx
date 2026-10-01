'use client';

/**
 * ai-hub-view.tsx — AI Hub (#/aihub, FAZA 16).
 *
 * Cele 6 AI-uri noi (Curator, Trend Forecaster, Semantic Search, Watchdog,
 * Marathon Builder, Translator) ca carduri comutabile live (persistență în
 * Neon prin POST /api/ai/hub/settings), fiecare cu panou detaliu expandabil
 * care încarcă datele live doar când e deschis și AI-ul e pornit. Secțiunea
 * „AI-uri existente” listează motoarele din FAZA 15 (fără switch — gestionate
 * în Home).
 */

import { useState } from 'react';
import {
  AlertTriangle,
  Bot,
  Brain,
  Check,
  ChevronDown,
  Globe2,
  Languages,
  Loader2,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ApiError, api } from '@/lib/animaxia/api';
import { useApi } from '@/lib/animaxia/hooks';
import { navigate } from '@/lib/animaxia/router';
import type { AiHubAi, AiHubKey, CuratorEnrichResponse } from '@/lib/animaxia/types';
import { Container, PageHeader, Section } from '../section';
import { EmptyState, ErrorState } from '../states';
import { cn } from '@/lib/utils';

/* ------------------------------ provider chip ----------------------------- */

const PROVIDER_STYLES: Record<string, string> = {
  'z-ai': 'border-rose-500/40 bg-rose-500/15 text-rose-300',
  heuristic: 'border-zinc-500/40 bg-zinc-500/15 text-zinc-300',
  sql: 'border-teal-500/40 bg-teal-500/15 text-teal-300',
  'hashed-bow': 'border-fuchsia-500/40 bg-fuchsia-500/15 text-fuchsia-300',
  tmdb: 'border-amber-500/40 bg-amber-500/15 text-amber-300',
};

function ProviderChip({ provider }: { provider: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px] font-bold',
        PROVIDER_STYLES[provider] ?? PROVIDER_STYLES.heuristic,
      )}
      title={`Provider: ${provider}`}
    >
      {provider}
    </span>
  );
}

/* --------------------------------- the view -------------------------------- */

export function AiHubView() {
  const statusRes = useApi('ai-hub-status', () => api.aiHubStatus());
  /* Optimistic on/off overrides (backend truth arrives via refetch). */
  const [overrides, setOverrides] = useState<Partial<Record<AiHubKey, boolean>>>({});

  const toggle = (key: AiHubKey, next: boolean, name: string) => {
    setOverrides((prev) => ({ ...prev, [key]: next }));
    api
      .aiHubToggle(key, next)
      .then(() => toast.success(next ? `${name} activat` : `${name} oprit`))
      .catch(() => {
        setOverrides((prev) => ({ ...prev, [key]: !next }));
        toast.error('Comutatorul nu a putut fi salvat', {
          description: 'Backend-ul nu răspunde — am revenit la starea anterioară.',
        });
      });
  };

  const ais = statusRes.data?.ais ?? [];
  const activeCount = ais.filter((a) => overrides[a.key] ?? a.enabled).length;

  return (
    <Container className="space-y-8 py-8 sm:py-10">
      <PageHeader
        title="AI Hub"
        subtitle={`Toate AI-urile platformei — ${activeCount} active, comutabile live`}
      >
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Badge className="border-rose-500/30 bg-rose-500/15 text-rose-300 hover:bg-rose-500/15">
            <span className="relative mr-1.5 flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-rose-500" />
            </span>
            LIVE
          </Badge>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void statusRes.refetch()}
            disabled={statusRes.loading}
            className="h-8 border-white/15 bg-white/5 text-zinc-200 hover:bg-white/10 hover:text-white"
          >
            <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', statusRes.loading && 'animate-spin')} aria-hidden />
            Reîmprospătează
          </Button>
        </div>
      </PageHeader>

      {statusRes.error && !statusRes.loading && !statusRes.data ? (
        <ErrorState message={statusRes.error} onRetry={() => void statusRes.refetch()} />
      ) : ais.length === 0 && statusRes.loading ? (
        <div className="grid gap-4 md:grid-cols-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-40 rounded-2xl" />
          ))}
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {ais.map((ai) => (
            <AiCard
              key={ai.key}
              ai={ai}
              enabled={overrides[ai.key] ?? ai.enabled}
              onToggle={(next) => toggle(ai.key, next, ai.name)}
            />
          ))}
        </div>
      )}

      {/* ---------------------- existing AI engines (FAZA 15) ---------------------- */}
      {(statusRes.data?.existing ?? []).length > 0 ? (
        <Section title="AI-uri existente" subtitle="Motoarele AI integrate în platformă — gestionate din Home.">
          <div className="space-y-2">
            {(statusRes.data?.existing ?? []).map((ex) => (
              <div
                key={ex.key}
                className="flex flex-col gap-2 rounded-xl border border-white/10 bg-white/[0.03] p-3.5 sm:flex-row sm:items-center"
              >
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-black/40 text-lg" aria-hidden>
                  {ex.emoji}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold text-zinc-100">{ex.name}</p>
                  <p className="text-xs leading-relaxed text-zinc-500">{ex.note}</p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => navigate(ex.key === 'home' ? '/home' : '/ai')}
                  className="h-8 shrink-0 border-white/15 bg-white/5 text-xs font-semibold text-zinc-200 hover:bg-white/10 hover:text-white"
                >
                  Deschide
                </Button>
              </div>
            ))}
          </div>
        </Section>
      ) : null}
    </Container>
  );
}

/* --------------------------------- AI card --------------------------------- */

function AiStatsLine({ ai }: { ai: AiHubAi }) {
  const s = ai.stats ?? {};
  const text = (() => {
    switch (ai.key) {
      case 'curator':
        return `${s.duplicates ?? 0} grupuri duplicate · scor mediu ${s.avgCompleteness ?? 0}%`;
      case 'forecaster':
        return `${s.eventsAnalyzed ?? 0} evenimente de vizionare analizate`;
      case 'semantic':
        return `${s.embedded ?? 0}/${s.total ?? 0} docs embedate · ${ai.provider}`;
      case 'watchdog':
        return `scor ${s.score ?? '—'} · ${s.alerts ?? 0} alerte`;
      case 'marathon':
        return `${s.marathons ?? 0} maratoane salvate`;
      case 'translator':
        return `${s.translations ?? 0} traduceri salvate`;
      default:
        return '';
    }
  })();
  if (!text) return null;
  return <p className="text-xs font-medium text-zinc-400">{text}</p>;
}

function AiCard({ ai, enabled, onToggle }: { ai: AiHubAi; enabled: boolean; onToggle: (next: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const active = open && enabled;

  return (
    <div
      className={cn(
        'min-w-0 rounded-2xl border bg-white/[0.03] transition',
        enabled ? 'border-white/10' : 'border-white/5 opacity-80',
      )}
    >
      <div className="min-w-0 space-y-3 p-4">
        <div className="flex items-start gap-3">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-white/10 to-white/[0.03] text-2xl" aria-hidden>
            {ai.emoji}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-bold text-white">{ai.name}</h3>
              <ProviderChip provider={ai.provider} />
            </div>
            <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-zinc-500">{ai.description}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className={cn('text-[10px] font-bold uppercase', enabled ? 'text-emerald-400' : 'text-zinc-500')}>
              {enabled ? 'ON' : 'OFF'}
            </span>
            <Switch
              checked={enabled}
              onCheckedChange={onToggle}
              aria-label={`${enabled ? 'Oprește' : 'Activează'} ${ai.name}`}
              className="data-[state=checked]:bg-rose-600"
            />
          </div>
        </div>
        <AiStatsLine ai={ai} />
      </div>

      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="flex w-full items-center gap-2 border-t border-white/10 px-4 py-2.5 text-left text-xs font-semibold text-zinc-400 transition hover:bg-white/[0.04] hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60">
          <ChevronDown className={cn('h-3.5 w-3.5 transition-transform duration-200', open && 'rotate-180')} aria-hidden />
          {open ? 'Ascunde detaliile' : 'Vezi detaliile live'}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-t border-white/10 p-4">
            {!enabled ? (
              <div className="flex items-center gap-2 rounded-xl border border-zinc-500/30 bg-zinc-500/10 p-3 text-sm text-zinc-400">
                <X className="h-4 w-4 shrink-0" aria-hidden />
                AI oprit — activează-l ca să vezi datele.
              </div>
            ) : ai.key === 'curator' ? (
              <CuratorDetail active={active} />
            ) : ai.key === 'forecaster' ? (
              <ForecasterDetail active={active} />
            ) : ai.key === 'semantic' ? (
              <SemanticDetail active={active} />
            ) : ai.key === 'watchdog' ? (
              <WatchdogDetail active={active} />
            ) : ai.key === 'marathon' ? (
              <MarathonDetail active={active} />
            ) : (
              <TranslatorDetail active={active} />
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

/* ------------------------------- panel helpers ----------------------------- */

function PanelLoading({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="Se încarcă datele AI">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-12 w-full rounded-xl" />
      ))}
    </div>
  );
}

/* ------------------------------ Curator detail ----------------------------- */

const FIELD_LABELS: Record<string, string> = {
  year: 'an',
  genres: 'genuri',
  description: 'descriere',
  actors: 'actori',
  studios: 'studiouri',
  title: 'titlu',
  thumbnail: 'poster',
  trailer: 'trailer',
};

function CuratorDetail({ active }: { active: boolean }) {
  const scan = useApi('hub-curator-scan', () => api.curatorScan(), { enabled: active });
  const [enriching, setEnriching] = useState(false);
  const [enriched, setEnriched] = useState<CuratorEnrichResponse | null>(null);

  const enrich = async () => {
    setEnriching(true);
    try {
      const res = await api.curatorEnrich({ missing: true, limit: 5 });
      setEnriched(res);
      toast.success(
        res.enriched.length > 0
          ? `${res.enriched.length} ${res.enriched.length === 1 ? 'titlu îmbogățit' : 'titluri îmbogățite'} (${res.provider})`
          : 'Nimic de îmbogățit — metadata e completă',
      );
      void scan.refetch();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        toast.error('Conectează-te ca să îmbogățești metadata');
      } else if (err instanceof ApiError && err.status === 503) {
        toast.error('AI Curator este oprit');
      } else {
        toast.error('Îmbogățirea a eșuat', { description: err instanceof Error ? err.message : undefined });
      }
    } finally {
      setEnriching(false);
    }
  };

  if (!active) return <PanelLoading />;
  if (scan.error && !scan.loading && !scan.data) return <ErrorState message={scan.error} onRetry={() => void scan.refetch()} />;
  if (!scan.data) return <PanelLoading rows={4} />;

  const data = scan.data;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
        <span className="font-semibold text-zinc-200">{data.scanned} itemi scanați</span>
        <span>· scor mediu completitudine</span>
        <span className="font-bold text-fuchsia-300">{data.avgScore}%</span>
        <Button
          size="sm"
          onClick={() => void enrich()}
          disabled={enriching}
          className="ml-auto h-8 bg-fuchsia-600 text-xs font-bold text-white hover:bg-fuchsia-500"
        >
          {enriching ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden /> : <Sparkles className="mr-1.5 h-3.5 w-3.5" aria-hidden />}
          Îmbogățește metadata acum
        </Button>
      </div>

      {enriched ? (
        <div className="rounded-xl border border-fuchsia-500/30 bg-fuchsia-500/10 p-3">
          <p className="text-xs font-bold text-fuchsia-200">
            Ultima îmbogățire ({enriched.provider}) — {enriched.enriched.length}{' '}
            {enriched.enriched.length === 1 ? 'titlu' : 'titluri'}
          </p>
          {enriched.enriched.length === 0 ? (
            <p className="mt-1 text-xs text-fuchsia-300/70">Toate câmpurile lipsă au fost deja acoperite.</p>
          ) : (
            <ul className="mt-1.5 space-y-1">
              {enriched.enriched.map((e) => (
                <li key={e.contentId} className="text-xs text-zinc-300">
                  <span className="font-semibold">{e.title}</span> — adăugat: {e.added.map((f) => FIELD_LABELS[f] ?? f).join(', ')}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {/* duplicates */}
      <div>
        <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-zinc-500">
          Duplicate detectate — {data.duplicates.length}
        </p>
        {data.duplicates.length === 0 ? (
          <p className="rounded-xl border border-white/10 bg-white/[0.02] p-3 text-xs text-zinc-500">
            Nicio pereche duplicată găsită în bibliotecă.
          </p>
        ) : (
          <ul className="space-y-2">
            {data.duplicates.map((dup, i) => (
              <li key={i} className="rounded-xl border border-amber-500/20 bg-amber-500/[0.06] p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full border border-amber-500/30 bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold text-amber-300">
                    {dup.reason === 'same-source' ? 'sursă comună' : 'titlu similar'}
                  </span>
                  <span className="ml-auto text-[11px] font-bold text-amber-200">
                    similaritate {(dup.similarity * 100).toFixed(0)}%
                  </span>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <div className="min-w-0 flex-1 space-y-0.5">
                    {dup.titles.map((t, j) => (
                      <button
                        key={j}
                        type="button"
                        onClick={() => navigate(`/content/${dup.ids[j]}`)}
                        className="block max-w-full truncate text-left text-xs font-medium text-zinc-300 underline-offset-2 hover:text-rose-300 hover:underline"
                        title={`Deschide „${t}”`}
                      >
                        {t} <span className="text-zinc-600">#{dup.ids[j]}</span>
                      </button>
                    ))}
                  </div>
                  <Progress value={dup.similarity * 100} className="h-1.5 w-20 shrink-0 bg-white/10" />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* completeness */}
      <div>
        <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-zinc-500">
          Completitudine metadata — cele mai incomplete 8
        </p>
        <ul className="space-y-2">
          {data.completeness.slice(0, 8).map((c) => (
            <li key={c.contentId} className="rounded-xl border border-white/10 bg-white/[0.02] p-2.5">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => navigate(`/content/${c.contentId}`)}
                  className="min-w-0 flex-1 truncate text-left text-xs font-semibold text-zinc-200 underline-offset-2 hover:text-rose-300 hover:underline"
                >
                  {c.title}
                </button>
                <span className="shrink-0 text-xs font-black text-fuchsia-300">{c.score}%</span>
              </div>
              <div className="mt-1.5 flex items-center gap-2">
                <Progress value={c.score} className="h-1.5 flex-1 bg-white/10" />
                <div className="flex shrink-0 flex-wrap justify-end gap-1">
                  {c.missing.slice(0, 4).map((f) => (
                    <span key={f} className="rounded-full border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[10px] text-zinc-500">
                      {FIELD_LABELS[f] ?? f}
                    </span>
                  ))}
                  {c.missing.length > 4 ? <span className="text-[10px] text-zinc-600">+{c.missing.length - 4}</span> : null}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/* ---------------------------- Forecaster detail ---------------------------- */

const WINDOWS: { value: '1d' | '7d' | '30d'; label: string }[] = [
  { value: '1d', label: '1z' },
  { value: '7d', label: '7z' },
  { value: '30d', label: '30z' },
];

function ForecasterDetail({ active }: { active: boolean }) {
  const [window, setWindow] = useState<'1d' | '7d' | '30d'>('7d');
  const forecast = useApi(`hub-forecast-${window}`, () => api.trendsForecast(window), { enabled: active });

  if (!active) return <PanelLoading />;
  if (forecast.error && !forecast.loading && !forecast.data)
    return <ErrorState message={forecast.error} onRetry={() => void forecast.refetch()} />;
  if (!forecast.data) return <PanelLoading rows={4} />;

  const data = forecast.data;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Tabs value={window} onValueChange={(v) => setWindow(v as typeof window)}>
          <TabsList className="h-8 rounded-lg border border-white/10 bg-white/[0.03] p-0.5">
            {WINDOWS.map((w) => (
              <TabsTrigger
                key={w.value}
                value={w.value}
                className="h-7 px-3 text-xs text-zinc-400 data-[state=active]:bg-rose-600 data-[state=active]:text-white"
              >
                {w.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <span className="text-[11px] text-zinc-500">
          {data.eventsAnalyzed} evenimente · {data.source === 'viewevents' ? 'vizionări reale' : 'euristică bibliotecă'}
        </span>
        <ProviderChip provider={data.provider} />
      </div>

      <blockquote className="rounded-xl border-l-4 border-rose-500 bg-rose-500/[0.06] p-3 text-xs leading-relaxed text-zinc-200">
        {data.narrative}
      </blockquote>

      <div>
        <p className="mb-2 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-500">
          <TrendingUp className="h-3.5 w-3.5" aria-hidden /> În ascensiune
        </p>
        {data.rising.length === 0 ? (
          <p className="rounded-xl border border-white/10 bg-white/[0.02] p-3 text-xs text-zinc-500">
            Niciun trend în creștere în această fereastră.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {data.rising.slice(0, 6).map((r) => (
              <li key={r.contentId} className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.02] px-2.5 py-2">
                <button
                  type="button"
                  onClick={() => navigate(`/content/${r.contentId}`)}
                  className="min-w-0 flex-1 truncate text-left text-xs font-semibold text-zinc-200 hover:text-rose-300"
                >
                  {r.title}
                </button>
                {r.recentViews != null ? (
                  <span className="shrink-0 text-[10px] text-zinc-500">{r.recentViews} vizionări</span>
                ) : null}
                {r.momentum != null ? (
                  <span className="shrink-0 rounded-full border border-emerald-500/30 bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold text-emerald-300">
                    +{r.momentum.toFixed(0)}%
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-zinc-500">Top vizionări</p>
        <ul className="space-y-1">
          {data.top.slice(0, 5).map((r, i) => (
            <li key={r.contentId} className="flex items-center gap-2 text-xs text-zinc-400">
              <span className="w-4 shrink-0 text-center font-black text-zinc-600">{i + 1}</span>
              <button
                type="button"
                onClick={() => navigate(`/content/${r.contentId}`)}
                className="min-w-0 flex-1 truncate text-left hover:text-rose-300"
              >
                {r.title}
              </button>
              {r.recentViews != null ? <span className="shrink-0 text-[10px] text-zinc-500">{r.recentViews}</span> : null}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/* ----------------------------- Semantic detail ----------------------------- */

function SemanticDetail({ active }: { active: boolean }) {
  const status = useApi('hub-semantic-status', () => api.semanticStatus(), { enabled: active });
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Awaited<ReturnType<typeof api.semanticQuery>> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.semanticQuery(trimmed, 12);
      setResults(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Căutarea semantică a eșuat');
      setResults(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
        <Brain className="h-4 w-4 text-fuchsia-400" aria-hidden />
        {status.data ? (
          <span>
            <span className="font-bold text-zinc-200">
              {status.data.embedded}/{status.data.total}
            </span>{' '}
            docs embedate · {status.data.provider} · {status.data.dims}-dim
          </span>
        ) : (
          <span>se încarcă statusul embeddings…</span>
        )}
      </div>

      <form onSubmit={run} className="flex flex-col gap-2 sm:flex-row">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Caută semantic: „desert planet science fiction”…"
          aria-label="Interogare semantică"
          className="h-10 border-white/10 bg-black/40"
        />
        <Button type="submit" disabled={!query.trim() || busy} className="h-10 bg-fuchsia-600 font-bold hover:bg-fuchsia-500">
          {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden /> : <Search className="mr-1.5 h-4 w-4" aria-hidden />}
          Caută
        </Button>
      </form>

      {error ? <ErrorState message={error} compact onRetry={() => setError(null)} /> : null}

      {results ? (
        results.results.length === 0 ? (
          <EmptyState title="Nicio potrivire semantică" message="Încearcă o formulare diferită — embeddings-ul lucrează pe sens, nu pe cuvinte exacte." />
        ) : (
          <div className="space-y-2">
            <p className="text-[11px] text-zinc-500">
              {results.results.length} rezultate · {results.embeddedDocs} docs căutate · {results.provider}
            </p>
            <ul className="space-y-1.5">
              {results.results.map((r) => (
                <li key={`${r.contentId}-${r.externalid}`}>
                  <button
                    type="button"
                    onClick={() => navigate(`/content/${r.contentId}`)}
                    className="flex w-full items-center gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-2 text-left transition hover:border-fuchsia-500/40 hover:bg-fuchsia-500/[0.06]"
                  >
                    {r.thumbnail ? (
                      <img src={r.thumbnail} alt="" loading="lazy" className="h-12 w-9 shrink-0 rounded object-cover" />
                    ) : (
                      <span className="grid h-12 w-9 shrink-0 place-items-center rounded bg-white/[0.04]">
                        <Brain className="h-4 w-4 text-zinc-600" aria-hidden />
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-semibold text-zinc-200">{r.title}</span>
                      <span className="block text-[10px] text-zinc-500">{r.type}</span>
                    </span>
                    <span className="shrink-0 rounded-full border border-fuchsia-500/40 bg-black/60 px-2 py-0.5 text-[10px] font-bold text-fuchsia-300">
                      {r.score.toFixed(3)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )
      ) : active ? null : (
        <PanelLoading rows={2} />
      )}
    </div>
  );
}

/* ----------------------------- Watchdog detail ----------------------------- */

function WatchdogDetail({ active }: { active: boolean }) {
  const health = useApi('hub-watchdog-health', () => api.watchdogHealth(), { enabled: active });

  if (!active) return <PanelLoading />;
  if (health.error && !health.loading && !health.data)
    return <ErrorState message={health.error} onRetry={() => void health.refetch()} />;
  if (!health.data) return <PanelLoading rows={4} />;

  const data = health.data;
  const scoreColor = data.score >= 80 ? 'text-emerald-400' : data.score >= 50 ? 'text-amber-400' : 'text-red-400';
  const scoreBorder = data.score >= 80 ? 'border-emerald-500/40' : data.score >= 50 ? 'border-amber-500/40' : 'border-red-500/40';

  return (
    <div className="space-y-4">
      <div className={cn('flex items-center gap-4 rounded-xl border bg-white/[0.02] p-3', scoreBorder)}>
        <div className="text-center">
          <p className={cn('text-3xl font-black leading-none', scoreColor)}>{data.score}</p>
          <p className="mt-1 text-[10px] font-bold uppercase tracking-wider text-zinc-500">scor sănătate</p>
        </div>
        <div className="min-w-0 flex-1">
          <Progress value={data.score} className="h-2 bg-white/10" />
          <p className="mt-1.5 text-[11px] text-zinc-500">
            {data.checks.filter((c) => c.status === 'pass').length}/{data.checks.length} verificări trecute ·{' '}
            {data.alerts.length} alerte
          </p>
        </div>
        <ProviderChip provider={data.provider} />
      </div>

      <ul className="space-y-1.5">
        {data.checks.map((c) => (
          <li key={c.name} className="flex items-start gap-2 rounded-xl border border-white/10 bg-white/[0.02] px-2.5 py-2">
            {c.status === 'pass' ? (
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" aria-hidden />
            ) : c.status === 'warn' ? (
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" aria-hidden />
            ) : (
              <X className="mt-0.5 h-4 w-4 shrink-0 text-red-400" aria-hidden />
            )}
            <div className="min-w-0">
              <p className="text-xs font-semibold text-zinc-200">{c.name}</p>
              <p className="text-[11px] leading-relaxed text-zinc-500">{c.detail}</p>
            </div>
          </li>
        ))}
      </ul>

      {data.alerts.length > 0 ? (
        <div>
          <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-zinc-500">Alerte</p>
          <ul className="space-y-1.5">
            {data.alerts.map((a, i) => (
              <li
                key={i}
                className={cn(
                  'rounded-xl border p-2.5 text-xs',
                  a.severity === 'critical'
                    ? 'border-red-500/30 bg-red-500/10 text-red-200'
                    : a.severity === 'warning'
                      ? 'border-amber-500/30 bg-amber-500/10 text-amber-200'
                      : 'border-zinc-500/30 bg-zinc-500/10 text-zinc-300',
                )}
              >
                <p className="font-bold">
                  {a.area}: {a.message}
                </p>
                <p className="mt-0.5 text-[11px] opacity-70">{a.hint}</p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <blockquote className="rounded-xl border-l-4 border-rose-500 bg-rose-500/[0.06] p-3 text-xs leading-relaxed text-zinc-200">
        {data.diagnosis}
      </blockquote>
    </div>
  );
}

/* ----------------------------- Marathon detail ----------------------------- */

function marathonTarget(item: { contentId: number | null; externalId: string }): string | null {
  if (item.contentId != null) return `/content/${item.contentId}`;
  const m = /^tmdb:(movie|tv):(.+)$/.exec(item.externalId);
  if (m) return `/content/ext:${m[1]}:${m[2]}`;
  return null;
}

function MarathonDetail({ active }: { active: boolean }) {
  const suggestions = useApi('hub-marathon-suggestions', () => api.marathonSuggestions(), { enabled: active });
  const [saving, setSaving] = useState<string | null>(null);

  if (!active) return <PanelLoading />;
  if (suggestions.error && !suggestions.loading && !suggestions.data)
    return <ErrorState message={suggestions.error} onRetry={() => void suggestions.refetch()} />;
  if (!suggestions.data) return <PanelLoading rows={4} />;

  const save = async (key: string, title: string) => {
    setSaving(key);
    try {
      const res = await api.marathonCreate(key);
      toast.success('Maraton salvat', { description: `${res.marathon.title} · ${res.marathon.items.length} părți` });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        toast.error('Conectează-te ca să salvezi maratonul');
      } else {
        toast.error('Maratonul nu a putut fi salvat', { description: err instanceof Error ? err.message : undefined });
      }
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-[11px] text-zinc-500">
        {suggestions.data.suggestions.length} maratoane generate din francize, trilogii și biblioteca ta — derulează orizontal.
      </p>
      <div className="no-scrollbar -mx-1 flex snap-x gap-3 overflow-x-auto px-1 pb-1">
        {suggestions.data.suggestions.map((s) => (
          <div
            key={s.key}
            className="flex w-64 shrink-0 snap-start flex-col gap-2 rounded-xl border border-white/10 bg-white/[0.03] p-3 sm:w-72"
          >
            <div className="flex items-center gap-2">
              <span className="text-lg" aria-hidden>
                {s.emoji}
              </span>
              <p className="min-w-0 flex-1 truncate text-xs font-bold text-white">{s.title}</p>
              <span className="shrink-0 rounded-full border border-teal-500/30 bg-teal-500/15 px-2 py-0.5 text-[10px] font-bold text-teal-300">
                {s.count} părți
              </span>
            </div>
            <div className="flex items-center gap-1">
              {s.items.slice(0, 6).map((item) => {
                const target = marathonTarget(item);
                return target ? (
                  <button
                    key={`${item.externalId}-${item.order}`}
                    type="button"
                    onClick={() => navigate(target)}
                    title={`${item.order}. ${item.title}${item.year ? ` (${item.year})` : ''}`}
                    className="h-14 w-10 shrink-0 overflow-hidden rounded border border-white/10 transition hover:border-rose-500/50"
                  >
                    {item.thumbnail ? (
                      <img src={item.thumbnail} alt="" loading="lazy" className="h-full w-full object-cover" />
                    ) : (
                      <span className="grid h-full w-full place-items-center bg-white/[0.04] text-[10px] text-zinc-500">
                        {item.order}
                      </span>
                    )}
                  </button>
                ) : (
                  <span key={`${item.externalId}-${item.order}`} className="h-14 w-10 shrink-0 rounded bg-white/[0.04]" />
                );
              })}
              {s.items.length > 6 ? (
                <span className="grid h-14 w-8 shrink-0 place-items-center rounded border border-white/10 bg-white/[0.04] text-[10px] font-bold text-zinc-400">
                  +{s.items.length - 6}
                </span>
              ) : null}
            </div>
            <p className="line-clamp-2 text-[11px] leading-relaxed text-zinc-500">{s.rationale}</p>
            <Button
              size="sm"
              onClick={() => void save(s.key, s.title)}
              disabled={saving === s.key}
              className="h-8 w-full bg-teal-600 text-xs font-bold text-white hover:bg-teal-500"
            >
              {saving === s.key ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden /> : <Save className="mr-1.5 h-3.5 w-3.5" aria-hidden />}
              Salvează maratonul
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------------------------- Translator detail ---------------------------- */

const LANGS = [
  { value: 'ro', label: 'Română' },
  { value: 'en', label: 'Engleză' },
  { value: 'es', label: 'Spaniolă' },
  { value: 'fr', label: 'Franceză' },
  { value: 'de', label: 'Germană' },
] as const;

function TranslatorDetail({ active }: { active: boolean }) {
  const status = useApi('hub-translate-status', () => api.translateStatus(), { enabled: active });
  const titles = useApi('hub-translate-titles', () => api.all({ limit: 50 }), { enabled: active });
  const [contentId, setContentId] = useState('');
  const [lang, setLang] = useState<'ro' | 'en' | 'es' | 'fr' | 'de'>('ro');
  const [busy, setBusy] = useState(false);
  const [translation, setTranslation] = useState<{ title: string; lang: string; text: string; provider: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const translate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!contentId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.translateContent(Number(contentId), lang);
      const title = titles.data?.data.find((t) => t.id === Number(contentId))?.title ?? `#${contentId}`;
      setTranslation({ title, lang: res.lang, text: res.translation, provider: res.provider });
      toast.success('Traducere salvată', { description: `${title} · ${res.lang.toUpperCase()} · ${res.provider}` });
      void status.refetch();
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        toast.error('Prea multe cereri — încearcă peste un minut');
        setError('Limită de rată atinsă (10/min) — așteaptă un minut.');
      } else if (err instanceof ApiError && err.status === 401) {
        toast.error('Conectează-te ca să traduci');
        setError('Necesită autentificare.');
      } else {
        setError(err instanceof Error ? err.message : 'Traducerea a eșuat');
      }
    } finally {
      setBusy(false);
    }
  };

  const coverage = status.data?.coverage;

  return (
    <div className="space-y-4">
      {coverage ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
          <Languages className="h-4 w-4 text-rose-400" aria-hidden />
          <span>
            <span className="font-bold text-zinc-200">{coverage.withTranslations}</span>/{coverage.total} titluri traduse
          </span>
          {Object.entries(coverage.byLang).map(([l, n]) => (
            <span key={l} className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] font-bold uppercase text-zinc-300">
              {l} · {n}
            </span>
          ))}
        </div>
      ) : null}

      <form onSubmit={translate} className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
        <div className="space-y-1.5">
          <Label htmlFor="tr-content" className="text-xs">Titlu</Label>
          <Select value={contentId} onValueChange={setContentId}>
            <SelectTrigger id="tr-content" className="w-full border-white/10 bg-black/40">
              <SelectValue placeholder="Alege un titlu" />
            </SelectTrigger>
            <SelectContent className="max-h-64 border-white/10 bg-[#12121a]">
              {(titles.data?.data ?? []).map((t) => (
                <SelectItem key={t.id} value={String(t.id)}>
                  #{t.id} · {t.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="tr-lang" className="text-xs">Limbă</Label>
          <Select value={lang} onValueChange={(v) => setLang(v as typeof lang)}>
            <SelectTrigger id="tr-lang" className="w-full border-white/10 bg-black/40">
              <SelectValue placeholder="Limbă" />
            </SelectTrigger>
            <SelectContent className="border-white/10 bg-[#12121a]">
              {LANGS.map((l) => (
                <SelectItem key={l.value} value={l.value}>
                  {l.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-end">
          <Button
            type="submit"
            disabled={!contentId || busy}
            className="h-10 w-full bg-rose-600 font-bold hover:bg-rose-500 sm:w-auto"
          >
            {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden /> : <Globe2 className="mr-1.5 h-4 w-4" aria-hidden />}
            Traduce
          </Button>
        </div>
      </form>

      {error ? (
        <div className="flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-200" role="alert">
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
          {error}
        </div>
      ) : null}

      {translation ? (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/[0.06] p-3">
          <p className="flex flex-wrap items-center gap-2 text-xs font-bold text-rose-200">
            <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
            {translation.title} · {translation.lang.toUpperCase()}
            <ProviderChip provider={translation.provider} />
          </p>
          <p className="mt-2 max-h-48 overflow-y-auto text-xs leading-relaxed text-zinc-200 custom-scrollbar">
            {translation.text}
          </p>
        </div>
      ) : null}

      {active && titles.loading && !titles.data ? <PanelLoading rows={1} /> : null}
    </div>
  );
}
