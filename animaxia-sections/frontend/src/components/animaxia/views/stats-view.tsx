'use client';

/**
 * stats-view.tsx — #/stats „Statistici Platformă" (FAZA 21, task 21-1).
 *
 * PUBLIC (fără auth). Date 100% reale din hub-urile FAZA 20:
 * /api/hub/stats (totaluri + tops de angajament + recență),
 * /api/hub/scale (numerele reale din Neon vs. capacitatea logică 30B)
 * și /api/hub/feed (3 rafturi live) — toate într-un singur Promise.all.
 *
 * Honestitatea FAZA 20 e păstrată: cardul „Date reale vs. capacitate
 * logică" arată explicit că datele reale sunt cele listate, iar spațiul
 * de 30B este logic (simulat, 30 shard-uri × 1 miliard).
 */

import {
  Activity,
  BarChart3,
  Captions,
  Clapperboard,
  Database,
  Eye,
  Flame,
  Heart,
  ListMusic,
  MessageSquare,
  Play,
  RefreshCw,
  Sparkles,
  Star,
  Users,
} from 'lucide-react';
import { api } from '@/lib/animaxia/api';
import { useApi } from '@/lib/animaxia/hooks';
import { navigate } from '@/lib/animaxia/router';
import type { HubContentRow, HubFeedResponse, HubScaleResponse, HubStatsResponse } from '@/lib/animaxia/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { Container, PageHeader, Section } from '../section';
import { EmptyState, ErrorState, TypeBadge } from '../states';

/* ------------------------------- formatting -------------------------------- */

function formatCount(n: number): string {
  return n.toLocaleString('ro-RO');
}

/** „30000000000" → „30.000.000.000" (grupare ro-RO). */
function formatCapacity(claim: string): string {
  const n = Number(claim);
  return Number.isFinite(n) ? n.toLocaleString('ro-RO') : claim;
}

function formatGeneratedAt(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('ro-RO', { dateStyle: 'short', timeStyle: 'medium' });
}

/* ------------------------------ gauge cards ------------------------------- */

interface GaugeDef {
  label: string;
  value: number;
  icon: typeof Users;
  hint: string;
  accent: string;
}

function gaugeDefs(stats: HubStatsResponse): GaugeDef[] {
  const t = stats.totals;
  const topTypes = Object.entries(t.byType ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, v]) => `${k} ${v}`)
    .join(' · ');
  return [
    { label: 'Conținut total', value: t.content, icon: Clapperboard, hint: topTypes || '—', accent: 'text-rose-300' },
    { label: 'Utilizatori', value: t.users, icon: Users, hint: 'conturi înregistrate', accent: 'text-fuchsia-300' },
    { label: 'Vizualizări', value: t.viewEvents, icon: Eye, hint: `${formatCount(t.watchEntries)} intrări istoric`, accent: 'text-amber-300' },
    { label: 'Comentarii', value: t.comments, icon: MessageSquare, hint: 'conversații sociale', accent: 'text-teal-300' },
    { label: 'Playlist-uri', value: t.playlists, icon: ListMusic, hint: `${formatCount(t.playlistItems)} titluri în cozi`, accent: 'text-emerald-300' },
    { label: 'Subtitrări', value: t.subtitleTracks, icon: Captions, hint: 'trackuri WebVTT', accent: 'text-lime-300' },
  ];
}

function GaugeCard({ gauge }: { gauge: GaugeDef }) {
  const Icon = gauge.icon;
  return (
    <div className="relative min-w-0 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03] p-4">
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-gradient-to-br from-white/[0.04] to-transparent" />
      <div className="relative space-y-2">
        <span className={cn('grid h-9 w-9 place-items-center rounded-xl bg-black/40', gauge.accent)}>
          <Icon className="h-4.5 w-4.5" aria-hidden />
        </span>
        <p className="text-2xl font-black tracking-tight text-white sm:text-3xl">{formatCount(gauge.value)}</p>
        <p className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">{gauge.label}</p>
        <p className="truncate text-[11px] text-zinc-500" title={gauge.hint}>
          {gauge.hint}
        </p>
      </div>
    </div>
  );
}

/* --------------------------- engagement columns ---------------------------- */

