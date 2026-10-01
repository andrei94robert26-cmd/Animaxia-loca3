'use client';

/**
 * history-view.tsx — FAZA 21 (#/history): personal watch history.
 * Two honest sections — "Continuă să vizionezi" (progress > 30s, unfinished)
 * and "Istoric recent" — fed by GET /api/users/me/history. Progress bars are
 * rendered ONLY when metadata.runtime/duration exists (no fake percentages);
 * otherwise the card shows plain "N min vizionate". The backend exposes no
 * history-delete route, so no remove action is offered.
 */

import { useMemo } from 'react';
import { Compass, Film, History as HistoryIcon, Info, Play } from 'lucide-react';
import { platform, type HistoryEntry } from '@/lib/animaxia/platform';
import { useApi } from '@/lib/animaxia/hooks';
import { navigate } from '@/lib/animaxia/router';
import { useAuth } from '@/components/animaxia/auth-provider';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { Container, PageHeader } from '../section';
import { EmptyState, ErrorState, TypeBadge } from '../states';

/* ------------------------------- helpers --------------------------------- */

/** Estimated total length in seconds when the metadata carries one
 *  (runtime is in minutes, duration may appear in seconds). Honest: null
 *  when unknown — callers must not invent a percentage. */
function estimatedDurationSeconds(entry: HistoryEntry): number | null {
  const md = entry.content.metadata ?? {};
  const runtime = md.runtime;
  if (typeof runtime === 'number' && runtime > 0) return Math.round(runtime * 60);
  const duration = md.duration;
  if (typeof duration === 'number' && duration > 0) return Math.round(duration);
  return null;
}

function formatMinutes(progressSec: number): string {
  const min = Math.round(progressSec / 60);
  if (min <= 0) return 'sub 1 min vizionate';
  return `${min} min vizionate`;
}

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return '—';
  const diff = Math.max(0, Date.now() - time);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'chiar acum';
  if (mins < 60) return `acum ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `acum ${hours} h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `acum ${days} zile`;
  const months = Math.floor(days / 30);
  return `acum ${months} luni`;
}

/* ------------------------------ history card ------------------------------ */

