/**
 * Actual upstream fetch history (not a fabricated availability probe).
 * Shows outcome from an attempted provider HTTP request, not live playback.
 */
import { localDb } from '../local/sqlite.js';
let schemaReady = false;
export function ensureProviderHealthSchema() {
  if (schemaReady) return;
  localDb.exec(`
    CREATE TABLE IF NOT EXISTS provider_fetch_health (
      providerid TEXT PRIMARY KEY,
      attempts INTEGER NOT NULL DEFAULT 0,
      successes INTEGER NOT NULL DEFAULT 0,
      lastattempt TEXT,
      lastsuccess TEXT,
      laststatus TEXT,
      lastitemcount INTEGER NOT NULL DEFAULT 0,
      lasterror TEXT
    );
  `);
  schemaReady = true;
}
export function recordProviderFetch(id, { ok, count = 0, error = null }) {
  ensureProviderHealthSchema();
  const when = new Date().toISOString();
  localDb.prepare(`
    INSERT INTO provider_fetch_health
      (providerid,attempts,successes,lastattempt,lastsuccess,laststatus,lastitemcount,lasterror)
    VALUES(?,1,?,?,?, ?,?,?)
    ON CONFLICT(providerid) DO UPDATE SET
      attempts=attempts+1,
      successes=successes+excluded.successes,
      lastattempt=excluded.lastattempt,
      lastsuccess=COALESCE(excluded.lastsuccess,provider_fetch_health.lastsuccess),
      laststatus=excluded.laststatus,
      lastitemcount=excluded.lastitemcount,
      lasterror=excluded.lasterror
  `).run(
    id, ok ? 1 : 0, when, ok ? when : null,
    ok ? 'success' : 'error', ok ? count : 0,
    ok ? null : String(error || 'Upstream request failed').slice(0, 220),
  );
}
export function getProviderFetchHealth(id) {
  ensureProviderHealthSchema();
  const row = localDb.prepare('SELECT * FROM provider_fetch_health WHERE providerid=?')
    .get(String(id));
  if (!row) return {
    attempts: 0, successes: 0, lastAttemptAt: null, lastSuccessAt: null,
    lastStatus: 'never-checked', lastItemCount: null, lastError: null,
  };
  return {
    attempts: Number(row.attempts), successes: Number(row.successes),
    lastAttemptAt: row.lastattempt, lastSuccessAt: row.lastsuccess,
    lastStatus: row.laststatus, lastItemCount: Number(row.lastitemcount),
    lastError: row.lasterror,
  };
}
