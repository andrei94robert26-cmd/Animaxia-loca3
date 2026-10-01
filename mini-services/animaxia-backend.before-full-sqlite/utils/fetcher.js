/**
 * utils/fetcher.js — Provider fetch layer: per-provider circuit breaker,
 * shared TTL result cache, timeout, and retry with backoff (Jikan-friendly).
 * Exposes fetchProviderJson / fetchProviderText / breakerStats.
 */

import { cache } from '../cache.js';
import { logger } from './logger.js';

const PROVIDER_CACHE_TTL_MS = parseInt(process.env.PROVIDERCACHETTL_MS || '120000', 10);
const FAILURE_THRESHOLD = parseInt(process.env.PROVIDERFAILURETHRESHOLD || '3', 10);
const CIRCUIT_OPEN_MS = parseInt(process.env.PROVIDERCIRCUITOPEN_MS || '60000', 10);

const KNOWN_PROVIDERS = ['tmdb', 'jikan', 'tvmaze', 'youtube', 'football-data', 'ergast', 'rss'];

/** Per-provider retry policies. Jikan rate-limits shared cloud IPs hard — retry longer. */
const PROVIDER_RETRY_POLICY = {
  jikan: { retries: 4, backoffMs: 2000 },
};

function retryPolicy(provider) {
  return PROVIDER_RETRY_POLICY[provider] || { retries: 2, backoffMs: 800 };
}

/** Error carrying an HTTP-ish status for the Express error middleware. */
export class ProviderError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
  }
}

/** Circuit breaker registry: name -> { state, failures, openedAt, lastError, probing } */
const breakers = new Map();

function getBreaker(name) {
  let b = breakers.get(name);
  if (!b) {
    b = { state: 'closed', failures: 0, openedAt: 0, lastError: null, probing: false };
    breakers.set(name, b);
  }
  return b;
}

export function breakerStats() {
  for (const name of KNOWN_PROVIDERS) getBreaker(name);
  return Array.from(breakers.entries()).map(([name, b]) => ({
    name,
    state: b.state,
    failures: b.failures,
    ...(b.lastError ? { lastError: b.lastError } : {}),
  }));
}

function assertCircuitAllows(provider) {
  const b = getBreaker(provider);
  if (b.state === 'open') {
    if (Date.now() - b.openedAt >= CIRCUIT_OPEN_MS) {
      b.state = 'half-open';
      b.probing = true;
    } else {
      throw new ProviderError(`Provider circuit open: ${provider}`, 503);
    }
  } else if (b.state === 'half-open') {
    b.probing = true;
  }
}

function recordSuccess(provider) {
  const b = getBreaker(provider);
  b.state = 'closed';
  b.failures = 0;
  b.lastError = null;
  b.probing = false;
}

function recordFailure(provider, message) {
  const b = getBreaker(provider);
  b.failures += 1;
  b.lastError = message;
  if (b.state === 'half-open' || b.failures >= FAILURE_THRESHOLD) {
    b.state = 'open';
    b.openedAt = Date.now();
    b.probing = false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildUrl(url, params) {
  if (!params || Object.keys(params).length === 0) return url;
  const u = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) u.searchParams.set(key, String(value));
  }
  return u.toString();
}

function isRetryableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Shared core: fetch a provider URL with circuit breaker + cache + retries.
 * Returns parsed JSON or raw text depending on `as`.
 */
async function fetchProvider(provider, url, options = {}, as = 'json') {
  const policy = retryPolicy(provider);
  const { headers = {}, timeoutMs = 10000, params } = options;
  const retries = Math.max(1, options.retries ?? policy.retries);
  const backoffMs = policy.backoffMs;
  assertCircuitAllows(provider);

  const finalUrl = buildUrl(url, params);
  const cacheKey = `provider:${provider}:${finalUrl}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  const maxAttempts = Math.max(1, retries + 1);
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const res = await fetch(finalUrl, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
      });

      if (!res.ok) {
        const err = new ProviderError(
          `${provider} responded ${res.status} ${res.statusText} for ${finalUrl}`,
          res.status,
        );
        if (isRetryableStatus(res.status) && attempt < maxAttempts) {
          logger.warn(`[fetcher] ${err.message} — retrying (attempt ${attempt}/${maxAttempts})`);
          await sleep(backoffMs * attempt);
          lastError = err;
          continue;
        }
        recordFailure(provider, err.message);
        throw err;
      }

      const body = as === 'text' ? await res.text() : await res.json();
      recordSuccess(provider);
      cache.set(cacheKey, body, PROVIDER_CACHE_TTL_MS);
      return body;
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      lastError = err;
      if (attempt < maxAttempts) {
        logger.warn(
          `[fetcher] ${provider} network error (${err.name || 'Error'}: ${err.message}) — retrying (attempt ${attempt}/${maxAttempts})`,
        );
        await sleep(backoffMs * attempt);
      }
    }
  }

  const message = `${provider} request failed after ${maxAttempts} attempts: ${lastError ? (lastError.message || lastError.name) : 'unknown error'}`;
  recordFailure(provider, message);
  throw new ProviderError(message, 502);
}

/** Fetch a provider URL and return parsed JSON. */
export async function fetchProviderJson(provider, url, options = {}) {
  return fetchProvider(provider, url, options, 'json');
}

/** Fetch a provider URL and return raw text (e.g. RSS XML). */
export async function fetchProviderText(provider, url, options = {}) {
  return fetchProvider(provider, url, options, 'text');
}
