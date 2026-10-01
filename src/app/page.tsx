'use client';

/**
 * page.tsx — Animaxia single-route SPA shell. All "pages" are hash-routed
 * views (see src/lib/animaxia/router.ts). This is the only Next.js route.
 */

import { useEffect } from 'react';
import { motion } from 'framer-motion';
import { Play } from 'lucide-react';
import { Toaster } from '@/components/ui/sonner';
import { AiHomeSettingsProvider } from '@/components/animaxia/ai-home-settings';
import { AiCursor } from '@/components/animaxia/ai-cursor';
import { ErrorBoundary } from '@/components/animaxia/error-boundary';
import { AuthProvider } from '@/components/animaxia/auth-provider';
import { Navbar } from '@/components/animaxia/navbar';
import { AppSidebar } from '@/components/animaxia/sidebar';
import { Footer } from '@/components/animaxia/footer';
import { navigate, useRoute, type AppRoute } from '@/lib/animaxia/router';
import { HomeView } from '@/components/animaxia/views/home-view';
import { CategoryView } from '@/components/animaxia/views/category-view';
import { FranchiseView } from '@/components/animaxia/views/franchise-view';
import { FranchiseHubView } from '@/components/animaxia/views/franchise-hub-view';
import { ContentView } from '@/components/animaxia/views/content-view';
import { PlayerView } from '@/components/animaxia/views/player-view';
import { SearchView } from '@/components/animaxia/views/search-view';
import { RecommendationsView } from '@/components/animaxia/views/recommendations-view';
import { AdminView } from '@/components/animaxia/views/admin-view';
import { AuthView } from '@/components/animaxia/views/auth-view';
import { ProfileView } from '@/components/animaxia/views/profile-view';
import { PremiumView } from '@/components/animaxia/views/premium-view';
import { FeedView } from '@/components/animaxia/views/feed-view';
import { AiView } from '@/components/animaxia/views/ai-view';
import { MobileView } from '@/components/animaxia/views/mobile-view';
import { EdgeView } from '@/components/animaxia/views/edge-view';
import { SocialView } from '@/components/animaxia/views/social-view';
import { MetaBrowseView } from '@/components/animaxia/views/meta-view';
import { ScaleReportView } from '@/components/animaxia/views/scale-report-view';
import { StabilityLabView } from '@/components/animaxia/views/stability-lab-view';
import { AiHubView } from '@/components/animaxia/views/ai-hub-view';
import { HistoryView } from '@/components/animaxia/views/history-view'; // FAZA 21 istoric
import { PlaylistsView } from '@/components/animaxia/views/playlists-view'; // FAZA 21 playlist-uri
import { StatsView } from '@/components/animaxia/views/stats-view'; // FAZA 21 statistici live
import { StatusView } from '@/components/animaxia/views/status-view'; // FAZA 29 (2.0): stare platformă live
import { AiSuiteView } from '@/components/animaxia/views/ai-suite-view'; // FAZA 32 (AI SUITE 100X): 18 motoare AI noi
import { AiLabView } from '@/components/animaxia/views/ai-lab-view'; // FAZA 35 (PLAN 100X · WS5): AI Lab — 8 capabilități AI noi
import { PersoView } from '@/components/animaxia/views/perso-view'; // FAZA 36-R (PLAN 100X · WS6): Personalizare 2.0 — feed Pentru Tine + profil de gust + profile cu PIN + memento-uri
import { LaunchBanner } from '@/components/animaxia/launch-banner'; // FAZA 29 (2.0): anunțuri globale
import { CommandPalette } from '@/components/animaxia/command-palette'; // FAZA 33 (PLAN 100X · WS3): paletă globală ⌘K
import { PlayerDockProvider } from '@/components/animaxia/player/player-dock'; // FAZA 34 (PLAN 100X · WS4): dock persistent
import { MiniDock } from '@/components/animaxia/player/mini-dock'; // FAZA 34 (PLAN 100X · WS4): mini-dock + restrângere
import { SubtitleStyleApplier } from '@/components/animaxia/player/subtitle-studio'; // FAZA 34 (PLAN 100X · WS4): stil ::cue global
import { PlayerExperienceHost } from '@/components/animaxia/player/experience-host'; // FAZA 34 (PLAN 100X · WS4): gazdă experiență player
import { installBrowserTracing } from '@/lib/animaxia/otel-browser'; // FAZA 23 (observability): browser OTel spans
import { Button } from '@/components/ui/button';