function TopRow({
  id,
  title,
  thumbnail,
  type,
  trailing,
  trailingClass,
}: {
  id: number;
  title: string;
  thumbnail: string | null;
  type?: string;
  trailing: React.ReactNode;
  trailingClass?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => navigate(`/content/${id}`)}
      className="flex w-full items-center gap-2.5 rounded-lg border border-transparent bg-black/30 px-2.5 py-2 text-left transition hover:border-rose-500/30 hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60"
    >
      <span className="h-10 w-7 shrink-0 overflow-hidden rounded border border-white/10 bg-black/40">
        {thumbnail ? <img src={thumbnail} alt="" loading="lazy" className="h-full w-full object-cover" /> : null}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-semibold text-zinc-200">{title}</span>
        {type ? (
          <span className="mt-0.5 block text-[10px] uppercase tracking-wider text-zinc-500">{type}</span>
        ) : null}
      </span>
      <span className={cn('shrink-0 text-xs font-bold', trailingClass ?? 'text-zinc-400')}>{trailing}</span>
    </button>
  );
}

function EngagementColumn({
  title,
  icon: Icon,
  accent,
  children,
}: {
  title: string;
  icon: typeof Flame;
  accent: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0 space-y-2.5">
      <p className={cn('flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider', accent)}>
        <Icon className="h-3.5 w-3.5" aria-hidden />
        {title}
      </p>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

/* --------------------------------- feed row -------------------------------- */

function FeedRow({ item }: { item: HubContentRow }) {
  const rating = typeof item.metadata?.rating === 'number' ? item.metadata.rating : null;
  return (
    <button
      type="button"
      onClick={() => navigate(`/content/${item.id}`)}
      className="group flex w-full items-center gap-2.5 rounded-lg border border-transparent bg-black/30 px-2.5 py-2 text-left transition hover:border-rose-500/30 hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60"
    >
      <span className="h-12 w-8 shrink-0 overflow-hidden rounded border border-white/10 bg-black/40">
        {item.thumbnail ? <img src={item.thumbnail} alt="" loading="lazy" className="h-full w-full object-cover" /> : null}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-semibold text-zinc-200 transition group-hover:text-rose-300">
          {item.title}
        </span>
        <span className="mt-0.5 flex items-center gap-1.5">
          <TypeBadge type={item.type} />
          {rating != null ? (
            <span className="inline-flex items-center gap-0.5 text-[10px] font-bold text-amber-300">
              <Star className="h-3 w-3 fill-amber-300" aria-hidden />
              {rating.toFixed(1)}
            </span>
          ) : null}
        </span>
      </span>
    </button>
  );
}

const FEED_ICONS: Record<string, typeof Sparkles> = {
  recent: Sparkles,
  popular: Flame,
  rated: Star,
};

/* ---------------------------------- view ---------------------------------- */

interface StatsBundle {
  stats: HubStatsResponse;
  scale: HubScaleResponse;
  feed: HubFeedResponse;
}

export function StatsView() {
  const bundle = useApi('faza21-stats', () =>
    Promise.all([api.hubStats(), api.hubScale(), api.hubFeed()]).then(
      ([stats, scale, feed]): StatsBundle => ({ stats, scale, feed }),
    ),
  );

  if (bundle.error && !bundle.loading && !bundle.data) {
    return (
      <Container className="py-10">
        <PageHeader title="Statistici Platformă" subtitle="Numerele reale ale platformei, live din Neon." />
        <div className="mt-6">
          <ErrorState message={bundle.error} onRetry={() => void bundle.refetch()} />
        </div>
      </Container>
    );
  }

  const data = bundle.data;
  const gauges = data ? gaugeDefs(data.stats) : [];
  const feedSources = data?.feed.sources ?? [];
  const maxFeedItems = 6;

  return (
    <Container className="space-y-8 py-8 sm:py-10">
      <PageHeader
        title="Statistici Platformă"
        subtitle="Totaluri, angajament și activitate recentă — 100% agregări SQL reale peste Neon."
      >
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Badge className="border-rose-500/30 bg-rose-500/15 text-rose-300 hover:bg-rose-500/15">
            <Activity className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            LIVE · public
          </Badge>
          {data ? (
            <span className="text-[11px] text-zinc-500">
              generate la {formatGeneratedAt(data.stats.generatedAt)}
            </span>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void bundle.refetch()}
            disabled={bundle.loading}
            className="h-8 border-white/15 bg-white/5 text-zinc-200 hover:bg-white/10 hover:text-white"
          >
            <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', bundle.loading && 'animate-spin')} aria-hidden />
            Reîmprospătează
          </Button>
        </div>
      </PageHeader>

      {/* ------------------------ rând de 6 gauge-uri ------------------------ */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6" aria-label="Totaluri platformă">
        {data
          ? gauges.map((g) => <GaugeCard key={g.label} gauge={g} />)
          : Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-40 animate-pulse rounded-2xl border border-white/10 bg-white/[0.03]" />
            ))}
      </div>

      {/* --------------------------- angajament --------------------------- */}
      <Section
        title="Angajament"
        subtitle="Topuri reale calculate din watchhistory, rating-urile din metadata și aprecierile din social."
      >
        {data ? (
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 sm:p-5">
            <div className="grid gap-6 lg:grid-cols-3">
              <EngagementColumn title="Cele mai vizionate" icon={Play} accent="text-rose-300">
                {data.stats.engagement.topWatched.length === 0 ? (
                  <p className="text-xs text-zinc-500">Nicio vizionare înregistrată.</p>
                ) : (
                  data.stats.engagement.topWatched.map((row) => (
                    <TopRow
                      key={row.id}
                      id={row.id}
                      title={row.title}
                      thumbnail={row.thumbnail}
                      type={row.type}
                      trailing={`${formatCount(row.count)} ${row.count === 1 ? 'vizionare' : 'vizionări'}`}
                      trailingClass="text-rose-300"
                    />
                  ))
                )}
              </EngagementColumn>
              <EngagementColumn title="Cel mai bine notate" icon={Star} accent="text-amber-300">
                {data.stats.engagement.topRated.length === 0 ? (
                  <p className="text-xs text-zinc-500">Niciun rating în metadata.</p>
                ) : (
                  data.stats.engagement.topRated.map((row) => (
                    <TopRow
                      key={row.id}
                      id={row.id}
                      title={row.title}
                      thumbnail={row.thumbnail}
                      type={row.type}
                      trailing={
                        <span className="inline-flex items-center gap-1">
                          <Star className="h-3 w-3 fill-amber-300 text-amber-300" aria-hidden />
                          {row.rating.toFixed(1)}
                        </span>
                      }
                      trailingClass="text-amber-300"
                    />
                  ))
                )}
              </EngagementColumn>
              <EngagementColumn title="Cele mai apreciate" icon={Heart} accent="text-fuchsia-300">
                {data.stats.engagement.mostLiked.length === 0 ? (
                  <p className="text-xs text-zinc-500">Niciun like înregistrat.</p>
                ) : (
                  data.stats.engagement.mostLiked.map((row) => (
                    <TopRow
                      key={row.id}
                      id={row.id}
                      title={row.title}
                      thumbnail={row.thumbnail}
                      type={row.type}
                      trailing={
                        <span className="inline-flex items-center gap-1">
                          <Heart className="h-3 w-3 fill-fuchsia-300 text-fuchsia-300" aria-hidden />
                          {formatCount(row.count)}
                        </span>
                      }
                      trailingClass="text-fuchsia-300"
                    />
                  ))
                )}
              </EngagementColumn>
            </div>
          </div>
        ) : (
          <div className="h-48 animate-pulse rounded-2xl border border-white/10 bg-white/[0.03]" />
        )}
      </Section>

      {/* ------------------ real vs. capacitate logică 30B ------------------ */}
      <Section
        title="Date reale vs. capacitate logică"
        subtitle="Raportarea oneastă FAZA 20: ce e real și ce e simulat, fără cosmetizare."
      >
        {data ? (
          <div className="grid gap-3 lg:grid-cols-3">
            <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/[0.06] p-4 sm:p-5">
              <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-emerald-300">
                <Database className="h-3.5 w-3.5" aria-hidden />
                Date reale (Neon)
              </p>
              <p className="mt-2 text-3xl font-black text-white">
                {formatCount(data.scale.real.contentItems)}
              </p>
              <p className="text-xs text-zinc-400">contenturi reale stocate în Neon</p>
              <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
                {formatCount(data.scale.real.searchDocs)} documente FTS · {formatCount(data.scale.real.vectorEmbeddings)}{' '}
                embedding-uri vectoriale · {formatCount(data.scale.real.users)} utilizatori
              </p>
            </div>
            <div className="rounded-2xl border border-amber-500/25 bg-amber-500/[0.06] p-4 sm:p-5">
              <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-amber-300">
                <BarChart3 className="h-3.5 w-3.5" aria-hidden />
                Capacitate logică (simulată)
              </p>
              <p className="mt-2 text-3xl font-black text-white">
                {formatCapacity(data.scale.view.capacityClaim)}
              </p>
              <p className="text-xs text-zinc-400">spațiu logic de adrese simulat</p>
              <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
                {formatCount(data.scale.real.shards)} shard-uri logice × 1 miliard ID-uri · modul{' '}
                {data.scale.real.shardMode} (un singur branch Neon)
              </p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 sm:p-5">
              <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-400">
                <Eye className="h-3.5 w-3.5" aria-hidden />
                Ce înseamnă asta
              </p>
              <p className="mt-2 text-xs leading-relaxed text-zinc-300">
                Datele reale ale platformei sunt cele listate în gauge-urile de mai sus — salvate și agregate 100% în
                Neon. Spațiul de {formatCapacity(data.scale.view.capacityClaim)} este o{' '}
                <span className="font-bold text-amber-300">capacitate logică simulată</span> (FAZA 14): feed-ul global
                „umple" virtual cele 30 de shard-uri, fără ca rândurile să existe fizic.
              </p>
              <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
                Playerul extern rămâne real ({data.scale.player.allowedTypes.join(' · ')}) iar căutarea folosește
                motorul {data.scale.search.engine}
                {data.scale.search.pipelineIntegrated ? ' cu pipeline complet integrat' : ''}.
              </p>
            </div>
          </div>
        ) : (
          <div className="h-40 animate-pulse rounded-2xl border border-white/10 bg-white/[0.03]" />
        )}
      </Section>

      {/* -------------------------- ultimele 7 zile -------------------------- */}
      <Section title="Ultimele 7 zile" subtitle="Activitate recentă, calculată live.">
        {data ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 sm:p-5">
              <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-500">
                <Clapperboard className="h-3.5 w-3.5" aria-hidden />
                Conținut adăugat
              </p>
              <p className="mt-1.5 text-3xl font-black text-white">
                {formatCount(data.stats.recency.contentAddedLast7d)}
              </p>
              <p className="text-[11px] text-zinc-500">titluri noi în Neon în ultimele 7 zile</p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 sm:p-5">
              <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-500">
                <Users className="h-3.5 w-3.5" aria-hidden />
                Utilizatori activi
              </p>
              <p className="mt-1.5 text-3xl font-black text-white">
                {formatCount(data.stats.recency.activeUsersLast7d)}
              </p>
              <p className="text-[11px] text-zinc-500">cu cel puțin o vizionare în ultimele 7 zile</p>
            </div>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="h-32 animate-pulse rounded-2xl border border-white/10 bg-white/[0.03]" />
            ))}
          </div>
        )}
      </Section>

      {/* ----------------------- ce e nou pe platformă ----------------------- */}
      <Section
        title="Ce e nou pe platformă"
        subtitle="Trei rafturi live din /api/hub/feed — apasă pe orice titlu pentru detalii."
      >
        {feedSources.length === 0 && !bundle.loading ? (
          <EmptyState title="Feed indisponibil" message="Hub-ul de feed nu a returnat surse — încearcă din nou." />
        ) : (
          <div className="grid gap-6 lg:grid-cols-3">
            {(feedSources.length > 0
              ? feedSources
              : [
                  { id: 'recent', label: 'Adăugate recent', data: [] },
                  { id: 'popular', label: 'Cele mai vizionate', data: [] },
                  { id: 'rated', label: 'Cel mai bine notate', data: [] },
                ]
            ).map((source) => {
              const Icon = FEED_ICONS[source.id] ?? Sparkles;
              return (
                <div key={source.id} className="min-w-0 space-y-2.5">
                  <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-400">
                    <Icon className="h-3.5 w-3.5 text-rose-300" aria-hidden />
                    {source.label}
                  </p>
                  <div className="space-y-1.5">
                    {source.data.length === 0 && bundle.loading
                      ? Array.from({ length: 4 }).map((_, i) => (
                          <Skeleton key={i} className="h-14 w-full rounded-lg" />
                        ))
                      : source.data.slice(0, maxFeedItems).map((item) => <FeedRow key={item.id} item={item} />)}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Section>

      {/* ------------------------------- footer ------------------------------- */}
      <p className="border-t border-white/10 pt-4 text-center text-[11px] text-zinc-500">
        Date live din Neon · generate la {data ? formatGeneratedAt(data.stats.generatedAt) : '…'} · hub FAZA 20
        (/api/hub/stats · /api/hub/scale · /api/hub/feed)
      </p>
    </Container>
  );
}
