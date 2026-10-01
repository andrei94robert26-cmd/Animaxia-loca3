/**
 * index.ts — animaxia-redis-global (FAZA 22 — Global Infrastructure).
 *
 * A Redis-protocol (RESP2) server used as the LOCAL VALIDATION INSTANCE for
 * the global distributed layers (global-gateway perimeter on :4040 and future
 * shared state). Production deployments use Upstash / Redis Cloud over the
 * exact same RESP2 wire protocol (the managed instances are provisioned by
 * the Terraform artifacts in animaxia-ops), so every client built and tested
 * against this instance works unchanged in production.
 *
 * Design notes:
 *   - RESP2 only: clients send arrays of bulk strings; inline commands
 *     (whitespace-separated, CRLF-terminated) are also accepted for manual
 *     testing convenience (printf / telnet style).
 *   - In-memory only: no persistence, no AUTH — this is a validation instance.
 *   - TTL engine: per-key expiry timestamps, lazy expiration on access plus
 *     a periodic sweep every second.
 *   - Pipelining: multiple complete commands in a single TCP buffer are all
 *     executed and answered in order.
 *   - Robustness: malformed input answers -ERR and resynchronizes; socket
 *     errors are caught; the process never crashes on bad traffic.
 */

import { createServer as createNetServer, Socket } from 'node:net';
import { randomBytes } from 'node:crypto';

const PORT = 4030;
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;
const RUN_ID = randomBytes(20).toString('hex');

/* ------------------------------ store + TTL ------------------------------ */

interface Entry {
  value: string;
  expiresAt: number | null; // epoch ms, null = no TTL
}

const store = new Map<string, Entry>();

function isExpired(e: Entry, now = Date.now()): boolean {
  return e.expiresAt !== null && e.expiresAt <= now;
}

function getLive(key: string): Entry | null {
  const e = store.get(key);
  if (!e) return null;
  if (isExpired(e)) {
    store.delete(key);
    return null;
  }
  return e;
}

function hasLive(key: string): boolean {
  return getLive(key) !== null;
}

/** Periodic sweep — removes expired keys even if nobody accesses them. */
function sweep(): void {
  const now = Date.now();
  for (const [k, e] of store) {
    if (isExpired(e, now)) store.delete(k);
  }
}

/* --------------------------------- stats --------------------------------- */

const commandCounts = new Map<string, number>();
let totalCommands = 0;
let totalConnections = 0;
let connectedClients = 0;

function recordCommand(name: string): void {
  totalCommands++;
  commandCounts.set(name, (commandCounts.get(name) ?? 0) + 1);
}

/* ----------------------------- RESP encoding ----------------------------- */

const CRLF = '\r\n';
const NIL_BULK = `$-1${CRLF}`;

function simple(s: string): string {
  return `+${s}${CRLF}`;
}

function err(msg: string): string {
  return `-ERR ${msg}${CRLF}`;
}

function int(n: number): string {
  return `:${n}${CRLF}`;
}

function bulk(s: string | null): string {
  if (s === null) return NIL_BULK;
  return `$${Buffer.byteLength(s, 'utf8')}${CRLF}${s}${CRLF}`;
}

function arr(items: (string | null)[]): string {
  let out = `*${items.length}${CRLF}`;
  for (const it of items) out += bulk(it);
  return out;
}

/* ----------------------------- RESP decoding ----------------------------- */

interface ParseResult {
  /** null = incomplete (need more bytes); empty array = empty line (*0) */
  args: string[] | null;
  rest: Buffer;
  malformed: boolean;
}

/** Reads one CRLF-terminated line starting at `from`. Returns null when the
 *  line has not fully arrived yet. */
function readLine(buf: Buffer, from: number): { line: string; next: number } | null {
  for (let i = from; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      let end = i;
      if (end > from && buf[end - 1] === 0x0d) end--;
      return { line: buf.subarray(from, end).toString('utf8'), next: i + 1 };
    }
  }
  return null;
}

/** Resynchronization point after a protocol error: drop everything up to and
 *  including the next newline (or the whole buffer when none is present). */
function resync(buf: Buffer, skipFrom: number): Buffer {
  let cut = skipFrom;
  while (cut < buf.length && buf[cut] !== 0x0a) cut++;
  if (cut < buf.length) cut++;
  return buf.subarray(cut);
}

