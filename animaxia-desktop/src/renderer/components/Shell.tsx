/**
 * components/Shell.tsx — The desktop app chrome: sidebar navigation, topbar
 * (connection pill + theme switch), offline banner, updater toasts and the
 * external-navigation bridge.
 *
 * • NavigationListener wires window.animaxia.onNavigate (deep links, tray,
 *   menu, notification clicks, mini-player expand) into the router, and
 *   replays the route that launched the app (app:initial-route).
 * • The topbar connection pill shows the resolved API target + live
 *   online/offline dot; the offline banner appears when the network is down.
 * • Updater toasts surface electron-updater events ('downloaded' → Restart).
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  Bookmark,
  Clapperboard,
  Crown,
  LogIn,
  LogOut,
  Monitor,
  Moon,
  Play,
  Rss,
  Sun,
  User as UserIcon,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { useOnline } from '../hooks/useOnline';
import { apiTargetLabel } from '../api/config';
import { useTheme } from './ThemeProvider';
import { Avatar } from './primitives';
import { planLabel } from '../utils/format';

/* --------------------------- navigation bridge ------------------------------ */

export function NavigationListener(): React.JSX.Element | null {
  const navigate = useNavigate();

  useEffect(() => {
    if (typeof window === 'undefined' || !window.animaxia) return undefined;

    const unsubscribe = window.animaxia.onNavigate((route) => {
      if (typeof route === 'string' && route.startsWith('/')) navigate(route);
    });

    // Replay the deep link that launched the app (cold start / parked route).
    window.animaxia
      .getInitialRoute()
      .then((route) => {
        if (typeof route === 'string' && route.startsWith('/')) navigate(route);
      })
      .catch(() => {});

    return unsubscribe;
  }, [navigate]);

  return null;
}

/* ------------------------------- page titles -------------------------------- */

const TITLES: { prefix: string; title: string }[] = [
  { prefix: '/', title: 'Home' },
  { prefix: '/content', title: 'Details' },
  { prefix: '/player', title: 'Player' },
  { prefix: '/feed', title: 'Feed' },
  { prefix: '/ai', title: 'AI Hub' },
  { prefix: '/watchlist', title: 'Watchlist' },
  { prefix: '/premium', title: 'Premium' },
  { prefix: '/profile', title: 'Profile' },
  { prefix: '/auth', title: 'Sign in' },
];

function usePageTitle(): string {
  const { pathname } = useLocation();
  const match = useMemo(() => TITLES.find((t) => pathname.startsWith(t.prefix)), [pathname]);
  return match?.title ?? 'Animaxia';
}

/* --------------------------------- toasts ----------------------------------- */

interface Toast {
  id: number;
  text: string;
  tone: 'rose' | 'amber' | 'plain';
  action?: { label: string; run: () => void };
}

