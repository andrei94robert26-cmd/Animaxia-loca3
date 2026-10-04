'use client';

/**
 * edge-view.tsx — Animaxia Edge console (FAZA 8): the Cloudflare Workers edge
 * layer that fronts the cloud monolith. Live upstream probe (the chain the
 * edge accelerates: gateway → :4000 → Neon), module cards for the seven
 * workers + shared layer, the gateway routing table, cron schedule and the
 * QA/deploy summary. Full source: animaxia-edge/ (in animaxia-cloud.zip).
 */

import { useState } from 'react';
import {
  Activity,
  BarChart3,
  Boxes,
  CloudCog,
  FileArchive,
  KeyRound,
  MonitorPlay,
  RefreshCw,
  Search,
  ShieldCheck,
  Terminal,
  Timer,
  type LucideIcon,
} from 'lucide-react';
import { useApi } from '@/lib/animaxia/hooks';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Container, PageHeader } from '../section';

/* ------------------------------------------------------------- data ------ */

interface EdgeStatus {
  ok: boolean;
  upstream: {
    status: number;
    healthy: boolean;
    service: string | null;
    uptimeSec: number | null;
    db: { driver?: string; connected?: boolean; totalItems?: number } | null;
  } | null;
  latencyMs: number;
  checkedAt: string;
  error?: string;
}

const WORKERS: { name: string; icon: LucideIcon; role: string; routes: string; bindings: string[] }[] = [
  {
    name: 'gateway',
    icon: CloudCog,
    role: 'Front door: WAF (bots/SQLi/XSS/traversal), per-IP + per-user + heavy rate limits, smart routing, response cache, R2 media, WebSocket proxy.',
    routes: '/edge/* · /api/* · /ai/* · /vector/* · /mobile/* · /search · /auth/* · /player/* · /media/* · /ws/*',
    bindings: ['EDGE_CONFIG', 'EDGE_CACHE', 'EDGE_RATELIMIT', 'MEDIA_BUCKET', 'RATE_LIMITER DO', '5× SVC'],
  },
  {
    name: 'search',
    icon: Search,
    role: 'Fuzzy search + autocomplete over a KV catalog snapshot built from /api/all (paged); cloud fallback when the catalog is unavailable.',
    routes: '/search · /autocomplete · /search/refresh · /search/health',
    bindings: ['EDGE_CONFIG', 'SEARCH_CACHE'],
  },
  {
    name: 'ai',
    icon: Activity,
    role: 'Edge-accelerated RAG: L1 answer cache + L2 retrieval pre-warm (/api/vector/search), SSE streaming passthrough, authorized requests bypass.',
    routes: '/ai/assistant · /ai/rag/* · /ai/embeddings · /ai/cloud/status',
    bindings: ['EDGE_CONFIG', 'EMBEDDINGS_CACHE', 'EDGE_CACHE'],
  },
  {
    name: 'auth',
    icon: KeyRound,
    role: 'HS256 verify at the edge (secret parity with the cloud), jti anti-replay registry, device-bound wrapper tokens, refresh replay guard.',
    routes: '/auth/verify · /auth/refresh · /auth/login… · /auth/device/token',
    bindings: ['EDGE_CONFIG', 'EDGE_CACHE', 'EDGE_REPLAY'],
  },
  {
    name: 'player',
    icon: MonitorPlay,
    role: 'HLS manifest rewrite (segments → /hls?u=…), host allowlist, L1 segment cache + R2 write-through + stale-if-error, R2 media hosting.',
    routes: '/player/manifest/:id · /hls · /player/sources/:id · /player/media/*',
    bindings: ['EDGE_CONFIG', 'EDGE_CACHE', 'MEDIA_BUCKET', 'HLS_CACHE'],
  },
  {
    name: 'analytics',
    icon: BarChart3,
    role: 'view/play/complete tracking → Cloudflare Queue (or KV ring) → cloud batches; hourly trending buckets with decayed scoring.',
    routes: '/analytics/view · /beacon · /analytics/trending · /analytics/flush',
    bindings: ['EDGE_CONFIG', 'ANALYTICS_TREND', 'ANALYTICS_QUEUE'],
  },
  {
    name: 'cron',
    icon: Timer,
    role: 'Scheduled jobs (daily picks, weekly recap, TMDB/Jikan refresh, log/session cleanups, analytics flush) + manual triggers, every run logged.',
    routes: '/cron/run/:job · /cron/jobs · /cron/health + scheduled()',
    bindings: ['EDGE_CONFIG', 'EDGE_CACHE', 'EDGE_RATELIMIT', 'EDGE_REPLAY', 'SVC_ANALYTICS'],
  },
];