function malformed(buf: Buffer, skipFrom: number): ParseResult {
  return { args: null, rest: resync(buf, skipFrom), malformed: true };
}

function needMore(buf: Buffer): ParseResult {
  return { args: null, rest: buf, malformed: false };
}

/**
 * Parses ONE command from the front of the buffer.
 *   - RESP array of bulk strings (`*N\r\n$len\r\n...\r\n`)
 *   - inline command (single line, whitespace separated) for manual testing
 */
function parseCommand(buf: Buffer): ParseResult {
  if (buf.length === 0) return needMore(buf);

  if (buf[0] === 0x2a) {
    // '*' — RESP array
    const header = readLine(buf, 0);
    if (header === null) return needMore(buf);
    const m = /^\*(\d+)$/.exec(header.line);
    if (!m) return malformed(buf, header.next);
    const n = parseInt(m[1], 10);
    let pos = header.next;
    const args: string[] = [];
    for (let i = 0; i < n; i++) {
      if (pos >= buf.length) return needMore(buf);
      if (buf[pos] !== 0x24) return malformed(buf, pos); // '$' expected
      const lenLine = readLine(buf, pos);
      if (lenLine === null) return needMore(buf);
      const lm = /^\$(\d+)$/.exec(lenLine.line);
      if (!lm) return malformed(buf, lenLine.next);
      const len = parseInt(lm[1], 10);
      const start = lenLine.next;
      const end = start + len;
      if (buf.length < end + 2) return needMore(buf);
      if (buf[end] !== 0x0d || buf[end + 1] !== 0x0a) return malformed(buf, end);
      args.push(buf.subarray(start, end).toString('utf8'));
      pos = end + 2;
    }
    return { args, rest: buf.subarray(pos), malformed: false };
  }

  // inline command (manual testing convenience)
  const line = readLine(buf, 0);
  if (line === null) return needMore(buf);
  const args = line.line.split(/\s+/).filter((s) => s.length > 0);
  return { args, rest: buf.subarray(line.next), malformed: false };
}

/* ------------------------------ glob matching ---------------------------- */