function renderView(route: AppRoute) {
  switch (route.view) {
    case 'home':
      return <HomeView />;
    case 'category':
      return <CategoryView route={route} />;
    case 'meta':
      return <MetaBrowseView route={route} />;
    case 'franchise':
      return <FranchiseView route={route} />;
    case 'franchises':
      return <FranchiseHubView variant="franchises" />;
    case 'trilogies':
      return <FranchiseHubView variant="trilogies" />;
    case 'content':
      return <ContentView route={route} />;
    case 'player':
      /* FAZA 17 — the player has its own internal fallback chain; this
          boundary is only the safety net for unexpected render errors.
          FAZA 34 (WS4) — PlayerExperienceHost GĂZDUIEȘTE playerul protejat
          (bară de acțiuni + studio subtitrări + markeri + dock + scurtături). */
      return (
        <ErrorBoundary
          showHome={false}
          title="Playerul a întâmpinat o problemă"
          description="Redarea acestui titlu a eșuat neașteptat. Poți reîncerca sau să te întorci la pagina de detalii."
        >
          <PlayerExperienceHost route={route}>
            <PlayerView route={route} />
          </PlayerExperienceHost>
        </ErrorBoundary>
      );
    case 'search':
      return <SearchView route={route} />;
    case 'recommendations':
      return <RecommendationsView />;
    case 'admin':
      return <AdminView />;
    case 'auth':
      return <AuthView route={route} />;
    case 'profile':
      return <ProfileView route={route} />;
    case 'premium':
      return <PremiumView route={route} />;
    case 'feed':
      return <FeedView route={route} />;
    case 'ai':
      return <AiView route={route} />;
    case 'mobile':
      return <MobileView route={route} />;
    case 'edge':
      return <EdgeView />;
    case 'social':
      return <SocialView route={route} />;
    case 'scale':
      return <ScaleReportView />;
    case 'stability':
      /* FAZA 17 — live stress & stability lab (resilience / stress real). */
      return <StabilityLabView />;
    case 'aihub':
      return <AiHubView />;
    case 'history':
      /* FAZA 21 — istoric personal (#/history). */
      return <HistoryView />;
    case 'playlists':
      /* FAZA 21 — playlist-uri reale (#/playlists). */
      return <PlaylistsView />;
    case 'stats':
      /* FAZA 21 — gauge-uri live publice + angajament personal (#/stats). */
      return <StatsView />;
    case 'status':
      /* FAZA 29 (Animaxia 2.0) — stare live platformă, sonde reale (#/status). */
      return <StatusView />;
    case 'ai-suite':
      /* FAZA 32 (AI SUITE 100X) — cele 18 motoare AI noi (#/ai-suite/<engine>). */
      return <AiSuiteView route={route} />;
    case 'ai-lab':
      /* FAZA 35 (PLAN 100X · WS5) — AI Lab: 8 capabilități AI noi (#/ai-lab/<cap>). */
      return <AiLabView route={route} />;
    case 'perso':
      /* FAZA 36-R (PLAN 100X · WS6) — Personalizare 2.0: feed „Pentru Tine" +
         profil de gust + profile cu PIN + memento-uri (#/perso/<tab>). */
      return <PersoView route={route} />;
    default:
      return (
        <div className="mx-auto flex min-h-[50vh] w-full max-w-7xl flex-col items-center justify-center gap-4 px-4 text-center">
          <h1 className="text-3xl font-black text-white">404 — Pierdut în stream</h1>
          <p className="text-sm text-zinc-400">Pagina pe care o cauți nu există.</p>
          <Button onClick={() => navigate('/home')} className="bg-rose-600 font-bold hover:bg-rose-500">
            Înapoi acasă
          </Button>
        </div>
      );
  }
}