const ROUTES: { prefix: string; target: string; cached: string }[] = [
  { prefix: '/api/*', target: 'cloud gateway (:4000)', cached: 'public GETs — 60s + SWR + SIE' },
  { prefix: '/ai/*', target: 'edge-ai → /api/ai/*', cached: 'answers + retrieval at the edge' },
  { prefix: '/vector/*', target: 'vector-service → /api/vector/*', cached: 'heavy-tier rate limited' },
  { prefix: '/mobile/*', target: 'mobile-service → /api/mobile/*', cached: 'public GETs' },
  { prefix: '/search · /autocomplete', target: 'edge-search (fallback /api/search/*)', cached: 'in-memory fuzzy index' },
  { prefix: '/auth/*', target: 'edge-auth (fallback /api/auth/*)', cached: 'never (bypass list)' },
  { prefix: '/player/* · /hls', target: 'edge-player (fallback /api/mobile/player/*)', cached: 'manifest 30s · segments 1h' },
  { prefix: '/analytics/* · /beacon', target: 'edge-analytics (fallback /api/analytics/*)', cached: 'never (writes)' },
  { prefix: '/media/*', target: 'R2 MEDIA_BUCKET', cached: 'immutable-ish (24h)' },
  { prefix: '/ws/*', target: 'WebSocket proxy → WS_ORIGIN', cached: '—' },
];

const CRONS: { schedule: string; job: string; action: string }[] = [
  { schedule: '0 5 * * *', job: 'daily-picks', action: 'GET /api/all — picks refresh + cache warm' },
  { schedule: '0 6 * * 1', job: 'weekly-recap', action: 'GET /api/analytics/trending?window=7d' },
  { schedule: '0 */6 * * *', job: 'tmdb-refresh', action: 'POST /api/workers/refresh (admin JWT)' },
  { schedule: '30 */6 * * *', job: 'jikan-refresh', action: 'POST /api/workers/refresh' },
  { schedule: '0 3 * * *', job: 'cleanup-logs', action: 'edge-only: purge waf:* + cron:log:*' },
  { schedule: '0 4 * * *', job: 'cleanup-sessions', action: 'edge-only: purge rl:* + replay:*' },
  { schedule: '*/5 * * * *', job: 'analytics-flush', action: 'service binding → POST /analytics/flush' },
];

const QA: { label: string; value: string }[] = [
  { label: 'Typecheck', value: 'tsc --noEmit strict — 0 erori (22 fișiere TS)' },
  { label: 'Guard lint', value: 'PASS — hygiene + wrangler contracts + script matrix' },
  { label: 'Smoke suite', value: '146/146 — hermetic, real worker code + stub cloud' },
  { label: 'E2E chain', value: '34/34 — edge → cloud :4000 → Neon (1 soft: cotă AI anonimă)' },
  { label: 'ZIP', value: 'animaxia-cloud.zip: 501 → 562 fișiere (aditiv, nimic rescris)' },
];

/* ------------------------------------------------------------- view ------ */

