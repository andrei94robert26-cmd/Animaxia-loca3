/**
 * metro.config.js — Expo Metro config (Phase 6).
 *
 * Default Expo configuration with the project root set to this folder so the
 * `app/assets/*` bundle patterns and the React Navigation entry (index.ts)
 * resolve correctly. No custom transformers needed.
 */

const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Asset extensions already include mp4/png by default; listed here so the
// offline test video is unambiguously bundled with the app.
config.resolver.assetExts.push('mp4');

module.exports = config;
