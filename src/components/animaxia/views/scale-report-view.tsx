'use client';

/**
 * scale-report-view.tsx — „Arhitectura Reală” (#/scale, AR10M).
 *
 * Vedeta onestă a platformei: contori EXCLUSIV reali din /api/ar10m/stats,
 * capacitate declarată separat (proiectată 10M / testată / demonstrată prin
 * benchmark), distribuția reală de rânduri pe cele 15 sharduri și bugetul
 * real Neon. Fără simulări, fără numere inventate — ce nu e măsurat apare
 * ca „—” sau „netestat încă”.
 *
 * Datele se încarcă O SINGURĂ dată la montare; reîmprospătarea este
 * exclusiv manuală (butonul „Reîmprospătează”), cu marcatorul „ultima
 * actualizare HH:MM:SS”. Endpoint-urile AR10M pot 404 până la montajul
 * orchestratorului — fiecare secțiune degradează onest, aplicația nu pică.
 */

import { useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Database,
  FlaskConical,
  Gauge,
  HardDrive,
  Network,
  RefreshCw,
  Server,
  Timer,
  Users,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/animaxia/api';
import { useApi } from '@/lib/animaxia/hooks';
import type { Ar10mBudget, Ar10mShards } from '@/lib/animaxia/types';
import { Container, PageHeader, Section } from '../section';
import { ErrorState } from '../states';
import { cn } from '@/lib/utils';

/* ------------------------------- formatting ------------------------------- */

function formatCount(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString('ro-RO');
}

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toLocaleString('ro-RO', { maximumFractionDigits: 1 })} ${units[unit]}`;
}

function formatStamp(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('ro-RO', { dateStyle: 'short', timeStyle: 'medium' });
}

function formatPct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${v.toLocaleString('ro-RO', { maximumFractionDigits: 1 })}%`;
}

/* ------------------------------ capacity cards ---------------------------- */

