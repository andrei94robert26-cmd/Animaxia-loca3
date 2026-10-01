/**
 * common/services.js — Animaxia Cloud service registry: names, default ports,
 * gateway route prefixes and URL resolution (per-service URL env overrides,
 * falling back to http://localhost:<port>).
 */

export const SERVICE_NAMES = [
  'gateway',
  'auth',
  'content',
  'ai',
  'analytics',
  'search',
  'premium',
  'social',
  'mobile',
  'queue',
];

export const SERVICE_PORTS = {
  gateway: 8080,
  auth: 4001,
  content: 4002,
  ai: 4003,
  analytics: 4004,
  search: 4005,
  premium: 4006,
  social: 4007,
  mobile: 4008,
  queue: 4009,
};

/** Env override per service (house style, no underscores): GATEWAYPORT, AUTHPORT, ... */
export const SERVICE_PORT_ENV = {
  gateway: 'GATEWAYPORT',
  auth: 'AUTHPORT',
  content: 'CONTENTPORT',
  ai: 'AIPORT',
  analytics: 'ANALYTICSPORT',
  search: 'SEARCHPORT',
  premium: 'PREMIUMPORT',
  social: 'SOCIALPORT',
  mobile: 'MOBILEPORT',
  queue: 'QUEUEPORT',
};

/** Env base-URL override per service: AUTHSERVICEURL, CONTENTSERVICEURL, ... */
export const SERVICE_URL_ENV = {
  gateway: 'GATEWAYSERVICEURL',
  auth: 'AUTHSERVICEURL',
  content: 'CONTENTSERVICEURL',
  ai: 'AISERVICEURL',
  analytics: 'ANALYTICSSERVICEURL',
  search: 'SEARCHSERVICEURL',
  premium: 'PREMIUMSERVICEURL',
  social: 'SOCIALSERVICEURL',
  mobile: 'MOBILESERVICEURL',
  queue: 'QUEUESERVICEURL',
};

/** Resolve the base URL of a service (docker/k8s override via env). */
export function serviceUrl(name) {
  const envName = SERVICE_URL_ENV[name];
  if (envName && process.env[envName]) return String(process.env[envName]).replace(/\/$/, '');
  const port = SERVICE_PORTS[name];
  return `http://localhost:${port}`;
}

export function servicePort(name) {
  const envName = SERVICE_PORT_ENV[name];
  if (envName && process.env[envName]) {
    const parsed = parseInt(process.env[envName], 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return SERVICE_PORTS[name];
}

/** Gateway route prefix table (BLUEPRINT §3) — single source for routing docs. */
export const GATEWAY_ROUTES = [
  { prefix: '/api/auth', service: 'auth' },
  { prefix: '/api/users', service: 'auth' },
  { prefix: '/api/security', service: 'auth' },
  { prefix: '/api/all', service: 'content' },
  { prefix: '/api/content', service: 'content' },
  { prefix: '/api/miner', service: 'content' },
  { prefix: '/api/admin', service: 'content' },
  { prefix: '/api/anime', service: 'content' },
  { prefix: '/api/movies', service: 'content' },
  { prefix: '/api/tv', service: 'content' },
  { prefix: '/api/sports', service: 'content' },
  { prefix: '/api/news', service: 'content' },
  { prefix: '/api/cache', service: 'content' },
  { prefix: '/api/ai', service: 'ai' },
  { prefix: '/api/vector', service: 'ai' }, // Phase 4 — Animaxia AI Cloud vector-service (BLUEPRINT §11)
  { prefix: '/api/analytics', service: 'analytics' },
  { prefix: '/api/search', service: 'search' },
  { prefix: '/api/premium', service: 'premium' },
  { prefix: '/api/social', service: 'social' },
  { prefix: '/api/mobile', service: 'mobile' },
  { prefix: '/api/queue', service: 'queue' },
  { prefix: '/api/workers', service: 'queue' },
];
