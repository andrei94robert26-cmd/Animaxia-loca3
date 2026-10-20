#!/usr/bin/env node
/**
 * Operator-only repair of the local Content FTS5 index.
 *
 * Run with backend stopped or traffic drained; rebuild is synchronous and
 * scales with the number of records. Back up SQLite first.
 */
import { initDb } from '../db.js';
import { rebuildContentFts, countFtsRows } from '../modules/search/content-fts.js';

if (process.argv[2] !== '--confirm') {
  console.error('Usage: node scripts/rebuild-content-fts.mjs --confirm');
  console.error('Backup the SQLite DB and stop writes before running.');
  process.exitCode = 2;
} else {
  try {
    await initDb();
    const before = countFtsRows();
    const after = rebuildContentFts();
    console.log(JSON.stringify({
      ok: true, engine: 'sqlite-fts5', before, after, at: new Date().toISOString(),
    }));
  } catch (err) {
    console.error('FTS5 rebuild failed:', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
