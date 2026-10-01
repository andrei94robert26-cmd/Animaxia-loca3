'use client';

/**
 * category-view.tsx — Browse by category. DB-backed categories render a live
 * provider strip plus a paginated library grid; the sports category is a
 * football + Formula 1 hub. Sidebar categories added by the platform menu
 * (Copii & Desene, Universuri, Canale Kids, Lumea…) are virtual views
 * filtered client-side over the Neon library, plus dedicated panels for
 * Lista Mea, Colecțiile Mele and Gestionare & Duplicate.
 *
 * NOTE (curățare utilizator): secțiunile Muzică, Documentare, Gaming, Știri,
 * Radio Live, Divertisment, Show-biz, Reality TV și Emisiuni TV au fost
 * eliminate complet din platformă, la cererea explicită a utilizatorului.
 */

import { useMemo, useRef, useState } from 'react';
import { Pickaxe, Plus, Zap } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, animeToItem, dbToItem, mediaToItem } from '@/lib/animaxia/api';
import { useApi, type UseApiResult } from '@/lib/animaxia/hooks';
import { SPECIAL_CATEGORIES, VIRTUAL_CATEGORIES } from '@/lib/animaxia/menu';
import { navigate, type AppRoute } from '@/lib/animaxia/router';
import type {
  FootballMatch,
  FootballTableEntry,
  F1Race,
  F1Standing,
  NormalizedItem,
} from '@/lib/animaxia/types';
import { cn } from '@/lib/utils';
import { CollectionsPanel, ManagePanel, MyListPanel } from '../category-panels';
import { ContentGrid } from '../content-grid';
import { ContentRow } from '../content-row';
import { AddContentDialog } from '../home-panels';
import { Pagination } from '../pagination';
import { Container, PageHeader, Section } from '../section';
import { EmptyState, ErrorState } from '../states';

/* ------------------------------- constants ------------------------------- */

const CATEGORY_META: Record<string, { title: string; subtitle: string }> = {
  all: { title: 'Toate titlurile', subtitle: 'Tot ce există în biblioteca ta Animaxia — filme, seriale, anime și multe altele.' },
  movie: { title: 'Filme', subtitle: 'Filmele din colecția ta, plus ce e în tendințe pe TMDB chiar acum.' },
  tv: { title: 'Seriale', subtitle: 'Serialele din colecția ta, plus producții populare de pe TMDB.' },
  anime: { title: 'Anime', subtitle: 'Colecția ta de anime, plus ce se difuzează în sezonul acesta.' },
  sports: { title: 'Sport', subtitle: 'Clasamente și meciuri de fotbal, plus sezonul de Formula 1 dintr-o privire.' },
  mined: { title: 'Minate', subtitle: 'Tot ce a extras Minerul Animaxia din URL-uri de stream.' },
  featured: { title: 'Recomandate', subtitle: 'Repere alese de echipa Animaxia.' },
  'my-list': { title: 'Lista Mea', subtitle: 'Favoritele tale, salvate în Neon și sincronizate pe toate dispozitivele.' },
  'my-collections': { title: 'Colecțiile Mele', subtitle: 'Organizează-ți biblioteca în colecții tematice — maratoane gata de pornit.' },
  manage: { title: 'Gestionare & Duplicate', subtitle: 'Panoul de administrare a bibliotecii — detectare duplicate și curățare.' },
};

const COMPETITIONS: { code: string; name: string }[] = [
  { code: 'PL', name: 'Premier League' },
  { code: 'BL1', name: 'Bundesliga' },
  { code: 'PD', name: 'La Liga' },
  { code: 'SA', name: 'Serie A' },
  { code: 'FL1', name: 'Ligue 1' },
  { code: 'CL', name: 'Champions League' },
  { code: 'WC', name: 'World Cup' },
];

