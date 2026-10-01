'use client';

/**
 * ai-suite/panels-ops.tsx — FAZA 32: panouri pentru motoarele operaționale —
 * AI Miner (complet), AI Statistics Dashboard, AI Source Discovery Engine,
 * Dashboard Administrare AI. Date reale din tabelele miner_*, aiusagelogs,
 * contentsources + sonde provideri HTTP reale.
 */

import { useState } from 'react';
import { Loader2, Pickaxe } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/animaxia/api';
import { useApi } from '@/lib/animaxia/hooks';
import type {
  AiSuiteAdminData,
  AiSuiteDiscoveryData,
  AiSuiteMinerData,
  AiSuiteMinerDryRun,
  AiSuiteStatsData,
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

/* --------------------------------- AI Miner --------------------------------- */

export function MinerPanel() {
  const res = useApi('ai-suite-miner', () => api.aiSuiteMiner());
  const [dryProvider, setDryProvider] = useState<string | null>(null);
  const [dryRun, setDryRun] = useState<AiSuiteMinerDryRun | null>(null);

  const runDry = async (provider: string) => {
    setDryProvider(provider);
    try {
      const r = await api.aiSuiteMinerDryRun(provider);
      setDryRun(r);
      if (r.ok) {
        toast.success(`Dry-run ${provider} reușit`, { description: `${r.wouldMine?.toLocaleString('ro-RO')} titluri ar fi minate.` });
      } else {
        toast.error(`Dry-run ${provider} a eșuat`, { description: r.error });
      }
    } catch {
      toast.error(`Dry-run ${provider} a eșuat`);
    } finally {
      setDryProvider(null);
    }
  };

  if (res.loading) return <PanelSkeleton />;
  if (res.error) return <ErrorState message={res.error} onRetry={() => void res.refetch()} />;
  const d = res.data as AiSuiteMinerData;
  const maxType = Math.max(...d.catalog.byType.map((t) => t.n), 1);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Job-uri miner" value={d.jobs.total} />
        <StatCard label="Surse înregistrate" value={d.sources.registered} hint={`${d.sources.providers} provideri`} />
        <StatCard label="Catalog total" value={d.catalog.total.toLocaleString('ro-RO')} />
        <StatCard label="Itemi minați" value={d.catalog.minedItems} tone="good" />
      </div>

      <div className="rounded-xl border border-rose-500/25 bg-rose-500/[0.05] p-4">
        <p className="mb-3 text-[10px] font-bold uppercase tracking-[0.16em] text-rose-300/90">⛏️ Dry-run provideri (fetch real, zero scrieri)</p>
        <div className="flex flex-wrap gap-2">
          {['tmdb', 'jikan', 'tvmaze'].map((p) => (
            <Button
              key={p}
              size="sm"
              variant="outline"
              onClick={() => void runDry(p)}
              disabled={dryProvider !== null}
              className="h-9 border-white/15 bg-white/5 text-xs font-mono"
            >
              {dryProvider === p ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden /> : <Pickaxe className="mr-1.5 h-3.5 w-3.5" aria-hidden />}
              {p}
            </Button>
          ))}
        </div>
        {dryRun ? (
          <div className="mt-3 rounded-lg border border-white/10 bg-black/25 p-3">
            {dryRun.ok ? (
              <>
                <p className="text-xs text-zinc-400">
                  <span className="font-bold text-zinc-200">{dryRun.source}</span> — {dryRun.wouldMine?.toLocaleString('ro-RO')} titluri disponibile
                </p>
                <div className="mt-2 space-y-1">
                  {dryRun.sample?.map((s) => (
                    <KeyValueRow key={String(s.externalId)} k={s.title} v={`${s.year ?? '—'} · ⭐ ${s.rating ?? '—'}`} />
                  ))}
                </div>
                <p className="mt-2 text-[10px] text-zinc-600">{dryRun.note}</p>
              </>
            ) : (
              <p className="text-xs text-rose-300">✗ {dryRun.error}</p>
            )}
          </div>
        ) : null}
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
          <p className="mb-3 text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-500">Catalog pe tipuri</p>
          <div className="space-y-2.5">
            {d.catalog.byType.map((t) => (
              <CountBar key={t.type} label={t.type} count={t.n} max={maxType} />
            ))}
          </div>
        </div>
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
          <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-500">Job-uri recente (miner_jobs)</p>
          <div className="max-h-56 space-y-1 overflow-y-auto pr-1">
            {d.jobs.recent.map((j) => (
              <KeyValueRow
                key={j.id}
                k={`${j.type} · ${j.status}`}
                v={j.finishedat ? new Date(j.finishedat).toLocaleString('ro-RO') : (j.error ?? 'în așteptare').slice(0, 40)}
              />
            ))}
            {d.jobs.recent.length === 0 ? <p className="py-2 text-center text-xs text-zinc-500">Niciun job încă.</p> : null}
          </div>
        </div>
      </div>

      {d.waves.length ? (
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
          <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-500">Valuri de ingest (catalog_waves)</p>
          {d.waves.map((w) => (
            <div key={w.id} className="py-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 truncate text-xs font-medium text-zinc-300">{w.label}</span>
                <span className="shrink-0 font-mono text-[10px] text-zinc-500">{w.provider} · {w.status} · {w.progress}%</span>
              </div>
              <PctBar pct={w.progress} />
            </div>
          ))}
        </div>
      ) : null}
      <ProviderChip provider={d.provider} />
    </div>
  );
}

