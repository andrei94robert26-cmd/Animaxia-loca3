/**
 * utils/logger.js — Leveled colorized console logger with ISO timestamps.
 * Exports `logger` (debug/info/warn/error) and `requestLogger` Express middleware
 * that logs `METHOD /path STATUS 123ms ip` on response finish.
 * Colors: gray(dim) reset, green, yellow, red, cyan via ANSI escape codes.
 *
 * TS3 (observability): LOGFORMAT=json (from .env) switches EVERY line — logger
 * calls and request access lines — to single-line JSON {time, level, msg,
 * ...extra} so a log shipper (Loki / Datadog / otel-collector) can parse the
 * stream without regex. The colorized human format is fully preserved when
 * the env var is absent (default).
 */

const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
};

const LEVEL_COLORS = {
  DEBUG: COLORS.dim,
  INFO: COLORS.green,
  WARN: COLORS.yellow,
  ERROR: COLORS.red,
};

function timestamp() {
  return new Date().toISOString();
}

/** TS3: single-line JSON mode (LOGFORMAT=json) — one parsable object per line. */
const JSON_LOGS = (process.env.LOGFORMAT || '').trim().toLowerCase() === 'json';

function write(level, message) {
  if (JSON_LOGS) {
    const line = JSON.stringify({ time: timestamp(), level, msg: String(message) });
    if (level === 'ERROR') console.error(line);
    else if (level === 'WARN') console.warn(line);
    else console.log(line);
    return;
  }
  const color = LEVEL_COLORS[level] || COLORS.reset;
  const prefix = `[${timestamp()}] [${level}]`;
  if (level === 'ERROR') {
    console.error(`${color}${prefix}${COLORS.reset} ${message}`);
  } else if (level === 'WARN') {
    console.warn(`${color}${prefix}${COLORS.reset} ${message}`);
  } else {
    console.log(`${color}${prefix}${COLORS.reset} ${message}`);
  }
}

export const logger = {
  debug(message, ...args) {
    if (process.env.NODE_ENV === 'development') {
      write('DEBUG', args.length ? `${message} ${args.map(String).join(' ')}` : message);
    }
  },
  info(message, ...args) {
    write('INFO', args.length ? `${message} ${args.map(String).join(' ')}` : message);
  },
  warn(message, ...args) {
    write('WARN', args.length ? `${message} ${args.map(String).join(' ')}` : message);
  },
  error(message, ...args) {
    write('ERROR', args.length ? `${message} ${args.map(String).join(' ')}` : message);
  },
};

function statusColor(status) {
  if (status >= 500) return COLORS.red;
  if (status >= 400) return COLORS.yellow;
  if (status >= 300) return COLORS.cyan;
  return COLORS.green;
}

export function requestLogger(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    const elapsed = Date.now() - start;
    const status = res.statusCode;
    const ip =
      (req.headers['x-forwarded-for'] && String(req.headers['x-forwarded-for']).split(',')[0].trim()) ||
      req.headers['x-real-ip'] ||
      (req.socket && req.socket.remoteAddress) ||
      '-';
    // TS3 (observability): trace id on the access line — set by the W3C
    // traceparent middleware in server.js (propagated or freshly generated).
    if (JSON_LOGS) {
      const entry = {
        time: timestamp(),
        level: 'REQ',
        msg: `${req.method} ${req.originalUrl} ${status} ${elapsed}ms ${ip}`,
        method: req.method,
        path: req.originalUrl,
        status,
        elapsedMs: elapsed,
        ip,
      };
      if (req.traceId) entry.traceId = req.traceId;
      console.log(JSON.stringify(entry));
      return;
    }
    const trace = req.traceId ? ` trace=${req.traceId}` : '';
    const line = `${req.method} ${req.originalUrl} ${status} ${elapsed}ms ${ip}${trace}`;
    console.log(`${statusColor(status)}[${timestamp()}] [REQ]${COLORS.reset} ${line}`);
  });
  next();
}