function CapacityCard({
  icon: Icon,
  title,
  value,
  hint,
  tone,
}: {
  icon: typeof Database;
  title: string;
  value: string;
  hint: string;
  tone: 'designed' | 'tested' | 'benchmarked';
}) {
  const accents: Record<typeof tone, string> = {
    designed: 'from-rose-500/20 to-rose-500/5 text-rose-300',
    tested: 'from-amber-500/20 to-amber-500/5 text-amber-300',
    benchmarked: 'from-teal-500/20 to-teal-500/5 text-teal-300',
  };
  return (
    <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03] p-4 sm:p-5">
      <div aria-hidden className={cn('pointer-events-none absolute inset-0 bg-gradient-to-br opacity-60', accents[tone])} />
      <div className="relative space-y-3">
        <span
          className={cn(
            'grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-black/40',
            accents[tone].split(' ').pop(),
          )}
        >
          <Icon className="h-5 w-5" aria-hidden />
        </span>
        <div>
          <h3 className="text-sm font-bold text-white">{title}</h3>
          <p className="mt-1 text-2xl font-black tracking-tight text-white sm:text-3xl">{value}</p>
          <p className="mt-1.5 text-xs leading-relaxed text-zinc-400">{hint}</p>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ counter tile ------------------------------ */

function CounterTile({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon?: typeof Database;
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
      <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-500">
        {Icon ? <Icon className="h-3.5 w-3.5" aria-hidden /> : null}
        {label}
      </p>
      <p className="mt-1.5 text-lg font-black text-white" title={value}>
        {value}
      </p>
      {hint ? <p className="mt-0.5 text-[11px] leading-snug text-zinc-500">{hint}</p> : null}
    </div>
  );
}

/* ------------------------------- budget view ------------------------------ */

const BUDGET_LEVELS: Record<Ar10mBudget['level'], { label: string; cls: string }> = {
  normal: { label: 'Normal', cls: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300' },
  warning: { label: 'Atenție', cls: 'border-amber-500/40 bg-amber-500/15 text-amber-300' },
  economic: { label: 'Economic', cls: 'border-orange-500/40 bg-orange-500/15 text-orange-300' },
  critical: { label: 'Critic', cls: 'border-red-500/40 bg-red-500/15 text-red-300' },
};

function BudgetSection({ budget }: { budget: Ar10mBudget | null }) {
  if (!budget) return null;
  const level = BUDGET_LEVELS[budget.level] ?? BUDGET_LEVELS.normal;
  return (
    <div className="space-y-4 rounded-2xl border border-white/10 bg-white/[0.03] p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-base font-black tracking-tight text-white">
          <Gauge className="h-5 w-5 text-rose-400" aria-hidden />
          Buget Neon — stare reală
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          {budget.economicMode ? (
            <Badge className="border-orange-500/40 bg-orange-500/15 text-orange-300 hover:bg-orange-500/15">
              mod economic activ
            </Badge>
          ) : null}
          <span
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[10px] font-black uppercase tracking-widest',
              level.cls,
            )}
          >
            {budget.level === 'critical' ? <AlertTriangle className="h-3 w-3" aria-hidden /> : null}
            {level.label}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <CounterTile
          label="Stocare folosită"
          value={budget.sources.storage ? formatBytes(budget.usage.storageBytes) : 'indisponibil'}
          hint={budget.sources.storage ? 'dimensiune reală pe disc' : 'sursa nu raportează stocare'}
        />
        <CounterTile
          label="Interogări / min"
          value={budget.sources.qpm ? formatCount(budget.usage.queriesPerMin) : 'indisponibil'}
          hint={budget.sources.qpm ? 'fereastră recentă' : 'sursa nu raportează QPM'}
        />
        <CounterTile
          label="Cache hit rate"
          value={formatPct(budget.usage.cacheHitRate != null ? budget.usage.cacheHitRate * 100 : null)}
          hint="percentaj real de servire din cache"
        />
        <CounterTile
          label="CU-hours"
          value={budget.sources.cuHours && budget.usage.cuHours != null ? formatCount(budget.usage.cuHours) : 'indisponibil'}
          hint={budget.sources.cuHours ? 'compute Neon consumat' : 'nequantificabil pe planul curent'}
        />
        <CounterTile
          label="Sharduri / pooluri active"
          value={`${formatCount(budget.usage.activeShards)} / ${formatCount(budget.usage.activePools)}`}
          hint="conexiuni reale deschise acum"
        />
      </div>

      <p className="text-[11px] leading-relaxed text-zinc-500">
        Praguri de protecție: atenție la {budget.thresholds.warn}% · economic la {budget.thresholds.economy}% · critic
        la {budget.thresholds.critical}% · limită {budget.thresholds.max}%. Valorile „indisponibil” semnalează onest
        sursele care nu pot fi măsurate pe planul gratuit — nu sunt estimate.
      </p>
    </div>
  );
}

/* ------------------------------ shards section ----------------------------- */

function stateChipClass(state: string | null | undefined): string {
  const s = (state ?? '').toLowerCase();
  /* Stările reale ale registrului AR10M (circuit breaker): 'closed' = sănătos,
   * 'open' = circuit deschis (indisponibil temporar), 'half-open' = probă,
   * 'inactive' = fără pool (slot neconfigurat/neutilizat). */
  if (s === 'closed' || s === 'active' || s === 'online' || s === 'healthy') {
    return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300';
  }
  if (s === 'half-open' || s === 'degraded' || s === 'warning' || s === 'draining') {
    return 'border-amber-500/40 bg-amber-500/10 text-amber-300';
  }
  if (s === 'open') {
    return 'border-rose-500/40 bg-rose-500/10 text-rose-300';
  }
  return 'border-zinc-500/40 bg-zinc-500/10 text-zinc-400';
}

/** Stare sănătoasă = breaker closed (sănătos) sau echivalentele istorice. */
function isShardHealthy(state: string | null | undefined): boolean {
  const s = (state ?? '').toLowerCase();
  return s === 'closed' || s === 'active' || s === 'online' || s === 'healthy';
}

