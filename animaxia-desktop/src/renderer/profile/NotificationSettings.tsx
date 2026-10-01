/**
 * profile/NotificationSettings.tsx — Desktop notification settings card.
 *
 * Self-contained card rendered by the Profile screen. The Electron main
 * process owns the schedules (ipc/notifications.js); this card reads and
 * writes them through the preload bridge:
 *
 *   Daily picks      every day at 09:00      (repeating)
 *   Weekly recap     Saturdays at 18:00      (repeating)
 *   New content      when Home detects new titles (renderer-pushed)
 *   Premium renewal  3 days before renewal   (needs the plan context below)
 *
 * Settings load via notifications.getSettings() on mount; every toggle
 * persists through notifications.saveSettings(), which also cancels +
 * re-applies the schedules in main. When the signed-in user has a paid plan,
 * the renewal context (plan + expiry) is pushed once via setPremium().
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/auth/AuthContext';
import { Button, Toggle } from '@/components/primitives';
import styles from './NotificationSettings.module.css';

/** Shape persisted by the main process (mirror of the preload bridge type). */
export interface NotificationSettingsData {
  dailyPicks: boolean;
  weeklyRecap: boolean;
  newContent: boolean;
  premiumRenewal: boolean;
}

interface NotificationRow {
  key: keyof NotificationSettingsData;
  label: string;
  hint: string;
}

const NOTIFICATION_ROWS: NotificationRow[] = [
  { key: 'dailyPicks', label: 'Daily picks', hint: '09:00' },
  { key: 'weeklyRecap', label: 'Weekly recap', hint: 'Saturday 18:00' },
  { key: 'newContent', label: 'New content', hint: 'When Home detects new titles' },
  { key: 'premiumRenewal', label: 'Premium renewal', hint: '3 days before renewal' },
];

export interface NotificationSettingsProps {
  /** Called with the persisted settings after every successful change —
   *  the Profile screen re-pushes the premium context from here. */
  onSettingsChange?: (settings: NotificationSettingsData) => void;
}

export function NotificationSettings({ onSettingsChange }: NotificationSettingsProps): React.JSX.Element {
  const { user } = useAuth();
  const [settings, setSettings] = useState<NotificationSettingsData | null>(null);
  /** true when the bridge is missing (plain browser) or the load failed. */
  const [unavailable, setUnavailable] = useState(false);
  /** Mirror of `settings` so rapid toggles never race the async save. */
  const settingsRef = useRef<NotificationSettingsData | null>(null);
  const premiumSynced = useRef(false);

  /* Load the persisted settings once (main → userData/settings.json). */
  useEffect(() => {
    let cancelled = false;
    const bridge = typeof window !== 'undefined' ? window.animaxia : undefined;
    if (!bridge) {
      setUnavailable(true);
      return undefined;
    }
    bridge.notifications
      .getSettings()
      .then((loaded) => {
        if (cancelled) return;
        settingsRef.current = loaded;
        setSettings(loaded);
      })
      .catch(() => {
        if (!cancelled) setUnavailable(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /* Paid plan → push the renewal context once so the main scheduler can
   * plan the "3 days before renewal" reminder. */
  useEffect(() => {
    const bridge = typeof window !== 'undefined' ? window.animaxia : undefined;
    if (!bridge || premiumSynced.current) return;
    if (!user || !user.plan || user.plan === 'free') return;
    premiumSynced.current = true;
    try {
      bridge.notifications.setPremium({ plan: user.plan, planExpiresAt: user.planexpiresat });
    } catch {
      /* best-effort — main re-reads settings.json on launch */
    }
  }, [user]);

  const toggle = useCallback(
    (key: keyof NotificationSettingsData, next: boolean) => {
      const current = settingsRef.current;
      const bridge = typeof window !== 'undefined' ? window.animaxia : undefined;
      if (!current || !bridge) return;
      const updated: NotificationSettingsData = { ...current, [key]: next };
      settingsRef.current = updated;
      setSettings(updated);
      const patch: Partial<NotificationSettingsData> = {};
      patch[key] = next;
      bridge.notifications
        .saveSettings(patch)
        .then(() => {
          onSettingsChange?.(updated);
        })
        .catch(() => {
          /* persist failed — revert so the switches match the stored state */
          settingsRef.current = current;
          setSettings(current);
        });
    },
    [onSettingsChange],
  );

  const sendTest = useCallback(() => {
    const bridge = typeof window !== 'undefined' ? window.animaxia : undefined;
    bridge?.notifications.test({ title: 'Animaxia', body: 'Desktop notifications are working.' });
  }, []);

  return (
    <section className="card stack">
      <div className={styles.header}>
        <div className={styles.headerText}>
          <div className={styles.title}>Notifications</div>
          <div className="dim">Scheduled locally by the desktop app — they fire even when Animaxia is in the tray.</div>
        </div>
        <Button size="sm" variant="ghost" onClick={sendTest} disabled={unavailable}>
          Send a test notification
        </Button>
      </div>

      {unavailable ? (
        <p className="dim">Notification settings are unavailable — Animaxia appears to be running outside Electron.</p>
      ) : (
        <div className={styles.rows}>
          {NOTIFICATION_ROWS.map((row) => {
            const value = settings ? settings[row.key] : false;
            return (
              <div className={styles.row} key={row.key}>
                <div className={styles.rowText}>
                  <div className={styles.rowLabel}>{row.label}</div>
                  <div className={styles.rowHint}>{row.hint}</div>
                </div>
                <Toggle checked={value} onChange={(next) => toggle(row.key, next)} disabled={!settings} />
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

export default NotificationSettings;
