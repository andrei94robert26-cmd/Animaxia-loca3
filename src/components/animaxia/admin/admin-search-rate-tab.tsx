'use client';

/**
 * admin-search-rate-tab.tsx — FAZA 16 Search Rate Management console: live
 * pacing gauges (rate-limit hits, cooldown blocks, spam blocks, burst
 * events), the rolling arrivals / blocked chart (recharts via the shadcn
 * chart wrapper), the active configuration cards (per-user limit, cooldown,
 * anti-spam, burst control), the 30-row per-shard attribution table and the
 * admin runtime settings form (POST /api/search/rate/settings, Bearer +
 * admin-gated). The banner keeps the FAZA 16 promise visible: the pacing
 * layer only decides WHO may search HOW OFTEN — the searches themselves stay
 * 100% REAL (byte-identical FTS through the FAZA 15 queue). Public
 * read-only data (GET /api/search/rate); auto-refreshes every 2 s while
 * visible. Deep-linked via #/admin/search-rate.
 */

import { useEffect, useMemo, useState } from 'react';
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import {
  Activity,
  Ban,
  CheckCircle2,
  Hourglass,
  LineChart,
  Lock,
  Network,
  RefreshCw,
  Save,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Timer,
  TrendingUp,
  Users,
  Zap,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, BACKEND_PORT } from '@/lib/animaxia/api';
import { authRequest, PlatformError } from '@/lib/animaxia/platform';
import { useApi } from '@/lib/animaxia/hooks';
import type { SearchRateConfig, SearchRateShardStats } from '@/lib/animaxia/types';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { useAuth } from '../auth-provider';
import { EmptyState, ErrorState } from '../states';

/* ------------------------------- helpers --------------------------------- */

/** Live console cadence — /api/search/rate is in-memory and fast. */

const RO_NUMBER = new Intl.NumberFormat('ro-RO');
const RO_RATE = new Intl.NumberFormat('ro-RO', { maximumFractionDigits: 2 });

function fmtRoNum(v: number | null | undefined): string {
  return RO_NUMBER.format(Number(v ?? 0));
}

function fmtMs(v: number | null | undefined): string {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n > 0 ? `${RO_NUMBER.format(Math.round(n))} ms` : '—';
}

/** HH:MM:SS clock label for the history X axis (samples are 1 s apart). */
function fmtClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/* ------------------------------ gauges strip ------------------------------ */

type Tone = 'zinc' | 'emerald' | 'amber' | 'red';

const TONE_CHIP: Record<Tone, string> = {
  zinc: 'border-white/10 bg-white/[0.04] text-zinc-300',
  emerald: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  amber: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  red: 'border-red-500/30 bg-red-500/10 text-red-300',
};

function GaugeCard({
  icon,
  label,
  value,
  sub,
  tone = 'zinc',
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: Tone;
}) {
  return (
    <Card className="border-white/10 bg-white/[0.03]">
      <CardContent className="flex items-center gap-3 p-4">
        <span
          className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-xl border', TONE_CHIP[tone])}
          aria-hidden
        >
          {icon}
        </span>
        <div className="min-w-0">
          <p className="truncate text-2xl font-black leading-tight text-white">{value}</p>
          <p className="text-[11px] font-semibold uppercase tracking-widest text-zinc-500">{label}</p>
          {sub ? <p className="mt-0.5 truncate text-[11px] leading-snug text-zinc-600">{sub}</p> : null}
        </div>
      </CardContent>
    </Card>
  );
}

/** Protection counter chip: zinc „0” while quiet, red the moment the layer
 *  actually blocked something (spam protection doing its job). */
function ProtectValue({ value }: { value: number }) {
  return value > 0 ? (
    <span className="inline-flex items-center rounded-full border border-red-500/30 bg-red-500/10 px-2.5 py-0.5 font-mono text-base font-bold text-red-300">
      {fmtRoNum(value)}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-0.5 font-mono text-base font-bold text-zinc-400">
      <span className="h-1.5 w-1.5 rounded-full bg-zinc-500" aria-hidden />
      0
    </span>
  );
}

