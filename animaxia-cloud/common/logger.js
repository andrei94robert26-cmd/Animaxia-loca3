/**
 * common/logger.js — Structured JSON logger for Animaxia Cloud microservices.
 *
 * Every line is a single-line JSON object on stdout/stderr (Loki/Promtail
 * friendly): { ts, level, service, msg, ...fields }. In development the lines
 * are colorized for readability. The API is compatible with the monolith
 * logger (logger.info(message, ...args)) with an extra structured-fields
 * variant logger.info(message, { ...fields }).
 *
 * requestLogger middleware adds requestId/traceId/method/path/status/durationMs
 * to each finished request log line.
 */

const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

const LEVEL_COLORS = {
  DEBUG: COLORS.dim,
  INFO: COLORS.green,
  WARN: COLORS.yellow,
  ERROR: COLORS.red,
};

const IS_DEV = (process.env.NODE_ENV || 'development') === 'development';
const SERVICE = process.env.SERVICENAME || null;

/** Normalize varargs: either (msg, {fields}) or (msg, ...primitiveArgs). */
function collect(message, args) {
  const fields = {};
  if (args.length === 1 && args[0] && typeof args[0] === 'object' && !(args[0] instanceof Error)) {
    Object.assign(fields, args[0]);
  } else if (args.length) {
    fields.detail = args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ');
  }
  for (const arg of args) {
    if (arg instanceof Error && !fields.error) {
      fields.error = arg.message;
      if (arg.stack) fields.stack = arg.stack;
    }
  }
  return fields;
}

function write(level, message, args) {
  const record = {
    ts: new Date().toISOString(),
    level,
    ...(SERVICE ? { service: SERVICE } : {}),
    msg: String(message),
    ...collect(message, args),
  };
  const line = IS_DEV
    ? `${LEVEL_COLORS[level] || ''}[${record.ts}] [${level}]${SERVICE ? ` [${SERVICE}]` : ''}${COLORS.reset} ${message}${
        Object.keys(collect(message, args)).length ? ` ${JSON.stringify(collect(message, args))}` : ''
      }`
    : JSON.stringify(record);
  if (level === 'ERROR') console.error(line);
  else if (level === 'WARN') console.warn(line);
  else console.log(line);
}

export const logger = {
  debug(message, ...args) {
    if (IS_DEV) write('DEBUG', message, args);
  },
  info(message, ...args) {
    write('INFO', message, args);
  },
  warn(message, ...args) {
    write('WARN', message, args);
  },
  error(message, ...args) {
    write('ERROR', message, args);
  },
  /** Child logger with always-attached fields (e.g. { worker: 'auth-cleanup' }). */
  child(baseFields = {}) {
    const childLogger = {};
    for (const level of ['debug', 'info', 'warn', 'error']) {
      childLogger[level] = (message, ...args) => {
        const fields = { ...baseFields, ...collect(message, args) };
        write(level.toUpperCase(), message, [fields]);
      };
    }
    return childLogger;
  },
};

/** Express middleware: logs METHOD path STATUS durationMs on response finish. */
export function requestLogger(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    const ip =
      (req.headers['x-forwarded-for'] && String(req.headers['x-forwarded-for']).split(',')[0].trim()) ||
      req.headers['x-real-ip'] ||
      (req.socket && req.socket.remoteAddress) ||
      '-';
    const fields = {
      method: req.method,
      path: req.originalUrl || req.url,
      status: res.statusCode,
      durationMs: Date.now() - start,
      ip,
      ...(req.requestId ? { requestId: req.requestId } : {}),
      ...(req.traceId ? { traceId: req.traceId } : {}),
    };
    write(res.statusCode >= 500 ? 'ERROR' : res.statusCode >= 400 ? 'WARN' : 'INFO', `${req.method} ${req.originalUrl || req.url} ${res.statusCode} ${fields.durationMs}ms`, [fields]);
  });
  next();
}

export default logger;
