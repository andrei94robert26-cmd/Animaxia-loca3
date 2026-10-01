/**
 * components/BottomNav.tsx — The 5-tab bottom bar: Home, Feed, AI, Watchlist,
 * Profile. Premium is reachable from Profile/upgrade cards. Uses
 * expo-router's usePathname for active-tab detection and router.navigate for
 * tab switches (keeps each screen's state in the stack).
 */

import React from 'react';
import { Pressable, StyleSheet, View, Text } from 'react-native';
import { usePathname, router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, typography } from '../theme';

const TABS = [
  { route: '/', label: 'Home', icon: 'home' as const },
  { route: '/feed', label: 'Feed', icon: 'newspaper' as const },
  { route: '/ai', label: 'AI', icon: 'sparkles' as const },
  { route: '/watchlist', label: 'Saved', icon: 'bookmark' as const },
  { route: '/profile', label: 'Profile', icon: 'person' as const },
];

export function BottomNav(): React.JSX.Element {
  const pathname = usePathname();
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, 10) }]}>
      {TABS.map((tab) => {
        const active = pathname === tab.route;
        return (
          <Pressable
            key={tab.route}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={tab.label}
            style={styles.tab}
            onPress={() => router.navigate(tab.route as never)}
          >
            <Ionicons
              name={active ? tab.icon : `${tab.icon}-outline`}
              size={22}
              color={active ? colors.rose : colors.textDim}
            />
            <Text style={[styles.label, active && styles.labelActive]}>{tab.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    backgroundColor: 'rgba(10,10,16,0.96)',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingTop: 8,
  },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 2, minHeight: 52 },
  label: { color: colors.textDim, fontSize: typography.tiny, fontWeight: '600' },
  labelActive: { color: colors.rose },
});

export default BottomNav;
