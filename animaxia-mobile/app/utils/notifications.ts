/**
 * app/utils/notifications.ts — Expo local notifications (Phase 6).
 *
 * Four categories, all scheduled LOCALLY on the device (no push server
 * required — repeating triggers fire even when the app is killed):
 *
 *   dailyPicks      every day 09:00 — "your AI daily picks are ready"
 *   weeklyRecap     every Saturday 18:00 — weekly recap nudge
 *   newContent      when the Home feed surfaces unseen titles
 *   premiumRenewal  3 days before the current plan expires
 *
 * Settings are persisted in AsyncStorage; toggling re-applies the schedule
 * (Profile → Notifications). Taps deep-link through app/navigation/helpers.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';

import type { DeepLinkPayload } from '../navigation/types';

export const NOTIFICATION_IDS = {
  dailyPicks: 'animaxia.daily-picks',
  weeklyRecap: 'animaxia.weekly-recap',
  newContent: 'animaxia.new-content',
  premiumRenewal: 'animaxia.premium-renewal',
} as const;

const SETTINGS_KEY = 'animaxia.notification-settings';
const SEEN_CONTENT_KEY = 'animaxia.seen-content-ids';
const ANDROID_CHANNEL_ID = 'animaxia';
const RENEWAL_LEAD_MS = 3 * 24 * 60 * 60 * 1000;

export interface NotificationSettings {
  dailyPicks: boolean;
  weeklyRecap: boolean;
  newContent: boolean;
  premiumRenewal: boolean;
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  dailyPicks: true,
  weeklyRecap: true,
  newContent: true,
  premiumRenewal: true,
};

/* Foreground presentation: banner + sound while the app is open. */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/** Android 8+ notification channel (importance HIGH, rose accent). */
async function ensureAndroidChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    await Notifications.setNotificationChannelAsync(ANDROID_CHANNEL_ID, {
      name: 'Animaxia',
      description: 'Daily picks, weekly recap, new content and premium reminders',
      importance: Notifications.AndroidImportance.HIGH,
      sound: 'default',
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
      bypassDnd: false,
    });
  } catch {
    /* channel creation is idempotent; failures are non-fatal */
  }
}

/** App-boot init: Android channel (permissions are requested on first toggle). */
export async function initNotifications(): Promise<void> {
  await ensureAndroidChannel();
}

/** Request (or check) the POST_NOTIFICATIONS / alert permission. */
export async function requestNotificationPermission(): Promise<boolean> {
  try {
    const current = await Notifications.getPermissionsAsync();
    if (current.granted) return true;
    if (current.canAskAgain === false) return false;
    const asked = await Notifications.requestPermissionsAsync({
      ios: { allowAlert: true, allowSound: true, allowBadge: false },
    });
    return asked.granted;
  } catch {
    return false;
  }
}

export async function hasNotificationPermission(): Promise<boolean> {
  try {
    const settings = await Notifications.getPermissionsAsync();
    return settings.granted;
  } catch {
    return false;
  }
}

/* --------------------------------- settings --------------------------------- */

export async function loadNotificationSettings(): Promise<NotificationSettings> {
  try {
    const raw = await AsyncStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_NOTIFICATION_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<NotificationSettings>;
    return { ...DEFAULT_NOTIFICATION_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_NOTIFICATION_SETTINGS };
  }
}

