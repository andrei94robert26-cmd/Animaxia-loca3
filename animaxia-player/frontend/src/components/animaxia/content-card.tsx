'use client';

/**
 * content-card.tsx — Poster card used across all grids and rows.
 * Handles image fallback, badges, hover play affordance and navigation.
 *
 * FAZA 15 additions (AI Home):
 *  - data-ai-poster / data-ai-title on the card root drive the AI cursor aura;
 *  - data-ai-trailer="1" is set while a hover trailer is playing;
 *  - when the "Trailere la hover" setting is ON (fine pointers only), dwelling
 *    ~700ms over a card resolves a real YouTube trailer (TMDB videos → Jikan →
 *    YouTube search, via /api/ai/home/trailers) and plays it muted inside the
 *    poster. The overlay is pointer-events-none so clicks keep navigating.
 *
 * FAZA 19 (task 19-3b) — the three card roots are wrapped in <ContentPreview>
 * (hover preview popover, desktop only). On non-hover devices ContentPreview
 * renders its children verbatim (fragment) — zero layout change; the card's
 * click behavior and the trailer hover are untouched.
 */

import { useEffect, useRef, useState } from 'react';
import { ExternalLink, Play } from 'lucide-react';
import { api } from '@/lib/animaxia/api';
import { navigate, targetForItem } from '@/lib/animaxia/router';
import type { AiTrailerResponse, NormalizedItem } from '@/lib/animaxia/types';
import { useAiHomeSettings } from './ai-home-settings';
import { ContentPreview } from './content-preview';
import { BrandPlaceholder, RatingBadge, TypeBadge } from './states';
import { cn } from '@/lib/utils';

/* ------------------------- hover trailer resolution ------------------------ */

/** Module-level cache: trailer key → resolution (negatives cached too). */
const trailerCache = new Map<string, AiTrailerResponse>();

const TRAILER_DWELL_MS = 700;

function trailerKeyFor(item: NormalizedItem): string | null {
  if (item.kind === 'db' && item.dbId != null) return `db:${item.dbId}`;
  if (item.kind === 'external' && item.extType && item.extId) {
    if (item.extType === 'anime') return `jikan:anime:${item.extId}`;
    if (item.extType === 'movie' || item.extType === 'tv') return `tmdb:${item.extType}:${item.extId}`;
  }
  return null;
}

function trailerProviderLabel(provider: string | null): string {
  switch (provider) {
    case 'tmdb-videos':
      return 'TMDB';
    case 'jikan':
      return 'Jikan';
    case 'youtube-search':
      return 'YouTube';
    default:
      return 'AI';
  }
}

/* ---------------------------------- card ---------------------------------- */

