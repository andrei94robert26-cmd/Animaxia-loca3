'use client';

/**
 * perso/perso-ui.tsx — FAZA 36-R (PLAN 100X · WS6): atomi UI comuni pentru
 * cele 4 panouri de personalizare (feed, profil de gust, profile, memento-uri).
 * Stilul urmează AI Lab / AI Suite (FAZA 35/32): dark zinc-950, carduri
 * rounded-xl border-white/10 bg-white/[0.02], accent rose-600, zero culori
 * albastru/indigo. Toate datele sunt aduse la montare + Refresh manual
 * (regula NEON FREE PLAN — zero auto-refresh).
 */

import { Loader2, LogIn, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { navigate } from '@/lib/animaxia/router';
import type { PersoMethod } from '@/lib/animaxia/types';
import { cn } from '@/lib/utils';

/* ------------------------------ honest method chip ------------------------- */

/** Eticheta onestă a motorului perso: mereu „⚙️ euristică deterministă"
 *  (zero ML extern — backend-ul declară method.ml=false în orice răspuns). */
export function PersoMethodBadge({ method }: { method?: PersoMethod | null }) {
  if (!method) return null;
  return (
    <span
      title={`${method.engine} — ${method.note}`}
      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-bold text-amber-300"
    >
      ⚙️ {method.engine}
    </span>
  );
}

/* --------------------------------- cards ----------------------------------- */

export function PersoCard({
  title,
  hint,
  action,
  children,
  className,
}: {
  title?: string;
  hint?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('min-w-0 rounded-xl border border-white/10 bg-white/[0.02] p-4', className)}>
      {title || action ? (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            {title ? (
              <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-500">{title}</p>
            ) : null}
            {hint ? <p className="mt-0.5 text-[11px] leading-tight text-zinc-500">{hint}</p> : null}
          </div>
          {action ? <div className="shrink-0">{action}</div> : null}
        </div>
      ) : null}
      {children}
    </div>
  );
}

export function PersoNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-xs leading-relaxed text-zinc-400">
      {children}
    </div>
  );
}

/** Notă onestă de tip „info" (amber discret, la fel cu AI Lab). */
export function PersoHonestNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-4 py-3 text-sm leading-relaxed text-amber-100/90">
      ℹ️ {children}
    </div>
  );
}

/* ------------------------------- refresh button ---------------------------- */

/** Butonul standard de Refresh manual (pattern NEON FREE PLAN — vezi
 *  admin-shards-tab): datele se încarcă la montare și LA CERERE. */
export function PersoRefreshButton({
  onClick,
  loading,
  label = 'Reîmprospătează',
}: {
  onClick: () => void;
  loading?: boolean;
  label?: string;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={onClick}
      disabled={loading}
      className="h-9 gap-1.5 border-white/15 bg-white/5 text-xs font-semibold text-zinc-300 hover:bg-white/10 hover:text-white"
    >
      <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} aria-hidden />
      {label}
    </Button>
  );
}

/** Spinner + label pentru acțiuni în curs. */
export function PersoLoading({ label }: { label: string }) {
  return (
    <p className="flex items-center gap-2 py-3 text-sm text-zinc-400" aria-busy="true">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      {label}
    </p>
  );
}

/* -------------------------------- login prompt ----------------------------- */

/** Prompt de conectare onest — backend-ul răspunde 401 explicabil pentru
 *  anonimi fără ?user= (identical cu pattern-ul AI Lab recap). */
export function PersoLoginPrompt({
  title = 'Personalizarea are nevoie de contul tău',
  message = 'Profilul de gust, feed-ul „Pentru Tine", profilele cu PIN și memento-urile se construiesc din semnalele tale reale de vizionare — disponibil doar conectat.',
}: {
  title?: string;
  message?: string;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-6 text-center">
      <span className="mx-auto grid h-12 w-12 place-items-center rounded-xl border border-rose-500/30 bg-rose-500/10">
        <LogIn className="h-5 w-5 text-rose-300" aria-hidden />
      </span>
      <p className="mt-3 text-sm font-bold text-zinc-100">{title}</p>
      <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-zinc-500">{message}</p>
      <Button onClick={() => navigate('/auth')} className="mt-4 h-10 bg-rose-600 text-sm font-bold hover:bg-rose-500">
        Conectează-te
      </Button>
    </div>
  );
}

/* ------------------------------ section chips ------------------------------ */

export const PERSO_SECTION_META: Record<string, { label: string; emoji: string; chip: string }> = {
  continue: {
    label: 'Continuă să urmărești',
    emoji: '▶️',
    chip: 'border-teal-500/30 bg-teal-500/10 text-teal-200',
  },
  similar: {
    label: 'Pentru că ai văzut…',
    emoji: '🔗',
    chip: 'border-fuchsia-500/30 bg-fuchsia-500/10 text-fuchsia-200',
  },
  genre: {
    label: 'Genuri favorite',
    emoji: '🎭',
    chip: 'border-rose-500/30 bg-rose-500/10 text-rose-200',
  },
};

/** Badge-ul de reason de pe cardurile de feed — motivul lizibil recomandării. */
export function PersoReasonBadge({ reason, section }: { reason: string; section: string }) {
  const meta = PERSO_SECTION_META[section] ?? PERSO_SECTION_META.genre;
  return (
    <span
      className={cn('inline-flex items-start gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold', meta.chip)}
      title={`Motiv: ${reason}`}
    >
      <span aria-hidden>{meta.emoji}</span>
      <span className="min-w-0 truncate">{reason}</span>
    </span>
  );
}

/** Bara de afinitate (0-100) — gen/tip/deceniu cu procent normalizat onest. */
export function PersoAffinityBar({
  value,
  pct,
  detail,
  index,
}: {
  value: string;
  pct: number;
  detail?: string;
  index: number;
}) {
  const palette = ['bg-rose-500', 'bg-fuchsia-500', 'bg-teal-500', 'bg-amber-500', 'bg-emerald-500', 'bg-orange-500'];
  const bar = palette[index % palette.length];
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <p className="min-w-0 truncate text-xs font-semibold text-zinc-200">{value}</p>
        <span className="shrink-0 text-[11px] font-bold text-zinc-400">
          {pct}%{detail ? <span className="ml-1 font-normal text-zinc-600">· {detail}</span> : null}
        </span>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-white/10"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Afinitate ${value}`}
      >
        <div className={cn('h-full rounded-full', bar)} style={{ width: `${Math.max(2, Math.min(100, pct))}%` }} />
      </div>
    </div>
  );
}

/** Badge generic pentru contoare mici. */
export function PersoCountBadge({ children, tone = 'zinc' }: { children: React.ReactNode; tone?: 'zinc' | 'rose' | 'emerald' }) {
  const tones = {
    zinc: 'border-white/10 bg-white/5 text-zinc-300',
    rose: 'border-rose-500/30 bg-rose-500/10 text-rose-200',
    emerald: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200',
  };
  return (
    <Badge variant="outline" className={cn('h-5 rounded-full px-1.5 text-[10px] font-bold', tones[tone])}>
      {children}
    </Badge>
  );
}
