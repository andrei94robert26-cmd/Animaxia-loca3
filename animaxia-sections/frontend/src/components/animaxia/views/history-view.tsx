'use client';

/**
 * history-view.tsx — #/history „Istoricul Meu" (FAZA 21, task 21-1).
 *
 * Auth-only: vizitatorii neconectați primesc un EmptyState cu buton de
 * conectare. Datele sunt 100% reale: ultimele 100 de intrări din
 * /api/users/me/history (watchhistory Neon, unificat cu progresul Player
 * Hub FAZA 19) + api.playerHubStatus() pentru badge-ul de hub.
 *
 * Secțiuni: „Continuă vizionarea" (primele 6 intrări cu progres > 10s,
 * cu butoane Play direct — playerul reia automat din progresul salvat)
 * și grila completă cu tab-uri Toate / Filme / Seriale / Anime (filtrare
 * client-side pe type). Bara de progres e raportată onest la pragul de
 * 1h folosit de player pentru resume (peste 1h = terminat, fără ofertă).
 */

import { useState } from 'react';
import {
  Clock,
  Compass,
  History as HistoryIcon,
  LogIn,
  Play,
  RefreshCw,
} from 'lucide-react';
import { useAuth } from '@/components/animaxia/auth-provider';
import { api } from '@/lib/animaxia/api';
import { useApi } from '@/lib/animaxia/hooks';
import { navigate } from '@/lib/animaxia/router';
import { platform, type HistoryEntry } from '@/lib/animaxia/platform';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { Container, PageHeader, Section } from '../section';
import { EmptyState, ErrorState, TypeBadge } from '../states';

/* ------------------------------- constants -------------------------------- */

const HISTORY_LIMIT = 100;
/** Pragul de la care playerul consideră că ai un punct de resume (aceeași
 *  valoare ca hasResume din /api/playerhub/continue-watching). */
const RESUME_THRESHOLD = 10;
/** Playerul tratează progresul peste 1h ca „terminat" (fără ofertă de
 *  resume) — bara vizuală folosește același tavan, nu o durată inventată. */
const RESUME_BAR_CEILING = 3600;

const HISTORY_TABS = [
  { id: 'all', label: 'Toate', type: null },
  { id: 'movie', label: 'Filme', type: 'movie' },
  { id: 'tv', label: 'Seriale', type: 'tv' },
  { id: 'anime', label: 'Anime', type: 'anime' },
] as const;
type HistoryTabId = (typeof HISTORY_TABS)[number]['id'];

/* ------------------------------- formatting -------------------------------- */

