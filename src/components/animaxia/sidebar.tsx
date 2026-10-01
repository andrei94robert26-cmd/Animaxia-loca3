'use client';

/**
 * sidebar.tsx — Grouped left navigation, the platform's main menu:
 * Principal / AI Metadata / Media / Live / Cont / Universuri / Canale Kids /
 * TV & Show-biz / Lumea — 196 țări. Desktop renders a sticky sidebar; the
 * mobile Sheet in the navbar renders the same SidebarMenuContent. Footer
 * mirrors the blueprint: "Conectează-te pentru a salva favoritele și progresul"
 * + Adaugă / Neon Sync / Conectare actions.
 *
 * FAZA 15 — the 'ai-metadata' group renders as collapsible submenus whose
 * values come live from the AI metadata extractor (/api/ai/home/metadata).
 */

import { useMemo, useState } from 'react';
import { ChevronDown, Globe2, LogIn, Plus, RefreshCw, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/animaxia/api';
import { useApi } from '@/lib/animaxia/hooks';
import { MENU_GROUPS, type MenuEntry, type MenuGroup } from '@/lib/animaxia/menu';
import type { AppRoute } from '@/lib/animaxia/router';
import { navigate } from '@/lib/animaxia/router';
import type { AiMetadataResponse, MetaDimension } from '@/lib/animaxia/types';
import { useAuth } from './auth-provider';
import { AddContentDialog } from './home-panels';
import { cn } from '@/lib/utils';

/* --------------------------- shared menu content -------------------------- */

export function SidebarMenuContent({
  route,
  onNavigate,
  showFooter = true,
}: {
  route: AppRoute | null;
  onNavigate?: () => void;
  showFooter?: boolean;
}) {
  const { user } = useAuth();
  const [addOpen, setAddOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);

  /* FAZA 15 — AI Metadata values (silent failure: group falls back to
     skeletons, then a subtle retry). */
  const metaRes = useApi('ai-home-metadata-sidebar', () => api.aiHome.metadata());

  const go = (href: string) => {
    navigate(href);
    onNavigate?.();
  };

  const neonSync = async () => {
    setSyncing(true);
    try {
      const health = await api.health();
      toast.success('Neon Sync complet', {
        description: `${health.db.totalItems.toLocaleString('ro-RO')} titluri în Neon · driver: ${health.db.driver}`,
      });
    } catch {
      toast.error('Neon Sync a eșuat', { description: 'Backend-ul nu răspunde — încearcă din nou.' });
    } finally {
      setSyncing(false);
    }
  };

  return (
    <>
      <nav aria-label="Sidebar navigation" className="flex flex-col gap-5">
        {MENU_GROUPS.map((group) =>
          group.id === 'ai-metadata' ? (
            <MetaDimGroup
              key={group.id}
              group={group}
              route={route}
              metadata={metaRes.data}
              loading={metaRes.loading}
              error={metaRes.error}
              onRetry={() => void metaRes.refetch()}
              onNavigate={onNavigate}
            />
          ) : group.id === 'ai-suite' ? (
            <AiSuiteGroup key={group.id} group={group} route={route} onNavigate={onNavigate} />
          ) : group.id === 'ai-lab' ? (
            <AiLabGroup key={group.id} group={group} route={route} onNavigate={onNavigate} />
          ) : group.id === 'perso' ? (
            <PersoGroup key={group.id} group={group} route={route} onNavigate={onNavigate} />
          ) : (
            <div key={group.id}>
              <p className="mb-1.5 px-3 text-[10px] font-bold uppercase tracking-[0.18em] text-zinc-500">
                {group.label}
              </p>
              <ul className="flex flex-col gap-0.5">
                {group.entries.map((entry) => (
                  <li key={entry.id}>
                    <MenuButton entry={entry} route={route} onClick={() => go(entry.href)} />
                  </li>
                ))}
              </ul>
            </div>
          ),
        )}
      </nav>

      {showFooter && (
        <div className="mt-auto space-y-3 pt-4">
          <div className="flex gap-2">
            <Button
              onClick={() => {
                onNavigate?.();
                setAddOpen(true);
              }}
              className="h-10 flex-1 bg-rose-600 text-sm font-bold hover:bg-rose-500"
            >
              <Plus className="mr-1.5 h-4 w-4" aria-hidden />
              Adaugă
            </Button>
            <Button
              onClick={neonSync}
              disabled={syncing}
              variant="outline"
              className="h-10 flex-1 border-white/15 bg-white/5 text-sm font-semibold text-zinc-200 hover:bg-white/10 hover:text-white"
            >
              <RefreshCw className={cn('mr-1.5 h-4 w-4', syncing && 'animate-spin')} aria-hidden />
              Neon Sync
            </Button>
          </div>
          {user ? (
            <Button
              variant="ghost"
              onClick={() => go('/profile')}
              className="h-10 w-full justify-start px-3 text-sm font-semibold text-zinc-300 hover:bg-white/5 hover:text-white"
            >
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-gradient-to-br from-rose-500 to-fuchsia-600 text-[10px] font-black text-white">
                {user.username.slice(0, 2).toUpperCase()}
              </span>
              <span className="truncate">{user.username}</span>
            </Button>
          ) : (
            <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
              <p className="text-xs leading-relaxed text-zinc-400">
                Conectează-te pentru a salva favoritele și progresul.
              </p>
              <Button
                onClick={() => go('/auth')}
                className="mt-2.5 h-9 w-full bg-rose-600 text-sm font-bold hover:bg-rose-500"
              >
                <LogIn className="mr-1.5 h-4 w-4" aria-hidden />
                Conectare
              </Button>
            </div>
          )}
        </div>
      )}

      <AddContentDialog open={addOpen} onOpenChange={setAddOpen} />
    </>
  );
}

function MenuButton({ entry, route, onClick }: { entry: MenuEntry; route: AppRoute | null; onClick: () => void }) {
  const active = entry.match(route);
  const Icon = entry.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60',
        active ? 'bg-rose-500/15 text-rose-300' : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-100',
      )}
    >
      {entry.emoji ? (
        <span className="w-4.5 shrink-0 text-center text-base leading-none" aria-hidden>
          {entry.emoji}
        </span>
      ) : Icon ? (
        <Icon className="h-4.5 w-4.5 shrink-0" aria-hidden />
      ) : (
        <span className="w-4.5 shrink-0" aria-hidden />
      )}
      <span className="truncate">{entry.label}</span>
    </button>
  );
}

