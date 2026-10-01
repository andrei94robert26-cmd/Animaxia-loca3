'use client';

/**
 * views/perso-view.tsx — FAZA 36-R (PLAN 100X · WS6): panoul unic de
 * Personalizare & Recomandări 2.0 (#/perso/<tab>): „Pentru Tine" (feed cu
 * secțiuni explicite), „Profil de gust" (afinități învățate pasiv), „Profile"
 * (manager profiluri multiple cu PIN) și „Memento-uri" (încheieri abandonate).
 *
 * 100% aditiv — recomandările existente (FAZA 15/20/32) rămân neatinse.
 * Header onest cu stare live + Refresh manual exclusiv (regula NEON FREE
 * PLAN: zero auto-refresh, datele se încarcă la montare și la cerere).
 */

import { useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/animaxia/api';
import { useApi } from '@/lib/animaxia/hooks';
import { navigate, type AppRoute } from '@/lib/animaxia/router';
import { PERSO_TABS } from '@/lib/animaxia/menu';
import { Container, PageHeader } from '../section';
import { cn } from '@/lib/utils';
import { useAuth } from '../auth-provider';
import { FeedPanel } from '../perso/feed-panel';
import { ProfilePanel } from '../perso/profile-panel';
import { ProfilesPanel } from '../perso/profiles-panel';
import { RemindersPanel } from '../perso/reminders-panel';

/* ------------------------------ status ribbon ------------------------------ */

function PersoStatusRibbon() {
  const res = useApi('perso-status', () => api.persoStatus());
  const [open, setOpen] = useState(false);
  if (res.loading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3 text-sm text-zinc-500">
        <RefreshCw className="h-4 w-4 animate-spin" aria-hidden /> Se încarcă starea modulului de personalizare…
      </div>
    );
  }
  if (res.error) {
    return (
      <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
        Modulul perso e indisponibil: {res.error}
      </div>
    );
  }
  const d = res.data;
  if (!d) return null;
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-xl border border-white/10 bg-white/[0.02]">
      <div className="flex items-center gap-3 px-4 py-3">
        <span className="text-lg leading-none" aria-hidden>🎯</span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-zinc-100">
            Personalizare activă — {d.counters.eventsTracked.toLocaleString('ro-RO')} semnale învățate ·
            {' '}{d.cache.entries.toLocaleString('ro-RO')} profiluri în cache (TTL 10 min)
          </p>
          <p className="truncate text-[11px] text-zinc-500">
            {d.faza} · euristică deterministă (zero ML extern) · refresh exclusiv manual (NEON FREE PLAN)
          </p>
        </div>
        <Badge variant="outline" className="shrink-0 border-rose-500/30 bg-rose-500/10 text-rose-200">
          {d.routes} rute
        </Badge>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="h-8 gap-1 px-2 text-xs text-zinc-400">
            {open ? 'Ascunde' : 'Detalii'}
            <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} aria-hidden />
          </Button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent>
        <div className="grid gap-2 border-t border-white/5 p-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { label: 'Feed-uri generate', value: d.counters.feedRequests },
            { label: 'Profiluri create', value: d.counters.profilesCreated },
            { label: 'Verificări PIN', value: d.counters.profileVerifications },
            { label: 'Memento-uri ascunse', value: d.counters.remindersDismissed },
            { label: 'Evenimente view', value: d.counters.eventsByType.view },
            { label: 'Evenimente like', value: d.counters.eventsByType.like },
            { label: 'Evenimente complete', value: d.counters.eventsByType.complete },
            { label: 'Evenimente search', value: d.counters.eventsByType.search },
          ].map((c) => (
            <div key={c.label} className="rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2">
              <p className="text-sm font-black text-zinc-100">{c.value.toLocaleString('ro-RO')}</p>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">{c.label}</p>
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/* --------------------------------- the view --------------------------------- */

export function PersoView({ route }: { route: AppRoute }) {
  const tabParam = route.params[0];
  const validKeys = useMemo(() => PERSO_TABS.map((t) => t.key), []);
  const tab = tabParam && validKeys.includes(tabParam) ? tabParam : 'feed';
  const meta = PERSO_TABS.find((t) => t.key === tab);
  const [ribbonKey, setRibbonKey] = useState(0);
  const { user } = useAuth();

  return (
    <Container className="pb-16">
      <PageHeader
        title="Personalizare 2.0 🎯"
        subtitle="FAZA 36-R (WS6) — profil de gust învățat pasiv din semnale reale, feed „Pentru Tine” cu motive lizibile, profile multiple cu PIN și memento-uri de încheiere. Euristică deterministă, etichetată onest — zero ML extern."
      />

      <div className="mb-4">
        <PersoStatusRibbon key={ribbonKey} />
      </div>

      {/* Navigare orizontală între taburi (scroll pe mobil — ca la AI Lab) */}
      <nav aria-label="Navigare personalizare" className="mb-5 flex gap-2 overflow-x-auto pb-2">
        {PERSO_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => navigate(`/perso/${t.key}`)}
            aria-current={t.key === tab ? 'page' : undefined}
            className={cn(
              'flex shrink-0 items-center gap-1.5 rounded-full border px-3.5 py-2 text-xs font-bold transition',
              t.key === tab
                ? 'border-rose-500/50 bg-rose-500/15 text-rose-200'
                : 'border-white/10 bg-white/[0.03] text-zinc-400 hover:border-white/25 hover:text-zinc-100',
            )}
          >
            <span aria-hidden>{t.emoji}</span>
            {t.label}
          </button>
        ))}
      </nav>

      <section aria-label={meta?.label ?? tab}>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <h2 className="text-xl font-black text-white">
            <span aria-hidden className="mr-2">{meta?.emoji}</span>
            {meta?.label ?? tab}
          </h2>
          {user ? (
            <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-emerald-300">
              @ {user.username}
            </Badge>
          ) : null}
        </div>
        {tab === 'feed' ? <FeedPanel /> : null}
        {tab === 'taste' ? <ProfilePanel /> : null}
        {tab === 'profiles' ? <ProfilesPanel /> : null}
        {tab === 'reminders' ? <RemindersPanel /> : null}
      </section>
    </Container>
  );
}
