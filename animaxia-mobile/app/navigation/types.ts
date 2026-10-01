/**
 * app/navigation/types.ts — Route param contracts (Phase 6, React Navigation).
 *
 * Screens import the param lists from here (NOT from index.tsx) to avoid a
 * circular import: index.tsx imports the screens, the screens import types.
 */

import type { NavigatorScreenParams } from '@react-navigation/native';

/** Root stack — everything the app can show. */
export type RootStackParamList = {
  /** The 5-tab bottom navigator (Home · Feed · AI · Watchlist · Profile). */
  MainTabs: NavigatorScreenParams<MainTabParamList> | undefined;
  /** Login + register + forgot-password (modal). */
  Login: undefined;
  /** Premium plans + upgrade. */
  Premium: undefined;
  /** Content details + AI panel. */
  Content: { id: number | string };
  /** Native player + tracking + AI companion. */
  Player: { id: number | string };
};

/** Bottom tabs. */
export type MainTabParamList = {
  Home: undefined;
  Feed: undefined;
  AI: undefined;
  Watchlist: undefined;
  Profile: undefined;
};

/** Payload carried by notification taps and deep links. */
export interface DeepLinkPayload {
  route: keyof RootStackParamList;
  params?: Record<string, unknown>;
}