const MATCH_STATUS: Record<string, { label: string; className: string }> = {
  FINISHED: { label: 'Finalizat', className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' },
  IN_PLAY: { label: 'Live', className: 'border-rose-500/40 bg-rose-500/15 text-rose-300' },
  PAUSED: { label: 'Live', className: 'border-rose-500/40 bg-rose-500/15 text-rose-300' },
  TIMED: { label: 'Programat', className: 'border-white/10 bg-white/5 text-zinc-400' },
  SCHEDULED: { label: 'Programat', className: 'border-white/10 bg-white/5 text-zinc-400' },
  POSTPONED: { label: 'Amânat', className: 'border-amber-500/30 bg-amber-500/10 text-amber-300' },
  SUSPENDED: { label: 'Suspendat', className: 'border-amber-500/30 bg-amber-500/10 text-amber-300' },
  CANCELLED: { label: 'Anulat', className: 'border-white/10 bg-white/5 text-zinc-400' },
};

function capitalize(raw: string): string {
  return raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : 'Categorie';
}

/* --------------------------------- view ---------------------------------- */

export function CategoryView({ route }: { route: AppRoute }) {
  const type = route.params[0] || 'all';

  /* Reset pagination whenever the category changes (adjust during render). */
  const [page, setPage] = useState(1);
  const [lastType, setLastType] = useState(type);
  if (lastType !== type) {
    setLastType(type);
    setPage(1);
  }

  const [sportTab, setSportTab] = useState<'football' | 'f1'>('football');
  const [competition, setCompetition] = useState('PL');
  const [addOpen, setAddOpen] = useState(false);

  const isSports = type === 'sports';
  const isSpecial = SPECIAL_CATEGORIES.has(type);
  const virtual = VIRTUAL_CATEGORIES[type];
  const isLive = Boolean(virtual?.live) && !isSpecial;
  const isVirtual = Boolean(virtual) && !isSpecial;
  const isGrid = !isSports && !isSpecial && !isVirtual;
  const hasStrip = type === 'movie' || type === 'tv' || type === 'anime';

  const meta =
    CATEGORY_META[type] ??
    (virtual
      ? { title: virtual.title, subtitle: virtual.subtitle }
      : {
          title: capitalize(type),
          subtitle: 'Răsfoiește toate titlurile pe care Animaxia le-a clasat în această categorie.',
        });

  const listRes = useApi(
    `cat-${type}-${page}`,
    () => api.all({ type: type === 'all' ? undefined : type, page, limit: 24 }),
    { enabled: isGrid },
  );

  /* Virtual sidebar categories: one full-catalog fetch + client-side filter. */
  const virtualRes = useApi(`cat-virtual-${type}`, () => api.all({ limit: 100 }), { enabled: isVirtual });
  const virtualItems = useMemo<NormalizedItem[]>(() => {
    if (!virtual || !virtualRes.data) return [];
    const rows = virtualRes.data.data.filter(virtual.filter);
    const sorted = virtual.sort ? [...rows].sort(virtual.sort) : rows;
    return sorted.map(dbToItem);
  }, [virtual, virtualRes.data]);

  /* FAZA 14: live category feeds (real TMDB discover) for every sidebar menu. */
  const liveRes = useApi(`cat-live-${type}-${page}`, () => api.discover(type, page), { enabled: isLive });
  const liveItems = useMemo<NormalizedItem[]>(() => {
    if (!liveRes.data) return [];
    return liveRes.data.data.map(mediaToItem);
  }, [liveRes.data]);

  const stripRes = useApi(
    `cat-strip-${type}`,
    async (): Promise<NormalizedItem[]> => {
      if (type === 'movie') return (await api.moviesTrending('day')).data.map(mediaToItem);
      if (type === 'tv') return (await api.tvPopular()).data.map(mediaToItem);
      return (await api.animeSeason()).data.map(animeToItem);
    },
    { enabled: hasStrip },
  );

  const standingsRes = useApi(`fb-standings-${competition}`, () => api.footballStandings(competition), {
    enabled: isSports,
  });
  const matchesRes = useApi(`fb-matches-${competition}`, () => api.footballMatches(competition, 10), {
    enabled: isSports,
  });
  const f1StandingsRes = useApi('f1-standings', () => api.f1Standings(), {
    enabled: isSports && sportTab === 'f1',
  });
  const f1ScheduleRes = useApi('f1-schedule', () => api.f1Schedule(), {
    enabled: isSports && sportTab === 'f1',
  });

  const items = useMemo(() => (listRes.data?.data ?? []).map(dbToItem), [listRes.data]);
  const gridRef = useRef<HTMLDivElement>(null);

  const stripMeta =
    type === 'movie'
      ? { title: 'În tendințe pe TMDB', subtitle: 'Cele mai vizionate filme de azi, la nivel mondial' }
      : type === 'tv'
        ? { title: 'Populare pe TMDB', subtitle: 'Serialele pe care lumea nu se poate opri să le vizioneze' }
        : { title: 'În difuzare acest sezon', subtitle: 'Difuzate curent în Japonia' };

  const goToPage = (next: number) => {
    setPage(next);
    gridRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <Container className="space-y-8 py-8 sm:py-10">
      <PageHeader title={meta.title} subtitle={meta.subtitle}>
        {isGrid && !listRes.loading && listRes.data && (
          <p className="text-sm font-medium text-zinc-500">
            Afișez {listRes.data.data.length} din {listRes.data.total}{' '}
            {listRes.data.total === 1 ? 'titlu' : 'titluri'}
          </p>
        )}
        {isLive && virtual?.liveSource && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-rose-500/30 bg-rose-600/10 px-3 py-1 text-xs font-bold text-rose-200">
            <Zap className="h-3 w-3" aria-hidden />
            LIVE · {virtual.liveSource}
          </span>
        )}
      </PageHeader>

      {isGrid && (
        <>
          {type === 'mined' && (
            <Alert className="border-rose-500/20 bg-rose-500/5">
              <Pickaxe className="h-4 w-4 text-rose-400" aria-hidden />
              <AlertTitle className="text-zinc-100">Extraase de Minerul Animaxia</AlertTitle>
              <AlertDescription className="text-zinc-400">
                <span>
                  Titlurile minate sunt extrase de Minerul Animaxia din orice URL — deschide panoul
                  de administrare pentru a extrage un stream nou.
                </span>
                <Button
                  size="sm"
                  onClick={() => navigate('/admin')}
                  className="mt-2 bg-rose-600 font-semibold text-white hover:bg-rose-500"
                >
                  Deschide panoul Admin
                </Button>
              </AlertDescription>
            </Alert>
          )}

          {hasStrip &&
            (stripRes.error && !stripRes.loading && !stripRes.data ? (
              <ErrorState message={stripRes.error} onRetry={stripRes.refetch} compact />
            ) : (
              <ContentRow
                title={stripMeta.title}
                subtitle={stripMeta.subtitle}
                items={stripRes.data ?? []}
                loading={stripRes.loading}
                emptyMessage="Datele furnizorului live sunt momentan indisponibile."
              />
            ))}

          <div ref={gridRef} className="scroll-mt-24 space-y-6">
            {listRes.error && !listRes.loading && !listRes.data ? (
              <ErrorState message={listRes.error} onRetry={listRes.refetch} />
            ) : (
              <ContentGrid
                items={items}
                loading={listRes.loading}
                skeletonCount={12}
                emptyTitle={type === 'all' ? 'Biblioteca ta e goală' : `Încă nimic în ${meta.title}`}
                emptyMessage="Nimic nu a fost adăugat încă în această categorie — adaugă titluri din orice pagină de detalii."
              />
            )}
            <Pagination page={page} totalPages={listRes.data?.totalPages ?? 1} onPage={goToPage} />
          </div>
        </>
      )}

      {isSpecial && (
        <>
          {type === 'my-list' && <MyListPanel />}
          {type === 'my-collections' && <CollectionsPanel />}
          {type === 'manage' && <ManagePanel />}
        </>
      )}

      {isVirtual && !isLive && (
        <>
          {virtualRes.error && !virtualRes.loading && !virtualRes.data ? (
            <ErrorState message={virtualRes.error} onRetry={virtualRes.refetch} />
          ) : (
            <ContentGrid
              items={virtualItems}
              loading={virtualRes.loading}
              skeletonCount={9}
              emptyTitle={`Încă nimic în ${meta.title}`}
              emptyMessage={
                virtual?.emptyHint ??
                'Această categorie se umple automat cu tot ce încarci tu — adaugă conținut din orice sursă.'
              }
              emptyAction={
                <Button onClick={() => setAddOpen(true)} className="mt-4 bg-rose-600 font-bold hover:bg-rose-500">
                  <Plus className="mr-1.5 h-4 w-4" aria-hidden />
                  Adaugă conținut
                </Button>
              }
            />
          )}
          {!virtualRes.loading && virtualItems.length > 0 && (
            <p className="text-sm font-medium text-zinc-500">
              {virtualItems.length} {virtualItems.length === 1 ? 'titlu' : 'titluri'} în {meta.title}
            </p>
          )}
        </>
      )}

      {isLive && (
        <>
          {/* Titles already in the Neon library that match this category */}
          {!virtualRes.loading && virtualItems.length > 0 && (
            <ContentRow
              title="În biblioteca ta"
              subtitle={`${virtualItems.length} ${virtualItems.length === 1 ? 'titlu' : 'titluri'} salvate în Neon apar și aici`}
              items={virtualItems}
              emptyMessage=""
            />
          )}

          {/* Live TMDB feed */}
          <div ref={gridRef} className="scroll-mt-24 space-y-6">
            {liveRes.error && !liveRes.loading && !liveRes.data ? (
              <ErrorState message={liveRes.error} onRetry={liveRes.refetch} />
            ) : (
              <ContentGrid
                items={liveItems}
                loading={liveRes.loading && !liveRes.data}
                skeletonCount={12}
                emptyTitle="Feed-ul live nu a returnat nimic"
                emptyMessage="Sursa live este momentan indisponibilă — încearcă din nou sau adaugă conținut propriu."
                emptyAction={
                  <Button onClick={() => setAddOpen(true)} className="mt-4 bg-rose-600 font-bold hover:bg-rose-500">
                    <Plus className="mr-1.5 h-4 w-4" aria-hidden />
                    Adaugă conținut
                  </Button>
                }
              />
            )}
            <div className="flex items-center justify-between gap-4">
              {liveRes.data && liveRes.data.total > 0 && (
                <p className="text-sm font-medium text-zinc-500">
                  {liveRes.data.total.toLocaleString('ro-RO')}{' '}
                  {liveRes.data.total === 1 ? 'titlu' : 'titluri'} în feed-ul live
                  {liveRes.data.legsOk < liveRes.data.legs && (
                    <span className="text-amber-400"> · {liveRes.data.legsOk}/{liveRes.data.legs} surse active</span>
                  )}
                </p>
              )}
            </div>
            <Pagination page={page} totalPages={Math.min(liveRes.data?.totalPages ?? 1, 50)} onPage={goToPage} />
          </div>
        </>
      )}

      <AddContentDialog open={addOpen} onOpenChange={setAddOpen} />

      {isSports && (
        <Tabs defaultValue="football" onValueChange={(value) => setSportTab(value as 'football' | 'f1')}>
          <TabsList className="h-10 w-full justify-start gap-1 rounded-xl border border-white/10 bg-white/[0.03] p-1 sm:w-auto">
            <TabsTrigger
              value="football"
              className="px-4 text-zinc-400 hover:text-zinc-100 data-[state=active]:bg-rose-600 data-[state=active]:text-white data-[state=active]:shadow-rose-900/40 sm:px-5"
            >
              Fotbal
            </TabsTrigger>
            <TabsTrigger
              value="f1"
              className="px-4 text-zinc-400 hover:text-zinc-100 data-[state=active]:bg-rose-600 data-[state=active]:text-white data-[state=active]:shadow-rose-900/40 sm:px-5"
            >
              Formula 1
            </TabsTrigger>
          </TabsList>
          <TabsContent value="football" className="pt-6">
            <FootballPanel
              competition={competition}
              onCompetition={setCompetition}
              standingsRes={standingsRes}
              matchesRes={matchesRes}
            />
          </TabsContent>
          <TabsContent value="f1" className="pt-6">
            <F1Panel standingsRes={f1StandingsRes} scheduleRes={f1ScheduleRes} />
          </TabsContent>
        </Tabs>
      )}
    </Container>
  );
}

