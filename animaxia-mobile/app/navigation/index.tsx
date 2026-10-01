/**
 * app/navigation/index.tsx — React Navigation root (Phase 6).
 *
 *   RootNavigator
 *   └─ Stack (native-stack, no headers, dark chrome)
 *      ├─ MainTabs (bottom tabs + custom BottomNav tab bar)
 *      │   Home · Feed · AI · Watchlist · Profile
 *      ├─ Login    modal  — login / register / forgot password
 *      ├─ Premium  stack  — plans + upgrade
 *      ├─ Content  stack  — details + AI panel
 *      └─ Player   full-screen modal — video + tracking + AI companion
 *
 * Deep links: animaxia://home|feed|ai|watchlist|profile|premium|login,
 * animaxia://content/:id, animaxia://player/:id — same paths as the Phase-5
 * expo-router scheme, so existing links and notification payloads keep working.
 */

import React from 'react';
import { DarkTheme, NavigationContainer, type LinkingOptions } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';

import { BottomNav } from '../components/BottomNav';
import AIHubScreen from '../screens/AIHubScreen';
import ContentScreen from '../screens/ContentScreen';
import FeedScreen from '../screens/FeedScreen';
import HomeScreen from '../screens/HomeScreen';
import LoginScreen from '../screens/LoginScreen';
import PlayerScreen from '../screens/PlayerScreen';
import PremiumScreen from '../screens/PremiumScreen';
import ProfileScreen from '../screens/ProfileScreen';
import WatchlistScreen from '../screens/WatchlistScreen';
import { colors } from '../utils/theme';
import { navigationRef } from './helpers';
import type { MainTabParamList, RootStackParamList } from './types';

export type { DeepLinkPayload, MainTabParamList, RootStackParamList } from './types';
export { goBackOrHome, navigateTo, navigationRef } from './helpers';

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator<MainTabParamList>();

/** animaxia:// deep-link configuration (notification taps + external links). */
const linking: LinkingOptions<RootStackParamList> = {
  prefixes: ['animaxia://'],
  config: {
    screens: {
      MainTabs: {
        screens: {
          Home: 'home',
          Feed: 'feed',
          AI: 'ai',
          Watchlist: 'watchlist',
          Profile: 'profile',
        },
      },
      Login: 'login',
      Premium: 'premium',
      Content: 'content/:id',
      Player: 'player/:id',
    },
  },
};

/** Dark cinema theme aligned with the app's design tokens. */
const navTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: colors.bg,
    card: colors.card,
    border: colors.border,
    primary: colors.rose,
    text: colors.text,
  },
};

/** The 5-tab bottom navigator with the Phase-5 BottomNav as custom tab bar. */
function MainTabs(): React.JSX.Element {
  return (
    <Tab.Navigator
      screenOptions={{ headerShown: false, lazy: true }}
      tabBar={(props) => <BottomNav {...props} />}
    >
      <Tab.Screen name="Home" component={HomeScreen} />
      <Tab.Screen name="Feed" component={FeedScreen} />
      <Tab.Screen name="AI" component={AIHubScreen} />
      <Tab.Screen name="Watchlist" component={WatchlistScreen} />
      <Tab.Screen name="Profile" component={ProfileScreen} />
    </Tab.Navigator>
  );
}

export function RootNavigator(): React.JSX.Element {
  return (
    <NavigationContainer ref={navigationRef} linking={linking} theme={navTheme}>
      <Stack.Navigator
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.bg },
          animation: 'slide_from_right',
        }}
      >
        <Stack.Screen name="MainTabs" component={MainTabs} />
        <Stack.Screen
          name="Login"
          options={{ presentation: 'modal', animation: 'slide_from_bottom' }}
          component={LoginScreen}
        />
        <Stack.Screen name="Premium" component={PremiumScreen} />
        <Stack.Screen name="Content" component={ContentScreen} />
        <Stack.Screen
          name="Player"
          options={{ presentation: 'fullScreenModal', animation: 'slide_from_bottom' }}
          component={PlayerScreen}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

export default RootNavigator;