/** Converts a Redis glob pattern (*, ?, [class]) into a RegExp. */
function globToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      out += '.*';
    } else if (c === '?') {
      out += '.';
    } else if (c === '[') {
      let j = i + 1;
      let cls = '[';
      if (j < pattern.length && (pattern[j] === '^' || pattern[j] === '!')) {
        cls += '^';
        j++;
      }
      if (pattern[j] === ']') {
        cls += '\\]';
        j++;
      }
      while (j < pattern.length && pattern[j] !== ']') {
        cls += pattern[j];
        j++;
      }
      if (j >= pattern.length) {
        out += '\\['; // unmatched '[' → literal
        continue;
      }
      cls += ']';
      out += cls;
      i = j;
    } else {
      out += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

/* ------------------------------ argument utils --------------------------- */

function integerArg(s: string): number | null {
  if (!/^-?\d+$/.test(s)) return null;
  const n = parseInt(s, 10);
  return Number.isSafeInteger(n) ? n : null;
}

function positiveIntArg(s: string): number | null {
  const n = integerArg(s);
  return n === null || n <= 0 ? null : n;
}

/** INCR/INCRBY/DECR core. Redis semantics: the TTL of an existing key is
 *  preserved by arithmetic operations. */
function applyIncr(key: string, delta: number): string {
  const cur = getLive(key);
  if (cur !== null && !/^-?\d+$/.test(cur.value)) {
    return err('value is not an integer or out of range');
  }
  const base = cur === null ? 0 : parseInt(cur.value, 10);
  const next = base + delta;
  if (!Number.isSafeInteger(next)) {
    return err('increment or decrement would overflow');
  }
  store.set(key, { value: String(next), expiresAt: cur ? cur.expiresAt : null });
  return int(next);
}

/* ---------------------------------- INFO --------------------------------- */

function buildInfo(): string {
  const now = Date.now();
  let liveKeys = 0;
  let expiring = 0;
  for (const e of store.values()) {
    if (!isExpired(e, now)) {
      liveKeys++;
      if (e.expiresAt !== null) expiring++;
    }
  }
  const lines: string[] = [
    '# Server',
    'redis_version:7.4.0-animaxia-global',
    'animaxia_role:resp_validation-instance',
    'redis_mode:standalone',
    'os:bun',
    `run_id:${RUN_ID}`,
    '',
    '# Keyspace',
    `db0:keys=${liveKeys},expires=${expiring}`,
    '',
    '# Stats',
    `total_commands_processed:${totalCommands}`,
    `total_connections_received:${totalConnections}`,
    'rejected_connections:0',
    `connected_clients:${connectedClients}`,
    'instantaneous_ops_per_sec:0',
    '',
  ];
  return lines.join('\r\n');
}

/* ------------------------------ command table ---------------------------- */

const REGISTERED_COMMANDS = [
  'PING', 'ECHO', 'SET', 'GET', 'DEL', 'EXISTS', 'EXPIRE', 'TTL', 'PTTL',
  'INCR', 'INCRBY', 'DECR', 'KEYS', 'DBSIZE', 'FLUSHDB', 'SELECT',
  'COMMAND', 'INFO', 'QUIT',
];

function wrongArgs(name: string): string {
  return err(`wrong number of arguments for '${name.toLowerCase()}'`);
}

/** Executes one command (never throws — internal errors become -ERR). */
function execute(args: string[]): string {
  try {
    if (args.length === 0) return '';
    const name = args[0].toUpperCase();
    recordCommand(name);

    switch (name) {
      case 'PING': {
        if (args.length > 2) return wrongArgs('ping');
        if (args.length === 2) return bulk(args[1]);
        return simple('PONG');
      }
      case 'ECHO': {
        if (args.length !== 2) return wrongArgs('echo');
        return bulk(args[1]);
      }
      case 'SET': {
        if (args.length < 3) return wrongArgs('set');
        const key = args[1];
        const value = args[2];
        let exSec: number | null = null;
        let pxMs: number | null = null;
        let nx = false;
        let xx = false;
        let i = 3;
        while (i < args.length) {
          const t = args[i].toUpperCase();
          if (t === 'EX') {
            if (i + 1 >= args.length) return err('syntax error');
            const n = positiveIntArg(args[i + 1]);
            if (n === null) return err("invalid expire time in 'set' command");
            exSec = n;
            i += 2;
          } else if (t === 'PX') {
            if (i + 1 >= args.length) return err('syntax error');
            const n = positiveIntArg(args[i + 1]);
            if (n === null) return err("invalid expire time in 'set' command");
            pxMs = n;
            i += 2;
          } else if (t === 'NX') {
            nx = true;
            i += 1;
          } else if (t === 'XX') {
            xx = true;
            i += 1;
          } else {
            return err('syntax error');
          }
        }
        if ((nx && xx) || (exSec !== null && pxMs !== null)) return err('syntax error');
        const exists = hasLive(key);
        if (nx && exists) return NIL_BULK;
        if (xx && !exists) return NIL_BULK;
        // plain SET drops any previous TTL (no KEEPTTL support needed here)
        const expiresAt = exSec !== null ? Date.now() + exSec * 1000 : pxMs !== null ? Date.now() + pxMs : null;
        store.set(key, { value, expiresAt });
        return simple('OK');
      }
      case 'GET': {
        if (args.length !== 2) return wrongArgs('get');
        const e = getLive(args[1]);
        return bulk(e ? e.value : null);
      }
      case 'DEL': {
        if (args.length < 2) return wrongArgs('del');
        let n = 0;
        for (let i = 1; i < args.length; i++) {
          if (hasLive(args[i])) {
            store.delete(args[i]);
            n++;
          }
        }
        return int(n);
      }
      case 'EXISTS': {
        if (args.length < 2) return wrongArgs('exists');
        let n = 0;
        for (let i = 1; i < args.length; i++) if (hasLive(args[i])) n++;
        return int(n);
      }
      case 'EXPIRE': {
        if (args.length !== 3) return wrongArgs('expire');
        const sec = integerArg(args[2]);
        if (sec === null) return err('value is not an integer or out of range');
        const e = getLive(args[1]);
        if (e === null) return int(0);
        if (sec <= 0) {
          store.delete(args[1]);
          return int(1);
        }
        e.expiresAt = Date.now() + sec * 1000;
        return int(1);
      }
      case 'TTL': {
        if (args.length !== 2) return wrongArgs('ttl');
        const e = getLive(args[1]);
        if (e === null) return int(-2);
        if (e.expiresAt === null) return int(-1);
        return int(Math.max(1, Math.ceil((e.expiresAt - Date.now()) / 1000)));
      }
      case 'PTTL': {
        if (args.length !== 2) return wrongArgs('pttl');
        const e = getLive(args[1]);
        if (e === null) return int(-2);
        if (e.expiresAt === null) return int(-1);
        return int(Math.max(1, e.expiresAt - Date.now()));
      }
      case 'INCR': {
        if (args.length !== 2) return wrongArgs('incr');
        return applyIncr(args[1], 1);
      }
      case 'INCRBY': {
        if (args.length !== 3) return wrongArgs('incrby');
        const delta = integerArg(args[2]);
        if (delta === null) return err('value is not an integer or out of range');
        return applyIncr(args[1], delta);
      }
      case 'DECR': {
        if (args.length !== 2) return wrongArgs('decr');
        return applyIncr(args[1], -1);
      }
      case 'KEYS': {
        if (args.length !== 2) return wrongArgs('keys');
        const re = globToRegExp(args[1]);
        const now = Date.now();
        const matched: string[] = [];
        for (const [k, e] of store) {
          if (!isExpired(e, now) && re.test(k)) matched.push(k);
        }
        return arr(matched);
      }
      case 'DBSIZE': {
        const now = Date.now();
        let n = 0;
        for (const e of store.values()) if (!isExpired(e, now)) n++;
        return int(n);
      }
      case 'FLUSHDB': {
        store.clear();
        return simple('OK');
      }
      case 'SELECT': {
        if (args.length !== 2) return wrongArgs('select');
        if (args[1] === '0') return simple('OK');
        return err('DB index is out of range');
      }
      case 'COMMAND': {
        return int(REGISTERED_COMMANDS.length);
      }
      case 'INFO': {
        return bulk(buildInfo());
      }
      case 'QUIT': {
        return simple('OK');
      }
      default:
        return err(`unknown command '${args[0].toLowerCase()}'`);
    }
  } catch (e) {
    return err(`internal error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/* ------------------------------ TCP server ------------------------------- */

function log(msg: string): void {
  console.log(`[redis-global ${new Date().toISOString()}] ${msg}`);
}

const server = createNetServer((socket: Socket) => {
  totalConnections++;
  connectedClients++;
  let closed = false;
  let buf = Buffer.alloc(0);

  const markClosed = (): void => {
    if (!closed) {
      closed = true;
      connectedClients--;
    }
  };

  socket.on('error', (e: Error) => {
    log(`socket error: ${e.message}`);
    markClosed();
    socket.destroy();
  });
  socket.on('close', () => markClosed());

  socket.on('data', (chunk: Buffer) => {
    try {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const r = parseCommand(buf);
        if (r.malformed) {
          socket.write(err('Protocol error: invalid request'));
          buf = r.rest;
          continue;
        }
        if (r.args === null) break; // incomplete — wait for more bytes
        buf = r.rest;
        if (r.args.length === 0) continue; // empty line / *0 — ignore
        const name = r.args[0].toUpperCase();
        const reply = execute(r.args);
        if (reply.length > 0) socket.write(reply);
        if (name === 'QUIT') {
          socket.end();
          return;
        }
      }
      // unbounded garbage without a newline would grow the buffer forever
      if (buf.length > MAX_BUFFER_BYTES) {
        buf = Buffer.alloc(0);
        socket.write(err('Protocol error: request too large'));
        socket.destroy();
      }
    } catch (e) {
      // never crash the process on malformed traffic
      log(`data handler error: ${e instanceof Error ? e.message : String(e)}`);
      try {
        socket.write(err('internal error'));
      } catch {
        /* socket already gone */
      }
      buf = Buffer.alloc(0);
    }
  });
});

server.on('error', (e: Error) => {
  log(`server error: ${e.message}`);
});

/* NEON FREE PLAN: sweep la 30s (fost 1s) — igienă CPU, fără treziri inutile
 * de 86.400×/zi; cheile TTL expiră oricum lazy la acces. */
const sweepTimer = setInterval(sweep, 30000);
if (typeof sweepTimer.unref === 'function') sweepTimer.unref();

server.listen(PORT, () => {
  console.log(
    'redis-global — RESP validation instance (production: Upstash/Redis Cloud via același protocol) listening on :4030',
  );
});

process.on('uncaughtException', (e: Error) => {
  log(`uncaughtException (server continues): ${e.message}`);
});
process.on('unhandledRejection', (reason: unknown) => {
  log(`unhandledRejection (server continues): ${reason instanceof Error ? reason.message : String(reason)}`);
});
