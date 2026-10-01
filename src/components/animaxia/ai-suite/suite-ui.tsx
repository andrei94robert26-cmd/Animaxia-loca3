'use client';

/**
 * ai-suite/suite-ui.tsx — FAZA 32 (AI SUITE 100X): atomi UI comuni pentru
 * cele 18 panouri. Urmează stilul AI Hub (FAZA 16): dark, accente rose,
 * provider chip onest, date mereu etichetate cu sursa reală.
 */

import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';

/* ------------------------------ provider chip ----------------------------- */

const PROVIDER_STYLES: Record<string, string> = {
  'z-ai': 'border-rose-500/40 bg-rose-500/15 text-rose-300',
  mixed: 'border-fuchsia-500/40 bg-fuchsia-500/15 text-fuchsia-300',
  heuristic: 'border-zinc-500/40 bg-zinc-500/15 text-zinc-300',
  sql: 'border-teal-500/40 bg-teal-500/15 text-teal-300',
  http: 'border-teal-500/40 bg-teal-500/15 text-teal-300',
  provider: 'border-amber-500/40 bg-amber-500/15 text-amber-300',
};

export function ProviderChip({ provider }: { provider: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px] font-bold',
        PROVIDER_STYLES[provider] ?? PROVIDER_STYLES.heuristic,
      )}
      title={`Provider de date: ${provider}`}
    >
      {provider}
    </span>
  );
}

/* -------------------------------- stat card -------------------------------- */

export function StatCard({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: 'default' | 'good' | 'warn' | 'bad';
}) {
  const toneClass =
    tone === 'good'
      ? 'text-emerald-300'
      : tone === 'warn'
        ? 'text-amber-300'
        : tone === 'bad'
          ? 'text-rose-300'
          : 'text-white';
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3.5">
      <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-zinc-500">{label}</p>
      <p className={cn('mt-1 text-2xl font-black tabular-nums', toneClass)}>{value}</p>
      {hint ? <p className="mt-0.5 text-[11px] leading-tight text-zinc-500">{hint}</p> : null}
    </div>
  );
}

/* ------------------------------ bar (0-100 pct) ----------------------------- */

export function PctBar({ pct, label }: { pct: number; label?: string }) {
  const clamped = Math.max(0, Math.min(100, pct));
  const tone = clamped >= 80 ? 'bg-emerald-500' : clamped >= 50 ? 'bg-amber-500' : 'bg-rose-500';
  return (
    <div className="min-w-0 flex-1">
      {label ? (
        <div className="mb-1 flex items-baseline justify-between gap-2">
          <span className="truncate text-xs font-medium text-zinc-300">{label}</span>
          <span className="shrink-0 font-mono text-[11px] font-bold tabular-nums text-zinc-400">
            {clamped.toFixed(1)}%
          </span>
        </div>
      ) : null}
      <div className="h-1.5 overflow-hidden rounded-full bg-white/10" role="progressbar" aria-valuenow={Math.round(clamped)} aria-valuemin={0} aria-valuemax={100} aria-label={label ?? 'procent'}>
        <div className={cn('h-full rounded-full transition-all', tone)} style={{ width: `${clamped}%` }} />
      </div>
    </div>
  );
}

/* ------------------------------ count bar row ------------------------------ */

export function CountBar({
  label,
  count,
  max,
  right,
}: {
  label: React.ReactNode;
  count: number;
  max: number;
  right?: React.ReactNode;
}) {
  const width = max > 0 ? Math.max(2, (count / max) * 100) : 0;
  return (
    <div className="flex items-center gap-3">
      <div className="w-40 shrink-0 truncate text-xs text-zinc-300">{label}</div>
      <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-white/10">
        <div className="h-full rounded-full bg-gradient-to-r from-rose-500 to-fuchsia-500" style={{ width: `${width}%` }} />
      </div>
      <div className="w-14 shrink-0 text-right font-mono text-[11px] font-bold tabular-nums text-zinc-400">{right ?? count}</div>
    </div>
  );
}

/* ------------------------------- note strip -------------------------------- */

export function NoteStrip({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-xl border border-white/10 bg-white/[0.02] px-3.5 py-2.5 text-[11px] leading-relaxed text-zinc-500">
      {children}
    </p>
  );
}

/* ------------------------------ panel skeleton ----------------------------- */

export function PanelSkeleton() {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-[76px] rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-32 rounded-xl" />
      <Skeleton className="h-24 rounded-xl" />
    </div>
  );
}

/* ------------------------------- ai digest box ------------------------------ */

export function AiDigest({ text, provider }: { text: string | null | undefined; provider?: string }) {
  if (!text) return null;
  return (
    <div className="rounded-xl border border-rose-500/25 bg-rose-500/[0.06] p-4">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-base leading-none" aria-hidden>
          🤖
        </span>
        <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-rose-300/90">Narațiune AI</span>
        {provider ? <ProviderChip provider={provider} /> : null}
      </div>
      <p className="text-sm leading-relaxed text-zinc-200">{text}</p>
    </div>
  );
}

/* ------------------------------ simple key list ----------------------------- */

export function KeyValueRow({ k, v, mono = false }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-white/5 py-1.5 last:border-0">
      <span className="text-xs text-zinc-500">{k}</span>
      <span className={cn('text-right text-xs font-semibold text-zinc-200', mono && 'font-mono tabular-nums')}>{v}</span>
    </div>
  );
}