/* --------------------------- AI Statistics Dashboard -------------------------- */

export function StatsPanel() {
  const res = useApi('ai-suite-stats', () => api.aiSuiteStats());
  if (res.loading) return <PanelSkeleton />;
  if (res.error) return <ErrorState message={res.error} onRetry={() => void res.refetch()} />;
  const d = res.data as AiSuiteStatsData;
  const maxDaily = Math.max(...d.daily.map((x) => x.n), 1);
  const maxFeature = Math.max(...d.byFeature.map((x) => x.n), 1);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Apeluri AI totale" value={d.totals.calls.toLocaleString('ro-RO')} />
        <StatCard label="Tokeni (prompt)" value={d.totals.promptTokens.toLocaleString('ro-RO')} />
        <StatCard label="Latență p50 / p95" value={`${d.latency.p50} / ${d.latency.p95} ms`} tone={d.latency.p95 > 5000 ? 'warn' : 'good'} />
        <StatCard
          label="Rată erori"
          value={`${d.totals.errorRate}%`}
          tone={d.totals.errorRate === 0 ? 'good' : d.totals.errorRate < 5 ? 'warn' : 'bad'}
          hint={`${d.totals.errors} erori · ${d.totals.degraded} degradate`}
        />
      </div>

      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
        <p className="mb-3 text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-500">Consum AI pe zile (14 zile)</p>
        <div className="space-y-2.5">
          {d.daily.map((x) => (
            <CountBar key={x.day} label={x.day} count={x.n} max={maxDaily} />
          ))}
          {d.daily.length === 0 ? <p className="py-2 text-center text-xs text-zinc-500">Feriștea de 14 zile e goală.</p> : null}
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
          <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-500">Apeluri pe feature</p>
          <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
            {d.byFeature.map((f) => (
              <CountBar key={f.feature} label={f.feature} count={f.n} max={maxFeature} right={`${f.n} · ${f.avgms}ms`} />
            ))}
          </div>
        </div>
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
          <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-500">Pe provider</p>
          {d.byProvider.map((p) => (
            <KeyValueRow key={p.provider ?? 'necunoscut'} k={p.provider ?? 'necunoscut'} v={`${p.n} apeluri`} mono />
          ))}
          {d.topErrors.length ? (
            <>
              <p className="mb-2 mt-4 text-[10px] font-bold uppercase tracking-[0.16em] text-rose-300/80">Top erori</p>
              {d.topErrors.map((e, i) => (
                <KeyValueRow key={i} k={e.feature} v={`${e.n}× ${(e.errormessage ?? '').slice(0, 40)}`} />
              ))}
            </>
          ) : null}
        </div>
      </div>
      <ProviderChip provider={d.provider} />
    </div>
  );
}

/* ------------------------- AI Source Discovery Engine ------------------------- */

