'use client';

/**
 * resume-banner.tsx — FAZA 34 (PLAN 100X · WS4): „Continuă de unde ai rămas"
 * global — banner de resume pe home cu poziția exactă. Consumă istoricul
 * protejat FAZA 21 prin GET /api/playerhub/continue-watching (read-only,
 * nu-l modifică) și navighează la /player/:id?t=<secunde>.
 *
 * 100% aditiv și niciodată un blocker: randează null pentru vizitatori,
 * la eroare sau când nu există titluri reluabile — restul home-ului nu
 * depinde de acest banner în niciun fel.
 */

import { useMemo, useState } from 'react';
import { History as HistoryIcon, Play, X } from 'lucide-react';
import { api } from '@/lib/animaxia/api';
import { navigate } from '@/lib/animaxia/router';
import { useApi } from '@/lib/animaxia/hooks';
import { useAuth } from '@/components/animaxia/auth-provider';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

/* ------------------------------- helpers ---------------------------------- */

/** m:ss (ex. 4:07) — aceeași formatare ca în history-view. */
function formatResume(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

/** Durata totală estimată (secunde) din metadata titlului. FAZA-34-a a
 *  verificat datele reale: metadata.duration e SECUNDE (string numeric pe
 *  multe rânduri tv), metadata.runtime e MINUTE (number). Onest: null când
 *  e necunoscută — atunci bannerul arată doar „la m:ss", fără bară. */
function durationSeconds(metadata: Record<string, unknown> | undefined): number | null {
  const md = metadata ?? {};
  const duration = md.duration;
  const durNum =
    typeof duration === 'number' ? duration : typeof duration === 'string' ? Number(duration) : NaN;
  if (Number.isFinite(durNum) && durNum > 0) return Math.round(durNum);
  const runtime = md.runtime;
  if (typeof runtime === 'number' && runtime > 0) return Math.round(runtime * 60);
  return null;
}

/** Cheia de sessionStorage pentru ascunderea bannerului, per titlu. */
function dismissKey(contentId: number): string {
  return `animaxia.resumeHidden.${contentId}`;
}

/* ------------------------------ the banner -------------------------------- */

export function ResumeBanner() {
  const { user } = useAuth();
  /* Read-only peste istoricul protejat FAZA 21 — endpoint-ul există deja
     (AUTH); eroarea sau lipsa datelor înseamnă null, niciodată ErrorState. */
  const res = useApi('playerx-resume', () => api.playerHubContinueWatching(), {
    enabled: Boolean(user),
  });

  /* Ascundere manuală (per sesiune, cheiată pe primul titlu): sessionStorage
     e citit doar când sosesc datele (memo pe id-ul titlului) — reapare la o
     sesiune nouă sau pentru un alt titlu. */
  const [hideNow, setHideNow] = useState(false);

  const items = useMemo(() => {
    const all = res.data?.data ?? [];
    return all.filter((e) => e.hasResume && e.progress > 10).slice(0, 3);
  }, [res.data]);

  const first = items[0] ?? null;
  const others = items.slice(1);

  const dismissedForFirst = useMemo(() => {
    if (!first || typeof window === 'undefined') return false;
    try {
      return window.sessionStorage.getItem(dismissKey(first.content.id)) === '1';
    } catch {
      return false;
    }
  }, [first]);

  /* ----------------------------- stări de grație ---------------------------- */

  if (!user || res.error || !first || hideNow || dismissedForFirst) return null;

  if (res.loading && !res.data) {
    return (
      <div aria-hidden className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
        <div className="flex items-center gap-4">
          <Skeleton className="h-16 w-28 shrink-0 rounded-lg" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-3 w-44" />
            <Skeleton className="h-5 w-72 max-w-full" />
            <Skeleton className="h-1.5 w-52 max-w-full" />
          </div>
          <Skeleton className="hidden h-9 w-40 shrink-0 rounded-lg sm:block" />
        </div>
      </div>
    );
  }

  const content = first.content;
  const progressSec = Math.max(0, Math.floor(first.progress));
  const duration = durationSeconds(content.metadata);
  const pct =
    duration != null && duration > 0 ? Math.min(100, Math.round((progressSec / duration) * 100)) : null;

  function dismiss(): void {
    try {
      window.sessionStorage.setItem(dismissKey(content.id), '1');
    } catch {
      /* sessionStorage indisponibil — ascundem doar pentru acest render */
    }
    setHideNow(true);
  }

  return (
    <section aria-label="Continuă de unde ai rămas" className="relative">
      <div className="rounded-2xl border border-white/10 bg-gradient-to-r from-zinc-900 to-zinc-950 p-4 transition hover:border-rose-500/20">
        <button
          type="button"
          onClick={dismiss}
          aria-label="Ascunde bannerul"
          title="Ascunde bannerul (reapare în sesiunea următoare)"
          className="absolute right-2.5 top-2.5 z-10 grid h-7 w-7 place-items-center rounded-lg text-zinc-500 transition hover:bg-white/10 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>

        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          {/* Thumbnail-ul titlului reluabil */}
          <button
            type="button"
            onClick={() => navigate(`/content/${content.id}`)}
            aria-label={`Detalii ${content.title}`}
            className="group shrink-0 overflow-hidden rounded-lg border border-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60"
          >
            {content.thumbnail ? (
              <img
                src={content.thumbnail}
                alt=""
                loading="lazy"
                className="h-16 w-28 object-cover transition group-hover:scale-[1.03]"
              />
            ) : (
              <span className="grid h-16 w-28 place-items-center bg-gradient-to-br from-white/[0.08] to-white/[0.02]">
                <Play className="h-6 w-6 text-zinc-600" aria-hidden />
              </span>
            )}
          </button>

          {/* Titlu + progres + acțiuni */}
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
              Continuă de unde ai rămas
            </p>
            <h2 className="mt-0.5 truncate text-base font-bold text-white">{content.title}</h2>

            {pct != null ? (
              <div className="mt-2 flex items-center gap-2.5">
                <div
                  className="h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-white/10"
                  role="progressbar"
                  aria-valuenow={pct}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={`Progres ${content.title}`}
                >
                  <div className="h-full rounded-full bg-rose-500" style={{ width: `${pct}%` }} />
                </div>
                <span className="shrink-0 font-mono text-[11px] text-zinc-400">
                  {formatResume(progressSec)} / {formatResume(duration ?? 0)}
                </span>
              </div>
            ) : (
              <p className="mt-2 text-xs text-zinc-400">
                te-ai oprit la {formatResume(progressSec)}
              </p>
            )}

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                className="h-9 bg-rose-600 font-bold text-white hover:bg-rose-500"
                onClick={() => navigate(`/player/${content.id}?t=${progressSec}`)}
              >
                <Play className="h-3.5 w-3.5 fill-white" aria-hidden />
                Începe de la {formatResume(progressSec)}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-9 border border-white/10 font-semibold text-zinc-300 hover:bg-white/10 hover:text-white"
                onClick={() => navigate('/history')}
              >
                <HistoryIcon className="h-3.5 w-3.5" aria-hidden />
                Vezi istoricul
              </Button>
            </div>
          </div>

          {/* Celelalte titluri reluabile — chip-uri mici; pe mobil rămân într-o
              bandă cu scroll orizontal, pe ecrane mari stau în coloană la dreapta. */}
          {others.length > 0 && (
            <nav
              aria-label="Alte titluri reluabile"
              className="flex shrink-0 gap-2 overflow-x-auto custom-scrollbar pb-1 sm:pb-0 lg:flex-col lg:overflow-visible"
            >
              {others.map((entry) => (
                <button
                  key={entry.content.id}
                  type="button"
                  onClick={() => navigate(`/player/${entry.content.id}?t=${Math.max(0, Math.floor(entry.progress))}`)}
                  aria-label={`Continuă ${entry.content.title} de la ${formatResume(entry.progress)}`}
                  className="group flex w-44 shrink-0 items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] p-2 text-left transition hover:border-rose-500/40 hover:bg-rose-500/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60"
                >
                  {entry.content.thumbnail ? (
                    <img
                      src={entry.content.thumbnail}
                      alt=""
                      loading="lazy"
                      className="h-9 w-14 shrink-0 rounded-md border border-white/10 object-cover"
                    />
                  ) : (
                    <span className="grid h-9 w-14 shrink-0 place-items-center rounded-md border border-white/10 bg-white/[0.04]">
                      <Play className="h-4 w-4 text-zinc-600" aria-hidden />
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[11px] font-semibold text-zinc-200 group-hover:text-white">
                      {entry.content.title}
                    </span>
                    <span className="block text-[10px] text-zinc-500">
                      la {formatResume(entry.progress)}
                    </span>
                  </span>
                </button>
              ))}
            </nav>
          )}
        </div>
      </div>
    </section>
  );
}
