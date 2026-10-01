'use client';

/**
 * hero-carousel.tsx — Full-width auto-rotating hero banner with framer-motion
 * transitions, dots, arrows and Watch/Details actions.
 */

import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronLeft, ChevronRight, Info, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { navigate, targetForItem } from '@/lib/animaxia/router';
import type { NormalizedItem } from '@/lib/animaxia/types';
import { BrandPlaceholder, RatingBadge, TypeBadge } from './states';

const ROTATE_MS = 6500;

export function HeroCarousel({ items }: { items: NormalizedItem[] }) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);

  const count = items.length;
  const go = useCallback((next: number) => setIndex(((next % count) + count) % count), [count]);

  useEffect(() => {
    if (paused || count <= 1) return;
    const timer = setInterval(() => setIndex((i) => (i + 1) % count), ROTATE_MS);
    return () => clearInterval(timer);
  }, [paused, count]);

  if (count === 0) return null;
  const item = items[index];
  const target = targetForItem(item);
  const detailHref = item.kind === 'db' && item.dbId != null ? `/content/${item.dbId}` : target?.kind === 'internal' ? target.href : null;

  return (
    <section
      aria-label="Featured content"
      className="relative h-[62vh] min-h-[430px] w-full overflow-hidden sm:h-[68vh]"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <AnimatePresence mode="wait">
        <motion.div
          key={item.key}
          initial={{ opacity: 0, scale: 1.04 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.7, ease: 'easeOut' }}
          className="absolute inset-0"
        >
          {item.backdrop || item.image ? (
            <img
              src={(item.backdrop || item.image) as string}
              alt=""
              aria-hidden
              className="h-full w-full object-cover"
            />
          ) : (
            <BrandPlaceholder title={item.title} />
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-[#0a0a10] via-[#0a0a10]/55 to-[#0a0a10]/10" />
          <div className="absolute inset-0 bg-gradient-to-r from-[#0a0a10]/85 via-transparent to-transparent" />
        </motion.div>
      </AnimatePresence>

      <div className="relative z-10 flex h-full flex-col justify-end">
        <div className="mx-auto w-full max-w-7xl px-4 pb-10 sm:px-6 sm:pb-14 lg:px-8">
          <motion.div
            key={`${item.key}-copy`}
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.15 }}
            className="max-w-2xl space-y-4"
          >
            <div className="flex flex-wrap items-center gap-2">
              <TypeBadge type={item.type} />
              <RatingBadge value={item.rating} />
              {item.year != null && item.year !== '' && (
                <span className="text-xs font-medium text-zinc-400">{item.year}</span>
              )}
            </div>
            <h1 className="text-3xl font-black leading-tight tracking-tight text-white drop-shadow-lg sm:text-5xl">
              {item.title}
            </h1>
            {item.overview && (
              <p className="line-clamp-3 max-w-xl text-sm leading-relaxed text-zinc-300 drop-shadow sm:text-base">
                {item.overview}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-3 pt-1">
              {item.playable && item.dbId != null ? (
                <Button
                  size="lg"
                  onClick={() => navigate(`/player/${item.dbId}`)}
                  className="bg-rose-600 font-bold text-white shadow-lg shadow-rose-900/40 hover:bg-rose-500"
                >
                  <Play className="mr-2 h-5 w-5 fill-white" aria-hidden />
                  Watch now
                </Button>
              ) : null}
              {detailHref && (
                <Button
                  size="lg"
                  variant="outline"
                  onClick={() => navigate(detailHref)}
                  className="border-white/20 bg-white/10 font-semibold text-white backdrop-blur hover:bg-white/20"
                >
                  <Info className="mr-2 h-4 w-4" aria-hidden />
                  Details
                </Button>
              )}
            </div>
          </motion.div>
        </div>
      </div>

      {count > 1 && (
        <>
          <button
            type="button"
            aria-label="Previous featured item"
            onClick={() => go(index - 1)}
            className="absolute left-3 top-1/2 z-20 -translate-y-1/2 rounded-full border border-white/10 bg-black/50 p-2.5 text-white backdrop-blur transition hover:bg-rose-600"
          >
            <ChevronLeft className="h-5 w-5" aria-hidden />
          </button>
          <button
            type="button"
            aria-label="Next featured item"
            onClick={() => go(index + 1)}
            className="absolute right-3 top-1/2 z-20 -translate-y-1/2 rounded-full border border-white/10 bg-black/50 p-2.5 text-white backdrop-blur transition hover:bg-rose-600"
          >
            <ChevronRight className="h-5 w-5" aria-hidden />
          </button>
          <div className="absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 gap-2">
            {items.map((it, i) => (
              <button
                key={it.key}
                type="button"
                aria-label={`Go to featured item ${i + 1}`}
                onClick={() => go(i)}
                className={`h-1.5 rounded-full transition-all ${i === index ? 'w-7 bg-rose-500' : 'w-3 bg-white/25 hover:bg-white/50'}`}
              />
            ))}
          </div>
        </>
      )}
    </section>
  );
}