/* --------------------- FAZA 15: AI Metadata submenus ---------------------- */

/** Sidebar display caps per dimension (backend already orders the lists). */
const META_DIM_CAPS: Partial<Record<MetaDimension, number>> = {
  actor: 24,
  genre: 30,
  year: 30,
};

/** The 'ai-metadata' group: each entry is a collapsible of extracted values. */
function MetaDimGroup({
  group,
  route,
  metadata,
  loading,
  error,
  onRetry,
  onNavigate,
}: {
  group: MenuGroup;
  route: AppRoute | null;
  metadata: AiMetadataResponse | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onNavigate?: () => void;
}) {
  return (
    <div>
      <p className="mb-1.5 px-3 text-[10px] font-bold uppercase tracking-[0.18em] text-zinc-500">
        {group.label}
      </p>
      {loading && !metadata ? (
        <div className="space-y-1.5 px-3" aria-busy="true">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-full rounded-lg" />
          ))}
        </div>
      ) : error && !metadata ? (
        <div className="px-3">
          <button
            type="button"
            onClick={onRetry}
            className="flex w-full items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-xs font-medium text-zinc-400 transition hover:border-rose-500/40 hover:text-rose-300"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
            AI Metadata indisponibil — reîncearcă
          </button>
        </div>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {group.entries.map((entry) => (
            <li key={entry.id}>
              {entry.metaDim ? (
                <MetaDimCollapsible
                  entry={entry}
                  route={route}
                  values={metadata?.dimensions[entry.metaDim] ?? []}
                  onNavigate={onNavigate}
                />
              ) : (
                <MenuButton entry={entry} route={route} onClick={() => navigate(entry.href)} />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MetaDimCollapsible({
  entry,
  route,
  values,
  onNavigate,
}: {
  entry: MenuEntry;
  route: AppRoute | null;
  values: { value: string; count: number }[];
  onNavigate?: () => void;
}) {
  const dim = entry.metaDim as MetaDimension;
  const [open, setOpen] = useState(false);
  const active = entry.match(route);

  const shown = useMemo(() => {
    const cap = META_DIM_CAPS[dim];
    return cap ? values.slice(0, cap) : values;
  }, [values, dim]);

  const isActiveValue = (value: string) =>
    route?.view === 'meta' &&
    route.params[0] === dim &&
    (route.params[1] || '').toLowerCase() === value.toLowerCase();

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        className={cn(
          'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60',
          active ? 'bg-rose-500/15 text-rose-300' : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-100',
        )}
      >
        {entry.emoji ? (
          <span className="w-4.5 shrink-0 text-center text-base leading-none" aria-hidden>
            {entry.emoji}
          </span>
        ) : (
          <span className="w-4.5 shrink-0" aria-hidden />
        )}
        <span className="truncate">{entry.label}</span>
        <Badge
          className={cn(
            'ml-auto h-5 shrink-0 rounded-full px-1.5 text-[10px] font-bold',
            shown.length > 0
              ? 'border-rose-500/30 bg-rose-500/10 text-rose-200'
              : 'border-white/10 bg-white/5 text-zinc-500',
          )}
        >
          {shown.length > 0 ? shown.length : '—'}
        </Badge>
        <ChevronDown
          className={cn('h-4 w-4 shrink-0 text-zinc-500 transition-transform duration-200', open && 'rotate-180')}
          aria-hidden
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="custom-scrollbar ml-6 max-h-52 space-y-0.5 overflow-y-auto border-l border-white/10 py-1 pl-2">
          {shown.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-zinc-500">AI extrage valorile…</p>
          ) : (
            shown.map((v) => (
              <button
                key={v.value}
                type="button"
                onClick={() => {
                  navigate(`/meta/${dim}/${encodeURIComponent(v.value)}`);
                  onNavigate?.();
                }}
                className={cn(
                  'flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60',
                  isActiveValue(v.value)
                    ? 'bg-rose-500/15 font-semibold text-rose-300'
                    : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-100',
                )}
              >
                <span className="truncate">{v.value}</span>
                <span className="shrink-0 text-[10px] font-semibold text-zinc-600">{v.count}</span>
              </button>
            ))
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/* ------------------------- FAZA 35: AI LAB group -------------------------- */

/** The 'ai-lab' group: one collapsible holding all 8 capability entries —
 *  same treatment as the AI SUITE group (keeps the sidebar compact). */
function AiLabGroup({
  group,
  route,
  onNavigate,
}: {
  group: MenuGroup;
  route: AppRoute | null;
  onNavigate?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const anyActive = route?.view === 'ai-lab';
  return (
    <div>
      <p className="mb-1.5 px-3 text-[10px] font-bold uppercase tracking-[0.18em] text-zinc-500">{group.label}</p>
      <Collapsible open={open || !!anyActive} onOpenChange={setOpen}>
        <CollapsibleTrigger
          className={cn(
            'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60',
            anyActive ? 'text-emerald-300' : 'text-zinc-300 hover:bg-white/5 hover:text-white',
          )}
        >
          <span className="w-4.5 shrink-0 text-center text-base leading-none" aria-hidden>
            🧪
          </span>
          <span className="truncate">8 Capabilități AI</span>
          <Badge className="ml-auto h-5 shrink-0 rounded-full border-emerald-500/30 bg-emerald-500/10 px-1.5 text-[10px] font-bold text-emerald-200">
            8
          </Badge>
          <ChevronDown
            className={cn('h-4 w-4 shrink-0 text-zinc-500 transition-transform duration-200', (open || anyActive) && 'rotate-180')}
            aria-hidden
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="custom-scrollbar ml-6 max-h-72 space-y-0.5 overflow-y-auto border-l border-white/10 py-1 pl-2">
            {group.entries.map((entry) => (
              <MenuButton key={entry.id} entry={entry} route={route} onClick={() => { navigate(entry.href); onNavigate?.(); }} />
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

/* ------------------------- FAZA 36-R: PERSO group -------------------------- */

/** Grupul 'perso' (Personalizare & Recomandări 2.0): un collapsibil cu cele
 *  4 taburi — feed „Pentru Tine", profil de gust, profile cu PIN, memento-uri.
 *  Același tratament ca grupurile AI Lab / AI Suite (sidebar compact);
 *  auto-deschis când orice tab perso e activ. */
function PersoGroup({
  group,
  route,
  onNavigate,
}: {
  group: MenuGroup;
  route: AppRoute | null;
  onNavigate?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const anyActive = route?.view === 'perso';
  return (
    <div>
      <p className="mb-1.5 px-3 text-[10px] font-bold uppercase tracking-[0.18em] text-zinc-500">{group.label}</p>
      <Collapsible open={open || !!anyActive} onOpenChange={setOpen}>
        <CollapsibleTrigger
          className={cn(
            'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60',
            anyActive ? 'text-rose-300' : 'text-zinc-300 hover:bg-white/5 hover:text-white',
          )}
        >
          <span className="w-4.5 shrink-0 text-center text-base leading-none" aria-hidden>
            🎯
          </span>
          <span className="truncate">Personalizare 2.0</span>
          <Badge className="ml-auto h-5 shrink-0 rounded-full border-rose-500/30 bg-rose-500/10 px-1.5 text-[10px] font-bold text-rose-200">
            4
          </Badge>
          <ChevronDown
            className={cn('h-4 w-4 shrink-0 text-zinc-500 transition-transform duration-200', (open || anyActive) && 'rotate-180')}
            aria-hidden
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="custom-scrollbar ml-6 max-h-72 space-y-0.5 overflow-y-auto border-l border-white/10 py-1 pl-2">
            {group.entries.map((entry) => (
              <MenuButton key={entry.id} entry={entry} route={route} onClick={() => { navigate(entry.href); onNavigate?.(); }} />
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

/* ---------------------- FAZA 32: AI SUITE 100X group ----------------------- */

/** The 'ai-suite' group: one collapsible holding all 18 engine entries —
 *  keeps the sidebar compact (18 flat entries would be unreadable). */
function AiSuiteGroup({
  group,
  route,
  onNavigate,
}: {
  group: MenuGroup;
  route: AppRoute | null;
  onNavigate?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const anyActive = route?.view === 'ai-suite';
  return (
    <div>
      <p className="mb-1.5 px-3 text-[10px] font-bold uppercase tracking-[0.18em] text-zinc-500">{group.label}</p>
      <Collapsible open={open || !!anyActive} onOpenChange={setOpen}>
        <CollapsibleTrigger
          className={cn(
            'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60',
            anyActive ? 'text-rose-300' : 'text-zinc-300 hover:bg-white/5 hover:text-white',
          )}
        >
          <span className="w-4.5 shrink-0 text-center text-base leading-none" aria-hidden>
            🧠
          </span>
          <span className="truncate">18 Motoare AI</span>
          <Badge className="ml-auto h-5 shrink-0 rounded-full border-rose-500/30 bg-rose-500/10 px-1.5 text-[10px] font-bold text-rose-200">
            18
          </Badge>
          <ChevronDown
            className={cn('h-4 w-4 shrink-0 text-zinc-500 transition-transform duration-200', (open || anyActive) && 'rotate-180')}
            aria-hidden
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="custom-scrollbar ml-6 max-h-72 space-y-0.5 overflow-y-auto border-l border-white/10 py-1 pl-2">
            {group.entries.map((entry) => (
              <MenuButton key={entry.id} entry={entry} route={route} onClick={() => { navigate(entry.href); onNavigate?.(); }} />
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

/* ---------------------------- desktop sidebar ----------------------------- */

export function AppSidebar({ route }: { route: AppRoute | null }) {
  return (
    <aside
      aria-label="Main sidebar"
      className="sticky top-16 hidden h-[calc(100dvh-4rem)] w-64 shrink-0 flex-col border-r border-white/10 bg-[#0c0c13]/80 backdrop-blur-xl lg:flex"
    >
      {/* Brand header — 196 țări • 6 continente */}
      <div className="border-b border-white/10 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-rose-500 to-fuchsia-600 shadow-lg shadow-rose-900/40">
            <Upload className="h-4 w-4 text-white" aria-hidden />
          </span>
          <div className="min-w-0 leading-tight">
            <p className="truncate text-sm font-black tracking-tight text-white">
              ANIMA<span className="text-rose-400">XIA</span>
            </p>
            <p className="flex items-center gap-1 truncate text-[10px] font-medium text-zinc-500">
              <Globe2 className="h-3 w-3" aria-hidden /> 196 țări • 6 continente
            </p>
          </div>
        </div>
      </div>

      <div className="custom-scrollbar flex-1 overflow-y-auto px-3 py-4">
        <SidebarMenuContent route={route} showFooter={false} />
      </div>

      <div className="border-t border-white/10 px-3 py-3">
        <SidebarFooterActions route={route} />
      </div>
    </aside>
  );
}

/** Desktop footer actions (kept outside the scroll area). */
function SidebarFooterActions({ route }: { route: AppRoute | null }) {
  const { user } = useAuth();
  const [addOpen, setAddOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const neonSync = async () => {
    setSyncing(true);
    try {
      const health = await api.health();
      toast.success('Neon Sync complet', {
        description: `${health.db.totalItems.toLocaleString('ro-RO')} titluri în Neon · driver: ${health.db.driver}`,
      });
    } catch {
      toast.error('Neon Sync a eșuat', { description: 'Backend-ul nu răspunde — încearcă din nou.' });
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="space-y-2.5">
      <div className="flex gap-2">
        <Button
          onClick={() => setAddOpen(true)}
          className="h-10 flex-1 bg-rose-600 text-sm font-bold hover:bg-rose-500"
        >
          <Plus className="mr-1.5 h-4 w-4" aria-hidden />
          Adaugă
        </Button>
        <Button
          onClick={neonSync}
          disabled={syncing}
          variant="outline"
          className="h-10 flex-1 border-white/15 bg-white/5 text-sm font-semibold text-zinc-200 hover:bg-white/10 hover:text-white"
        >
          <RefreshCw className={cn('mr-1.5 h-4 w-4', syncing && 'animate-spin')} aria-hidden />
          Neon Sync
        </Button>
      </div>
      {user ? (
        <Button
          variant="ghost"
          onClick={() => navigate('/profile')}
          className={cn(
            'h-10 w-full justify-start px-3 text-sm font-semibold text-zinc-300 hover:bg-white/5 hover:text-white',
            route?.view === 'profile' && 'bg-rose-500/15 text-rose-300',
          )}
        >
          <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-gradient-to-br from-rose-500 to-fuchsia-600 text-[10px] font-black text-white">
            {user.username.slice(0, 2).toUpperCase()}
          </span>
          <span className="truncate">{user.username}</span>
        </Button>
      ) : (
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
          <p className="text-xs leading-relaxed text-zinc-400">
            Conectează-te pentru a salva favoritele și progresul.
          </p>
          <Button
            onClick={() => navigate('/auth')}
            className="mt-2.5 h-9 w-full bg-rose-600 text-sm font-bold hover:bg-rose-500"
          >
            <LogIn className="mr-1.5 h-4 w-4" aria-hidden />
            Conectare
          </Button>
        </div>
      )}
      <AddContentDialog open={addOpen} onOpenChange={setAddOpen} />
    </div>
  );
}
