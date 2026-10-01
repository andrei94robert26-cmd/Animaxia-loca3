/**
 * app/_layout.tsx — Root layout: AuthProvider wraps the expo-router Stack.
 *
 *   /            Home (tab root)
 *   /feed        Feed (tab root)          /ai          AI hub (tab root)
 *   /watchlist   Watchlist (tab root)     /profile     Profile (tab root)
 *   /login       modal                    /premium     plans + upgrade
 *   /content/:id details + AI panel       /player/:id  video + tracking
 */

import React from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { AuthProvider } from '../auth/AuthContext';
import { colors } from '../theme';

export default function RootLayout(): React.JSX.Element {
  return (
    <AuthProvider>
      <StatusBar style="light" backgroundColor={colors.bg} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.bg },
          animation: 'slide_from_right',
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="feed" />
        <Stack.Screen name="ai" />
        <Stack.Screen name="watchlist" />
        <Stack.Screen name="profile" />
        <Stack.Screen name="login" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
        <Stack.Screen name="premium" />
        <Stack.Screen name="content/[id]" />
        <Stack.Screen name="player/[id]" options={{ animation: 'slide_from_bottom' }} />
      </Stack>
    </AuthProvider>
  );
}