/* -------------------------------- chart ---------------------------------- */

const RATE_CHART_CONFIG = {
  sosiri: { label: 'Sosiri', color: '#10b981' },
  blocate: { label: 'Blocate', color: '#f43f5e' },
} satisfies ChartConfig;

/* ---------------------------- settings form ------------------------------ */

const SETTINGS_FIELDS = [
  { key: 'perUserMs', label: 'Limită / utilizator', hint: '100 – 5.000 ms', min: 100, max: 5000 },
  { key: 'cooldownMs', label: 'Cooldown după rezultat', hint: '250 – 10.000 ms', min: 250, max: 10000 },
  { key: 'spamThreshold', label: 'Prag anti-spam (ENTER)', hint: '2 – 10 apăsări', min: 2, max: 10 },
  { key: 'spamBlockMs', label: 'Blocare anti-spam', hint: '100 – 10.000 ms', min: 100, max: 10000 },
  { key: 'burstThreshold', label: 'Prag burst / fereastră', hint: '10 – 100.000', min: 10, max: 100000 },
] as const;

type SettingsKey = (typeof SETTINGS_FIELDS)[number]['key'];
type SettingsForm = Record<SettingsKey, string>;

function RateSettingsCard({
  config,
  isAdmin,
  onSaved,
}: {
  config: SearchRateConfig;
  isAdmin: boolean;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<SettingsForm>({
    perUserMs: String(config.perUserMs),
    cooldownMs: String(config.cooldownMs),
    spamThreshold: String(config.spamThreshold),
    spamBlockMs: String(config.spamBlockMs),
    burstThreshold: String(config.burstThreshold),
  });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  /* Re-sync the pre-filled inputs from the polled config while the user has
     not edited anything (and right after a successful save). */
  useEffect(() => {
    if (dirty) return;
    setForm((prev) => {
      const next: SettingsForm = {
        perUserMs: String(config.perUserMs),
        cooldownMs: String(config.cooldownMs),
        spamThreshold: String(config.spamThreshold),
        spamBlockMs: String(config.spamBlockMs),
        burstThreshold: String(config.burstThreshold),
      };
      return (Object.keys(next) as SettingsKey[]).every((k) => prev[k] === next[k]) ? prev : next;
    });
  }, [config, dirty]);

  async function handleSave() {
    if (saving) return;
    const parsed: Record<SettingsKey, number> = {
      perUserMs: Number(form.perUserMs),
      cooldownMs: Number(form.cooldownMs),
      spamThreshold: Number(form.spamThreshold),
      spamBlockMs: Number(form.spamBlockMs),
      burstThreshold: Number(form.burstThreshold),
    };
    for (const f of SETTINGS_FIELDS) {
      const v = parsed[f.key];
      if (!Number.isFinite(v) || v < f.min || v > f.max) {
        toast.error(`${f.label} trebuie să fie între ${RO_NUMBER.format(f.min)} și ${RO_NUMBER.format(f.max)}`);
        return;
      }
    }
    setSaving(true);
    try {
      await authRequest<{ ok: boolean; config: SearchRateConfig }>(
        `/api/search/rate/settings?XTransformPort=${BACKEND_PORT}`,
        { method: 'POST', body: JSON.stringify(parsed) },
      );
      toast.success('Setări salvate');
      setDirty(false);
      onSaved();
    } catch (e) {
      if (e instanceof PlatformError && (e.status === 401 || e.status === 403)) {
        toast.error('Setările ritmului necesită cont de administrator');
      } else {
        toast.error(e instanceof Error ? e.message : 'Salvarea setărilor a eșuat');
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="border-white/10 bg-white/[0.03]">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="h-4 w-4 text-rose-400" aria-hidden />
          Setări runtime (administrator)
        </CardTitle>
        <CardDescription>
          Reglare live a ritmului de căutare — se aplică imediat, fără restart.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isAdmin ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
              {SETTINGS_FIELDS.map((f) => (
                <div key={f.key} className="space-y-1.5">
                  <Label htmlFor={`rate-setting-${f.key}`} className="text-xs text-zinc-400">
                    {f.label} <span className="font-normal text-zinc-600">({f.hint})</span>
                  </Label>
                  <Input
                    id={`rate-setting-${f.key}`}
                    type="number"
                    inputMode="numeric"
                    min={f.min}
                    max={f.max}
                    step={1}
                    value={form[f.key]}
                    onChange={(e) => {
                      setDirty(true);
                      setForm((prev) => ({ ...prev, [f.key]: e.target.value }));
                    }}
                    className="border-white/10 bg-white/[0.04] font-mono text-zinc-100"
                    aria-label={`${f.label}, interval acceptat ${f.hint}`}
                  />
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="max-w-xl text-[11px] leading-snug text-zinc-600">
                Validarea și limitarea valorilor (clamping) se fac pe server — valorile finale sunt cele
                returnate după salvare și reflectate mai sus în cardurile de configurare.
              </p>
              <Button
                size="sm"
                onClick={() => void handleSave()}
                disabled={saving || !dirty}
                className="bg-rose-600 font-bold hover:bg-rose-500"
              >
                {saving ? <RefreshCw className="animate-spin" aria-hidden /> : <Save aria-hidden />}
                Salvează
              </Button>
            </div>
          </>
        ) : (
          <p className="flex items-center gap-2 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-4 py-2.5 text-xs text-amber-200">
            <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden />
            Setările ritmului necesită cont de administrator — valorile curente sunt read-only.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/* -------------------------------- main tab -------------------------------- */

export function AdminSearchRateTab() {
  const { isAdmin, initializing } = useAuth();
  const rate = useApi('admin-search-rate', () => api.searchRate());

  /* NEON FREE PLAN: auto-refresh 2s ELIMINAT — montare + Refresh manual. */

  const data = rate.data;
  const rl = data?.rateLimit ?? null;
  const bc = data?.burstControl ?? null;
  const config = data?.config ?? null;
  const counters = data?.counters ?? null;
  const shards = useMemo<SearchRateShardStats[]>(
    () => [...(data?.perShard ?? [])].sort((a, b) => a.shardid - b.shardid),
    [data?.perShard],
  );
  /* Chronological history (oldest → newest) for the area chart. */
  const chartData = useMemo(
    () =>
      [...(data?.history ?? [])]
        .sort((a, b) => new Date(a.t).getTime() - new Date(b.t).getTime())
        .map((p) => ({ clock: fmtClock(p.t), sosiri: p.arrivals, blocate: p.blocked })),
    [data?.history],
  );

  const loadingFirst = rate.loading && !data;

  return (
    <div className="space-y-5">
      {/* Banner — the FAZA 16 promise: pacing never fakes or delays a search. */}
      <Card className="border-emerald-500/25 bg-emerald-500/[0.04]">
        <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:p-5">
          <span
            className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-emerald-500/30 bg-emerald-500/10"
            aria-hidden
          >
            <Timer className="h-5 w-5 text-emerald-400" />
          </span>
          <div>
            <p className="text-sm font-bold text-emerald-200">
              Controlul ritmului de căutări — căutările rămân 100% reale
            </p>
            <p className="mt-1 text-xs leading-relaxed text-zinc-400">
              Stratul FAZA 16 decide <span className="font-semibold text-zinc-200">cine</span> poate căuta{' '}
              <span className="font-semibold text-zinc-200">cât de des</span>: limită per utilizator (
              {fmtMs(rl?.perUserMs ?? config?.perUserMs)}), cooldown după rezultat (
              {fmtMs(rl?.cooldownMs ?? config?.cooldownMs)}), anti-spam ENTER (
              {fmtRoNum(config?.spamThreshold ?? 3)} apăsări / {fmtMs(config?.spamWindowMs ?? 200)} → blocare{' '}
              {fmtMs(config?.spamBlockMs ?? 1000)}) și detectare de burst-uri. Cererile admise trec neschimbate
              prin coada FAZA 15 — interogările FTS rămân byte-identice cu FAZA 14, iar respingerile sunt
              întotdeauna explicite (429 + retryInMs), niciodată pierdute.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Toolbar: live pulse + manual refresh */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-xs text-zinc-500" aria-live="off">
          <span className="relative flex h-2 w-2" aria-hidden>
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
          </span>
          Consolă live — actualizare manuală
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => rate.refetch()}
          aria-label="Reîmprospătează starea ritmului de căutare"
          className="border-white/15 bg-white/5 font-semibold hover:bg-white/10"
        >
          {rate.loading ? <RefreshCw className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
          Refresh
        </Button>
      </div>

      {/* Live gauges */}
      {loadingFirst ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-[92px] rounded-xl" />
          ))}
        </div>
      ) : rate.error && !data ? (
        <ErrorState message={rate.error} onRetry={rate.refetch} compact />
      ) : rl && counters ? (
        <section aria-label="Indicatori live ai ritmului de căutare" className="space-y-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            <GaugeCard
              icon={<Hourglass className="h-5 w-5" aria-hidden />}
              label="Rate-limit"
              value={<ProtectValue value={rl.hits} />}
              tone={rl.hits > 0 ? 'red' : 'zinc'}
              sub={`o căutare / ${fmtMs(rl.perUserMs)} / utilizator`}
            />
            <GaugeCard
              icon={<Timer className="h-5 w-5" aria-hidden />}
              label="Cooldown active"
              value={<ProtectValue value={rl.cooldownBlocks} />}
              tone={rl.cooldownBlocks > 0 ? 'red' : 'zinc'}
              sub={`blocate ${fmtMs(rl.cooldownMs)} după rezultat`}
            />
            <GaugeCard
              icon={<Ban className="h-5 w-5" aria-hidden />}
              label="Spam blocate"
              value={<ProtectValue value={rl.spamBlocked} />}
              tone={rl.spamBlocked > 0 ? 'red' : 'zinc'}
              sub={`${fmtRoNum(config?.spamThreshold ?? 3)} ENTER / ${fmtMs(config?.spamWindowMs ?? 200)} → blocare`}
            />
            <GaugeCard
              icon={<Zap className="h-5 w-5" aria-hidden />}
              label="Burst-uri"
              value={fmtRoNum(bc?.events ?? 0)}
              tone={bc?.burstActive ? 'amber' : 'zinc'}
              sub={bc?.burstActive ? 'burst ACTIV acum' : `prag ${fmtRoNum(bc?.maxBurstPerWindow ?? 1000)} / ${fmtMs(bc?.windowMs ?? 1000)}`}
            />
            <GaugeCard
              icon={<Activity className="h-5 w-5" aria-hidden />}
              label="Sosiri / s"
              value={RO_RATE.format(bc?.arrivalsPerS ?? 0)}
              tone={(bc?.arrivalsPerS ?? 0) > 0 ? 'amber' : 'zinc'}
              sub={`max observat ${fmtRoNum(bc?.peak ?? 0)} / fereastră`}
            />
            <GaugeCard
              icon={<CheckCircle2 className="h-5 w-5" aria-hidden />}
              label="Admise"
              value={fmtRoNum(counters.admitted)}
              tone="emerald"
              sub={`${fmtRoNum(counters.completed)} rezultate livrate`}
            />
            <GaugeCard
              icon={<Users className="h-5 w-5" aria-hidden />}
              label="Utilizatori urmăriți"
              value={fmtRoNum(rl.trackedUsers)}
              sub={`max ${fmtRoNum(counters.trackedUsersHighWater)}`}
            />
            <GaugeCard
              icon={<TrendingUp className="h-5 w-5" aria-hidden />}
              label="Sosiri totale"
              value={fmtRoNum(counters.arrivals)}
              sub={`${fmtRoNum(counters.rateLimitHits + counters.cooldownBlocks + counters.spamBlocked)} respingeri explicite`}
            />
          </div>
          {bc ? (
            <p className="flex flex-wrap items-baseline gap-x-4 gap-y-1 rounded-xl border border-white/10 bg-white/[0.02] px-4 py-2.5 font-mono text-[11px] text-zinc-400">
              <span className="font-sans text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
                Burst control
              </span>
              <span>
                {bc.active ? 'ACTIV' : 'inactiv'}{' '}
                <span className="text-zinc-600">— 1000 utilizatori simultan = coadă FAZA 15 + ferestre, zero pierderi</span>
              </span>
              <span>
                {fmtRoNum(bc.arrivalsInWindow)} <span className="text-zinc-600">sosiri în fereastră</span>
              </span>
              <span>
                ultimul burst: {bc.lastBurstAt ? new Date(bc.lastBurstAt).toLocaleTimeString('ro-RO') : '—'}
              </span>
            </p>
          ) : null}
        </section>
      ) : null}

      {/* Config cards */}
      {config ? (
        <section aria-label="Configurația ritmului de căutare" className="space-y-3">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-200">
            <SlidersHorizontal className="h-4 w-4 text-rose-400" aria-hidden />
            Configurație activă
          </h3>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {[
              {
                label: 'Limită / utilizator',
                value: fmtMs(config.perUserMs),
                sub: 'interval minim între căutări (per tip)',
              },
              {
                label: 'Cooldown',
                value: fmtMs(config.cooldownMs),
                sub: 'după primirea unui rezultat',
              },
              {
                label: 'Anti-spam',
                value: `${fmtRoNum(config.spamThreshold)} / ${fmtMs(config.spamWindowMs)}`,
                sub: `apăsări ENTER → blocare ${fmtMs(config.spamBlockMs)}`,
              },
              {
                label: 'Burst prag',
                value: fmtRoNum(config.burstThreshold),
                sub: `sosiri / ${fmtMs(config.burstWindowMs)} = eveniment burst`,
              },
              {
                label: 'Strat FAZA 16',
                value: config.enabled ? 'ACTIV' : 'DEZACTIVAT',
                sub: config.enabled ? 'rate-limit + cooldown + anti-spam' : 'doar coada FAZA 15 rămâne',
              },
            ].map((c) => (
              <Card key={c.label} className="border-white/10 bg-white/[0.03]">
                <CardContent className="p-4">
                  <p className="text-lg font-black leading-tight text-white">{c.value}</p>
                  <p className="mt-0.5 text-[11px] font-semibold uppercase tracking-widest text-zinc-500">{c.label}</p>
                  <p className="mt-1 text-[11px] leading-snug text-zinc-600">{c.sub}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      ) : null}

      {/* Chart: arrivals + blocked over the rolling history */}
      <section aria-label="Istoricul ritmului de căutare">
        <Card className="border-white/10 bg-white/[0.03]">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <LineChart className="h-4 w-4 text-rose-400" aria-hidden />
              Sosiri &amp; respingeri (ultimele 3 minute)
            </CardTitle>
            <CardDescription>
              180 eșantioane de 1 s — sosiri căutări (emerald) și cereri respinse explicit (rose).
            </CardDescription>
          </CardHeader>
          <CardContent>
            {loadingFirst ? (
              <Skeleton className="h-56 w-full rounded-xl sm:h-64" />
            ) : chartData.length === 0 ? (
              <EmptyState
                title="Fără activitate încă"
                message="Istoricul se populează odată cu primele căutări trecute prin stratul de ritm."
              />
            ) : (
              <ChartContainer config={RATE_CHART_CONFIG} className="h-56 w-full sm:h-64">
                <AreaChart data={chartData} margin={{ left: 4, right: 8, top: 8, bottom: 0 }}>
                  <defs>
                    <linearGradient id="fillRateArrivals" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#10b981" stopOpacity={0.45} />
                      <stop offset="95%" stopColor="#10b981" stopOpacity={0.02} />
                    </linearGradient>
                    <linearGradient id="fillRateBlocked" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#f43f5e" stopOpacity={0.45} />
                      <stop offset="95%" stopColor="#f43f5e" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid vertical={false} stroke="rgba(255,255,255,0.08)" />
                  <XAxis
                    dataKey="clock"
                    tickLine={false}
                    axisLine={false}
                    minTickGap={32}
                    tick={{ fill: '#71717a', fontSize: 11 }}
                  />
                  <YAxis
                    allowDecimals={false}
                    tickLine={false}
                    axisLine={false}
                    width={30}
                    tick={{ fill: '#71717a', fontSize: 11 }}
                  />
                  <ChartTooltip
                    cursor={{ stroke: 'rgba(16,185,129,0.35)' }}
                    content={
                      <ChartTooltipContent
                        className="border-white/10 bg-[#1a1a24] text-zinc-200"
                        indicator="line"
                      />
                    }
                  />
                  <Area
                    dataKey="sosiri"
                    type="monotone"
                    stroke="#10b981"
                    strokeWidth={2}
                    fill="url(#fillRateArrivals)"
                    dot={false}
                    activeDot={{ r: 4, fill: '#10b981' }}
                  />
                  <Area
                    dataKey="blocate"
                    type="monotone"
                    stroke="#f43f5e"
                    strokeWidth={2}
                    fill="url(#fillRateBlocked)"
                    dot={false}
                    activeDot={{ r: 4, fill: '#f43f5e' }}
                  />
                </AreaChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>
      </section>

      {/* Per-shard attribution */}
      {loadingFirst ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full rounded-xl" />
          ))}
        </div>
      ) : rate.error && !data ? (
        <ErrorState message={rate.error} onRetry={rate.refetch} compact />
      ) : shards.length === 0 ? (
        <EmptyState
          title="Fără sharduri"
          message="Backend-ul nu a raportat încă atribuiri per-shard pentru ritmul de căutare."
        />
      ) : (
        <section aria-label="Atribuirea ritmului de căutare pe sharduri" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-200">
              <Network className="h-4 w-4 text-rose-400" aria-hidden />
              Atribuire pe sharduri ({shards.length})
            </h3>
            <span className="font-mono text-[11px] text-zinc-600">
              rândurile cu activitate sunt evidențiate în amber · respingerile în roșu
            </span>
          </div>
          <div className="custom-scrollbar max-h-[32rem] overflow-y-auto rounded-xl border border-white/10">
            <Table aria-label="Atribuirea ritmului de căutare pe sharduri — un rând per shard logic">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead scope="col">Shard</TableHead>
                  <TableHead scope="col">Admise</TableHead>
                  <TableHead scope="col">Rate-limit</TableHead>
                  <TableHead scope="col">Cooldown</TableHead>
                  <TableHead scope="col">Spam</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shards.map((row) => {
                  const blocked = row.rateLimited + row.cooldownActive + row.spamBlocked;
                  const active = row.admitted > 0 || blocked > 0;
                  return (
                    <TableRow
                      key={row.shardid}
                      className={cn(
                        'hover:bg-white/[0.03]',
                        active && blocked === 0 && 'bg-amber-500/[0.06]',
                        blocked > 0 && 'bg-red-500/[0.07]',
                      )}
                    >
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Server className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden />
                          <p className="font-mono text-sm font-medium text-zinc-100">#{row.shardid}</p>
                        </div>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-zinc-300">{fmtRoNum(row.admitted)}</TableCell>
                      <TableCell
                        className={cn('font-mono text-xs', row.rateLimited > 0 ? 'text-red-300' : 'text-zinc-600')}
                      >
                        {fmtRoNum(row.rateLimited)}
                      </TableCell>
                      <TableCell
                        className={cn('font-mono text-xs', row.cooldownActive > 0 ? 'text-red-300' : 'text-zinc-600')}
                      >
                        {fmtRoNum(row.cooldownActive)}
                      </TableCell>
                      <TableCell
                        className={cn('font-mono text-xs', row.spamBlocked > 0 ? 'text-red-300' : 'text-zinc-600')}
                      >
                        {fmtRoNum(row.spamBlocked)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </section>
      )}

      {/* Settings (admin only) */}
      {config ? (
        <RateSettingsCard
          config={config}
          isAdmin={!initializing && isAdmin}
          onSaved={() => void rate.refetch()}
        />
      ) : loadingFirst ? (
        <Skeleton className="h-56 w-full rounded-xl" />
      ) : null}
    </div>
  );
}
