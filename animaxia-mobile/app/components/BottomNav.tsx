/**
 * components/BottomNav.tsx — The 5-tab bottom bar: Home, Feed, AI, Watchlist,
 * Profile. Rendered as the CUSTOM TAB BAR of the React Navigation tab
 * navigator (app/navigation/index.tsx) — same Phase-5 visuals (rose accent on
 * charcoal, absolute overlay; screens keep their 96pt bottom padding).
 */

import React from 'react';
import { Pressable, StyleSheet, View, Text } from 'react-native';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, typography } from '../utils/theme';

const TABS = [
  { name: 'Home', label: 'Home', icon: 'home' as const },
  { name: 'Feed', label: 'Feed', icon: 'newspaper' as const },
  { name: 'AI', label: 'AI', icon: 'sparkles' as const },
  { name: 'Watchlist', label: 'Saved', icon: 'bookmark' as const },
  { name: 'Profile', label: 'Profile', icon: 'person' as const },
];

export function BottomNav({ state, descriptors, navigation }: BottomTabBarProps): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const current = state.routes[state.index]?.name;

  return (
    <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, 10) }]}>
      {TABS.map((tab) => {
        const route = state.routes.find((r) => r.name === tab.name);
        if (!route) return null;
        const active = current === tab.name;
        const { options } = descriptors[route.key];

        const onPress = () => {
          const event = navigation.emit({
            type: 'tabPress',
            target: route.key,
            canPreventDefault: true,
          });
          if (!active && !event.defaultPrevented) {
            // Keep each tab's state in the stack — same as Phase 5.
            navigation.navigate(tab.name);
          }
        };
        const onLongPress = () => {
          navigation.emit({ type: 'tabLongPress', target: route.key });
        };

        return (
          <Pressable
            key={tab.name}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={options.tabBarAccessibilityLabel ?? tab.label}
            style={styles.tab}
            onPress={onPress}
            onLongPress={onLongPress}
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
