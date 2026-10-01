/**
 * app/profile/NotificationSettings.tsx — Local notification settings card
 * (new Phase 6 feature).
 *
 * Self-contained card rendered by the Profile screen: a "Notifications"
 * SectionHeader plus one row per category, each with a rose Switch:
 *
 *   Daily picks      every day at 09:00    (repeating calendar trigger)
 *   Weekly recap     Saturdays at 18:00    (repeating calendar trigger)
 *   New content      when new titles land  (fired by Home → checkNewContent)
 *   Premium renewal  3 days before expiry  (one-shot, set by the Profile tab)
 *
 * Settings load from AsyncStorage on mount; every toggle persists via
 * saveNotificationSettings(), which cancels + re-applies the schedules.
 * Turning a category ON first requests the system permission — when denied
 * the setting is still saved, but an amber hint explains the block.
 */

import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Switch, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SectionHeader } from '../components/Screen';
import { colors, radii, spacing, typography } from '../utils/theme';
import {
  loadNotificationSettings,
  requestNotificationPermission,
  saveNotificationSettings,
  type NotificationSettings as NotificationSettingsData,
} from '../utils/notifications';

/** One switchable category row. */
interface NotificationRow {
  key: keyof NotificationSettingsData;
  label: string;
  description: string;
}

const NOTIFICATION_ROWS: NotificationRow[] = [
  { key: 'dailyPicks', label: 'Daily picks', description: 'Every day at 09:00' },
  { key: 'weeklyRecap', label: 'Weekly recap', description: 'Saturdays at 18:00' },
  { key: 'newContent', label: 'New content', description: 'Alert when new titles land' },
  { key: 'premiumRenewal', label: 'Premium renewal', description: '3 days before your plan expires' },
];

export interface NotificationSettingsProps {
  /** Called after a change was persisted — the Profile tab re-schedules the
   *  premium-renewal reminder from here. */
  onSettingsChange?: (settings: NotificationSettingsData) => void;
}

export function NotificationSettings({
  onSettingsChange,
}: NotificationSettingsProps): React.JSX.Element {
  const [settings, setSettings] = useState<NotificationSettingsData | null>(null);
  /** true after a toggle-ON whose permission request was denied. */
  const [blocked, setBlocked] = useState(false);
  /** Mirror of `settings` so rapid toggles never race the async save. */
  const settingsRef = useRef<NotificationSettingsData | null>(null);

  /* Load the persisted settings once (never throws — defaults on failure). */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const loaded = await loadNotificationSettings();
      if (cancelled) return;
      settingsRef.current = loaded;
      setSettings(loaded);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const toggle = (key: keyof NotificationSettingsData, value: boolean): void => {
    const current = settingsRef.current;
    if (!current) return; // settings not loaded yet — switches stay disabled
    const next: NotificationSettingsData = { ...current, [key]: value };
    settingsRef.current = next;
    setSettings(next);
    void (async () => {
      if (value) {
        const granted = await requestNotificationPermission();
        setBlocked(!granted);
      }
      try {
        await saveNotificationSettings(next);
        onSettingsChange?.(next);
      } catch {
        // Storage hiccup — revert so the switches match the persisted state.
        settingsRef.current = current;
        setSettings(current);
      }
    })();
  };

  return (
    <View>
      <SectionHeader title="Notifications" />
      <View style={styles.card}>
        {NOTIFICATION_ROWS.map((row, index) => {
          const value = settings ? settings[row.key] : false;
          return (
            <View
              key={row.key}
              accessibilityRole="switch"
              accessibilityLabel={row.label}
              accessibilityState={{ checked: value }}
              style={[styles.row, index > 0 && styles.rowDivider]}
            >
              <View style={styles.rowText}>
                <Text style={styles.rowLabel}>{row.label}</Text>
                <Text style={styles.rowDescription}>{row.description}</Text>
              </View>
              <Switch
                value={value}
                disabled={!settings}
                onValueChange={(next) => toggle(row.key, next)}
                trackColor={{ false: colors.border, true: colors.rose }}
                thumbColor="#fff"
              />
            </View>
          );
        })}
        {blocked ? (
          <View style={styles.blockedHint}>
            <Ionicons name="warning-outline" size={12} color={colors.amber} />
            <Text style={styles.blockedText}>Notifications are blocked in system settings</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
  },
  rowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderSoft },
  rowText: { flex: 1, gap: 2 },
  rowLabel: { color: colors.text, fontSize: typography.small, fontWeight: '700' },
  rowDescription: { color: colors.textDim, fontSize: typography.tiny },
  blockedHint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSoft,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
  },
  blockedText: { flex: 1, color: colors.amber, fontSize: typography.tiny, fontWeight: '600' },
});

export default NotificationSettings;
