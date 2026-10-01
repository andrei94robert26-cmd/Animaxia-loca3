'use client';

/**
 * states.tsx — Badges and state components (loading / error / empty).
 */

import { AlertTriangle, Clapperboard, Inbox, RefreshCw, Star } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

const TYPE_BADGES: Record<string, string> = {
  anime: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
  movie: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  tv: 'bg-teal-500/15 text-teal-300 border-teal-500/30',
  news: 'bg-orange-500/15 text-orange-300 border-orange-500/30',
  sports: 'bg-lime-500/15 text-lime-300 border-lime-500/30',
  mined: 'bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/30',
  featured: 'bg-violet-500/15 text-violet-300 border-violet-500/30',
};

export function typeBadgeClass(type: string): string {
  return TYPE_BADGES[type] || 'bg-zinc-500/15 text-zinc-300 border-zinc-500/30';
}

export function TypeBadge({ type, className }: { type: string; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider backdrop-blur-sm',
        typeBadgeClass(type),
        className,
      )}
    >
      {type}
    </span>
  );
}

export function RatingBadge({ value, className }: { value: number | null | undefined; className?: string }) {
  if (value == null || Number.isNaN(Number(value))) return null;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-black/60 px-2 py-0.5 text-[11px] font-bold text-amber-300 backdrop-blur-sm',
        className,
      )}
    >
      <Star className="h-3 w-3 fill-amber-300" aria-hidden />
      {Number(value).toFixed(1)}
    </span>
  );
}

export function LoadingCards({ count = 6, className }: { count?: number; className?: string }) {
  return (
    <div
      className={cn(
        'grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6',
        className,
      )}
      aria-busy="true"
      aria-label="Loading content"
    >
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="space-y-2">
          <Skeleton className="aspect-[2/3] w-full rounded-xl" />
          <Skeleton className="h-4 w-4/5" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ))}
    </div>
  );
}

export function RowSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div className="flex gap-3 overflow-hidden sm:gap-4" aria-busy="true" aria-label="Loading row">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="w-[150px] shrink-0 space-y-2 sm:w-[176px]">
          <Skeleton className="aspect-[2/3] w-full rounded-xl" />
          <Skeleton className="h-4 w-4/5" />
        </div>
      ))}
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
  compact,
}: {
  message?: string | null;
  onRetry?: () => void;
  compact?: boolean;
}) {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-2xl border border-rose-500/20 bg-rose-500/5 text-center',
        compact ? 'p-6' : 'p-10',
      )}
    >
      <AlertTriangle className="h-8 w-8 text-rose-400" aria-hidden />
      <div>
        <p className="font-semibold text-zinc-100">Something went wrong</p>
        <p className="mt-1 max-w-md text-sm text-zinc-400">{message || 'The request could not be completed.'}</p>
      </div>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry} className="border-white/15 bg-white/5 hover:bg-white/10">
          <RefreshCw className="mr-2 h-3.5 w-3.5" aria-hidden />
          Try again
        </Button>
      )}
    </div>
  );
}

export function EmptyState({
  title = 'Nimic aici deocamdată',
  message,
  action,
  icon,
}: {
  title?: string;
  message?: string;
  action?: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-white/10 bg-white/[0.02] p-10 text-center">
      <div className="rounded-full bg-white/5 p-3 text-zinc-400">
        {icon || <Inbox className="h-6 w-6" aria-hidden />}
      </div>
      <div>
        <p className="font-semibold text-zinc-100">{title}</p>
        {message && <p className="mt-1 max-w-md text-sm text-zinc-400">{message}</p>}
      </div>
      {action}
    </div>
  );
}

export function BrandPlaceholder({ title }: { title: string }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-gradient-to-br from-white/[0.06] to-white/[0.02] p-3 text-center">
      <Clapperboard className="h-8 w-8 text-rose-400/60" aria-hidden />
      <span className="line-clamp-3 text-xs font-medium text-zinc-400">{title}</span>
    </div>
  );
}
