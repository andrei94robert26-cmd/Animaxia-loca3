'use client';

/**
 * mobile-view.tsx — Animaxia Mobile API showcase: a live phone-shaped preview
 * fed by /api/mobile/home, API documentation cards and a player-payload
 * inspector fed by /api/mobile/player/:id.
 */

import { useState } from 'react';
import {
  BatteryFull,
  BookOpen,
  Bot,
  Bookmark,
  BrainCircuit,
  Crown,
  Download,
  Film,
  FolderTree,
  House,
  MessageSquareText,
  MonitorPlay,
  Play,
  Search,
  Signal,
  Smartphone,
  Sparkles,
  Terminal,
  UserRound,
  Users,
  Wifi,
  WifiOff,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { platform, type MobileItem } from '@/lib/animaxia/platform';
import { useApi } from '@/lib/animaxia/hooks';
import type { AppRoute } from '@/lib/animaxia/router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { Container, PageHeader } from '../section';
import { EmptyState, ErrorState, RatingBadge, TypeBadge } from '../states';

/* ------------------------------ endpoints ------------------------------ */

const MOBILE_ENDPOINTS: { method: string; path: string; desc: string }[] = [
  { method: 'GET', path: '/api/mobile/home', desc: 'Hero + rânduri curate pentru ecranul de acasă' },
  { method: 'GET', path: '/api/mobile/player/:id', desc: 'Payload de stream pentru playerul nativ' },
  { method: 'GET', path: '/api/mobile/profile', desc: 'Cont, plan și statistici de vizionare' },
  { method: 'GET', path: '/api/mobile/config', desc: 'Versiuni și flag-uri de funcționalități' },
];

/* ---------------------------- phone helpers ---------------------------- */

function Thumb({ src, alt, className }: { src: string | null; alt: string; className?: string }) {
  if (src) {
    return (
      <img
        src={src}
        alt={alt}
        loading="lazy"
        className={cn('h-36 w-full rounded-lg border border-white/10 object-cover', className)}
      />
    );
  }
  return (
    <div
      className={cn(
        'grid h-36 w-full place-items-center rounded-lg border border-white/10 bg-gradient-to-br from-rose-600/30 to-fuchsia-600/20',
        className,
      )}
    >
      <Film className="h-6 w-6 text-rose-300/60" aria-hidden />
    </div>
  );
}

function PhoneMockup({
  hero,
  rows,
  selectedId,
  onSelect,
}: {
  hero: MobileItem | null;
  rows: { key: string; title: string; items: MobileItem[] }[];
  selectedId: number | null;
  onSelect: (item: MobileItem) => void;
}) {
  return (
    <div
      className="relative mx-auto flex h-[620px] w-[300px] flex-col overflow-hidden rounded-[2.8rem] border-[10px] border-zinc-800 bg-[#0a0a10] shadow-2xl shadow-black/60 sm:w-[340px]"
      aria-label="Animaxia mobile app preview"
    >
      {/* Notch */}
      <div className="absolute left-1/2 top-2 z-20 h-5 w-24 -translate-x-1/2 rounded-full bg-zinc-800" aria-hidden />

      {/* Status bar */}
      <div className="flex items-center justify-between px-5 pb-1 pt-3 text-[10px] font-medium text-zinc-400">
        <span>9:41</span>
        <span className="flex items-center gap-1.5">
          <Signal className="h-3.5 w-3.5" aria-hidden />
          <Wifi className="h-3.5 w-3.5" aria-hidden />
          <BatteryFull className="h-3.5 w-3.5" aria-hidden />
        </span>
      </div>

      {/* Scrollable app content */}
      <div className="no-scrollbar flex-1 space-y-5 overflow-y-auto p-3 pb-4">
        {/* Hero */}
        {hero ? (
          <div className="relative h-44 shrink-0 overflow-hidden rounded-2xl border border-white/10">
            {hero.backdrop ? (
              <img src={hero.backdrop} alt="" className="h-full w-full object-cover" />
            ) : (
              <div className="h-full w-full bg-gradient-to-br from-rose-600/40 to-fuchsia-600/30" />
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/30 to-transparent" />
            <div className="absolute inset-x-0 bottom-0 space-y-1.5 p-3">
              <h3 className="line-clamp-2 text-lg font-black leading-tight text-white">{hero.title}</h3>
              <div className="flex items-center gap-2">
                <TypeBadge type={hero.type} />
                <RatingBadge value={hero.rating} />
              </div>
            </div>
          </div>
        ) : (
          <div className="h-44 shrink-0 rounded-2xl bg-gradient-to-br from-rose-600/40 to-fuchsia-600/30" />
        )}

        {/* Rows */}
        {rows.map((row) => (
          <div key={row.key} className="space-y-2">
            <div className="flex items-center justify-between px-1">
              <p className="text-xs font-bold uppercase tracking-wide text-zinc-400">{row.title}</p>
              <span className="text-[10px] font-semibold text-rose-400">See all</span>
            </div>
            <div className="no-scrollbar flex gap-2 overflow-x-auto pb-1">
              {row.items.map((item) => (
                <button
                  key={`${row.key}-${item.id}`}
                  type="button"
                  onClick={() => onSelect(item)}
                  aria-label={`Open ${item.title}`}
                  className="w-24 shrink-0 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60"
                >
                  <Thumb
                    src={item.thumbnail}
                    alt={item.title}
                    className={cn(selectedId === item.id && 'ring-2 ring-rose-500')}
                  />
                  <p className="mt-1 line-clamp-2 text-[10px] font-medium leading-tight text-zinc-300">
                    {item.title}
                  </p>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Bottom tab bar (decorative) */}
      <div
        className="flex items-end justify-around border-t border-white/10 bg-[#0a0a10] px-2 py-2 text-zinc-500"
        aria-hidden
      >
        <House className="h-5 w-5" />
        <Search className="h-5 w-5" />
        <span className="-mt-6 grid h-12 w-12 place-items-center rounded-full bg-rose-600 text-white shadow-lg shadow-rose-900/50">
          <Play className="h-5 w-5 fill-white" />
        </span>
        <Film className="h-5 w-5" />
        <span className="grid h-5 w-5 place-items-center rounded-full bg-gradient-to-br from-rose-500/40 to-fuchsia-500/30 text-[8px] font-bold text-rose-200">
          A
        </span>
      </div>
    </div>
  );
}

/* --------------------------- player payload ---------------------------- */

function modeClass(mode: string): string {
  if (mode === 'direct') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300';
  if (mode === 'trailer') return 'border-amber-500/30 bg-amber-500/10 text-amber-300';
  return 'border-white/10 bg-white/5 text-zinc-400';
}

function PlayerPayloadCard({ item, onClose }: { item: MobileItem; onClose: () => void }) {
  const player = useApi(`mobile-player-${item.id}`, () => platform.mobilePlayer(item.id));

  return (
    <Card className="border-rose-500/20 bg-white/[0.03]">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <CardTitle className="truncate text-base">Player payload</CardTitle>
            <span
              className={cn(
                'shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
                player.data ? modeClass(player.data.mode) : 'border-white/10 bg-white/5 text-zinc-400',
              )}
            >
              {player.data?.mode ?? '…'}
            </span>
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Închide payload-ul playerului"
            className="h-7 w-7 shrink-0 text-zinc-500 hover:bg-white/10 hover:text-zinc-200"
            onClick={onClose}
          >
            <X className="h-4 w-4" aria-hidden />
          </Button>
        </div>
        <CardDescription className="truncate">
          GET /api/mobile/player/{item.id} — {item.title}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {player.loading && !player.data ? (
          <div className="space-y-2">
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : player.error ? (
          <ErrorState message={player.error} onRetry={player.refetch} compact />
        ) : player.data ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <TypeBadge type={player.data.content.type} />
              <RatingBadge value={player.data.content.rating} />
              {player.data.allowedTypes.map((t) => (
                <span
                  key={t}
                  className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 font-mono text-[10px] text-zinc-400"
                >
                  {t}
                </span>
              ))}
            </div>

            <div className="space-y-1.5">
              <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">
                Sources ({player.data.sources.length})
              </p>
              {player.data.sources.length === 0 ? (
                <p className="text-sm text-zinc-500">No sources attached to this title.</p>
              ) : (
                player.data.sources.map((s, i) => (
                  <div
                    key={`${s.type}-${i}-${s.url}`}
                    className="flex items-center gap-2 rounded-lg border border-white/5 bg-white/[0.02] px-2.5 py-1.5"
                  >
                    <span className="shrink-0 rounded border border-rose-500/30 bg-rose-500/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-rose-300">
                      {s.type}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs text-zinc-300">
                      {s.label || s.url}
                    </span>
                  </div>
                ))
              )}
            </div>

            {player.data.primary && (
              <div className="space-y-1.5">
                <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">Primary URL</p>
                <pre className="custom-scrollbar overflow-x-auto rounded-lg border border-white/10 bg-black/50 p-2.5 font-mono text-[11px] text-zinc-300">
                  {player.data.primary.url}
                </pre>
              </div>
            )}

            {player.data.nextUp && (
              <p className="text-xs text-zinc-500">
                Next up: <span className="font-semibold text-zinc-300">{player.data.nextUp.title}</span>
              </p>
            )}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

/* ------------------- phase 5 — native app showcase --------------------- */

const PHASE5_BADGES: { label: string; className: string }[] = [
  { label: 'Expo SDK 52', className: 'border-rose-500/30 bg-rose-500/10 text-rose-300' },
  { label: 'expo-router', className: 'border-white/10 bg-white/[0.05] text-zinc-300' },
  { label: 'TypeScript strict', className: 'border-white/10 bg-white/[0.05] text-zinc-300' },
  { label: 'JWT + refresh', className: 'border-white/10 bg-white/[0.05] text-zinc-300' },
  { label: 'offline cache', className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' },
];

const MOBILE_TREE: { dir: string; desc: string }[] = [
  {
    dir: 'app/',
    desc: '10 expo-router screens — home · login · content · player · feed · ai · watchlist · profile · premium',
  },
  {
    dir: 'api/',
    desc: 'fetch client — single-flight 401 token refresh + retry, AsyncStorage stale-while-error cache, one module per API prefix',
  },
  {
    dir: 'auth/',
    desc: 'SecureStore (Keychain/Keystore) token store + AuthContext — boot restore → background /me validation',
  },
  { dir: 'player/', desc: 'expo-av VideoPlayer + view/play/complete tracking + throttled progress saves' },
  { dir: 'feed/', desc: 'FeedList activity cards — avatar · verb · content · time-ago' },
  { dir: 'ai/', desc: 'PersonalTab (daily picks · recap) + AssistantTab (chat · tool traces · memories)' },
  { dir: 'watchlist/', desc: 'optimistic add/remove with server truth re-sync' },
  { dir: 'premium/', desc: 'plan helpers — order · rank · formatting' },
  {
    dir: 'components/',
    desc: 'Screen · BottomNav · Segmented · content cards · AIPanel · QuotaMeter · state components',
  },
  { dir: 'hooks/useApi', desc: 'declarative fetch hook with stale-while-error' },
  { dir: 'theme/', desc: 'dark cinema tokens — rose on charcoal, no blue/indigo' },
];

const MOBILE_SCREENS: { icon: LucideIcon; title: string; desc: string; endpoints: string[] }[] = [
  {
    icon: House,
    title: 'Acasă',
    desc: 'Carusel hero + rânduri curatate, cu pull-to-refresh și cache stale offline.',
    endpoints: ['/api/mobile/home'],
  },
  {
    icon: BookOpen,
    title: 'Conținut',
    desc: 'Detalii + panou AI: Explică · Semănătoare · Întreabă.',
    endpoints: ['/api/content/:id', '/api/ai/rag/*'],
  },
  {
    icon: MonitorPlay,
    title: 'Player',
    desc: 'Video expo-av + surse + tracking analytics + companion AI.',
    endpoints: ['/api/mobile/player/:id', '/api/analytics/views'],
  },
  {
    icon: Users,
    title: 'Feed',
    desc: 'Global | Personal | Pentru tine·AI — carduri de activitate cu paginare prin cursor.',
    endpoints: ['/api/social/feed/*', '/api/ai/personal/feed'],
  },
  {
    icon: Bot,
    title: 'Hub AI',
    desc: 'Tab Personal + tab Asistent — alegeri, recapitulativ și chat într-un singur ecran.',
    endpoints: ['/api/ai/personal/*', '/api/ai/assistant'],
  },
  {
    icon: Bookmark,
    title: 'Lista Mea',
    desc: 'Titluri salvate cu adăugare/eliminare optimistă și re-sincronizare cu serverul.',
    endpoints: ['/api/users/me/watchlist'],
  },
  {
    icon: UserRound,
    title: 'Profil',
    desc: 'Avatar, plan, istoric de vizionare și preferințe de gusturi.',
    endpoints: ['/api/mobile/profile', '/api/users/me/*'],
  },
  {
    icon: Crown,
    title: 'Premium',
    desc: 'Planuri + checkout sandbox / Stripe cu activare inline.',
    endpoints: ['/api/premium/*'],
  },
];

const AI_MOBILE_FEATURES: { icon: LucideIcon; title: string; desc: string }[] = [
  {
    icon: Sparkles,
    title: 'Alegeri zilnice personale',
    desc: 'Salut, sugestii pentru-că-ai-vizionat și recapitulativul săptămânal — /api/ai/personal/*.',
  },
  {
    icon: MessageSquareText,
    title: 'RAG pe fiecare titlu',
    desc: 'Explică · Semănătoare cu aceasta · chat-cu-conținutul — /api/ai/rag/*.',
  },
  {
    icon: Bot,
    title: 'animaxiaAssistant',
    desc: 'Chat with tool traces, memories and guardrail notices, restored from server history.',
  },
  {
    icon: WifiOff,
    title: 'AI offline',
    desc: 'Payload-uri AI cache-uite în AsyncStorage și servite stale, cu banner amber, când ești offline.',
  },
];

const AI_QUOTA_CHIPS: { label: string; className: string }[] = [
  { label: 'free 10/day', className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' },
  { label: 'plus 100/day', className: 'border-rose-500/30 bg-rose-500/10 text-rose-300' },
  { label: 'pro 500/day', className: 'border-amber-500/30 bg-amber-500/10 text-amber-300' },
  { label: 'anonymous 5/day', className: 'border-zinc-500/30 bg-zinc-500/10 text-zinc-400' },
];

function Phase5Section() {
  return (
    <section className="space-y-4" aria-labelledby="phase5-heading">
      {/* Section header */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="grid h-9 w-9 place-items-center rounded-xl border border-rose-500/30 bg-rose-500/10">
            <Smartphone className="h-4 w-4 text-rose-400" aria-hidden />
          </span>
          <h2
            id="phase5-heading"
            className="text-xl font-bold tracking-tight text-zinc-100 sm:text-2xl"
          >
            Phase 5 — Animaxia Mobile App
          </h2>
          <Sparkles className="h-4 w-4 text-rose-400/70" aria-hidden />
        </div>
        <p className="max-w-3xl text-sm leading-relaxed text-zinc-400">
          The native Android + iOS client — React Native · Expo SDK 52 · one app for browsing, native playback,
          social, watchlist, premium and the full AI Cloud, connected to the gateway on{' '}
          <code className="rounded bg-black/50 px-1.5 py-0.5 font-mono text-xs text-rose-300">:8080</code> or the
          monolith on{' '}
          <code className="rounded bg-black/50 px-1.5 py-0.5 font-mono text-xs text-rose-300">:4000</code>.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {PHASE5_BADGES.map((b) => (
            <span
              key={b.label}
              className={cn('rounded-full border px-2.5 py-1 text-[11px] font-semibold', b.className)}
            >
              {b.label}
            </span>
          ))}
        </div>
      </div>

      {/* Architecture — folder tree */}
      <Card className="border-white/10 bg-white/[0.03]">
        <CardHeader className="pb-3">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            <FolderTree className="h-4 w-4 text-rose-400" aria-hidden />
            Architecture — <span className="font-mono text-rose-300">animaxia-mobile/</span>
            <span className="font-mono text-[11px] font-normal text-zinc-500">47 files</span>
          </CardTitle>
          <CardDescription>
            Ten expo-router screens over a typed HTTP layer — every API prefix gets its own module.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="custom-scrollbar overflow-x-auto rounded-xl border border-white/10 bg-black/40">
            <div className="min-w-[540px] divide-y divide-white/5">
              {MOBILE_TREE.map((t) => (
                <div key={t.dir} className="flex items-baseline gap-4 px-4 py-2">
                  <span className="w-24 shrink-0 font-mono text-xs font-bold text-rose-300">{t.dir}</span>
                  <span className="min-w-0 flex-1 text-xs leading-relaxed text-zinc-400">{t.desc}</span>
                </div>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Screens gallery */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {MOBILE_SCREENS.map((s) => (
          <Card
            key={s.title}
            className="border-white/10 bg-white/[0.03] transition-colors hover:border-rose-500/25"
          >
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-rose-500/20 bg-rose-500/10">
                  <s.icon className="h-3.5 w-3.5 text-rose-400" aria-hidden />
                </span>
                {s.title}
              </CardTitle>
              <CardDescription className="text-xs leading-relaxed">{s.desc}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-1.5">
                {s.endpoints.map((e) => (
                  <span
                    key={e}
                    className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 font-mono text-[10px] text-zinc-400"
                  >
                    {e}
                  </span>
                ))}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* AI Cloud on mobile */}
      <Card className="border-rose-500/20 bg-gradient-to-br from-rose-500/[0.08] to-white/[0.02]">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <BrainCircuit className="h-4 w-4 text-rose-400" aria-hidden />
            AI Cloud on mobile
          </CardTitle>
          <CardDescription>
            The whole Phase-4 AI Cloud pocket-sized — quota-aware everywhere, upgrade cards deep-link to Premium.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,300px)]">
          <ul className="space-y-2.5">
            {AI_MOBILE_FEATURES.map((f) => (
              <li key={f.title} className="flex items-start gap-2.5">
                <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md border border-white/10 bg-white/[0.04]">
                  <f.icon className="h-3.5 w-3.5 text-rose-300" aria-hidden />
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-zinc-200">{f.title}</p>
                  <p className="mt-0.5 text-xs leading-relaxed text-zinc-500">{f.desc}</p>
                </div>
              </li>
            ))}
          </ul>
          <div className="h-fit space-y-2.5 rounded-xl border border-white/10 bg-black/40 p-4">
            <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-zinc-500">
              <Zap className="h-3 w-3 text-amber-300" aria-hidden />
              Live quota meter — per plan
            </p>
            <div className="flex flex-wrap gap-1.5">
              {AI_QUOTA_CHIPS.map((c) => (
                <span
                  key={c.label}
                  className={cn(
                    'rounded-full border px-2.5 py-1 font-mono text-[11px] font-semibold',
                    c.className,
                  )}
                >
                  {c.label}
                </span>
              ))}
            </div>
            <p className="text-[11px] leading-relaxed text-zinc-500">
              The QuotaMeter renders live usage on every AI surface — a 402 with{' '}
              <span className="font-mono text-zinc-400">upgrade: true</span> opens the upgrade card.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Build & download */}
      <Card className="border-white/10 bg-white/[0.03]">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Terminal className="h-4 w-4 text-rose-400" aria-hidden />
            Build &amp; download
          </CardTitle>
          <CardDescription>
            Run it locally with Expo Go, or ship a release build through EAS — no local Android/Xcode toolchain
            needed.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid items-center gap-4 lg:grid-cols-[minmax(0,1fr)_auto]">
          <pre className="custom-scrollbar overflow-x-auto rounded-xl border border-white/10 bg-black/40 p-4 font-mono text-[11px] leading-relaxed text-zinc-300">
            <code>{`cd animaxia-mobile
npm install
cp .env.example .env    # EXPO_PUBLIC_API_URL -> gateway :8080 or monolith :4000
npx expo start          # Expo DevTools + QR code for Expo Go

# EAS release build (Android AAB)
eas build -p android --profile production`}</code>
          </pre>
          <div className="flex flex-col items-start gap-2 lg:items-end">
            <Button asChild size="lg" className="bg-rose-600 font-bold text-white hover:bg-rose-500">
              <a
                href="/animaxia-cloud.zip"
                download
                aria-label="Descarcă animaxia-cloud.zip — arhiva completă a platformei, inclusiv aplicația mobilă Animaxia"
              >
                <Download aria-hidden /> Download animaxia-cloud.zip
              </a>
            </Button>
            <p className="text-[11px] text-zinc-500">
              Full stack archive —{' '}
              <span className="font-semibold text-zinc-400">includes the mobile app · 359 files</span>
            </p>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}

/* -------------------------------- view --------------------------------- */

export function MobileView(_props: { route: AppRoute }) {
  const [selected, setSelected] = useState<MobileItem | null>(null);

  const home = useApi('mobile:home', () => platform.mobileHome());
  const config = useApi('mobile:config', () => platform.mobileConfig());

  return (
    <Container className="space-y-8 py-8 sm:py-10">
      <PageHeader
        title="Animaxia Mobile"
        subtitle="API-ul mobil complet, live într-o previzualizare în formă de telefon — apasă pe orice dalie pentru a-i inspecta payload-ul playerului."
      />

      <div className="grid grid-cols-1 items-start gap-10 lg:grid-cols-[minmax(0,400px)_minmax(0,1fr)]">
        {/* LEFT — phone */}
        <div>
          {home.loading && !home.data ? (
            <div
              className="mx-auto flex h-[620px] w-[300px] flex-col gap-4 rounded-[2.8rem] border-[10px] border-zinc-800 bg-[#0a0a10] p-4 sm:w-[340px]"
              aria-busy="true"
              aria-label="Loading mobile home"
            >
              <Skeleton className="h-5 w-24 self-center rounded-full" />
              <Skeleton className="h-44 w-full rounded-2xl" />
              {Array.from({ length: 2 }).map((_, i) => (
                <div key={i} className="space-y-2">
                  <Skeleton className="h-3 w-28" />
                  <div className="flex gap-2">
                    {Array.from({ length: 4 }).map((_, j) => (
                      <Skeleton key={j} className="h-36 w-24 shrink-0 rounded-lg" />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : home.error && !home.data ? (
            <ErrorState message={home.error} onRetry={home.refetch} />
          ) : home.data ? (
            <PhoneMockup
              hero={home.data.hero}
              rows={home.data.rows}
              selectedId={selected?.id ?? null}
              onSelect={setSelected}
            />
          ) : null}
        </div>

        {/* RIGHT — API docs */}
        <div className="space-y-4">
          {selected && <PlayerPayloadCard item={selected} onClose={() => setSelected(null)} />}

          {/* Endpoints */}
          <Card className="border-white/10 bg-white/[0.03]">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Smartphone className="h-4 w-4 text-rose-400" aria-hidden />
                Mobile API
              </CardTitle>
              <CardDescription>
                Four endpoints power the native app — same backend, trimmed payloads.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="custom-scrollbar overflow-x-auto rounded-xl border border-white/10 bg-black/40">
                <div className="min-w-[440px] divide-y divide-white/5">
                  {MOBILE_ENDPOINTS.map((e) => (
                    <div key={e.path} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
                      <span className="inline-flex w-[52px] shrink-0 justify-center rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold text-emerald-300">
                        {e.method}
                      </span>
                      <span className="font-mono text-xs text-zinc-200">{e.path}</span>
                      <span className="w-full text-[11px] text-zinc-500 sm:w-auto sm:flex-1 sm:text-right">
                        {e.desc}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Config */}
          <Card className="border-white/10 bg-white/[0.03]">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">App configuration</CardTitle>
              <CardDescription>
                GET /api/mobile/config — version gates and server-side feature flags.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {config.loading && !config.data ? (
                <div className="flex flex-wrap gap-2">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <Skeleton key={i} className="h-6 w-20 rounded-full" />
                  ))}
                </div>
              ) : config.error && !config.data ? (
                <ErrorState message={config.error} onRetry={config.refetch} compact />
              ) : config.data ? (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge className="border-white/10 bg-white/[0.05] font-mono text-[11px] text-zinc-300">
                      min v{config.data.versions.min}
                    </Badge>
                    <Badge className="border-rose-500/30 bg-rose-500/10 font-mono text-[11px] text-rose-300">
                      latest v{config.data.versions.latest}
                    </Badge>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {Object.entries(config.data.features).map(([flag, on]) => (
                      <span
                        key={flag}
                        className={cn(
                          'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold',
                          on
                            ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                            : 'border-zinc-500/30 bg-zinc-500/10 text-zinc-400',
                        )}
                      >
                        <span
                          className={cn('h-1.5 w-1.5 rounded-full', on ? 'bg-emerald-400' : 'bg-zinc-500')}
                          aria-hidden
                        />
                        {flag}
                      </span>
                    ))}
                  </div>
                </>
              ) : null}
            </CardContent>
          </Card>

          {/* Note */}
          <Card className="border-rose-500/20 bg-gradient-to-br from-rose-500/[0.08] to-white/[0.02]">
            <CardContent className="flex items-start gap-3 p-4">
              <Smartphone className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" aria-hidden />
              <p className="text-sm text-zinc-300">
                Same gateway, same auth — point the native app at{' '}
                <code className="rounded bg-black/50 px-1.5 py-0.5 font-mono text-xs text-rose-300">
                  /api/mobile/*
                </code>{' '}
                with{' '}
                <code className="rounded bg-black/50 px-1.5 py-0.5 font-mono text-xs text-rose-300">
                  XTransformPort=4000
                </code>
                .
              </p>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Empty-home fallback */}
      {home.data && home.data.rows.length === 0 && (
        <EmptyState title="Niciun rând mobil" message="Feed-ul mobil de acasă nu are încă conținut." />
      )}

      {/* Phase 5 — native app showcase */}
      <Phase5Section />
    </Container>
  );
}

export default MobileView;