function Splash() {
  return (
    <div className="fixed inset-0 z-[100] grid place-items-center bg-[#0a0a10]">
      <motion.div
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.4 }}
        className="flex flex-col items-center gap-4"
      >
        <motion.span
          animate={{ scale: [1, 1.08, 1] }}
          transition={{ repeat: Infinity, duration: 1.4, ease: 'easeInOut' }}
          className="grid h-16 w-16 place-items-center rounded-2xl bg-gradient-to-br from-rose-500 to-fuchsia-600 shadow-2xl shadow-rose-900/50"
        >
          <Play className="h-7 w-7 fill-white text-white" aria-hidden />
        </motion.span>
        <span className="text-2xl font-black tracking-tight text-white">
          ANIMA<span className="text-rose-400">XIA</span>
        </span>
      </motion.div>
    </div>
  );
}

export default function Page() {
  const route = useRoute();

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [route?.view, route?.params.join('/')]);

  /* TS2a — PWA: register the vanilla service worker (public/sw.js) once the
     client shell is up. Fire-and-forget: a failed registration (older browser,
     private mode, HTTP) never blocks or breaks the app — it only warns. */
  useEffect(() => {
    if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
      navigator.serviceWorker
        .register('/sw.js')
        .catch((err) => console.warn('[pwa] service worker registration failed:', err));
    }
  }, []);

  // FAZA 23 (observability): browser OTel spans — patch fetch once (idempotent,
  // silent, never affects UX) and export batches to the :4050 collector.
  useEffect(() => {
    installBrowserTracing();
  }, []);

  return (
    <div className="relative flex min-h-screen flex-col bg-[#0a0a10] text-zinc-100">
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
        <div className="absolute -top-32 right-0 h-96 w-96 rounded-full bg-rose-600/10 blur-3xl" />
        <div className="absolute left-0 top-1/3 h-96 w-96 rounded-full bg-fuchsia-600/[0.07] blur-3xl" />
        <div className="absolute bottom-0 right-1/4 h-72 w-72 rounded-full bg-orange-600/[0.05] blur-3xl" />
      </div>

      {route ? (
        <AuthProvider>
          {/* FAZA 15 — AI Home settings context: sidebar, home view, content
              cards and the meta view all read the four AI toggles from here. */}
          <AiHomeSettingsProvider>
            {/* FAZA 34 (PLAN 100X · WS4) — dock-ul persistent FAZA 19 devine
                global: trebuie să învelească ȘI playerul (minimizeToDock), ȘI
                MiniDock-ul montat lângă CommandPalette (sub Footer). */}
            <PlayerDockProvider>
            {/* FAZA 29 (2.0) — banner global de anunțuri (dismissible, randează
                null când nu există anunț activ — zero impact vizual). */}
            <LaunchBanner />
            <Navbar route={route} />
            <div className="flex flex-1">
              {/* Grouped main menu: Principal / AI Metadata / Media / Live /
                  Cont / Universuri / Canale Kids / TV & Show-biz / Lumea. */}
              <AppSidebar route={route} />
              <main id="main" className="min-w-0 flex-1">
                {/* FAZA 17 — global render-error containment. The key changes
                    on every navigation (view + params), so a boundary that
                    caught an error resets cleanly on page change. */}
                <ErrorBoundary key={`${route.view}:${route.params.join('/')}`}>
                  {renderView(route)}
                </ErrorBoundary>
              </main>
            </div>
            <Footer />
            {/* FAZA 33 (PLAN 100X · WS3): paleta globală de comandă ⌘K — mount
                o singură dată, funcționează pe orice view (consumă doar API-uri
                existente + searchux; zero touch pe componente protejate). */}
            <CommandPalette />
            {/* FAZA 34 (PLAN 100X · WS4): stilul global al subtitrărilor
                (::cue, aplicat pe orice <video> din app) + mini-dock-ul
                persistent cu restrângere — ambele randează null când nu e
                nimic de afișat, zero impact pe restul views-urilor. */}
            <SubtitleStyleApplier />
            <MiniDock />
            {/* AI cursor aura — renders null while the aiCursor toggle is OFF. */}
            <AiCursor />
            </PlayerDockProvider>
          </AiHomeSettingsProvider>
        </AuthProvider>
      ) : (
        <Splash />
      )}

      <Toaster theme="dark" position="bottom-right" richColors closeButton />
    </div>
  );
}