export function ContentCard({ item, className }: { item: NormalizedItem; className?: string }) {
  const [imgError, setImgError] = useState(false);
  const { settings } = useAiHomeSettings();

  /* Hover trailer state — purely event-driven, zero impact on first paint. */
  const [trailer, setTrailer] = useState<AiTrailerResponse | null>(null);
  const dwellRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverRef = useRef(false);
  const trailersOn =
    settings.autoTrailers &&
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: fine)').matches;
  const trailerKey = trailerKeyFor(item);

  const clearDwell = () => {
    if (dwellRef.current) {
      clearTimeout(dwellRef.current);
      dwellRef.current = null;
    }
  };

  /* Clear any pending dwell timer when the card unmounts. */
  useEffect(() => clearDwell, []);

  const onEnter = () => {
    hoverRef.current = true;
    if (!trailersOn || !trailerKey) return;
    clearDwell();
    dwellRef.current = setTimeout(() => {
      dwellRef.current = null;
      const key = trailerKey;
      const cached = trailerCache.get(key);
      if (cached) {
        if (cached.trailerKey && cached.embedUrl && hoverRef.current) setTrailer(cached);
        return;
      }
      void api.aiHome
        .trailer(key, item.title)
        .then((res) => {
          trailerCache.set(key, res);
          if (res.trailerKey && res.embedUrl && hoverRef.current) setTrailer(res);
        })
        .catch(() => {
          /* Negative-cache the failure so we don't re-fetch on every hover. */
          trailerCache.set(key, {
            key,
            trailerKey: null,
            provider: null,
            title: item.title,
            embedUrl: null,
            cached: false,
            fetchedAt: new Date().toISOString(),
          });
        });
    }, TRAILER_DWELL_MS);
  };

  const onLeave = () => {
    hoverRef.current = false;
    clearDwell();
    /* Removing the iframe unmounts the player — nothing keeps playing. */
    setTrailer(null);
  };

  const target = targetForItem(item);
  const showImage = Boolean(item.image) && !imgError;

  const body = (
    <>
      <div className="relative aspect-[2/3] w-full overflow-hidden rounded-xl border border-white/10 bg-white/[0.03] transition-colors duration-300 group-hover:border-rose-500/40">
        {showImage ? (
          <img
            src={item.image as string}
            alt={item.title}
            loading="lazy"
            decoding="async"
            onError={() => setImgError(true)}
            className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
          />
        ) : (
          <BrandPlaceholder title={item.title} />
        )}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/80 via-black/10 to-transparent opacity-90" />
        <div className="absolute left-2 top-2 flex flex-col items-start gap-1">
          <RatingBadge value={item.rating} />
        </div>
        <div className="absolute right-2 top-2">
          <TypeBadge type={item.type} />
        </div>
        <div className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-300 group-hover:opacity-100">
          <span className="rounded-full bg-rose-600/95 p-3 shadow-lg shadow-rose-900/40">
            {item.kind === 'link' ? (
              <ExternalLink className="h-5 w-5 fill-white text-white" aria-hidden />
            ) : (
              <Play className="h-5 w-5 fill-white text-white" aria-hidden />
            )}
          </span>
        </div>
        <div className="absolute inset-x-0 bottom-0 p-2.5">
          <p className="line-clamp-2 text-sm font-semibold leading-tight text-white drop-shadow">{item.title}</p>
          {item.year != null && item.year !== '' && (
            <p className="mt-0.5 text-[11px] text-zinc-400">{item.year}</p>
          )}
        </div>

        {/* AI hover trailer — muted autoplay, clicks pass through to the card. */}
        {trailer && trailer.embedUrl && (
          <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden rounded-xl bg-black/90">
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="relative aspect-video w-full">
                <iframe
                  src={trailer.embedUrl}
                  title={`Trailer ${item.title}`}
                  allow="autoplay; encrypted-media; picture-in-picture"
                  referrerPolicy="strict-origin-when-cross-origin"
                  tabIndex={-1}
                  className="pointer-events-none absolute inset-0 h-full w-full"
                />
              </div>
            </div>
            <div className="absolute left-2 top-2 flex items-center gap-1.5">
              <span className="rounded-full bg-rose-600 px-2 py-0.5 text-[10px] font-bold text-white">
                AI · Trailer
              </span>
              <span className="rounded-full border border-white/15 bg-black/70 px-2 py-0.5 text-[10px] font-semibold text-zinc-300">
                {trailerProviderLabel(trailer.provider)}
              </span>
            </div>
            <p className="absolute inset-x-0 bottom-1 text-center text-[10px] font-medium text-zinc-400">
              click pentru detalii
            </p>
          </div>
        )}
      </div>
    </>
  );

  /* AI cursor attributes — present on every card, read by the aura overlay. */
  const aiAttrs = {
    'data-ai-poster': '',
    'data-ai-title': item.title,
    'data-ai-trailer': trailer ? '1' : undefined,
  };
  const hoverHandlers = trailersOn
    ? { onMouseEnter: onEnter, onMouseLeave: onLeave }
    : {};

  if (!target) {
    return (
      <ContentPreview item={item}>
        <div className={cn('group w-full', className)} aria-label={item.title} {...aiAttrs} {...hoverHandlers}>
          {body}
        </div>
      </ContentPreview>
    );
  }

  if (target.kind === 'external') {
    return (
      <ContentPreview item={item}>
        <a
          href={target.href}
          target="_blank"
          rel="noopener noreferrer"
          className={cn('group w-full focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60 rounded-xl', className)}
          aria-label={`${item.title} — opens external site`}
          {...aiAttrs}
          {...hoverHandlers}
        >
          {body}
        </a>
      </ContentPreview>
    );
  }

  return (
    <ContentPreview item={item}>
      <button
        type="button"
        onClick={() => navigate(target.href)}
        className={cn('group w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60 rounded-xl', className)}
        aria-label={`Open ${item.title}`}
        {...aiAttrs}
        {...hoverHandlers}
      >
        {body}
      </button>
    </ContentPreview>
  );
}