function StatusChip({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <Badge
      variant="secondary"
      className={ok ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-rose-500/30 bg-rose-500/10 text-rose-300'}
    >
      {children}
    </Badge>
  );
}

function UpstreamCard() {
  const [checking, setChecking] = useState(false);
  const { data, loading, error, refetch: reload } = useApi<EdgeStatus>('/api/edge-status', async () => {
    const res = await fetch('/api/edge-status', { cache: 'no-store' });
    if (!res.ok) throw new Error(`edge-status probe failed (${res.status})`);
    return (await res.json()) as EdgeStatus;
  });

  const ok = data?.ok === true;
  const busy = loading || checking;

  const refresh = async () => {
    setChecking(true);
    try {
      await reload();
    } finally {
      setChecking(false);
    }
  };

  return (
    <Card className="border-zinc-800 bg-zinc-900/60">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <CloudCog className="h-4 w-4 text-rose-400" aria-hidden /> Cloud origin — upstream-ul stratului edge
          </CardTitle>
          <Button size="sm" variant="outline" className="h-8 gap-1.5 border-zinc-700" onClick={() => void refresh()}>
            <RefreshCw className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} aria-hidden /> Reîmprospătează
          </Button>
        </div>
        <CardDescription>
          CLOUD_ORIGIN al gateway-ului edge — lanțul accelerat și protejat de Workers: gateway → monolit → Neon.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {busy && !data ? (
          <div className="space-y-2">
            <Skeleton className="h-5 w-72" />
            <Skeleton className="h-5 w-52" />
          </div>
        ) : error || !data ? (
          <p className="text-sm text-rose-300">{error ?? 'Cloud origin unreachable.'}</p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip ok={ok}>{ok ? 'origin healthy' : 'origin down'}</StatusChip>
            <StatusChip ok={data.upstream?.db?.connected === true}>
              Neon {data.upstream?.db?.connected ? 'conectat' : 'deconectat'} · {data.upstream?.db?.driver ?? '—'}
            </StatusChip>
            {typeof data.upstream?.db?.totalItems === 'number' && (
              <Badge variant="secondary" className="border-zinc-700 bg-zinc-800 text-zinc-300">
                {data.upstream.db.totalItems} item-uri în catalog
              </Badge>
            )}
            <Badge variant="secondary" className="border-zinc-700 bg-zinc-800 text-zinc-300">
              {data.latencyMs} ms
            </Badge>
            {data.upstream?.uptimeSec != null && (
              <Badge variant="secondary" className="border-zinc-700 bg-zinc-800 text-zinc-300">
                uptime {Math.floor(data.upstream.uptimeSec / 60)} min
              </Badge>
            )}
          </div>
        )}
        <p className="text-xs text-zinc-500">
          Worker-ele edge rulează în animaxia-edge/ — verificabile local cu <code className="text-zinc-400">bun run test:smoke</code> /
          <code className="text-zinc-400"> test:e2e</code>; deploy Cloudflare prin <code className="text-zinc-400">deploy/deploy-all.sh</code>.
        </p>
      </CardContent>
    </Card>
  );
}