/** Timp relativ în română: „chiar acum" / „acum 12 min" / „acum 3 ore"… */
function relativeTimeRo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return '—';
  const diff = Math.max(0, Date.now() - time);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'chiar acum';
  if (mins < 60) return `acum ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `acum ${hours} ${hours === 1 ? 'oră' : 'ore'}`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `acum ${days} ${days === 1 ? 'zi' : 'zile'}`;
  const months = Math.floor(days / 30);
  if (months < 12) return `acum ${months} ${months === 1 ? 'lună' : 'luni'}`;
  const years = Math.floor(months / 12);
  return `acum ${years} ${years === 1 ? 'an' : 'ani'}`;
}

/** Progresul salvat, fără durată cunoscută: „~m:ss". */
function formatWatched(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Umplerea barei vizuale (0-100%), raportată la tavanul de resume 1h. */
function barFill(progress: number): number {
  if (progress <= 0) return 0;
  return Math.min(100, Math.round((progress / RESUME_BAR_CEILING) * 100));
}

/* ------------------------------ history cards ------------------------------ */

/** Card compact pentru „Continuă vizionarea" — rând cu thumbnail, progres
 *  și buton Play direct (playerul reia automat din progresul salvat). */
function ContinueCard({ entry }: { entry: HistoryEntry }) {
  const content = entry.content;
  const fill = barFill(entry.progress);
  return (
    <div className="group flex min-w-0 items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-3 transition hover:border-rose-500/30">
      <button
        type="button"
        onClick={() => navigate(`/player/${content.id}`)}
        aria-label={`Redă ${content.title}`}
        className="relative h-20 w-14 shrink-0 overflow-hidden rounded-lg border border-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60"
      >
        {content.thumbnail ? (
          <img src={content.thumbnail} alt="" loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <span className="grid h-full w-full place-items-center bg-gradient-to-br from-white/[0.08] to-white/[0.02] text-zinc-600">
            <Play className="h-5 w-5" aria-hidden />
          </span>
        )}
        <span
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-1 bg-black/60"
        >
          <span className="block h-full bg-rose-500" style={{ width: `${fill}%` }} />
        </span>
      </button>
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={() => navigate(`/player/${content.id}`)}
          className="block max-w-full truncate text-left text-sm font-bold text-zinc-100 transition hover:text-rose-300"
        >
          {content.title}
        </button>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-zinc-500">
          <span className="inline-flex items-center gap-1">
            <Clock className="h-3 w-3" aria-hidden />~{formatWatched(entry.progress)} vizionate
          </span>
          <span>· {relativeTimeRo(entry.watchedat)}</span>
        </p>
      </div>
      <Button
        size="sm"
        onClick={() => navigate(`/player/${content.id}`)}
        aria-label={`Continuă ${content.title}`}
        className="h-9 shrink-0 bg-rose-600 font-bold text-white hover:bg-rose-500"
      >
        <Play className="h-3.5 w-3.5 fill-white" aria-hidden />
        Play
      </Button>
    </div>
  );
}

/** Card de grilă pentru istoricul complet — click pe card → /player/:id. */
function HistoryCard({ entry }: { entry: HistoryEntry }) {
  const content = entry.content;
  const fill = barFill(entry.progress);
  return (
    <button
      type="button"
      onClick={() => navigate(`/player/${content.id}`)}
      aria-label={`Deschide playerul pentru ${content.title}`}
      className="group flex w-full flex-col overflow-hidden rounded-xl border border-white/10 bg-white/[0.03] text-left transition hover:border-rose-500/40 hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60"
    >
      <span className="relative block aspect-[2/3] w-full overflow-hidden bg-black/40">
        {content.thumbnail ? (
          <img
            src={content.thumbnail}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.03]"
          />
        ) : (
          <span className="grid h-full w-full place-items-center text-zinc-700">
            <Play className="h-8 w-8" aria-hidden />
          </span>
        )}
        <span className="absolute left-2 top-2">
          <TypeBadge type={content.type} />
        </span>
        {entry.progress > 0 ? (
          <span aria-hidden className="absolute inset-x-0 bottom-0 block h-1.5 bg-black/60">
            <span className="block h-full bg-rose-500" style={{ width: `${fill}%` }} />
          </span>
        ) : null}
        <span className="absolute inset-0 grid place-items-center bg-black/40 opacity-0 transition group-hover:opacity-100">
          <span className="grid h-11 w-11 place-items-center rounded-full bg-rose-600 shadow-lg shadow-rose-900/50">
            <Play className="h-5 w-5 fill-white text-white" aria-hidden />
          </span>
        </span>
      </span>
      <span className="flex flex-1 flex-col gap-1 p-3">
        <span className="line-clamp-2 text-sm font-bold leading-snug text-zinc-100">{content.title}</span>
        <span className="mt-auto text-[11px] text-zinc-500">urmărit {relativeTimeRo(entry.watchedat)}</span>
        {entry.progress > 0 ? (
          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-rose-300/90">
            <Clock className="h-3 w-3" aria-hidden />~{formatWatched(entry.progress)} vizionate
          </span>
        ) : null}
      </span>
    </button>
  );
}

/* ---------------------------------- view ---------------------------------- */

export function HistoryView() {
  const { user, initializing } = useAuth();
  const [tab, setTab] = useState<HistoryTabId>('all');

  const history = useApi(
    `faza21-history-${user ? user.id : 'anon'}`,
    () => platform.history(HISTORY_LIMIT),
    { enabled: !!user },
  );
  /** Badge public de hub (versiune + totaluri platformă). */
  const hub = useApi('faza21-history-hubstatus', () => api.playerHubStatus());

  /* ---- stări de auth: inițializare / neconectat ---- */
  if (initializing) {
    return (
      <Container className="space-y-6 py-10">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-5 w-96 max-w-full" />
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="aspect-[2/3] w-full rounded-xl" />
              <Skeleton className="h-4 w-4/5" />
            </div>
          ))}
        </div>
      </Container>
    );
  }

  if (!user) {
    return (
      <Container className="py-12">
        <PageHeader
          title="Istoricul Meu"
          subtitle="Istoricul de vizionare e legat de contul tău — conectează-te pentru a-l vedea."
        />
        <div className="mt-8">
          <EmptyState
            icon={<HistoryIcon className="h-6 w-6" aria-hidden />}
            title="Conectează-te pentru istoricul tău"
            message="Pe contul tău găsești fiecare titlu vizionat, progresul salvat și punctele de reluare — salvate 100% în Neon."
            action={
              <Button onClick={() => navigate('/auth')} className="bg-rose-600 font-bold hover:bg-rose-500">
                <LogIn className="mr-2 h-4 w-4" aria-hidden />
                Conectează-te
              </Button>
            }
          />
        </div>
      </Container>
    );
  }

  /* ---- stări de date ---- */
  if (history.loading && !history.data) {
    return (
      <Container className="space-y-6 py-10">
        <PageHeader title="Istoricul Meu" subtitle="Ultimele tale vizionări, cu progres real salvat." />
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="aspect-[2/3] w-full rounded-xl" />
              <Skeleton className="h-4 w-4/5" />
            </div>
          ))}
        </div>
      </Container>
    );
  }

  if (history.error && !history.data) {
    return (
      <Container className="py-10">
        <PageHeader title="Istoricul Meu" subtitle="Ultimele tale vizionări, cu progres real salvat." />
        <div className="mt-6">
          <ErrorState message={history.error} onRetry={() => void history.refetch()} />
        </div>
      </Container>
    );
  }

  const entries = history.data?.data ?? [];
  const resumeEntries = entries.filter((e) => e.progress > RESUME_THRESHOLD).slice(0, 6);
  const activeTab = HISTORY_TABS.find((t) => t.id === tab) ?? HISTORY_TABS[0];
  const filtered = activeTab.type ? entries.filter((e) => e.content.type === activeTab.type) : entries;
  const counts: Record<HistoryTabId, number> = {
    all: entries.length,
    movie: entries.filter((e) => e.content.type === 'movie').length,
    tv: entries.filter((e) => e.content.type === 'tv').length,
    anime: entries.filter((e) => e.content.type === 'anime').length,
  };

  /* ---- istoric gol ---- */
  if (entries.length === 0) {
    return (
      <Container className="py-12">
        <PageHeader
          title="Istoricul Meu"
          subtitle={`Salut, ${user.username} — aici vor apărea titlurile pe care le vizionezi.`}
        />
        <div className="mt-8">
          <EmptyState
            icon={<HistoryIcon className="h-6 w-6" aria-hidden />}
            title="Nu ai vizionat nimic încă"
            message="Începe să explorezi biblioteca — fiecare redare se salvează aici cu progresul ei."
            action={
              <Button onClick={() => navigate('/home')} className="bg-rose-600 font-bold hover:bg-rose-500">
                <Compass className="mr-2 h-4 w-4" aria-hidden />
                Explorează biblioteca
              </Button>
            }
          />
        </div>
      </Container>
    );
  }

  return (
    <Container className="space-y-8 py-8 sm:py-10">
      <PageHeader
        title="Istoricul Meu"
        subtitle={`Ultimele ${entries.length === HISTORY_LIMIT ? `${HISTORY_LIMIT}+` : entries.length} ${
          entries.length === 1 ? 'titlu vizionat' : 'titluri vizionate'
        } · progres real salvat în Neon`}
      >
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {hub.data ? (
            <Badge
              variant="outline"
              className="border-rose-500/30 bg-rose-500/10 text-rose-300 hover:bg-rose-500/10"
            >
              <HistoryIcon className="mr-1.5 h-3.5 w-3.5" aria-hidden />
              Player Hub v{hub.data.version} · {hub.data.totals.playlists} playlist-uri ·{' '}
              {hub.data.totals.subtitleTracks} subtitrări
            </Badge>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void history.refetch()}
            disabled={history.loading}
            className="h-8 border-white/15 bg-white/5 text-zinc-200 hover:bg-white/10 hover:text-white"
          >
            <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', history.loading && 'animate-spin')} aria-hidden />
            Reîmprospătează
          </Button>
        </div>
      </PageHeader>

      {/* ------------------- Continuă vizionarea (resume) ------------------- */}
      {resumeEntries.length > 0 ? (
        <Section
          title="Continuă vizionarea"
          subtitle={`Primele ${resumeEntries.length} titluri cu progres salvat — playerul reia automat de unde ai rămas.`}
        >
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {resumeEntries.map((entry) => (
              <ContinueCard key={`${entry.content.id}-${entry.watchedat}`} entry={entry} />
            ))}
          </div>
        </Section>
      ) : null}

      {/* --------------------------- grila + tab-uri --------------------------- */}
      <Section>
        <Tabs value={tab} onValueChange={(v) => setTab(v as HistoryTabId)}>
          <TabsList className="h-10 border border-white/10 bg-white/[0.03]">
            {HISTORY_TABS.map((t) => (
              <TabsTrigger
                key={t.id}
                value={t.id}
                className="px-3 text-xs font-semibold data-[state=active]:bg-rose-500/15 data-[state=active]:text-rose-300"
              >
                {t.label}
                <span className="ml-1.5 text-[10px] font-bold text-zinc-500">{counts[t.id]}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        {filtered.length === 0 ? (
          <EmptyState
            title="Nimic în această categorie"
            message={`Nu ai încă ${activeTab.label.toLowerCase()} în istoric — comută pe „Toate" pentru restul vizionărilor.`}
          />
        ) : (
          <div className="custom-scrollbar max-h-[38rem] overflow-y-auto pr-1">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
              {filtered.map((entry) => (
                <HistoryCard key={`${entry.content.id}-${entry.watchedat}`} entry={entry} />
              ))}
            </div>
          </div>
        )}
      </Section>
    </Container>
  );
}
