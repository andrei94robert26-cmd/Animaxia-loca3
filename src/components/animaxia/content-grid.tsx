'use client';

/**
 * content-grid.tsx — Responsive poster grid with loading skeletons.
 */

import type { NormalizedItem } from '@/lib/animaxia/types';
import { ContentCard } from './content-card';
import { EmptyState, LoadingCards } from './states';

export function ContentGrid({
  items,
  loading,
  skeletonCount = 12,
  emptyMessage = 'Niciun titlu găsit.',
  emptyTitle = 'Nimic aici deocamdată',
  emptyAction,
}: {
  items: NormalizedItem[];
  loading?: boolean;
  skeletonCount?: number;
  emptyMessage?: string;
  emptyTitle?: string;
  emptyAction?: React.ReactNode;
}) {
  if (loading) {
    return <LoadingCards count={skeletonCount} />;
  }
  if (!items || items.length === 0) {
    return <EmptyState title={emptyTitle} message={emptyMessage} action={emptyAction} />;
  }
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
      {items.map((item) => (
        <ContentCard key={item.key} item={item} />
      ))}
    </div>
  );
}