/* ---------------------------- football panel ----------------------------- */

function FootballPanel({
  competition,
  onCompetition,
  standingsRes,
  matchesRes,
}: {
  competition: string;
  onCompetition: (code: string) => void;
  standingsRes: UseApiResult<{ data: { competition: string; table: FootballTableEntry[] } }>;
  matchesRes: UseApiResult<{ data: FootballMatch[] }>;
}) {
  const competitionName = COMPETITIONS.find((c) => c.code === competition)?.name ?? competition;
  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <h2 className="text-lg font-bold text-zinc-100">Competiție</h2>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filtru competiție">
          {COMPETITIONS.map((c) => (
            <FilterChip key={c.code} active={competition === c.code} onClick={() => onCompetition(c.code)}>
              {c.name}
            </FilterChip>
          ))}
        </div>
      </div>

      <Section title="Clasament" subtitle={`Clasamentul curent — ${competitionName}`}>
        {standingsRes.loading ? (
          <Skeleton className="h-80 w-full rounded-xl" />
        ) : standingsRes.error ? (
          <ErrorState message={standingsRes.error} onRetry={standingsRes.refetch} compact />
        ) : !standingsRes.data || standingsRes.data.data.table.length === 0 ? (
          <EmptyState title="Clasament indisponibil" message="Această competiție nu are momentan date de clasament." />
        ) : (
          <StandingsTable entries={standingsRes.data.data.table} />
        )}
      </Section>

      <Section title="Meciuri & rezultate" subtitle="Meciuri viitoare și scoruri recente">
        {matchesRes.loading ? (
          <Skeleton className="h-72 w-full rounded-xl" />
        ) : matchesRes.error ? (
          <ErrorState message={matchesRes.error} onRetry={matchesRes.refetch} compact />
        ) : !matchesRes.data || matchesRes.data.data.length === 0 ? (
          <EmptyState title="Niciun meci programat" message="Nu există meciuri viitoare pentru această competiție." />
        ) : (
          <div className="overflow-hidden rounded-xl border border-white/10 bg-white/[0.02]">
            <div className="divide-y divide-white/5">
              {matchesRes.data.data.map((match) => (
                <MatchRow key={match.id} match={match} />
              ))}
            </div>
          </div>
        )}
      </Section>
    </div>
  );
}

