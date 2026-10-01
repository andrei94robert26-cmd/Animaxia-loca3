'use client';

/**
 * global-30b-view.tsx — Global 30B (#/global30b, FAZA 14).
 *
 * Feed-ul spațiului logic de 30 de miliarde de sloturi (ID-uri
 * 0 … 29.999.999.999, 30 de sharduri × 1 miliard), cu overlay REAL: rândurile
 * din Neon apar la id-ul lor propriu; restul sloturilor sunt generate
 * determinist, O(1), fără stocare fizică.
 *
 *  1. Spațiul logic vs. conținutul real — 4 cărți de statistici (spațiu 30B,
 *     30 × 1 miliard, reale în Neon, simulate logic).
 *  2. Cele 30 de sharduri — chip-uri compacte `sN [x real]`; un click
 *     îngustează feed-ul la intervalul shardului ([s×10⁹,(s+1)×10⁹−1]).
 *  3. Feed-ul global — 20 sloturi/pagină, paginare numerotată în stilul flux
 *     AI (chip-uri + ellipsis + Anterior/Următor) PLUS «Salt la pagina»:
 *     cursorul {i,s} se construiește client-side (buildVirtualCursor), deci
 *     săritura la pagina 1.500.000.000 e la fel de rapidă ca la pagina 1.
 */

import { useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Database,
  Globe,
  Layers,
  Loader2,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, buildVirtualCursor } from '@/lib/animaxia/api';
import { useApi } from '@/lib/animaxia/hooks';
import { navigate } from '@/lib/animaxia/router';
import type { GlobalFeedItem, GlobalFeedResponse } from '@/lib/animaxia/types';
import { Container, PageHeader, Section } from '../section';
import { BrandPlaceholder, EmptyState, ErrorState, RatingBadge, TypeBadge } from '../states';
import { cn } from '@/lib/utils';

/* ------------------------------- constants ------------------------------- */

/** 20 sloturi pe pagină — exact ca fluxul AI de pe prima pagină. */
const FEED_LIMIT = 20;
/** Spațiul logic FAZA 14: 30B sloturi, 30 sharduri × 1 miliard ID-uri. */
const DEFAULT_ADDRESS_SPACE = 30_000_000_000;
const DEFAULT_SHARD_SPAN = 1_000_000_000;
/** Seed determinist implicit al feedului global (identic backend-ului). */
const FEED_SEED = 'animaxia';

/* ------------------------------- formatting ------------------------------- */

const RO_NUMBER = new Intl.NumberFormat('ro-RO');

function formatCount(n: number): string {
  return RO_NUMBER.format(n);
}

/** Fereastră compactă de pagini (1 … n) cu ellipsis — ca în home-ai-feed. */
function pageWindow(current: number, total: number): (number | '…')[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages = new Set<number>([1, total, current, current - 1, current + 1]);
  const sorted = [...pages].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b);
  const out: (number | '…')[] = [];
  let prev = 0;
  for (const p of sorted) {
    if (p - prev > 1) out.push('…');
    out.push(p);
    prev = p;
  }
  return out;
}

/* ------------------------------- stat tiles ------------------------------- */

type StatTone = 'emerald' | 'neutral';

const STAT_TONE: Record<StatTone, string> = {
  emerald: 'text-emerald-300',
  neutral: 'text-white',
};

function StatTile({
  label,
  icon: Icon,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string;
  icon: typeof Globe;
  value: string;
  hint?: string;
  tone?: StatTone;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
      <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-500">
        <Icon className="h-3.5 w-3.5" aria-hidden />
        {label}
      </p>
      <p className={cn('mt-1.5 truncate text-lg font-black', STAT_TONE[tone])} title={value}>
        {value}
      </p>
      {hint ? <p className="mt-0.5 text-[11px] leading-snug text-zinc-500">{hint}</p> : null}
    </div>
  );
}

/* -------------------------------- feed card ------------------------------- */

/**
 * Un slot al feedului global: REAL (clickabil → /content/{id}) sau SIMULAT
 * (slot logic, fără stocare — ne-clickabil, tooltip explicativ).
 */
