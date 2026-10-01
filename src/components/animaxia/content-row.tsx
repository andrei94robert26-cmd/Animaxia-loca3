'use client';

/**
 * content-row.tsx — Horizontally scrollable row of ContentCards with
 * desktop arrow controls. Renders nothing when there is no content.
 */

import { useRef } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { navigate } from '@/lib/animaxia/router';
import type { NormalizedItem } from '@/lib/animaxia/types';
import { ContentCard } from './content-card';
import { RowSkeleton } from './states';

export function ContentRow({
  title,
  subtitle,
  items,
  loading,
  seeAllHref,
  emptyMessage,
}: {
  title: string;
  subtitle?: string;
  items: NormalizedItem[];
  loading?: boolean;
  seeAllHref?: string;
  emptyMessage?: string;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);

  if (loading) {
    return (
      <section aria-label={title} className="space-y-3">
        <RowHeader title={title} subtitle={subtitle} seeAllHref={seeAllHref} />
        <RowSkeleton />
      </section>
    );
  }

  if (!items || items.length === 0) {
    if (!emptyMessage) return null;
    return (
      <section aria-label={title} className="space-y-3">
        <RowHeader title={title} subtitle={subtitle} />
        <p className="rounded-xl border border-white/5 bg-white/[0.02] px-4 py-3 text-sm text-zinc-500">{emptyMessage}</p>
      </section>
    );
  }

  const scrollBy = (dir: 1 | -1) => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * el.clientWidth * 0.85, behavior: 'smooth' });
  };

  return (
    <section aria-label={title} className="space-y-3">
      <RowHeader title={title} subtitle={subtitle} seeAllHref={seeAllHref} />
      <div className="group/row relative">
        <div
          ref={scrollerRef}
          className="custom-scrollbar flex snap-x snap-mandatory gap-3 overflow-x-auto scroll-smooth pb-2 sm:gap-4"
        >
          {items.map((item) => (
            <div key={item.key} className="w-[150px] shrink-0 snap-start sm:w-[176px]">
              <ContentCard item={item} />
            </div>
          ))}
        </div>
        <button
          type="button"
          aria-label={`Scroll ${title} left`}
          onClick={() => scrollBy(-1)}
          className="absolute -left-3 top-1/2 hidden -translate-y-1/2 rounded-full border border-white/10 bg-black/70 p-2 text-white opacity-0 backdrop-blur transition hover:bg-rose-600 group-hover/row:opacity-100 md:block"
        >
          <ChevronLeft className="h-5 w-5" aria-hidden />
        </button>
        <button
          type="button"
          aria-label={`Scroll ${title} right`}
          onClick={() => scrollBy(1)}
          className="absolute -right-3 top-1/2 hidden -translate-y-1/2 rounded-full border border-white/10 bg-black/70 p-2 text-white opacity-0 backdrop-blur transition hover:bg-rose-600 group-hover/row:opacity-100 md:block"
        >
          <ChevronRight className="h-5 w-5" aria-hidden />
        </button>
      </div>
    </section>
  );
}

function RowHeader({ title, subtitle, seeAllHref }: { title: string; subtitle?: string; seeAllHref?: string }) {
  return (
    <div className="flex items-end justify-between gap-4">
      <div>
        <h2 className="text-lg font-bold tracking-tight text-zinc-100 sm:text-xl">{title}</h2>
        {subtitle && <p className="mt-0.5 text-xs text-zinc-500">{subtitle}</p>}
      </div>
      {seeAllHref && (
        <button
          type="button"
          onClick={() => navigate(seeAllHref)}
          className="shrink-0 text-xs font-semibold text-rose-400 transition hover:text-rose-300"
        >
          See all →
        </button>
      )}
    </div>
  );
}
