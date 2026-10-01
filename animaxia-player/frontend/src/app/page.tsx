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
import { PlayerDock, PlayerDockProvider } from '@/components/animaxia/player/player-dock';
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
import { Global30BView } from '@/components/animaxia/views/global-30b-view';
import { AiHubView } from '@/components/animaxia/views/ai-hub-view';
/* FAZA 21 — istoric vizionare, playlist-uri proprii și statistici publice. */
import { HistoryView } from '@/components/animaxia/views/history-view';
import { PlaylistsView } from '@/components/animaxia/views/playlists-view';
import { StatsView } from '@/components/animaxia/views/stats-view';
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
          boundary is only the safety net for unexpected render errors. */
      return (
        <ErrorBoundary
          showHome={false}
          title="Playerul a întâmpinat o problemă"
          description="Redarea acestui titlu a eșuat neașteptat. Poți reîncerca sau să te întorci la pagina de detalii."
        >
          <PlayerView route={route} />
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
      /* FAZA 17 — live stress & stability lab (resilience / stress / 30B). */
      return <StabilityLabView />;
    case 'global30b':
      /* FAZA 14 — feed-ul spațiului logic 30B cu overlay real (O(1)). */
      return <Global30BView />;
    case 'aihub':
      return <AiHubView />;
    /* FAZA 21 (task 21-1) — istoric + playlist-uri (auth) și statistici (public). */
    case 'history':
      return <HistoryView />;
    case 'playlists':
      return <PlaylistsView />;
    case 'stats':
      return <StatsView />;
    default:
      return (
        <div className="mx-auto flex min-h-[50vh] w-full max-w-7xl flex-col items-center justify-center gap-4 px-4 text-center">
          <h1 className="text-3xl font-black text-white">404 — Lost in the stream</h1>
          <p className="text-sm text-zinc-400">The page you are looking for does not exist.</p>
          <Button onClick={() => navigate('/home')} className="bg-rose-600 font-bold hover:bg-rose-500">
            Back to home
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

  return (
    <div className="relative flex min-h-screen flex-col bg-[#0a0a10] text-zinc-100">
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
        <div className="absolute -top-32 right-0 h-96 w-96 rounded-full bg-rose-600/10 blur-3xl" />
        <div className="absolute left-0 top-1/3 h-96 w-96 rounded-full bg-fuchsia-600/[0.07] blur-3xl" />
        <div className="absolute bottom-0 right-1/4 h-72 w-72 rounded-full bg-orange-600/[0.05] blur-3xl" />
      </div>

      {route ? (
        <AuthProvider>
          {/* FAZA 19 (19-3a) — global persistent mini-player state: survives
              hash navigations so a minimized playback keeps playing. */}
          <PlayerDockProvider>
            {/* FAZA 15 — AI Home settings context: sidebar, home view, content
                cards and the meta view all read the four AI toggles from here. */}
            <AiHomeSettingsProvider>
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
              {/* FAZA 19 (19-3a) — the persistent mini-player dock (fixed
                  bottom-right; renders null unless a minimized mp4/HLS
                  playback is active and the user is not on the same title's
                  player page). */}
              <PlayerDock />
              <Footer />
              {/* AI cursor aura — renders null while the aiCursor toggle is OFF. */}
              <AiCursor />
            </AiHomeSettingsProvider>
          </PlayerDockProvider>
        </AuthProvider>
      ) : (
        <Splash />
      )}

      <Toaster theme="dark" position="bottom-right" richColors closeButton />
    </div>
  );
}