function GlobalFeedCard({ item }: { item: GlobalFeedItem }) {
  const body = (
    <>
      <div className="relative aspect-[2/3] w-full overflow-hidden bg-black/40">
        {item.thumbnail ? (
          <img
            src={item.thumbnail}
            alt={item.title}
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover"
          />
        ) : (
          <BrandPlaceholder title={item.title} />
        )}
        <span className="absolute left-1.5 top-1.5">
          <TypeBadge type={item.type} />
        </span>
        <span className="absolute right-1.5 top-1.5">
          <RatingBadge value={item.rating} />
        </span>
        <span className="absolute bottom-1.5 left-1.5 inline-flex items-center rounded-full border border-white/10 bg-black/60 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-zinc-300 backdrop-blur-sm">
          s{item.shardid}
        </span>
        <span
          className={cn(
            'absolute bottom-1.5 right-1.5 inline-flex items-center rounded-full border px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wider backdrop-blur-sm',
            item.real
              ? 'border-emerald-500/40 bg-emerald-500/20 text-emerald-300'
              : 'border-zinc-400/30 bg-black/50 text-zinc-300',
          )}
        >
          {item.real ? 'Real' : 'Simulat'}
        </span>
      </div>
      <div className="space-y-1.5 p-2.5">
        <p className="line-clamp-2 text-xs font-bold leading-snug text-zinc-100" title={item.title}>
          {item.title}
        </p>
        <p className="text-[10px] text-zinc-500">
          {item.year} · #{formatCount(item.id)}
        </p>
        <div className="flex flex-wrap gap-1">
          {item.genres.slice(0, 3).map((g) => (
            <span
              key={g}
              className="rounded-full border border-white/10 bg-white/5 px-1.5 py-0.5 text-[9px] font-medium text-zinc-400"
            >
              {g}
            </span>
          ))}
        </div>
      </div>
    </>
  );

  if (item.real) {
    return (
      <button
        type="button"
        onClick={() => navigate(`/content/${item.id}`)}
        aria-label={`Deschide ${item.title} — conținut real din Neon`}
        className="overflow-hidden rounded-xl border border-white/10 bg-white/[0.03] text-left transition hover:border-emerald-500/40 hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
      >
        {body}
      </button>
    );
  }
  return (
    <div
      title="Slot simulat — spațiul logic 30B"
      aria-label={`${item.title} — slot simulat`}
      className="overflow-hidden rounded-xl border border-white/10 bg-white/[0.02]"
    >
      {body}
    </div>
  );
}

/* ---------------------------------- view ---------------------------------- */

