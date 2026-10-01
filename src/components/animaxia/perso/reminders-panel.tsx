'use client';

/**
 * perso/reminders-panel.tsx — FAZA 36-R (WS6): Memento-urile de încheiere —
 * titluri începute și abandonate (progres 20-90%, >3 zile), cu minute rămase
 * estimate, „finalizează serialul" (când metadata are sezoane) și buton
 * Dismiss (ascuns 30 de zile). Încărcare la montare + Refresh manual.
 */

import { useState } from 'react';
import { BellOff, Clock, Play } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { api, ApiError } from '@/lib/animaxia/api';
import { useApi } from '@/lib/animaxia/hooks';
import { navigate } from '@/lib/animaxia/router';
import type { PersoReminderItem } from '@/lib/animaxia/types';
import { useAuth } from '../auth-provider';
import { BrandPlaceholder, TypeBadge } from '../states';
import {
  PersoCard, PersoCountBadge, PersoHonestNote, PersoLoginPrompt, PersoMethodBadge, PersoRefreshButton,
} from './perso-ui';

function ReminderRow({
  item,
  onDismiss,
  dismissing,
}: {
  item: PersoReminderItem;
  onDismiss: (contentId: number) => void;
  dismissing: boolean;
}) {
  const pct = item.progressPct ?? null;
  return (
    <article className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-3 transition hover:border-white/25">
      <button
        type="button"
        onClick={() => navigate(`/content/${item.contentId}`)}
        className="relative h-20 w-14 shrink-0 overflow-hidden rounded-lg bg-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60"
        aria-label={`Deschide ${item.title}`}
      >
        {item.thumbnail ? (
          <img src={item.thumbnail} alt={`Poster ${item.title}`} loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <div className="grid h-full w-full place-items-center">
            <BrandPlaceholder title={item.title} />
          </div>
        )}
      </button>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <p className="min-w-0 truncate text-sm font-bold text-zinc-100">{item.title}</p>
          <TypeBadge type={item.type} />
          {item.idleDays != null ? (
            <span className="shrink-0 rounded-full border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-bold text-amber-300">
              {item.idleDays} {item.idleDays === 1 ? 'zi' : 'zile'} de când ai lăsat-o
            </span>
          ) : null}
        </div>
        <p className="mt-0.5 line-clamp-1 text-[11px] text-zinc-500">{item.reason}</p>

        {pct !== null ? (
          <div
            className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/10"
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`Progres ${item.title}`}
          >
            <div className="h-full rounded-full bg-gradient-to-r from-amber-500 to-rose-500" style={{ width: `${pct}%` }} />
          </div>
        ) : null}

        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[10px] font-semibold text-zinc-500">
          {pct !== null ? <span>{pct}% vizionat</span> : null}
          {item.remainingMin != null ? (
            <span className="inline-flex items-center gap-0.5 text-teal-300">
              <Clock className="h-3 w-3" aria-hidden /> ~{item.remainingMin} min rămase
            </span>
          ) : null}
          {item.seasonFinish ? (
            <span className="inline-flex items-center gap-0.5 text-fuchsia-300">
              📺 {item.seasonFinish.note}
            </span>
          ) : null}
        </div>
      </div>

      <div className="flex shrink-0 flex-col gap-1.5">
        <Button
          type="button"
          size="sm"
          onClick={() => navigate(`/player/${item.contentId}`)}
          className="h-8 bg-rose-600 text-xs font-bold hover:bg-rose-500"
        >
          <Play className="mr-1 h-3 w-3 fill-white" aria-hidden />
          Continuă
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => onDismiss(item.contentId)}
          disabled={dismissing}
          className="h-8 border-white/15 bg-white/5 text-xs font-semibold text-zinc-400 hover:bg-white/10 hover:text-white"
        >
          <BellOff className="mr-1 h-3 w-3" aria-hidden />
          Ascunde
        </Button>
      </div>
    </article>
  );
}

export function RemindersPanel() {
  const { user } = useAuth();
  const res = useApi(
    `perso-reminders-${user?.id ?? 'anon'}`,
    () => api.persoReminders(user?.id),
    { enabled: Boolean(user) },
  );
  const [dismissing, setDismissing] = useState<number | null>(null);

  if (!user) return <PersoLoginPrompt />;

  const dismiss = async (contentId: number) => {
    if (dismissing) return;
    setDismissing(contentId);
    try {
      await api.persoReminderDismiss(contentId, user.id);
      toast.success('Memento ascuns', { description: 'Reapare onest după 30 de zile dacă titlul rămâne abandonat.' });
      await res.refetch();
    } catch (e) {
      toast.error('Ascunderea a eșuat', {
        description: e instanceof ApiError ? e.message : 'backend-ul nu răspunde',
      });
    } finally {
      setDismissing(null);
    }
  };

  if (res.loading && !res.data) {
    return (
      <div className="space-y-3" aria-busy="true">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24 rounded-xl" />
        ))}
      </div>
    );
  }
  if (res.error) {
    const needLogin = res.error.toLowerCase().includes('autentificare');
    if (needLogin) return <PersoLoginPrompt />;
    return (
      <div role="alert" className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
        Memento-urile nu au putut fi încărcate: {res.error}
        <div className="mt-2">
          <PersoRefreshButton onClick={() => void res.refetch()} loading={res.loading} label="Reîncearcă" />
        </div>
      </div>
    );
  }

  const items = res.data?.items ?? [];
  const criteria = res.data?.criteria;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <PersoMethodBadge method={res.data?.method} />
          <PersoCountBadge tone={items.length > 0 ? 'rose' : 'emerald'}>
            {items.length} {items.length === 1 ? 'memento' : 'memento-uri'}
          </PersoCountBadge>
          {res.data?.dismissedActive ? (
            <span className="text-[11px] text-zinc-600">{res.data.dismissedActive} ascunse (reapar în 30 zile)</span>
          ) : null}
        </div>
        <PersoRefreshButton onClick={() => void res.refetch()} loading={res.loading} />
      </div>

      {criteria ? (
        <p className="text-[11px] text-zinc-600">
          Criterii oneste: progres {criteria.progressBand} · netradus de {criteria.staleAfterDays} zile ·
          dismiss ascunde {criteria.dismissalTtlDays} zile.
        </p>
      ) : null}

      {items.length === 0 ? (
        <PersoCard>
          <div className="py-8 text-center">
            <span className="text-3xl" aria-hidden>👌</span>
            <p className="mt-2 text-sm font-bold text-zinc-200">Totul e la zi</p>
            <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-zinc-500">
              {res.data?.note ?? 'Nicio vizionare abandonată recent.'} Memento-urile apar automat când lași un
              titlu la jumătate mai mult de 3 zile.
            </p>
          </div>
        </PersoCard>
      ) : (
        <div className="space-y-2.5">
          {items.map((item) => (
            <ReminderRow key={item.contentId} item={item} onDismiss={(id) => void dismiss(id)} dismissing={dismissing === item.contentId} />
          ))}
        </div>
      )}

      <PersoHonestNote>
        Memento-urile se calculează on-demand din istoricul tău real de vizionare — zero notificări în
        fundal, zero interogări periodice (regula NEON FREE PLAN): deschizi tabul, vezi lista.
      </PersoHonestNote>
    </div>
  );
}