export function EdgeView() {
  return (
    <Container className="space-y-8 py-10">
      <PageHeader title="Animaxia Edge — Cloudflare Workers" subtitle="FAZA 8 · stratul edge: gateway cu WAF, rate limiting pe 3 nivele, cache SWR/stale-if-error, căutare fuzzy, RAG accelerat, auth cu anti-replay, player HLS și analytics — 7 worker-e + strat shared, testate end-to-end pe lanțul edge → cloud → SQLite local.">
        <div className="flex flex-wrap gap-2 pt-1">
          <Badge className="bg-rose-600 font-bold hover:bg-rose-500">FAZA 8</Badge>
          <Badge variant="secondary" className="border-zinc-700 bg-zinc-800 text-zinc-300">7 worker-e</Badge>
          <Badge variant="secondary" className="border-zinc-700 bg-zinc-800 text-zinc-300">7 KV · 2 R2 · 1 DO · 1 Queue</Badge>
          <Badge variant="secondary" className="border-zinc-700 bg-zinc-800 text-zinc-300">zero runtime deps</Badge>
        </div>
      </PageHeader>

      <UpstreamCard />

      {/* Workers */}
      <section aria-label="Edge workers" className="space-y-4">
        <h2 className="text-lg font-bold text-white">Worker-e</h2>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {WORKERS.map((w) => (
            <Card key={w.name} className="border-zinc-800 bg-zinc-900/60">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <span className="grid h-8 w-8 place-items-center rounded-lg bg-rose-600/15 text-rose-400">
                    <w.icon className="h-4 w-4" aria-hidden />
                  </span>
                  animaxia-edge-{w.name}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm leading-relaxed text-zinc-400">{w.role}</p>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Rute</p>
                  <p className="mt-0.5 break-words font-mono text-[11px] text-zinc-300">{w.routes}</p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {w.bindings.map((b) => (
                    <Badge key={b} variant="secondary" className="border-zinc-700 bg-zinc-800 text-[10px] text-zinc-300">
                      {b}
                    </Badge>
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
          <Card className="border-zinc-800 bg-zinc-900/60">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <span className="grid h-8 w-8 place-items-center rounded-lg bg-fuchsia-600/15 text-fuchsia-400">
                  <Boxes className="h-4 w-4" aria-hidden />
                </span>
                shared/ — stratul de contracte
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-zinc-400">
              <p>Tipuri (EdgeEnv), configurare KV cu deep-merge, JWT WebCrypto HS256 cu paritate de secret, WAF, rate limiting 3 nivele, cache SWR/SIE, fuzzy, HTTP hardening, upstream fetch cu retry.</p>
              <p className="font-mono text-[11px] text-zinc-300">9 module · importate relativ de toate worker-ele</p>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* Routing + cron */}
      <section aria-label="Routing și cron" className="grid gap-4 lg:grid-cols-2">
        <Card className="border-zinc-800 bg-zinc-900/60">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldCheck className="h-4 w-4 text-rose-400" aria-hidden /> Rutare inteligentă (gateway)
            </CardTitle>
            <CardDescription>Service bindings cu fallback la cloud — fiecare binding e opțional la runtime.</CardDescription>
          </CardHeader>
          <CardContent>
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="text-zinc-500">
                  <th className="pb-2 pr-3 font-semibold">Prefix</th>
                  <th className="pb-2 pr-3 font-semibold">Țintă</th>
                  <th className="pb-2 font-semibold">Cache</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {ROUTES.map((r) => (
                  <tr key={r.prefix} className="align-top">
                    <td className="py-2 pr-3 font-mono text-rose-300">{r.prefix}</td>
                    <td className="py-2 pr-3 text-zinc-300">{r.target}</td>
                    <td className="py-2 text-zinc-400">{r.cached}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card className="border-zinc-800 bg-zinc-900/60">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Timer className="h-4 w-4 text-rose-400" aria-hidden /> Cron jobs (Cloudflare triggers)
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2 text-xs">
                {CRONS.map((c) => (
                  <li key={c.job} className="flex flex-wrap items-baseline gap-2">
                    <code className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-rose-300">{c.schedule}</code>
                    <span className="font-semibold text-zinc-200">{c.job}</span>
                    <span className="text-zinc-500">— {c.action}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>

          <Card className="border-zinc-800 bg-zinc-900/60">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <FileArchive className="h-4 w-4 text-rose-400" aria-hidden /> QA & livrare
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {QA.map((q) => (
                <div key={q.label} className="flex flex-wrap items-baseline gap-2 text-xs">
                  <span className="font-semibold text-zinc-200">{q.label}:</span>
                  <span className="text-zinc-400">{q.value}</span>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </section>

      {/* Run commands */}
      <Card className="border-zinc-800 bg-zinc-900/60">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Terminal className="h-4 w-4 text-rose-400" aria-hidden /> Rulează stratul edge
          </CardTitle>
        </CardHeader>
        <CardContent>
          <pre className="overflow-x-auto rounded-lg border border-zinc-800 bg-[#0a0a10] p-4 font-mono text-[11px] leading-relaxed text-zinc-300">
{`cd animaxia-edge
bun install
bun run typecheck     # tsc --noEmit strict
bun run lint          # guard lint (hygiene + wrangler contracts)
bun run test:smoke    # 146 checks — real worker code, hermetic harness
bun run test:e2e      # 34 checks — edge → cloud :4000 → Neon

./deploy/deploy-all.sh            # Cloudflare: sub-worker-e, apoi gateway
# CI/CD: .github/workflows/edge-deploy.yml (verify → deploy)`}
          </pre>
        </CardContent>
      </Card>
    </Container>
  );
}
