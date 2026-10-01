/**
 * app/utils/offlineVideo.ts — Offline playback fallback (Phase 6).
 *
 * A tiny test clip is BUNDLED with the app (app/assets/offline-test.mp4) so
 * the player always has something to play when the network is down and the
 * cached payload has no direct URL. Public demo streams (Blender open movies
 * via Google's sample bucket) serve as additional fallback sources when a
 * remote source fails while online.
 */

/** Bundled offline test clip (asset module id — playable by expo-av). */
export const OFFLINE_TEST_VIDEO: number = require('../assets/offline-test.mp4');

export const OFFLINE_TEST_LABEL = 'Offline test clip (bundled)';

/** Public demo streams used when a source fails but the network is up. */
export const DEMO_SOURCES: { label: string; uri: string }[] = [
  {
    label: 'Big Buck Bunny (demo)',
    uri: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
  },
  {
    label: 'Sintel (demo)',
    uri: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4',
  },
  {
    label: 'Tears of Steel (demo)',
    uri: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4',
  },
];