async function persistSettings(settings: NotificationSettings): Promise<void> {
  await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

/** Persist + (re)apply the repeating schedules. Returns the saved settings. */
export async function saveNotificationSettings(
  settings: NotificationSettings,
): Promise<NotificationSettings> {
  await persistSettings(settings);
  await applyNotificationSchedules(settings);
  return settings;
}

/** Cancel + reschedule the repeating categories according to `settings`. */
export async function applyNotificationSchedules(settings: NotificationSettings): Promise<void> {
  const cancel = async (id: string) => {
    try {
      await Notifications.cancelScheduledNotificationAsync(id);
    } catch {
      /* unknown identifier — nothing to cancel */
    }
  };
  await cancel(NOTIFICATION_IDS.dailyPicks);
  await cancel(NOTIFICATION_IDS.weeklyRecap);

  if (settings.dailyPicks) {
    try {
      await Notifications.scheduleNotificationAsync({
        identifier: NOTIFICATION_IDS.dailyPicks,
        content: {
          title: 'Your daily picks are ready 🍿',
          body: 'Animaxia AI has fresh titles picked just for you.',
          sound: true,
          data: { route: 'MainTabs' },
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.CALENDAR,
          hour: 9,
          minute: 0,
          repeats: true,
          channelId: ANDROID_CHANNEL_ID,
        },
      });
    } catch {
      /* scheduling without permission — ignored */
    }
  }

  if (settings.weeklyRecap) {
    try {
      await Notifications.scheduleNotificationAsync({
        identifier: NOTIFICATION_IDS.weeklyRecap,
        content: {
          title: 'Your weekly recap is in 📊',
          body: 'See what you watched and what AI lined up for next week.',
          sound: true,
          data: { route: 'MainTabs' },
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.CALENDAR,
          weekday: 7, // 1 = Sunday … 7 = Saturday
          hour: 18,
          minute: 0,
          repeats: true,
          channelId: ANDROID_CHANNEL_ID,
        },
      });
    } catch {
      /* scheduling without permission — ignored */
    }
  }
}

/* ----------------------------- new content alerts ---------------------------- */

/**
 * Compare the current home feed against the last seen set; when new titles
 * appear (and the category is enabled) fire one summary notification.
 * Returns the number of new titles detected.
 */
export async function checkNewContent(
  items: Array<{ id: number; title: string }>,
  enabled: boolean,
): Promise<number> {
  const ids = items.map((i) => i.id);
  if (items.length === 0) return 0;

  if (!enabled) {
    await rememberSeenContent(ids);
    return 0;
  }

  let seen: number[] = [];
  try {
    const raw = await AsyncStorage.getItem(SEEN_CONTENT_KEY);
    seen = raw ? (JSON.parse(raw) as number[]) : [];
  } catch {
    seen = [];
  }

  const fresh = items.filter((i) => !seen.includes(i.id));
  const hasBaseline = seen.length > 0;

  await rememberSeenContent(ids);

  if (hasBaseline && fresh.length > 0) {
    try {
      await Notifications.scheduleNotificationAsync({
        identifier: NOTIFICATION_IDS.newContent,
        content: {
          title: `${fresh.length} new ${fresh.length === 1 ? 'title' : 'titles'} on Animaxia`,
          body: fresh.slice(0, 3).map((i) => i.title).join(' · '),
          sound: true,
          data: { route: 'MainTabs' },
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DATE,
          date: new Date(Date.now() + 2000), // short delay → surfaces as a banner
        },
      });
    } catch {
      /* ignore */
    }
  }
  return fresh.length;
}

async function rememberSeenContent(ids: number[]): Promise<void> {
  try {
    await AsyncStorage.setItem(SEEN_CONTENT_KEY, JSON.stringify(ids.slice(0, 500)));
  } catch {
    /* ignore */
  }
}

/* ------------------------------ premium renewal ------------------------------ */

/**
 * Schedule a one-shot renewal reminder 3 days before the plan expires
 * (cancelled + rescheduled on every profile load).
 */
export async function schedulePremiumRenewalReminder(
  plan: string,
  expiresAt: string | null | undefined,
  enabled: boolean,
): Promise<void> {
  try {
    await Notifications.cancelScheduledNotificationAsync(NOTIFICATION_IDS.premiumRenewal);
  } catch {
    /* ignore */
  }
  if (!enabled || !expiresAt) return;
  const expiry = new Date(expiresAt).getTime();
  if (!Number.isFinite(expiry)) return;
  const remindAt = expiry - RENEWAL_LEAD_MS;
  if (remindAt <= Date.now()) return; // too close / already expired
  try {
    await Notifications.scheduleNotificationAsync({
      identifier: NOTIFICATION_IDS.premiumRenewal,
      content: {
        title: `Your ${plan} plan expires soon ⏳`,
        body: 'Renew from Premium to keep your quality, downloads and AI limits.',
        sound: true,
        data: { route: 'Premium' },
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: new Date(remindAt),
      },
    });
  } catch {
    /* ignore */
  }
}

/* ------------------------------- tap routing -------------------------------- */

/**
 * Route notification taps. Payloads are { route, params } (DeepLinkPayload);
 * App.tsx maps them onto the root stack. Returns an unsubscribe function.
 */
export function handleNotificationTap(
  onDeepLink: (payload: DeepLinkPayload) => void,
): () => void {
  const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
    const data = response.notification.request.content.data as
      | Partial<DeepLinkPayload>
      | undefined;
    if (!data || typeof data.route !== 'string') return;
    onDeepLink({
      route: data.route as DeepLinkPayload['route'],
      params: (data.params as Record<string, unknown>) ?? undefined,
    });
  });
  return () => subscription.remove();
}

/** Scheduled identifiers (for the settings screen / debugging). */
export async function scheduledNotificationIds(): Promise<string[]> {
  try {
    const all = await Notifications.getAllScheduledNotificationsAsync();
    return all.map((n) => n.identifier);
  } catch {
    return [];
  }
}