function UpdaterToasts(): React.JSX.Element | null {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback((toast: Omit<Toast, 'id'>) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev.slice(-2), { ...toast, id }]);
    if (!toast.action) window.setTimeout(() => dismiss(id), 4200);
  }, [dismiss]);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.animaxia) return undefined;
    return window.animaxia.updater.onStatus(({ event, info }) => {
      if (event === 'available') {
        push({ text: `Update ${info?.version ?? ''} available — downloading…`, tone: 'rose' });
      } else if (event === 'progress' && info?.percent != null) {
        push({ text: `Downloading update — ${Math.round(info.percent)}%`, tone: 'rose' });
      } else if (event === 'downloaded') {
        push({
          text: `Update ${info?.version ?? ''} ready — restart to install`,
          tone: 'rose',
          action: {
            label: 'Restart',
            run: () => window.animaxia?.updater.install(),
          },
        });
      } else if (event === 'error') {
        push({ text: info?.message ? `Update failed: ${info.message}` : 'Update check failed', tone: 'amber' });
      }
    });
  }, [push]);

  if (toasts.length === 0) return null;
  return (
    <div className="toast-area" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast${toast.tone !== 'plain' ? ` toast--${toast.tone}` : ''}`}>
          <span>{toast.text}</span>
          {toast.action ? (
            <button type="button" className="btn btn--sm" onClick={toast.action.run}>
              {toast.action.label}
            </button>
          ) : null}
          <button type="button" className="toast__close" onClick={() => dismiss(toast.id)} aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

/* --------------------------------- sidebar ---------------------------------- */

const NAV_ITEMS = [
  { to: '/', label: 'Home', icon: Clapperboard, end: true },
  { to: '/feed', label: 'Feed', icon: Rss, end: false },
  { to: '/ai', label: 'AI Hub', icon: Play, end: false },
  { to: '/watchlist', label: 'Watchlist', icon: Bookmark, end: false },
  { to: '/premium', label: 'Premium', icon: Crown, end: false },
  { to: '/profile', label: 'Profile', icon: UserIcon, end: false },
];

function Sidebar(): React.JSX.Element {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const { setting, setSetting } = useTheme();

  return (
    <nav className="sidebar" aria-label="Primary">
      <button type="button" className="sidebar__brand" onClick={() => navigate('/')} aria-label="Animaxia home">
        <span className="sidebar__brand-mark">
          <Play size={17} fill="currentColor" />
        </span>
        <span className="sidebar__brand-name">
          Anima<span>xa</span>
        </span>
      </button>

      <div className="sidebar__nav">
        {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
          <NavLink key={to} to={to} end={end} className={({ isActive }) => `sidebar__item${isActive ? ' sidebar__item--active' : ''}`}>
            <Icon size={18} />
            {label}
          </NavLink>
        ))}
      </div>

      <div className="sidebar__footer">
        <button
          type="button"
          className="sidebar__item"
          onClick={() => setSetting(setting === 'dark' ? 'light' : 'dark')}
          title="Toggle dark / light theme"
        >
          {setting === 'light' ? <Moon size={18} /> : <Sun size={18} />}
          {setting === 'light' ? 'Dark mode' : 'Light mode'}
        </button>

        {user ? (
          <>
            <button type="button" className="sidebar__user" onClick={() => navigate('/profile')} aria-label="Open profile">
              <Avatar url={user.avatar} name={user.username} size={34} />
              <span style={{ minWidth: 0 }}>
                <div className="sidebar__user-name">{user.username}</div>
                <div className="sidebar__user-plan">{planLabel(user.plan)} plan</div>
              </span>
            </button>
            <button
              type="button"
              className="sidebar__item"
              onClick={() => {
                void logout();
              }}
            >
              <LogOut size={18} /> Sign out
            </button>
          </>
        ) : (
          <NavLink to="/auth" className={({ isActive }) => `sidebar__item${isActive ? ' sidebar__item--active' : ''}`}>
            <LogIn size={18} /> Sign in
          </NavLink>
        )}
      </div>
    </nav>
  );
}

/* ---------------------------------- shell ----------------------------------- */

export function Shell(): React.JSX.Element {
  const online = useOnline();
  const title = usePageTitle();
  const { setting, resolved, setSetting } = useTheme();
  const [target, setTarget] = useState<string>('');

  useEffect(() => {
    setTarget(apiTargetLabel());
  }, []);

  return (
    <div className="app-shell">
      <Sidebar />
      <div className="app-main">
        <header className="topbar">
          <span className="topbar__title">{title}</span>
          <span className="topbar__spacer" />
          <span className="topbar__pill" title="API target — configurable in Profile → Connection">
            <span className={`topbar__dot${online ? '' : ' topbar__dot--off'}`} />
            {online ? <Wifi size={12} /> : <WifiOff size={12} />}
            {target}
          </span>
          <button
            type="button"
            className="icon-button"
            title={`Theme: ${setting}${setting === 'system' ? ` (resolved: ${resolved})` : ''} — click to cycle`}
            onClick={() => setThemeCycle(setting, setSetting)}
            aria-label="Cycle theme"
          >
            {setting === 'system' ? <Monitor size={16} /> : resolved === 'light' ? <Sun size={16} /> : <Moon size={16} />}
          </button>
        </header>
        <div className="page-scroll">
          {!online ? (
            <div className="offline-banner">
              <WifiOff size={15} /> Offline — showing cached content. Playback will resume when the connection returns.
            </div>
          ) : null}
          <main className="page">
            <Outlet />
          </main>
        </div>
      </div>
      <UpdaterToasts />
      <NavigationListener />
    </div>
  );
}

function setThemeCycle(
  setting: 'system' | 'dark' | 'light',
  set: (next: 'system' | 'dark' | 'light') => void,
): void {
  set(setting === 'system' ? 'dark' : setting === 'dark' ? 'light' : 'system');
}

export default Shell;
