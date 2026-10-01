/**
 * app.tsx — Renderer entry (Vite entry module referenced by index.html).
 *
 * Provider stack:
 *   ThemeProvider  — Electron-native theme (dark/light/system) → <html> class
 *   AuthProvider   — JWT session (localStorage snapshot + silent refresh)
 *   HashRouter     — file://-safe routing for the packaged app
 *
 * Route map (HashRouter — the mini-player window loads #/mini-player):
 *   /                Home          (hero carousel + anime/movies/sports rows)
 *   /content/:id     Content       (details + AI panel + comments)
 *   /player/:id      Player        (full-screen + pop-out mini-player)
 *   /feed            Feed          (global + personal tabs)
 *   /ai              AI Hub        (Personal AI + Assistant + RAG Lab)
 *   /watchlist       Watchlist     (auth-gated)
 *   /premium         Premium       (plans + upgrade)
 *   /profile         Profile       (auth-gated)
 *   /auth            Auth          (login / register / forgot / reset)
 *   /mini-player     MiniPlayer    (standalone always-on-top window)
 *
 * External navigations (deep links animaxia://…, app menu, tray, notification
 * clicks, mini-player "expand") arrive as 'app:navigate' and are routed by
 * <NavigationListener> inside <Shell>.
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import './globals.css';

import { ThemeProvider } from './components/ThemeProvider';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { Shell } from './components/Shell';
import { LoadingState } from './components/states';

import HomeScreen from './screens/HomeScreen';
import ContentScreen from './screens/ContentScreen';
import PlayerScreen from './screens/PlayerScreen';
import MiniPlayerScreen from './screens/MiniPlayerScreen';
import FeedScreen from './screens/FeedScreen';
import AIHubScreen from './screens/AIHubScreen';
import WatchlistScreen from './screens/WatchlistScreen';
import PremiumScreen from './screens/PremiumScreen';
import ProfileScreen from './screens/ProfileScreen';
import AuthScreen from './screens/AuthScreen';

/** Redirects unauthenticated users to /auth, remembering where they were headed. */
function AuthGate(): React.JSX.Element {
  const { user, initializing } = useAuth();
  const location = useLocation();

  if (initializing) {
    return (
      <div style={{ padding: '60px 0' }}>
        <LoadingState label="Restoring your session…" />
      </div>
    );
  }
  if (!user) {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/auth?next=${next}`} replace />;
  }
  return <Outlet />;
}

function AppRoutes(): React.JSX.Element {
  return (
    <Routes>
      {/* Standalone mini-player window (loads index.html#/mini-player). */}
      <Route path="/mini-player" element={<MiniPlayerScreen />} />

      {/* Main window chrome. */}
      <Route element={<Shell />}>
        <Route path="/" element={<HomeScreen />} />
        <Route path="/content/:id" element={<ContentScreen />} />
        <Route path="/player/:id" element={<PlayerScreen />} />
        <Route path="/feed" element={<FeedScreen />} />
        <Route path="/ai" element={<AIHubScreen />} />
        <Route element={<AuthGate />}>
          <Route path="/watchlist" element={<WatchlistScreen />} />
          <Route path="/profile" element={<ProfileScreen />} />
        </Route>
        <Route path="/premium" element={<PremiumScreen />} />
        <Route path="/auth" element={<AuthScreen />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

function AppRoot(): React.JSX.Element {
  return (
    <React.StrictMode>
      <ThemeProvider>
        <AuthProvider>
          <HashRouter>
            <AppRoutes />
          </HashRouter>
        </AuthProvider>
      </ThemeProvider>
    </React.StrictMode>
  );
}

const container = document.getElementById('root');
if (!container) throw new Error('#root container missing in index.html');
createRoot(container).render(<AppRoot />);
