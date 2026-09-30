/**
 * rateLimit.js — Global fixed-window per-client rate limiter.
 * clientId = first X-Forwarded-For value | X-Real-IP | socket.remoteAddress.
 * Sends X-RateLimit-Limit/Remaining/Reset headers; 429 + Retry-After when exceeded.
 */

const WINDOW_MS = parseInt(process.env.RATELIMITWINDOW_MS || '60000', 10);
const MAX = parseInt(process.env.RATELIMITMAX || '120', 10);

const clients = new Map();
let totalLimited = 0;

function cleanup() {
  const now = Date.now();
  for (const [id, entry] of clients) {
    if (entry.resetAt <= now) clients.delete(id);
  }
}

const cleanupTimer = setInterval(cleanup, Math.max(WINDOW_MS, 30000));
if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref();

function clientIdOf(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const first = String(xff).split(',')[0].trim();
    if (first) return first;
  }
  if (req.headers['x-real-ip']) return String(req.headers['x-real-ip']);
  if (req.socket && req.socket.remoteAddress) return req.socket.remoteAddress;
  return 'unknown';
}

export function rateLimitMiddleware(req, res, next) {
  const clientId = clientIdOf(req);
  const now = Date.now();
  let entry = clients.get(clientId);

  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + WINDOW_MS };
    clients.set(clientId, entry);
  }

  entry.count += 1;
  const remaining = Math.max(0, MAX - entry.count);
  const resetUnixSec = Math.ceil(entry.resetAt / 1000);

  res.set('X-RateLimit-Limit', String(MAX));
  res.set('X-RateLimit-Remaining', String(remaining));
  res.set('X-RateLimit-Reset', String(resetUnixSec));

  if (entry.count > MAX) {
    totalLimited += 1;
    const retryAfterSec = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    res.set('Retry-After', String(retryAfterSec));
    return res.status(429).json({
      error: 'Too many requests — please slow down',
      retryAfterSec,
    });
  }

  return next();
}

export function rateLimitStats() {
  return {
    windowMs: WINDOW_MS,
    max: MAX,
    trackedClients: clients.size,
    totalLimited,
  };
}

export default rateLimitMiddleware;
