'use client';

/**
 * pagination.tsx — Compact pagination with page window and ellipsis.
 */

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

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

export function Pagination({
  page,
  totalPages,
  onPage,
  className,
}: {
  page: number;
  totalPages: number;
  onPage: (page: number) => void;
  className?: string;
}) {
  if (totalPages <= 1) return null;
  return (
    <nav aria-label="Pagination" className={cn('flex flex-wrap items-center justify-center gap-1.5', className)}>
      <Button
        variant="outline"
        size="icon"
        aria-label="Pagina anterioară"
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
        className="h-9 w-9 border-white/10 bg-white/5 hover:bg-white/10"
      >
        <ChevronLeft className="h-4 w-4" aria-hidden />
      </Button>
      {pageWindow(page, totalPages).map((p, i) =>
        p === '…' ? (
          <span key={`ellipsis-${i}`} className="px-1.5 text-sm text-zinc-500" aria-hidden>
            …
          </span>
        ) : (
          <Button
            key={p}
            variant={p === page ? 'default' : 'outline'}
            size="icon"
            aria-label={`Pagina ${p}`}
            aria-current={p === page ? 'page' : undefined}
            onClick={() => onPage(p)}
            className={
              p === page
                ? 'h-9 w-9 bg-rose-600 font-bold text-white hover:bg-rose-500'
                : 'h-9 w-9 border-white/10 bg-white/5 font-medium hover:bg-white/10'
            }
          >
            {p}
          </Button>
        ),
      )}
      <Button
        variant="outline"
        size="icon"
        aria-label="Pagina următoare"
        disabled={page >= totalPages}
        onClick={() => onPage(page + 1)}
        className="h-9 w-9 border-white/10 bg-white/5 hover:bg-white/10"
      >
        <ChevronRight className="h-4 w-4" aria-hidden />
      </Button>
    </nav>
  );
}