function ShardsSection({ data }: { data: Ar10mShards }) {
  const dist = data.distribution ?? [];
  const totalRows = dist.reduce((acc, d) => acc + (Number.isFinite(d.rows) ? d.rows : 0), 0);
  const maxRows = dist.reduce((m, d) => Math.max(m, Number.isFinite(d.rows) ? d.rows : 0), 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <CounterTile
          icon={Network}
          label="Sloturi configurate"
          value={formatCount(data.shards.filter((s) => s.configured).length)}
          hint={`din ${formatCount(data.shards.length)} sloturi în registru`}
        />
        <CounterTile
          icon={Server}
          label="Sharduri active"
          value={formatCount(data.shards.filter((s) => isShardHealthy(s.state)).length)}
          hint="stare raportată onest de registru"
        />
        <CounterTile
          icon={Database}
          label="Rânduri totale"
          value={formatCount(totalRows)}
          hint="suma reală a distribuției"
        />
        <CounterTile
          icon={Timer}
          label="Latență medie"
          value={(() => {
            const lats = data.shards
              .map((s) => s.lastLatencyMs)
              .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0);
            if (lats.length === 0) return '—';
            const avg = lats.reduce((a, b) => a + b, 0) / lats.length;
            return `${Math.round(avg).toLocaleString('ro-RO')}ms`;
          })()}
          hint="ultima latență măsurată per shard"
        />
      </div>

      {data.shards.length === 0 ? (
        <p className="rounded-xl border border-white/10 bg-white/[0.03] p-4 text-sm text-zinc-400">
          Registrul AR10M nu a raportat niciun slot — modulul backend nu este încă montat.
        </p>
      ) : (
        <div className="custom-scrollbar max-h-96 space-y-2 overflow-y-auto pr-1" aria-label="Distribuția reală pe sharduri">
          {data.shards.map((shard) => {
            const d = dist.find((x) => x.shardId === shard.slot);
            const rows = d?.rows ?? 0;
            const barW = maxRows > 0 ? Math.max(1.5, (rows / maxRows) * 100) : 0;
            return (
              <div key={shard.slot} className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <span className="font-mono text-xs font-bold text-zinc-200">#{shard.slot}</span>
                  <span className="min-w-0 flex-1 truncate text-xs font-semibold text-zinc-300" title={shard.hostMasked ?? undefined}>
                    {shard.name}
                  </span>
                  <span
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider',
                      stateChipClass(shard.state),
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        'h-1.5 w-1.5 rounded-full',
                        isShardHealthy(shard.state) ? 'bg-emerald-400' : 'bg-zinc-500',
                      )}
                    />
                    {shard.state ?? 'inactiv'}
                  </span>
                  <span className="font-mono text-[11px] text-zinc-500">{shard.mode}</span>
                  <span className="font-mono text-xs font-bold text-zinc-200">{formatCount(rows)}</span>
                  <span className="font-mono text-[10px] text-zinc-500">{formatPct(d?.pct)}</span>
                </div>
                <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-rose-500 to-fuchsia-500"
                    style={{ width: `${barW}%` }}
                  />
                </div>
                <p className="mt-1.5 flex flex-wrap gap-x-3 font-mono text-[10px] text-zinc-600">
                  <span>{shard.poolActive ? `pool activ · ${formatCount(shard.openConnections)} conexiuni` : 'pool inactiv'}</span>
                  <span>latență {shard.lastLatencyMs != null ? `${formatCount(shard.lastLatencyMs)}ms` : '—'}</span>
                  <span>spațiu {formatBytes(shard.lastSpaceBytes)}</span>
                  <span>ultima folosire {shard.lastUsedAt ? formatStamp(shard.lastUsedAt) : '—'}</span>
                </p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------- view ---------------------------------- */

export function ScaleReportView() {
  const stats = useApi('ar10m-stats', () => api.ar10mStats());
  const shards = useApi('ar10m-shards', () => api.ar10mShards());
  const budget = useApi('ar10m-budget', () => api.ar10mBudget());

  const [updatedAt, setUpdatedAt] = useState<string | null>(null);

  /* Starea de încărcare e derivată pur; „ultima actualizare” se scrie
     (diferit, prin timeout) doar când TOATE sursele și-au terminat ciclul
     curent (montare sau refresh manual) — zero auto-refresh. */
  const anyLoading = stats.loading || shards.loading || budget.loading;

  useEffect(() => {
    if (anyLoading) return undefined;
    const t = setTimeout(() => setUpdatedAt(new Date().toLocaleTimeString('ro-RO', { hour12: false })), 0);
    return () => clearTimeout(t);
  }, [anyLoading]);

  const refreshAll = async () => {
    await Promise.allSettled([stats.refetch(), shards.refetch(), budget.refetch()]);
    toast.success('Datele AR10M au fost reîmprospătate');
  };

  const s = stats.data;
  const statsDown = Boolean(stats.error && !stats.data);
  const shardsDown = Boolean(shards.error && !shards.data);
  const budgetDown = Boolean(budget.error && !budget.data);
  const designed = s?.capacity.designed ?? 10_000_000;

  return (
    <Container className="space-y-8 py-8 sm:py-10">
      <PageHeader
        title="Arhitectura Reală"
        subtitle="Catalog real, distribuit și extensibil gradual până la 10 milioane de titluri."
      >
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Badge className="border-rose-500/30 bg-rose-500/15 text-rose-300 hover:bg-rose-500/15">
            <Network className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            ANIMAXIA REAL 10M
          </Badge>
          <span className="text-[11px] text-zinc-500">
            {updatedAt ? `ultima actualizare ${updatedAt}` : 'se încarcă datele reale…'}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refreshAll()}
            disabled={anyLoading}
            className="h-8 border-white/15 bg-white/5 text-zinc-200 hover:bg-white/10 hover:text-white"
          >
            <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', anyLoading && 'animate-spin')} aria-hidden />
            Reîmprospătează
          </Button>
        </div>
      </PageHeader>

      {statsDown ? (
        <p className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs leading-relaxed text-amber-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          Date indisponibile — endpoint AR10M neactiv. Contorii reali și capacitatea testată apar când modulul
          backend este montat; până atunci se afișează exclusiv arhitectura declarată.
        </p>
      ) : null}

      {/* ---------------------- capacitate (3 cards separate) ---------------------- */}
      <section className="space-y-3" aria-label="Capacitate declarată">
        <h2 className="text-lg font-bold tracking-tight text-zinc-100 sm:text-xl">Capacitate — declarată separat</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <CapacityCard
            icon={Network}
            title="Capacitate proiectată"
            value={formatCount(designed)}
            hint="15 sharduri Neon, arhitectura hash — ținta arhitecturală spre care platforma crește gradual."
            tone="designed"
          />
          <CapacityCard
            icon={FlaskConical}
            title="Capacitate testată"
            value={s?.capacity.tested != null ? formatCount(s.capacity.tested) : 'netestat încă'}
            hint={
              s?.capacity.tested != null
                ? 'rânduri reale validate prin teste de ingestie și interogare.'
                : 'nimic afirmat până la un test real — onestitate înainte de marketing.'
            }
            tone="tested"
          />
          <CapacityCard
            icon={Gauge}
            title="Capacitate demonstrată prin benchmark"
            value={s?.capacity.benchmarked != null ? formatCount(s.capacity.benchmarked) : 'în curs'}
            hint={
              s?.capacity.benchmarked != null
                ? 'demonstrată printr-un benchmark public, reproductibil.'
                : 'benchmark-ul de referință rulează / urmează să ruleze pe arhitectura reală.'
            }
            tone="benchmarked"
          />
        </div>
      </section>

      {/* --------------------------- contori reali --------------------------- */}
      <Section
        title="Contori reali"
        subtitle="Valori măsurate live în baza reală — zero extrapolări, zero simulări."
      >
        {stats.loading && !s ? (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="h-20 animate-pulse rounded-xl border border-white/10 bg-white/[0.03]" />
            ))}
          </div>
        ) : statsDown ? (
          <ErrorState message="Date indisponibile — endpoint AR10M neactiv" onRetry={() => void stats.refetch()} compact />
        ) : s ? (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
            <CounterTile
              icon={Database}
              label="Titluri reale"
              value={formatCount(s.real.titles)}
              hint="rânduri reale în catalogul AR10M"
            />
            <CounterTile icon={Server} label="Surse reale" value={formatCount(s.real.sources)} hint="surse înregistrate" />
            <CounterTile
              icon={HardDrive}
              label="Titluri redatabile"
              value={formatCount(s.real.playableTitles)}
              hint="cu sursă de redare funcțională"
            />
            <CounterTile icon={Users} label="Utilizatori" value={formatCount(s.real.users)} hint="conturi reale" />
            <CounterTile
              icon={Network}
              label="Sharduri online"
              value={`${formatCount(s.real.shardsOnline)} / ${formatCount(s.real.shardsConfigured)}`}
              hint="configurate / în registru"
            />
            <CounterTile
              icon={HardDrive}
              label="Spațiu real folosit"
              value={formatBytes(s.real.dbSizeBytes)}
              hint="dimensiunea reală a bazei"
            />
            <CounterTile
              icon={Timer}
              label="Ultima sincronizare"
              value={s.real.lastSyncAt ? formatStamp(s.real.lastSyncAt) : '—'}
              hint="momentul ultimei sincronizări reale"
            />
            <CounterTile
              icon={Activity}
              label="Buget"
              value={s.real.budgetLevel || '—'}
              hint={s.real.economicMode ? 'mod economic activ' : 'funcționare normală'}
            />
          </div>
        ) : null}
      </Section>

      {/* ------------------------ distribuție sharduri ------------------------ */}
      <Section
        title="Distribuție sharduri"
        subtitle="Cele 15 sloturi ale arhitecturii hash — rânduri reale, procent real, stare reală."
      >
        {shards.loading && !shards.data ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-16 animate-pulse rounded-xl border border-white/10 bg-white/[0.03]" />
            ))}
          </div>
        ) : shardsDown ? (
          <ErrorState message="Date indisponibile — endpoint AR10M neactiv" onRetry={() => void shards.refetch()} compact />
        ) : shards.data ? (
          <ShardsSection data={shards.data} />
        ) : null}
      </Section>

      {/* ------------------------------ buget Neon ------------------------------ */}
      <Section
        title="Buget Neon"
        subtitle="Consum real față de pragurile planului — ce nu se poate măsura apare onest ca indisponibil."
      >
        {budget.loading && !budget.data ? (
          <div className="h-44 animate-pulse rounded-2xl border border-white/10 bg-white/[0.03]" />
        ) : budgetDown ? (
          <ErrorState message="Date indisponibile — endpoint AR10M neactiv" onRetry={() => void budget.refetch()} compact />
        ) : budget.data ? (
          <BudgetSection budget={budget.data} />
        ) : null}
      </Section>

      {/* ------------------------------ legacy note ------------------------------ */}
      <blockquote className="rounded-2xl border-l-4 border-rose-500 bg-rose-500/[0.06] p-5">
        <p className="text-[10px] font-bold uppercase tracking-wider text-rose-300">Catalog legacy</p>
        <p className="mt-2 text-sm leading-relaxed text-zinc-200">
          Catalog legacy (metadate TMDB): {s ? formatCount(s.real.legacyTitles) : '—'} intrări — sursă reală,
          menținută pentru navigarea existentă.
        </p>
        {s?.message ? <p className="mt-2 text-xs leading-relaxed text-zinc-500">{s.message}</p> : null}
      </blockquote>
    </Container>
  );
}
