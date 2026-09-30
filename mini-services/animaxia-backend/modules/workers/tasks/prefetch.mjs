/**
 * tasks/prefetch.mjs — worker task: pre-resolve the player for a content row
 * (policy filtering + YouTube trailer fallback) so the result can be cached on
 * the main thread. NO database access — the full content row arrives in
 * workerData, keeping this task cheap and network-only.
 *
 * workerData: { content: <full content row>, userid? }
 * posts:      { ok: true, player } | { ok: false, error }
 */

import { parentPort, workerData } from 'node:worker_threads';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

// Player policy + YouTube key come from the backend .env (not inherited here).
dotenv.config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });

const { content } = workerData || {};

try {
  if (!content || !content.id) {
    throw new Error('prefetch task requires a content row');
  }
  const { resolvePlayer } = await import('../../player/player.js');
  const player = await resolvePlayer(content);
  parentPort.postMessage({ ok: true, player });
} catch (err) {
  parentPort.postMessage({ ok: false, error: err?.message || String(err) });
}