export function DiscoveryPanel() {
  const res = useApi('ai-suite-discovery', () => api.aiSuiteDiscovery());
  if (res.loading) return <PanelSkeleton />;
  if (res.error) return <ErrorState message={res.error} onRetry={() => void res.refetch()} />;
  const d = res.data as AiSuiteDiscoveryData;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Surse în registru" value={d.registry.total} hint={`${d.registry.kinds} tipuri`} />
        <StatCard label="Provideri sănătoși" value={`${d.providerProbes.filter((p) => p.ok).length}/${d.providerProbes.length}`} tone={d.providerProbes.every((p) => p.ok) ? 'good' : 'warn'} />
        <StatCard label="Surse propuse" value={d.proposed.length} tone="good" />
        <StatCard label="Sonde" value="HTTP real" hint="cu circuit-breaker" />
      </div>

      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
        <p className="mb-3 text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-500">Sonde provideri (live)</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {d.providerProbes.map((p) => (
            <div key={p.provider} className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2">
              <span className="truncate text-sm font-semibold text-zinc-100">{p.provider}</span>
              {p.ok ? (
                <span className="shrink-0 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 font-mono text-[10px] font-bold text-emerald-300">
                  ✓ {p.ms}ms
                </span>
              ) : (
                <span className="shrink-0 rounded-full border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 font-mono text-[10px] font-bold text-rose-300" title={p.error}>
                  ✗ indisponibil
                </span>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-rose-500/25 bg-rose-500/[0.05] p-4">
        <p className="mb-3 text-[10px] font-bold uppercase tracking-[0.16em] text-rose-300/90">🧭 Surse noi propuse</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {d.proposed.map((p) => (
            <div key={p.id} className="rounded-lg border border-white/10 bg-black/20 p-3">
              <div className="flex items-baseline justify-between gap-2">
                <p className="truncate text-sm font-bold text-zinc-100">{p.label}</p>
                <span className="shrink-0 rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[9px] font-bold text-zinc-400">valoare {p.value}</span>
              </div>
              <p className="mt-1 text-[11px] leading-snug text-zinc-500">{p.note}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
        <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-500">Registru pe tipuri (contentsources)</p>
        {d.registry.byKind.map((k) => (
          <KeyValueRow key={k.kind} k={`${k.kind} · ${k.n} surse`} v={`${k.hits} hit-uri`} mono />
        ))}
      </div>
      <NoteStrip>{d.note}</NoteStrip>
      <ProviderChip provider={d.provider} />
    </div>
  );
}

/* ------------------------ Dashboard Administrare AI -------------------------- */

export function AdminPanel({ onToggleRefresh }: { onToggleRefresh?: () => void }) {
  const res = useApi('ai-suite-admin', () => api.aiSuiteAdmin());
  if (res.loading) return <PanelSkeleton />;
  if (res.error) return <ErrorState message={res.error} onRetry={() => void res.refetch()} />;
  const d = res.data as AiSuiteAdminData;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Conținut în DB" value={Number(d.db?.content ?? 0).toLocaleString('ro-RO')} tone={d.health.database.ok ? 'good' : 'bad'} />
        <StatCard label="Log-uri utilizare AI" value={Number(d.db?.usage_logs ?? 0).toLocaleString('ro-RO')} />
        <StatCard label="Utilizatori" value={Number(d.db?.users ?? 0).toLocaleString('ro-RO')} />
        <StatCard label="Setări AI" value={Number(d.db?.settings ?? 0)} hint="aisettings (inclusiv suite:*)" />
      </div>

      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
        <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-500">Utilizare AI recentă (aiusagelogs)</p>
        <div className="max-h-64 space-y-1 overflow-y-auto pr-1">
          {d.recentUsage.map((u, i) => (
            <KeyValueRow
              key={i}
              k={u.feature}
              v={
                <span className={u.status === 'ok' ? 'text-emerald-300' : 'text-rose-300'}>
                  {u.provider ?? '—'} · {u.latencyms ?? '—'}ms · {u.status}
                </span>
              }
            />
          ))}
          {d.recentUsage.length === 0 ? <p className="py-2 text-center text-xs text-zinc-500">Încă niciun apel AI logat.</p> : null}
        </div>
      </div>

      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
        <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-500">Audit recent (auditlogs)</p>
        {d.recentAudit.map((a) => (
          <KeyValueRow key={a.id} k={a.action} v={new Date(a.createdat).toLocaleString('ro-RO')} />
        ))}
        {d.recentAudit.length === 0 ? <p className="py-2 text-center text-xs text-zinc-500">Fără acțiuni de administrare recente.</p> : null}
      </div>

      <NoteStrip>
        {`Sănătate: bază de date ${d.health.database.ok ? 'OK' : 'PROBLEMĂ'} · SDK z-ai: ${d.health.zaiSdk}. Comutatoarele celor 18 motoare sunt în registry (capul paginii) — acolo pornești/oprești orice motor.`}
      </NoteStrip>
      {onToggleRefresh ? (
        <Button size="sm" variant="outline" onClick={onToggleRefresh} className="border-white/15 bg-white/5 text-xs">
          Reîmprospătează registry
        </Button>
      ) : null}
      <ProviderChip provider={d.provider} />
    </div>
  );
}

/* Unused import guard (AiDigest kept for future admin narrative). */
export const __panelsOpsDigest = AiDigest;