function HistoryCard({ entry, resumable }: { entry: HistoryEntry; resumable: boolean }) {
  const content = entry.content;
  const duration = estimatedDurationSeconds(entry);
  /* Honest progress: only when a real total is known. >=95% counts as done
     and drops the card out of "Continuă să vizionezi" upstream. */
  const pct = duration && duration > 0 ? Math.min(100, Math.round((entry.progress / duration) * 100)) : null;

  return (
    <div className="group flex items-stretch gap-3 rounded-2xl border border-white/10 bg-white/[0.03] p-3 transition hover:border-rose-500/30 sm:gap-4 sm:p-4">
      <button
        type="button"
        onClick={() => navigate(`/content/${content.id}`)}
        className="shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60"
        aria-label={`Deschide ${content.title}`}
      >
        {content.thumbnail ? (
          <img
            src={content.thumbnail}
            alt=""
            loading="lazy"
            className="h-24 w-16 rounded-lg border border-white/10 object-cover sm:h-28 sm:w-[74px]"
          />
        ) : (
          <span className="grid h-24 w-16 place-items-center rounded-lg border border-white/10 bg-gradient-to-br from-white/[0.08] to-white/[0.02] sm:h-28 sm:w-[74px]">
            <Film className="h-6 w-6 text-zinc-600" aria-hidden />
          </span>
        )}
      </button>

      <div className="flex min-w-0 flex-1 flex-col justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <button
              type="button"
              onClick={() => navigate(`/content/${content.id}`)}
              className="truncate text-left text-sm font-bold text-zinc-100 transition hover:text-rose-300 sm:text-base"
            >
              {content.title}
            </button>
            <TypeBadge type={content.type} />
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-zinc-500">
            <span>{formatMinutes(entry.progress)}</span>
            {pct != null && (
              <span className="font-mono text-[11px] text-zinc-400">
                ~{pct}% din {Math.round((duration ?? 0) / 60)} min
              </span>
            )}
            <span>văzut {relativeTime(entry.watchedat)}</span>
          </p>
        </div>

        {/* Honest progress bar — rendered only with a real known total. */}
        {pct != null && (
          <div
            className="h-1.5 w-full overflow-hidden rounded-full bg-white/10"
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`Progres ${content.title}`}
          >
            <div
              className={cn('h-full rounded-full', resumable ? 'bg-gradient-to-r from-rose-500 to-fuchsia-500' : 'bg-zinc-500')}
              style={{ width: `${pct}%` }}
            />
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            className="h-8 bg-rose-600 font-bold hover:bg-rose-500"
            onClick={() => navigate(`/player/${content.id}?t=${Math.max(0, Math.floor(entry.progress))}`)}
          >
            <Play className="h-3.5 w-3.5 fill-white" aria-hidden />
            {resumable ? 'Continuă' : 'Redă'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8 border-white/15 bg-white/5 font-semibold hover:bg-white/10"
            onClick={() => navigate(`/content/${content.id}`)}
          >
            Detalii
          </Button>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------- the view -------------------------------- */

export function HistoryView() {
  const { user, initializing } = useAuth();
  const history = useApi('faza21-history', () => platform.history(50), { enabled: Boolean(user) });

  /* Split once per fetch: resumable = >30s progress and (<95% when the total
     is known); everything else falls to the recents list (desc by watchedat). */
  const { resumable, recent } = useMemo(() => {
    const entries = history.data?.data ?? [];
    const resume: HistoryEntry[] = [];
    const recents: HistoryEntry[] = [];
    for (const entry of entries) {
      const duration = estimatedDurationSeconds(entry);
      const finished = duration != null && duration > 0 && entry.progress / duration >= 0.95;
      if (entry.progress > 30 && !finished) resume.push(entry);
      else recents.push(entry);
    }
    resume.sort((a, b) => new Date(b.watchedat).getTime() - new Date(a.watchedat).getTime());
    recents.sort((a, b) => new Date(b.watchedat).getTime() - new Date(a.watchedat).getTime());
    return { resumable: resume, recent: recents };
  }, [history.data]);

  if (initializing) {
    return (
      <Container className="py-8 sm:py-12">
        <Skeleton className="h-10 w-56" />
        <div className="mt-6 space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-32 w-full rounded-2xl" />
          ))}
        </div>
      </Container>
    );
  }

  if (!user) {
    return (
      <Container className="py-16 sm:py-24">
        <div className="mx-auto max-w-md">
          <EmptyState
            icon={<HistoryIcon className="h-6 w-6" aria-hidden />}
            title="Conectează-te pentru a-ți vedea istoricul"
            message="Istoricul de vizionare este legat de contul tău — titlurile reluate, progresul și minutele vizionate apar aici după autentificare."
            action={
              <Button
                className="bg-rose-600 font-bold hover:bg-rose-500"
                onClick={() => navigate('/auth?next=/history')}
              >
                Conectează-te
              </Button>
            }
          />
        </div>
      </Container>
    );
  }

  const loading = history.loading && !history.data;

  return (
    <Container className="space-y-8 py-8 sm:py-10">
      <PageHeader
        title="Istoricul tău"
        subtitle="Continuă de unde ai rămas sau recitește ce ai vizionat recent — date reale din contul tău Animaxia."
      />

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-32 w-full rounded-2xl" />
          ))}
        </div>
      ) : history.error && !history.data ? (
        <ErrorState message={history.error} onRetry={() => void history.refetch()} />
      ) : resumable.length === 0 && recent.length === 0 ? (
        <EmptyState
          icon={<Film className="h-6 w-6" aria-hidden />}
          title="Încă nimic vizionat"
          message="Deschide un titlu din bibliotecă și istoricul tău va apărea aici, cu progres salvat automat."
          action={
            <Button className="bg-rose-600 font-bold hover:bg-rose-500" onClick={() => navigate('/home')}>
              <Compass className="mr-1.5 h-4 w-4" aria-hidden />
              Explorează
            </Button>
          }
        />
      ) : (
        <div className="space-y-10">
          {resumable.length > 0 && (
            <section className="space-y-4" aria-label="Continuă să vizionezi">
              <div className="flex items-center justify-between gap-4">
                <h2 className="text-lg font-bold tracking-tight text-zinc-100">Continuă să vizionezi</h2>
                <span className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-0.5 text-[11px] font-semibold text-zinc-400">
                  {resumable.length} {resumable.length === 1 ? 'titlu' : 'titluri'}
                </span>
              </div>
              <div className="grid gap-3 lg:grid-cols-2">
                {resumable.map((entry) => (
                  <HistoryCard key={`resume-${entry.content.id}`} entry={entry} resumable />
                ))}
              </div>
            </section>
          )}

          {recent.length > 0 && (
            <section className="space-y-4" aria-label="Istoric recent">
              <div className="flex items-center justify-between gap-4">
                <h2 className="text-lg font-bold tracking-tight text-zinc-100">Istoric recent</h2>
                <span className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-0.5 text-[11px] font-semibold text-zinc-400">
                  {recent.length} {recent.length === 1 ? 'înregistrare' : 'înregistrări'}
                </span>
              </div>
              <div className="grid gap-3 lg:grid-cols-2">
                {recent.map((entry) => (
                  <HistoryCard key={`recent-${entry.content.id}`} entry={entry} resumable={false} />
                ))}
              </div>
            </section>
          )}

          <p className="flex items-start gap-2 text-[11px] leading-relaxed text-zinc-600">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            Progresul se salvează automat la fiecare 10 secunde de redare și la pauză, doar pentru sursele mp4/HLS.
            Barele de procent apar doar pentru titlurile cu durată cunoscută în metadate.
          </p>
        </div>
      )}
    </Container>
  );
}