function StandingsTable({ entries }: { entries: FootballTableEntry[] }) {
  return (
    <div className="custom-scrollbar overflow-x-auto rounded-xl border border-white/10 bg-white/[0.02]">
      <Table className="min-w-[620px]">
        <TableHeader>
          <TableRow className="border-white/10 hover:bg-transparent">
            <TableHead className="w-12 text-center text-xs font-semibold uppercase tracking-wider text-zinc-500">#</TableHead>
            <TableHead className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Echipă</TableHead>
            <TableHead className="text-center text-xs font-semibold uppercase tracking-wider text-zinc-500">J</TableHead>
            <TableHead className="text-center text-xs font-semibold uppercase tracking-wider text-zinc-500">V</TableHead>
            <TableHead className="text-center text-xs font-semibold uppercase tracking-wider text-zinc-500">E</TableHead>
            <TableHead className="text-center text-xs font-semibold uppercase tracking-wider text-zinc-500">Î</TableHead>
            <TableHead className="text-center text-xs font-semibold uppercase tracking-wider text-zinc-500">±</TableHead>
            <TableHead className="text-center text-xs font-semibold uppercase tracking-wider text-zinc-500">Pct</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.map((entry) => (
            <TableRow key={entry.team} className="border-white/5 hover:bg-white/5">
              <TableCell
                className={cn(
                  'text-center font-bold tabular-nums',
                  entry.rank <= 4 ? 'text-emerald-400' : 'text-zinc-500',
                )}
              >
                {entry.rank}
              </TableCell>
              <TableCell className="font-medium text-zinc-100">
                <span className="flex items-center gap-2.5">
                  {entry.teamCrest ? (
                    <img
                      src={entry.teamCrest}
                      alt=""
                      aria-hidden
                      loading="lazy"
                      className="h-5 w-5 shrink-0 object-contain"
                    />
                  ) : null}
                  <span className="truncate">{entry.team}</span>
                </span>
              </TableCell>
              <TableCell className="text-center tabular-nums text-zinc-300">{entry.played}</TableCell>
              <TableCell className="text-center tabular-nums text-zinc-300">{entry.won}</TableCell>
              <TableCell className="text-center tabular-nums text-zinc-300">{entry.draw}</TableCell>
              <TableCell className="text-center tabular-nums text-zinc-300">{entry.lost}</TableCell>
              <TableCell className="text-center tabular-nums text-zinc-400">
                {entry.goalDifference > 0 ? `+${entry.goalDifference}` : entry.goalDifference}
              </TableCell>
              <TableCell className="text-center font-bold tabular-nums text-white">{entry.points}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function MatchRow({ match }: { match: FootballMatch }) {
  const finished =
    match.status === 'FINISHED' && match.score.home != null && match.score.away != null;
  const date = new Date(match.utcDate);
  const dateLabel = date.toLocaleDateString('ro-RO', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
  const timeLabel = date.toLocaleTimeString('ro-RO', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  });
  return (
    <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="grid min-w-0 flex-1 grid-cols-[1fr_auto_1fr] items-center gap-3">
        <div className="flex min-w-0 items-center justify-end gap-2">
          <span className="truncate text-right text-sm font-medium text-zinc-200">{match.home}</span>
          {match.homeCrest ? (
            <img src={match.homeCrest} alt="" aria-hidden loading="lazy" className="h-6 w-6 shrink-0 object-contain" />
          ) : null}
        </div>
        <div className="w-14 text-center text-sm font-bold">
          {finished ? (
            <span className="text-emerald-400">
              {match.score.home} – {match.score.away}
            </span>
          ) : (
            <span className="text-zinc-500">vs</span>
          )}
        </div>
        <div className="flex min-w-0 items-center gap-2">
          {match.awayCrest ? (
            <img src={match.awayCrest} alt="" aria-hidden loading="lazy" className="h-6 w-6 shrink-0 object-contain" />
          ) : null}
          <span className="truncate text-sm font-medium text-zinc-200">{match.away}</span>
        </div>
      </div>
      <div className="flex items-center gap-3 sm:flex-col sm:items-end sm:gap-1">
        <span className="text-xs text-zinc-500">
          {dateLabel} · {timeLabel} UTC
        </span>
        <StatusBadge status={match.status} />
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const meta = MATCH_STATUS[status] ?? { label: status, className: 'border-white/10 bg-white/5 text-zinc-400' };
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
        meta.className,
      )}
    >
      {meta.label}
    </span>
  );
}

/* ------------------------------- F1 panel -------------------------------- */

function F1Panel({
  standingsRes,
  scheduleRes,
}: {
  standingsRes: UseApiResult<{ data: F1Standing[] }>;
  scheduleRes: UseApiResult<{ data: F1Race[] }>;
}) {
  return (
    <div className="space-y-8">
      <Section title="Clasament piloți" subtitle="Bătălia curentă pentru titlu">
        {standingsRes.loading ? (
          <Skeleton className="h-80 w-full rounded-xl" />
        ) : standingsRes.error ? (
          <ErrorState message={standingsRes.error} onRetry={standingsRes.refetch} compact />
        ) : !standingsRes.data || standingsRes.data.data.length === 0 ? (
          <EmptyState title="Clasament indisponibil" message="Clasamentul piloților nu este disponibil momentan." />
        ) : (
          <div className="custom-scrollbar overflow-x-auto rounded-xl border border-white/10 bg-white/[0.02]">
            <Table className="min-w-[480px]">
              <TableHeader>
                <TableRow className="border-white/10 hover:bg-transparent">
                  <TableHead className="w-12 text-center text-xs font-semibold uppercase tracking-wider text-zinc-500">#</TableHead>
                  <TableHead className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Pilot</TableHead>
                  <TableHead className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Echipă</TableHead>
                  <TableHead className="text-center text-xs font-semibold uppercase tracking-wider text-zinc-500">Victorii</TableHead>
                  <TableHead className="text-center text-xs font-semibold uppercase tracking-wider text-zinc-500">Pct</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {standingsRes.data.data.map((row) => (
                  <TableRow key={row.driver} className="border-white/5 hover:bg-white/5">
                    <TableCell className="text-center font-bold tabular-nums text-zinc-500">{row.position}</TableCell>
                    <TableCell className="font-medium text-zinc-100">{row.driver}</TableCell>
                    <TableCell className="text-zinc-400">{row.team}</TableCell>
                    <TableCell className="text-center tabular-nums text-zinc-300">{row.wins}</TableCell>
                    <TableCell className="text-center font-bold tabular-nums text-white">{row.points}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Section>

      <Section title="Calendar curse" subtitle="Toate rundele sezonului">
        {scheduleRes.loading ? (
          <Skeleton className="h-72 w-full rounded-xl" />
        ) : scheduleRes.error ? (
          <ErrorState message={scheduleRes.error} onRetry={scheduleRes.refetch} compact />
        ) : !scheduleRes.data || scheduleRes.data.data.length === 0 ? (
          <EmptyState title="Nicio cursă programată" message="Calendarul curselor nu este încă disponibil." />
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {scheduleRes.data.data.map((race) => (
              <RaceCard key={`${race.round}-${race.race}`} race={race} />
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

function RaceCard({ race }: { race: F1Race }) {
  const date = new Date(race.date);
  const dateLabel = date.toLocaleDateString('ro-RO', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
  return (
    <div className="flex items-center gap-4 rounded-xl border border-white/10 bg-white/[0.03] p-4 transition hover:border-rose-500/30">
      <span
        aria-label={`Runda ${race.round}`}
        className="grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-rose-500/30 bg-rose-500/15 text-base font-black text-rose-300"
      >
        {race.round}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate font-semibold text-zinc-100">{race.race}</p>
        <p className="mt-0.5 truncate text-xs text-zinc-500">
          {[race.circuit, race.locality, race.country].filter(Boolean).join(' — ')}
        </p>
      </div>
      <div className="shrink-0 text-right">
        <p className="text-sm font-medium text-zinc-300">{dateLabel}</p>
        {race.time ? <p className="text-xs text-zinc-500">{race.time.slice(0, 5)} UTC</p> : null}
      </div>
    </div>
  );
}

/* ------------------------------ shared bits ------------------------------ */

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'rounded-full border px-4 py-2 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60',
        active
          ? 'border-rose-500/60 bg-rose-500/15 text-rose-300'
          : 'border-white/10 bg-white/[0.04] text-zinc-300 hover:border-white/25 hover:text-white',
      )}
    >
      {children}
    </button>
  );
}
