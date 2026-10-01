/**
 * tasks/mine.mjs — worker task: mine a URL for metadata + playable sources and
 * upsert the record into the content table. Runs in its own worker isolate:
 * the dynamic imports below create a SEPARATE db.js module instance with its
 * own lazy pg pool (connections opened on initDb(), closed before exit).
 *
 * workerData: { url, type?, externalId?, userid? }
 * posts:      { ok: true, extraction, record } | { ok: false, error }
 *
 * NOTE: the backend .env is loaded explicitly (path anchored to this file)
 * because worker isolates do not inherit the main process's dotenv/config call.
 */

import { parentPort, workerData } from 'node:worker_threads';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

dotenv.config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });

const { url, type, externalId } = workerData || {};

try {
  if (!url || typeof url !== 'string') {
    throw new Error('mine task requires a url');
  }
  const { initDb, closeDb } = await import('../../../db.js');
  const { mineUrl } = await import('../../../miner.js');

  await initDb(); // worker gets its own pool — must open before querying
  const { extraction, record } = await mineUrl(url, { type, externalId });
  await closeDb(); // release worker-side connections before exit

  parentPort.postMessage({ ok: true, extraction, record });
} catch (err) {
  try {
    const { closeDb } = await import('../../../db.js');
    await closeDb();
  } catch {
    /* pool may never have opened */
  }
  parentPort.postMessage({ ok: false, error: err?.message || String(err) });
}
