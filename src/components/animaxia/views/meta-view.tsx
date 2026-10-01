'use client';

/**
 * meta-view.tsx — AI metadata browse view (#/meta/<dim>/<value>, FAZA 15).
 *
 * The AI extractor classifies content along eight metadata dimensions
 * (year, genre, category, studio, actor, collection, franchise, trilogy).
 * This view grids everything placed under one value, with:
 *   - sibling quick-switch chips (same dimension, backend-ordered);
 *   - classic pagination (20 / page);
 *   - the shared ContentGrid + feedToItem normalizer, so every poster opens
 *     the real detail view (Neon row or live TMDB/Jikan item).
 *
 * Route params arrive pre-decoded from parseHash — no double decoding.
 */

import { useMemo, useRef, useState } from 'react';
import { ArrowLeft, Bot } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { api, feedToItem } from '@/lib/animaxia/api';
import { useApi } from '@/lib/animaxia/hooks';
import { navigate, type AppRoute } from '@/lib/animaxia/router';
import type { MetaDimension } from '@/lib/animaxia/types';
import { ContentGrid } from '../content-grid';
import { Pagination } from '../pagination';
import { Container, PageHeader } from '../section';
import { EmptyState, ErrorState, LoadingCards } from '../states';
import { cn } from '@/lib/utils';

const DIM_LABELS: Record<MetaDimension, string> = {
  year: 'An',
  genre: 'Gen',
  category: 'Categorie',
  studio: 'Studio',
  actor: 'Actor',
  collection: 'Colecție',
  franchise: 'Franciză',
  trilogy: 'Trilogie',
};

const PAGE_SIZE = 20;

export function MetaBrowseView({ route }: { route: AppRoute }) {
  const rawDim = route.params[0] || 'genre';
  const isKnownDim = rawDim in DIM_LABELS;
  const dim: MetaDimension = isKnownDim ? (rawDim as MetaDimension) : 'genre';
  const rawValue = route.params[1] || '';

  /* Sibling values power the quick-switch chips + the default value fallback
     (a bare #/meta/<dim> link auto-selects the dimension's first value). */
  const metaRes = useApi('ai-home-metadata', () => api.aiHome.metadata());
  const siblings = useMemo(() => metaRes.data?.dimensions[dim] ?? [], [metaRes.data, dim]);
  const value = rawValue || siblings[0]?.value || '';

  /* Reset pagination whenever dim/value changes (adjust during render). */
  const [page, setPage] = useState(1);
  const pageKey = `${dim}:${value}`;
  const [lastKey, setLastKey] = useState(pageKey);
  if (lastKey !== pageKey) {
    setLastKey(pageKey);
    setPage(1);
  }

  const browseRes = useApi(
    `ai-home-browse:${dim}:${value}:${page}`,
    () => api.aiHome.browse(dim, value, page),
    { enabled: Boolean(value) },
  );
  const items = useMemo(() => (browseRes.data?.items ?? []).map(feedToItem), [browseRes.data]);
  const totalPages = browseRes.data?.totalPages ?? 1;

  const gridTopRef = useRef<HTMLDivElement>(null);
  const onPage = (p: number) => {
    setPage(p);
    gridTopRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  if (!isKnownDim) {
    return (
      <Container className="py-10">
        <EmptyState
          title="Dimensiune metadata necunoscută"
          message={`AI nu știe să răsfoiască „${rawDim}”. Alege o dimensiune din meniul AI Metadata.`}
          action={
            <Button onClick={() => navigate('/home')} className="bg-rose-600 font-bold hover:bg-rose-500">
              Înapoi acasă
            </Button>
          }
        />
      </Container>
    );
  }

  return (
    <Container className="space-y-6 py-8 sm:py-10">
      <PageHeader
        title={`${DIM_LABELS[dim]}: ${value || '…'}`}
        subtitle="Conținuturi plasate automat de AI după metadata extrasă · ordonate"
      >
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Badge className="border-rose-500/30 bg-rose-500/15 text-rose-300 hover:bg-rose-500/15">
            <Bot className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            AI
          </Badge>
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate('/home')}
            className="h-8 border-white/15 bg-white/5 text-zinc-200 hover:bg-white/10 hover:text-white"
          >
            <ArrowLeft className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            Acasă
          </Button>
        </div>
      </PageHeader>

      {/* Sibling quick-switch chips — same dimension, backend-ordered. */}
      {siblings.length > 0 && (
        <div
          className="custom-scrollbar flex max-h-32 flex-wrap gap-1.5 overflow-y-auto rounded-xl border border-white/10 bg-white/[0.03] p-3"
          aria-label={`Alte valori ${DIM_LABELS[dim].toLowerCase()}`}
        >
          {siblings.map((s) => {
            const active = s.value.toLowerCase() === value.toLowerCase();
            return (
              <button
                key={s.value}
                type="button"
                onClick={() => navigate(`/meta/${dim}/${encodeURIComponent(s.value)}`)}
                aria-current={active ? 'true' : undefined}
                className={cn(
                  'rounded-full border px-2.5 py-1 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60',
                  active
                    ? 'border-rose-500/50 bg-rose-500/15 text-rose-200'
                    : 'border-white/10 bg-white/[0.04] text-zinc-300 hover:border-rose-500/40 hover:bg-rose-500/10 hover:text-rose-300',
                )}
              >
                {s.value}
                <span className="ml-1 text-[10px] font-semibold text-zinc-500">{s.count}</span>
              </button>
            );
          })}
        </div>
      )}

      <div ref={gridTopRef} className="scroll-mt-24 space-y-4">
        {!value ? (
          metaRes.loading ? (
            <LoadingCards count={12} />
          ) : (
            <EmptyState
              title="AI nu a găsit încă valori"
              message="Pool-ul de extragere crește continuu — revino în câteva minute."
            />
          )
        ) : browseRes.error && !browseRes.data ? (
          <ErrorState message={browseRes.error} onRetry={browseRes.refetch} />
        ) : (
          <>
            <ContentGrid
              items={items}
              loading={browseRes.loading}
              skeletonCount={PAGE_SIZE}
              emptyTitle="AI nu a găsit încă conținut pentru această valoare"
              emptyMessage="Pool-ul de extragere crește continuu — conținutul apare aici imediat ce AI îl clasifică."
            />
            <Pagination page={page} totalPages={totalPages} onPage={onPage} />
          </>
        )}
      </div>
    </Container>
  );
}
