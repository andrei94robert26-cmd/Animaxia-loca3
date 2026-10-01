'use client';

/**
 * navbar.tsx — Sticky top navigation with brand, quick search, platform
 * quick-links (Feed, Social, AI hub, Edge), auth state (sign-in button or
 * avatar dropdown with profile/premium/admin/logout). The grouped main menu
 * (Principal / Media / Live / … / Lumea) lives in the left sidebar on desktop
 * and in the mobile Sheet below lg (see sidebar.tsx).
 */

import { useEffect, useRef, useState } from 'react';
import {
  Bot,
  Clapperboard,
  CloudCog,
  Crown,
  Loader2,
  LogIn,
  LogOut,
  Rss,
  Search,
  ShieldCheck,
  Menu,
  MonitorPlay,
  Play,
  UserRound,
  Users,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { navigate, type AppRoute } from '@/lib/animaxia/router';
import { api } from '@/lib/animaxia/api';
import { useAuth } from '@/components/animaxia/auth-provider';
import { SidebarMenuContent } from './sidebar';
import { TypeBadge } from './states';
import { CommandKButton } from './command-palette'; // FAZA 33: declanșează paleta globală ⌘K
import { cn } from '@/lib/utils';

interface NavLink {
  label: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  match: (route: AppRoute | null) => boolean;
}

/** Sugestie în navbar: AR10M (id, titlu, an) sau legacy Neon (cu tip/rating). */
interface NavbarSuggestion {
  id: number;
  title: string;
  type: string;
  thumbnail?: string | null;
  rating?: number | null;
  catalog?: 'ar10m' | 'legacy';
  year?: number | null;
}

/** Compact platform quick-links (icon buttons, all breakpoints). */
const QUICK_LINKS: { label: string; href: string; icon: React.ComponentType<{ className?: string }>; matchView: string }[] = [
  { label: 'Feed de activitate', href: '/feed', icon: Rss, matchView: 'feed' },
  { label: 'Social', href: '/social', icon: Users, matchView: 'social' },
  { label: 'Hub AI', href: '/ai', icon: Bot, matchView: 'ai' },
  { label: 'Strat Edge', href: '/edge', icon: CloudCog, matchView: 'edge' },
];

export function Navbar({ route }: { route: AppRoute | null }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const { user, initializing, isAdmin, logout } = useAuth();

  /* TS2b + AR10M: navbar autocomplete — debounce 250ms, ≥2 caractere, max 6
     sugestii. Calea principală: sugestiile reale AR10M (catalog fuzionat);
     fallback transparent pe autocomplete-ul legacy Neon FTS. */
  const [acOpen, setAcOpen] = useState(false);
  const [acItems, setAcItems] = useState<NavbarSuggestion[]>([]);
  const [acLoading, setAcLoading] = useState(false);
  const [acHighlight, setAcHighlight] = useState(-1);

  /* FAZA 29-P (PLAN 100X): hover/keyboard prefetch — la hover sau săgeți pe o
   * sugestie, încălzim în fundal căutarea completă prin stratul accel, cu
   * semnătura EXACTĂ pe care o va cere search-view la click (sort=score,
   * limit=24, page=1). La click rezultatul vine din cache în ~2ms. */
  const prefetchedRef = useRef<Set<string>>(new Set());

  const prefetchSuggestion = (title?: string) => {
    if (!title || prefetchedRef.current.has(title)) return;
    prefetchedRef.current.add(title);
    void api.searchPrefetch({ q: title, sort: 'score', limit: 24, page: 1 });
  };

  useEffect(() => {
    const q = query.trim();
    if (!acOpen || q.length < 2) {
      setAcItems([]);
      setAcLoading(false);
      setAcHighlight(-1);
      return undefined;
    }
    setAcLoading(true);
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        /* Motorul real AR10M — id, titlu, an (fără thumbnail în contract). */
        const res = await api.ar10mSuggest(q);
        if (!cancelled) {
          setAcItems(
            res.suggestions.slice(0, 6).map((s) => ({
              id: s.id,
              title: s.title,
              type: 'titlu',
              thumbnail: null,
              rating: null,
              catalog: 'ar10m' as const,
              year: s.year,
            })),
          );
          setAcHighlight(-1);
        }
      } catch {
        /* Fallback onest: autocomplete legacy Neon FTS. */
        try {
          const legacy = await api.searchAutocomplete(q);
          if (!cancelled) {
            setAcItems(legacy.suggestions.slice(0, 6));
            setAcHighlight(-1);
          }
        } catch {
          if (!cancelled) setAcItems([]);
        }
      } finally {
        if (!cancelled) setAcLoading(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, acOpen]);

  function pickNavbarSuggestion(s: NavbarSuggestion) {
    setAcOpen(false);
    setQuery('');
    navigate(`/search?q=${encodeURIComponent(s.title)}`);
  }

  function handleAcKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      setAcOpen(false);
      return;
    }
    if (!acItems.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setAcOpen(true);
      const next = (acHighlight + 1) % acItems.length;
      setAcHighlight(next);
      prefetchSuggestion(acItems[next]?.title); // FAZA 29-P: warming predictiv și la tastatură
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const next = acHighlight <= 0 ? acItems.length - 1 : acHighlight - 1;
      setAcHighlight(next);
      prefetchSuggestion(acItems[next]?.title); // FAZA 29-P: warming predictiv și la tastatură
    } else if (e.key === 'Enter' && acHighlight >= 0 && acItems[acHighlight]) {
      e.preventDefault();
      pickNavbarSuggestion(acItems[acHighlight]);
    }
  }

  const showDropdown = acOpen && query.trim().length >= 2;

  const submitSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    navigate(q ? `/search?q=${encodeURIComponent(q)}` : '/search');
    setQuery('');
    setAcOpen(false);
    setOpen(false);
  };

  const handleLogout = async () => {
    await logout();
    navigate('/home');
  };

  const mobileExtraLinks: NavLink[] = [
    { label: 'Feed de activitate', href: '/feed', icon: Rss, match: (r) => r?.view === 'feed' },
    { label: 'Social', href: '/social', icon: Users, match: (r) => r?.view === 'social' },
    { label: 'Hub AI', href: '/ai', icon: Bot, match: (r) => r?.view === 'ai' },
    { label: 'Strat Edge', href: '/edge', icon: CloudCog, match: (r) => r?.view === 'edge' },
    { label: 'Planuri Premium', href: '/premium', icon: Crown, match: (r) => r?.view === 'premium' },
    ...(isAdmin
      ? [{ label: 'Panou Admin', href: '/admin', icon: ShieldCheck, match: (r: AppRoute | null) => r?.view === 'admin' }]
      : []),
    ...(user
      ? [{ label: 'Profilul meu', href: '/profile', icon: UserRound, match: (r: AppRoute | null) => r?.view === 'profile' }]
      : []),
  ];

  return (
    <header className="sticky top-0 z-50 border-b border-white/10 bg-[#0a0a10]/85 backdrop-blur-xl">
      <nav aria-label="Navigație principală" className="mx-auto flex h-16 w-full max-w-7xl items-center gap-3 px-4 sm:px-6 lg:px-8">
        <button
          type="button"
          onClick={() => navigate('/home')}
          className="flex items-center gap-2.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60 rounded-lg"
          aria-label="Acasă Animaxia"
        >
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-rose-500 to-fuchsia-600 shadow-lg shadow-rose-900/40">
            <Play className="h-4.5 w-4.5 fill-white text-white" aria-hidden />
          </span>
          <span className="flex flex-col items-start leading-none">
            <span className="text-lg font-black tracking-tight text-white">
              ANIMA<span className="text-rose-400">XIA</span>
            </span>
            <span className="hidden text-[10px] font-medium uppercase tracking-[0.2em] text-zinc-500 sm:block">
              Vizionează totul
            </span>
          </span>
        </button>

        <div className="ml-auto flex items-center gap-1.5">
          {QUICK_LINKS.map((quick) => {
            const Icon = quick.icon;
            const active = route?.view === quick.matchView;
            return (
              <Button
                key={quick.href}
                variant="ghost"
                size="icon"
                aria-label={quick.label}
                title={quick.label}
                onClick={() => navigate(quick.href)}
                className={cn(
                  'hidden text-zinc-400 hover:bg-white/5 hover:text-white 2xl:inline-flex',
                  active && 'bg-rose-500/15 text-rose-300',
                )}
              >
                <Icon className="h-5 w-5" aria-hidden />
              </Button>
            );
          })}

          {/* FAZA 33 (PLAN 100X · WS3): buton „⌘K" — deschide paleta globală
              (eveniment custom; paleta e montată global în page.tsx). */}
          <CommandKButton />

          <form onSubmit={submitSearch} className="hidden md:block" role="search">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" aria-hidden />
              <Input
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setAcOpen(true);
                  setAcHighlight(-1);
                }}
                onFocus={() => setAcOpen(true)}
                onBlur={() => {
                  /* delayed close so option clicks land before the blur */
                  window.setTimeout(() => setAcOpen(false), 150);
                }}
                onKeyDown={handleAcKeyDown}
                placeholder="Caută titluri, anime, filme…"
                aria-label="Caută titluri"
                aria-autocomplete="list"
                aria-expanded={showDropdown}
                aria-controls={showDropdown ? 'navbar-suggestions' : undefined}
                className="h-9 w-40 border-white/10 bg-white/5 pl-9 pr-9 text-sm text-zinc-100 placeholder:text-zinc-500 focus-visible:ring-rose-500/50 2xl:w-52"
              />
              {acLoading && query.trim().length >= 2 && (
                <Loader2
                  className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-zinc-500"
                  aria-hidden
                />
              )}

              {/* TS2b: autocomplete dropdown (Neon FTS prefix + trigram) */}
              {showDropdown && (
                <div
                  id="navbar-suggestions"
                  role="listbox"
                  aria-label="Sugestii de căutare"
                  className="custom-scrollbar absolute inset-x-0 top-full z-50 mt-2 max-h-80 w-72 max-w-[80vw] overflow-y-auto rounded-xl border border-white/10 bg-[#12121c] shadow-2xl shadow-black/60"
                >
                  {acLoading ? (
                    <div className="flex items-center gap-2 px-4 py-3 text-sm text-zinc-500">
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Caut…
                    </div>
                  ) : acItems.length === 0 ? (
                    <p className="px-4 py-3 text-sm text-zinc-500">
                      Niciun rezultat — Enter pentru căutare completă
                    </p>
                  ) : (
                    acItems.map((s, i) => (
                      <button
                        key={s.id}
                        type="button"
                        role="option"
                        aria-selected={acHighlight === i}
                        onMouseEnter={() => setAcHighlight(i)}
                        onMouseOver={() => prefetchSuggestion(s.title)} // FAZA 29-P: warming predictiv la hover
                        onFocus={() => prefetchSuggestion(s.title)} // FAZA 29-P: și la navigarea cu tastatura
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => pickNavbarSuggestion(s)}
                        className={cn(
                          'flex w-full items-center gap-3 px-3 py-2 text-left transition',
                          acHighlight === i ? 'bg-white/[0.06]' : 'hover:bg-white/[0.06]',
                        )}
                      >
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-200">{s.title}</span>
                        {s.catalog === 'ar10m' ? (
                          <span className="flex shrink-0 items-center gap-1.5">
                            {s.year != null ? (
                              <span className="font-mono text-[10px] text-zinc-500">{s.year}</span>
                            ) : null}
                            <span className="rounded-full border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-[9px] font-black uppercase tracking-wider text-rose-300">
                              AR10M
                            </span>
                          </span>
                        ) : (
                          <TypeBadge type={s.type} />
                        )}
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          </form>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Căutare"
            onClick={() => navigate('/search')}
            className="text-zinc-400 hover:bg-white/5 hover:text-white md:hidden"
          >
            <Search className="h-5 w-5" aria-hidden />
          </Button>

          {/* Auth area */}
          {initializing ? (
            <span className="ml-1 hidden h-8 w-8 animate-pulse rounded-full bg-white/10 sm:block" aria-hidden />
          ) : user ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="Meniu cont"
                  className="ml-1 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60"
                >
                  <Avatar className="h-8 w-8 border border-white/15">
                    {user.avatar?.startsWith('data:') || user.avatar?.startsWith('http') || user.avatar?.startsWith('/') ? (
                      <AvatarImage src={user.avatar} alt={user.username} />
                    ) : null}
                    <AvatarFallback className="bg-gradient-to-br from-rose-500 to-fuchsia-600 text-xs font-black text-white">
                      {user.username.slice(0, 2).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52 border-white/10 bg-[#12121c] text-zinc-100">
                <DropdownMenuLabel className="flex flex-col gap-0.5">
                  <span className="text-sm font-bold">{user.username}</span>
                  <span className="flex items-center gap-1.5 text-xs font-normal text-zinc-400">
                    {user.plan !== 'free' && <Crown className="h-3 w-3 text-amber-400" aria-hidden />}
                    {user.plan === 'free' ? 'Plan Free' : `Plan ${user.plan.charAt(0).toUpperCase()}${user.plan.slice(1)}`}
                    {isAdmin && <span className="rounded bg-rose-500/20 px-1 text-[10px] font-bold text-rose-300">ADMIN</span>}
                  </span>
                </DropdownMenuLabel>
                <DropdownMenuSeparator className="bg-white/10" />
                <DropdownMenuItem onClick={() => navigate('/profile')} className="gap-2">
                  <UserRound className="h-4 w-4" aria-hidden /> Profilul meu
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => navigate('/premium')} className="gap-2">
                  <Crown className="h-4 w-4" aria-hidden /> Planuri Premium
                </DropdownMenuItem>
                {isAdmin && (
                  <DropdownMenuItem onClick={() => navigate('/admin')} className="gap-2">
                    <ShieldCheck className="h-4 w-4" aria-hidden /> Panou Admin
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator className="bg-white/10" />
                <DropdownMenuItem onClick={handleLogout} className="gap-2 text-rose-400 focus:text-rose-300">
                  <LogOut className="h-4 w-4" aria-hidden /> Deconectare
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <Button
              onClick={() => navigate('/auth')}
              className="ml-1 hidden bg-rose-600 font-bold hover:bg-rose-500 sm:inline-flex"
              size="sm"
            >
              <LogIn className="mr-1.5 h-4 w-4" aria-hidden />
              Conectare
            </Button>
          )}

          <Button
            variant="ghost"
            size="icon"
            aria-label="Panou Admin"
            onClick={() => navigate('/admin')}
            className={cn(
              'hidden text-zinc-400 hover:bg-white/5 hover:text-white 2xl:inline-flex',
              route?.view === 'admin' && 'bg-rose-500/15 text-rose-300',
            )}
          >
            <ShieldCheck className="h-5 w-5" aria-hidden />
          </Button>

          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Deschide meniul"
                className="text-zinc-300 hover:bg-white/5 hover:text-white lg:hidden"
              >
                <Menu className="h-5 w-5" aria-hidden />
              </Button>
            </SheetTrigger>
            <SheetContent
              side="right"
              className="flex w-80 flex-col border-white/10 bg-[#0d0d14] text-zinc-100"
            >
              <SheetTitle className="flex items-center gap-2 px-1 text-base font-black tracking-tight">
                <Clapperboard className="h-5 w-5 text-rose-400" aria-hidden />
                ANIMAXIA
                <span className="ml-auto text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                  196 țări • 6 continente
                </span>
              </SheetTitle>
              <div className="custom-scrollbar mt-2 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-1 pb-4">
                <form onSubmit={submitSearch} className="px-2" role="search">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" aria-hidden />
                    <Input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Caută titluri, anime, filme…"
                      aria-label="Caută titluri"
                      className="h-10 border-white/10 bg-white/5 pl-9 text-sm"
                    />
                  </div>
                </form>

                {/* Grouped main menu (Principal → Lumea) + footer actions */}
                <SidebarMenuContent route={route} onNavigate={() => setOpen(false)} showFooter={false} />

                <div className="mt-1">
                  <p className="mb-1.5 px-3 text-[10px] font-bold uppercase tracking-[0.18em] text-zinc-500">
                    Platformă
                  </p>
                  <ul className="flex flex-col gap-0.5">
                    {mobileExtraLinks.map((link) => {
                      const Icon = link.icon;
                      const active = link.match(route);
                      return (
                        <li key={link.href}>
                          <button
                            type="button"
                            onClick={() => {
                              navigate(link.href);
                              setOpen(false);
                            }}
                            className={cn(
                              'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium transition',
                              active ? 'bg-rose-500/15 text-rose-300' : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-100',
                            )}
                          >
                            <Icon className="h-4.5 w-4.5" aria-hidden />
                            {link.label}
                          </button>
                        </li>
                      );
                    })}
                    <li>
                      <button
                        type="button"
                        onClick={() => {
                          navigate('/category/mined');
                          setOpen(false);
                        }}
                        className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium text-zinc-400 transition hover:bg-white/5 hover:text-zinc-100"
                      >
                        <MonitorPlay className="h-4.5 w-4.5" aria-hidden />
                        Conținut minat
                      </button>
                    </li>
                  </ul>
                </div>

                {user ? (
                  <button
                    type="button"
                    onClick={async () => {
                      setOpen(false);
                      await handleLogout();
                    }}
                    className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium text-rose-400 transition hover:bg-rose-500/10"
                  >
                    <LogOut className="h-4.5 w-4.5" aria-hidden />
                    Deconectare ({user.username})
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      navigate('/auth');
                      setOpen(false);
                    }}
                    className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-bold text-white transition hover:bg-rose-500/15"
                  >
                    <LogIn className="h-4.5 w-4.5 text-rose-400" aria-hidden />
                    Conectare / Creează cont
                  </button>
                )}
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </nav>
    </header>
  );
}
