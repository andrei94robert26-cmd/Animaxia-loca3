/**
 * env.js — configuration loading for animaxia-realtime.
 *
 * Resolution order for every variable: real process env → local ./.env →
 * the monolith's .env (../animaxia-backend/.env, the canonical restored
 * source). This makes the service survive session-reset env wipes as long as
 * the monolith .env was restored, and keeps AUTHSECRET parity automatic.
 *
 * House style (FAZA 10 recon): the monolith .env uses names WITHOUT
 * underscores for historical keys (AUTHSECRET, DATABASEURL); both spellings
 * are accepted here for the FAZA-10 additions.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

function parseEnvFile(path) {
  try {
    const text = readFileSync(path, 'utf8');
    const out = {};
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

const localEnv = parseEnvFile(join(HERE, '.env'));
const monolithEnv = parseEnvFile(join(HERE, '..', 'animaxia-backend', '.env'));

/** Get a config value: process env → local .env → monolith .env → fallback. */
export function env(name, fallback = undefined) {
  if (process.env[name] !== undefined) return process.env[name];
  if (localEnv[name] !== undefined) return localEnv[name];
  if (monolithEnv[name] !== undefined) return monolithEnv[name];
  return fallback;
}

export const config = {
  port: Number.parseInt(env('PORT', '4010'), 10) || 4010,
  monolithUrl: (env('MONOLITHURL') || env('MONOLITH_URL') || 'http://127.0.0.1:4000').replace(/\/$/, ''),
  authSecret: env('AUTHSECRET') || '',
  databaseUrl: env('DATABASEURL') || env('DATABASE_URL') || 'local',
  internalToken: env('REALTIMETOKEN') || env('REALTIME_TOKEN') || '',
};

export default config;