export function Global30BView() {
  /* Fetch-on-demand (ca VirtualBrowserSection): doar pagina curentă stă în
     memorie — săriturile O(1) nu acumulează gunoi în state. */
  const [shard, setShard] = useState<number | null>(null);
  const [cursor, setCursor] = useState('');
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState('1');

  const res = useApi(
    `global30b-${shard ?? 'toate'}-${cursor || 'start'}`,
    () =>
      api.platform.globalFeed({
        cursor: cursor || undefined,
        limit: FEED_LIMIT,
        shard: shard ?? undefined,
        seed: FEED_SEED,
      }),
  );

  const data: GlobalFeedResponse | null = res.data;
  const stats = data?.stats ?? null;

  /* Constantele modelului vin din răspuns; fallback-urile sunt valorile
     pinned FAZA 14 (30B / 30 × 1 mld) pentru prima încărcare. */
  const addressSpace = data?.addressSpace ?? DEFAULT_ADDRESS_SPACE;
  const shardSpan = data?.shardSpan ?? DEFAULT_SHARD_SPAN;
  const shardCount = stats?.shardcount ?? data?.shardcount ?? 30;
  /* totalPages doar din răspunsul care corespunde filtrului curent — altfel
     fallback matematic (30B/20 = 1,5 mld; 1 mld/20 = 50 mil per shard). */
  const totalPages =
    data && data.shard === shard
      ? data.totalPages
      : Math.floor((shard != null ? shardSpan : addressSpace) / FEED_LIMIT);

  /** Cursor O(1) construit client-side pentru ORICE pagină: indexul keyset
      este GLOBAL chiar și sub filtru de shard (shardul s începe la s×span). */
  const cursorForPage = (p: number): string =>
    buildVirtualCursor((shard != null ? shard * shardSpan : 0) + (p - 1) * FEED_LIMIT, FEED_SEED);

  const goToPage = (raw: number) => {
    const p = Math.floor(raw);
    if (!Number.isFinite(p) || p < 1 || p > totalPages) {
      toast.error(`Pagina trebuie să fie între 1 și ${formatCount(totalPages)}`);
      return;
    }
    setPage(p);
    setPageInput(String(p));
    setCursor(cursorForPage(p));
  };

  const jumpToTypedPage = () => {
    const p = Number.parseInt(pageInput, 10);
    goToPage(p);
  };

  const goPrev = () => goToPage(page - 1);

  const goNext = () => {
    if (page >= totalPages) return;
    const next = page + 1;
    setPage(next);
    setPageInput(String(next));
    /* Cursorul serverului (byte-identic cu cel calculat) când e disponibil;
       altfel sare în calcul client-side — ambele O(1). */
    const serverNext =
      data && data.shard === shard && data.page === page ? data.nextCursor : null;
    setCursor(serverNext ?? cursorForPage(next));
  };

  const selectShard = (s: number | null) => {
    if (s === shard) return;
    setShard(s);
    setPage(1);
    setPageInput('1');
    setCursor('');
  };

  const firstId = data && data.items.length > 0 ? data.items[0].id : null;
  const lastId = data && data.items.length > 0 ? data.items[data.items.length - 1].id : null;

  return (
    <Container className="space-y-8 py-8 sm:py-10">
      <PageHeader
        title="🌍 Global 30B — feed-ul spațiului logic"
        subtitle="30 de miliarde de sloturi (30 sharduri × 1 miliard ID-uri). Volumul e simulat logic și se generează O(1); conținutul REAL din Neon se suprapune la id-ul lui propriu. Orice pagină, oricât de adâncă, răspunde instant."
      >
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Badge className="border-rose-500/30 bg-rose-500/15 text-rose-300 hover:bg-rose-500/15">
            <span className="relative mr-1.5 flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-rose-500" />
            </span>
            O(1) · orice adâncime
          </Badge>
          {data ? (
            <>
              <span className="font-mono text-[11px] text-zinc-500">{data.engine}</span>
              <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                mod {data.mode}
              </span>
            </>
          ) : (
            <span className="text-[11px] text-zinc-500">măsurători direct de pe nodul backend</span>
          )}
        </div>
      </PageHeader>

      {/* ------------------------ stats strip (4 cards) ------------------------ */}
      <Section
        title="Spațiul logic vs. conținutul real"
        subtitle="Regula FAZA 14: volumul de 30B este simulat logic (fără stocare fizică); metadata reală rămâne 100% reală în Neon."
      >
        {stats ? (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile
              label="Spațiul logic"
              icon={Globe}
              value={formatCount(stats.addressSpace)}
              hint="ID-uri 0 … 29.999.999.999 · generare deterministă O(1)"
            />
            <StatTile
              label="Sharduri logice"
              icon={Layers}
              value={`${formatCount(shardCount)} × 1 miliard`}
              hint={`shardul s = [s × ${formatCount(shardSpan)} ID-uri, (s+1) × ${formatCount(shardSpan)} − 1]`}
            />
            <StatTile
              label="Conținuturi reale"
              icon={Database}
              value={formatCount(stats.realCount)}
              hint="salvate 100% real în Neon"
              tone="emerald"
            />
            <StatTile
              label="Simulate logic"
              icon={Sparkles}
              value={formatCount(stats.addressSpace - stats.realCount)}
              hint="fără stocare fizică — doar slot logic"
            />
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-[86px] animate-pulse rounded-xl border border-white/10 bg-white/[0.03]" />
            ))}
          </div>
        )}
      </Section>

      {/* ----------------------- per-shard strip (30 chips) ----------------------- */}
      <Section
        title="Cele 30 de sharduri"
        subtitle="Fiecare shard acoperă exact 1 miliard de ID-uri (computeShardId = floor(id/10⁹) % 30). Apasă un chip pentru a îngusta feed-ul la intervalul lui."
      >
        <div
          role="group"
          aria-label="Filtru pe shard — 30 de sharduri logice"
          className="custom-scrollbar -mx-1 flex gap-2 overflow-x-auto px-1 pb-2"
        >
          <button
            type="button"
            onClick={() => selectShard(null)}
            aria-pressed={shard == null}
            aria-label="Toate shardurile — întregul spațiu logic 30B"
            className={cn(
              'shrink-0 rounded-full border px-3 py-1 text-[11px] font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60',
              shard == null
                ? 'border-rose-500/60 bg-rose-600 text-white'
                : 'border-white/10 bg-white/5 text-zinc-300 hover:border-white/25 hover:bg-white/10 hover:text-white',
            )}
          >
            Toate
          </button>
          {(stats?.perShard ?? []).map((s) => {
            const active = shard === s.shardid;
            return (
              <button
                key={s.shardid}
                type="button"
                onClick={() => selectShard(s.shardid)}
                aria-pressed={active}
                aria-label={`Shardul s${s.shardid} — ${formatCount(s.real)} conținuturi reale`}
                className={cn(
                  'flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[11px] font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60',
                  active
                    ? 'border-rose-500/60 bg-rose-600 text-white'
                    : 'border-white/10 bg-white/5 text-zinc-300 hover:border-white/25 hover:bg-white/10 hover:text-white',
                )}
              >
                s{s.shardid}
                <span className={cn('font-sans', active ? 'text-white' : s.real > 0 ? 'text-emerald-300' : 'text-zinc-500')}>
                  [{s.real > 0 ? `${formatCount(s.real)} real` : '0'}]
                </span>
              </button>
            );
          })}
        </div>
        {shard != null ? (
          <p className="text-[11px] leading-relaxed text-zinc-500">
            Filtru activ: shardul <span className="font-mono text-zinc-300">s{shard}</span> — ID-urile{' '}
            {formatCount(shard * shardSpan)} … {formatCount((shard + 1) * shardSpan - 1)} ·{' '}
            {formatCount(Math.floor(shardSpan / FEED_LIMIT))} pagini în acest shard.{' '}
            <button
              type="button"
              onClick={() => selectShard(null)}
              className="font-semibold text-rose-300 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60"
            >
              Șterge filtrul
            </button>
          </p>
        ) : (
          <p className="text-[11px] text-zinc-500">
            Fără filtru — feed-ul acoperă tot spațiul logic de {formatCount(addressSpace)} ID-uri (
            {formatCount(totalPages)} pagini).
          </p>
        )}
      </Section>

      {/* ------------------------------- the feed ------------------------------- */}
      <Section
        title="Feed-ul global — 20 de sloturi pe pagină"
        subtitle="Overlay REAL: sloturile cu id-ul propriu al fiecărui conținut din Neon; restul generate determinist. Săriturile construiesc cursorul client-side — pagina 1.500.000.000 răspunde la fel de repede ca pagina 1."
        action={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void res.refetch()}
            disabled={res.loading}
            className="h-8 border-white/15 bg-white/5 text-zinc-200 hover:bg-white/10 hover:text-white"
          >
            <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', res.loading && 'animate-spin')} aria-hidden />
            Reîmprospătează
          </Button>
        }
      >
        {/* deep-jump controls */}
        <div className="flex flex-wrap items-end gap-2.5 rounded-2xl border border-white/10 bg-white/[0.03] p-3.5">
          <div className="w-56">
            <Label htmlFor="global30b-page" className="text-[11px] font-semibold text-zinc-400">
              Salt la pagina (1 – {formatCount(totalPages)})
            </Label>
            <Input
              id="global30b-page"
              type="number"
              min={1}
              max={totalPages}
              value={pageInput}
              onChange={(e) => setPageInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') jumpToTypedPage();
              }}
              className="mt-1 border-white/15 bg-black/30 text-zinc-100"
            />
          </div>
          <Button
            onClick={jumpToTypedPage}
            disabled={res.loading && !data}
            className="h-9 bg-rose-600 font-bold hover:bg-rose-500"
          >
            Sari
          </Button>
          <Button
            variant="outline"
            onClick={() => goToPage(1)}
            className="h-9 border-white/15 bg-white/5 font-semibold text-zinc-200 hover:bg-white/10 hover:text-white"
          >
            Prima pagină
          </Button>
          <Button
            variant="outline"
            onClick={() => goToPage(Math.ceil(totalPages / 2))}
            className="h-9 border-white/15 bg-white/5 font-semibold text-zinc-200 hover:bg-white/10 hover:text-white"
          >
            {shard != null ? `Mijloc (s${shard})` : 'Mijloc (15B)'}
          </Button>
          <Button
            variant="outline"
            onClick={() => goToPage(totalPages)}
            className="h-9 border-white/15 bg-white/5 font-semibold text-zinc-200 hover:bg-white/10 hover:text-white"
          >
            Ultima pagină
          </Button>
        </div>

        {/* grid / skeleton / error / empty */}
        {res.error && !res.loading && !data ? (
          <ErrorState message={res.error} onRetry={() => void res.refetch()} />
        ) : !data ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
            {Array.from({ length: FEED_LIMIT }).map((_, i) => (
              <div key={i} className="space-y-2">
                <div className="aspect-[2/3] animate-pulse rounded-xl border border-white/10 bg-white/[0.03]" />
                <div className="h-4 w-4/5 animate-pulse rounded bg-white/[0.05]" />
              </div>
            ))}
          </div>
        ) : data.items.length === 0 ? (
          <EmptyState
            title="Pagină goală"
            message="Acest interval al spațiului logic nu are sloturi de afișat."
          />
        ) : (
          <>
            {res.error ? (
              <ErrorState compact message={res.error} onRetry={() => void res.refetch()} />
            ) : null}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
              {data.items.map((item) => (
                <GlobalFeedCard key={item.id} item={item} />
              ))}
            </div>
          </>
        )}

        {/* per-page status line */}
        {data && data.items.length > 0 ? (
          <p className="text-[11px] leading-relaxed text-zinc-500" aria-live="polite">
            Pagina {formatCount(page)} din {formatCount(totalPages)}
            {shard != null ? <> · shardul s{shard}</> : null}
            {firstId != null && lastId != null ? (
              <>
                {' '}
                · ID-uri {formatCount(firstId)} … {formatCount(lastId)}
              </>
            ) : null}{' '}
            · {formatCount(data.stats.realInPage)} real + {formatCount(data.stats.virtualInPage)} simulate în
            pagină · generat în {formatCount(data.tookMs)}ms — O(1)
            {res.loading ? (
              <span className="ml-2 inline-flex items-center gap-1 text-rose-300">
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> se încarcă…
              </span>
            ) : null}
          </p>
        ) : null}

        {/* numbered pagination — în stilul fluxului AI de pe prima pagină */}
        {data ? (
          <div className="flex flex-col gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-zinc-400">
                Pagina <span className="font-bold text-white">{formatCount(page)}</span> din{' '}
                {formatCount(totalPages)}
                {shard != null ? (
                  <>
                    {' '}
                    · shard <span className="font-mono text-zinc-200">s{shard}</span>
                  </>
                ) : null}
              </p>
              <span className="text-xs text-zinc-600">
                {data.nextCursor
                  ? 'cursor keyset O(1) — nicio scanare, nicio acumulare'
                  : 'finalul feedului — nextCursor null'}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                variant="outline"
                size="sm"
                onClick={goPrev}
                disabled={page <= 1 || res.loading}
                className="h-9 border-white/10 bg-white/5 px-3 text-sm font-semibold hover:bg-white/10"
              >
                <ChevronLeft className="mr-1 h-4 w-4" aria-hidden /> Anterior
              </Button>
              {pageWindow(page, totalPages).map((p, i) =>
                p === '…' ? (
                  <span key={`gap-${i}`} className="px-1 text-sm text-zinc-600" aria-hidden>
                    …
                  </span>
                ) : (
                  <button
                    key={p}
                    type="button"
                    onClick={() => goToPage(p)}
                    aria-label={`Pagina ${formatCount(p)}`}
                    aria-current={p === page ? 'page' : undefined}
                    className={cn(
                      'h-9 min-w-9 rounded-lg px-2 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60',
                      p === page
                        ? 'bg-rose-600 text-white'
                        : 'border border-white/10 bg-white/5 text-zinc-300 hover:bg-white/10 hover:text-white',
                    )}
                  >
                    {formatCount(p)}
                  </button>
                ),
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={goNext}
                disabled={page >= totalPages || res.loading}
                className="h-9 border-white/10 bg-white/5 px-3 text-sm font-semibold hover:bg-white/10"
              >
                Următor <ChevronRight className="ml-1 h-4 w-4" aria-hidden />
              </Button>
            </div>
          </div>
        ) : null}
      </Section>
    </Container>
  );
}
