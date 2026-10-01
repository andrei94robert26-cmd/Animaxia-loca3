/**
 * app/navigation/helpers.ts — Module-level navigation access (Phase 6).
 *
 * navigationRef + navigateTo/goBackOrHome live in their own module (imported
 * by index.tsx AND by shared components) so there is never a circular import:
 * helpers.ts imports nothing from the screens.
 *
 * This replaces expo-router's imperative `router.navigate/back/replace` API
 * used throughout Phase 5.
 */

import { createNavigationContainerRef } from '@react-navigation/native';

import type { RootStackParamList } from './types';

/** The single container ref — attached in app/navigation/index.tsx. */
export const navigationRef = createNavigationContainerRef<RootStackParamList>();

/** Imperative navigation for shared components and notification deep links. */
export function navigateTo<K extends keyof RootStackParamList>(
  name: K,
  params?: RootStackParamList[K],
): void {
  if (navigationRef.isReady()) {
    // Generic-K overload resolution on the ref is not expressible; the method
    // shape is exactly (screen, params?).
    (navigationRef.navigate as unknown as (screen: K, params?: RootStackParamList[K]) => void)(
      name,
      params,
    );
  }
}

/**
 * Back when possible, otherwise jump to the tab root — mirrors the old
 * `router.canGoBack() ? router.back() : router.replace('/')` behaviour.
 */
export function goBackOrHome(): void {
  if (navigationRef.isReady() && navigationRef.current?.canGoBack()) {
    navigationRef.current.goBack();
  } else {
    navigateTo('MainTabs');
  }
}

/** Currently active root route name (best-effort, '' when not ready). */
export function currentRouteName(): string {
  if (!navigationRef.isReady()) return '';
  return navigationRef.current?.getCurrentRoute()?.name ?? '';
}
