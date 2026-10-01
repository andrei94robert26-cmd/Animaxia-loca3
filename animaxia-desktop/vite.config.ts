/**
 * vite.config.ts — Renderer build for Animaxia Desktop.
 *
 *   • root: src/renderer (index.html + app.tsx entry live there)
 *   • base './'       — the app loads from file:// in production, so every
 *                        asset reference must stay relative
 *   • publicDir root  — public/offline-test.mp4 + favicon are copied verbatim
 *                        into dist-renderer/ and referenced as './…'
 *   • outDir          — dist-renderer/, the folder electron-builder packs
 *                        (see electron-builder.yml `files`)
 *   • alias '@'       — src/renderer (matches tsconfig paths)
 *
 * The Electron main process (src/main/**) is plain CommonJS and needs no
 * bundler — electron-builder ships it as-is inside the asar.
 */

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  root: 'src/renderer',
  base: './',
  publicDir: path.resolve(__dirname, 'public'),
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src/renderer'),
    },
  },
  build: {
    outDir: path.resolve(__dirname, 'dist-renderer'),
    emptyOutDir: true,
    target: 'chrome124',
    sourcemap: false,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
