/**
 * App.tsx — Phase 6 root: AuthProvider + React Navigation root + notification
 * wiring.
 *
 *   • AuthProvider  — session restore/validation (app/context/AuthContext)
 *   • RootNavigator — tabs (Home · Feed · AI · Watchlist · Profile) + stack
 *                     (Login modal · Premium · Content · Player) — see
 *                     app/navigation/index.tsx
 *   • Notifications — Expo local notifications are initialized here and taps
 *                     deep-link through the module-level navigationRef.
 */

import React, { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';

import { AuthProvider } from './app/context/AuthContext';
import { RootNavigator, navigationRef } from './app/navigation';
import { colors } from './app/utils/theme';
import { handleNotificationTap, initNotifications } from './app/utils/notifications';

export default function App(): React.JSX.Element {
  useEffect(() => {
    // Android channel + handler setup (permissions are requested from
    // Profile → Notifications when the user enables a category).
    void initNotifications();

    // Deep-link notification taps: { route, params } payloads navigate the
    // root stack (Content / Player / Premium / tabs).
    return handleNotificationTap(({ route, params }) => {
      const nav = navigationRef.current;
      if (!nav) return;
      switch (route) {
        case 'Content':
        case 'Player':
        case 'Premium':
        case 'Login':
          nav.navigate(route, params as never);
          break;
        default:
          nav.navigate('MainTabs');
          break;
      }
    });
  }, []);

  return (
    <AuthProvider>
      <StatusBar style="light" backgroundColor={colors.bg} />
      <RootNavigator />
    </AuthProvider>
  );
}
