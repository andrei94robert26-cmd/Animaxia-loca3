/**
 * index.ts — App entry point (Phase 6: React Navigation, no expo-router).
 *
 * registerRootComponent mounts <App /> as the native root component for both
 * Expo Go and compiled builds (APK/IPA).
 */

import { registerRootComponent } from 'expo';

import App from './App';

registerRootComponent(App);
