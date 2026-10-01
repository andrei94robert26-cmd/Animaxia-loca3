/**
 * redis-client.ts — FAZA 22 global gateway Redis client.
 *
 * Minimal RESP2 client over node:net with a small connection pool. The
 * endpoint is the local validation instance (mini-services/redis-global,
 * :4030) in the sandbox and Upstash / Redis Cloud in production — the wire
 * protocol is identical. When Redis is unreachable, the client degrades
 * transparently to an in-memory store with the same interface (per-instance
 * limiter — honest degradation, reported via mode()) and re-probes every
 * 10 seconds to return to distributed mode.
 *
 * The FAZA 18 pipeline inside the backend is NOT modified — these perimeter
 * layers are defense-in-depth in front of it.
 */

import net from 'node:net';

export interface RedisLike {
  ping(): Promise<string>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, opts?: { exSec?: number }): Promise<boolean>;
  setNx(key: string, value: string, opts?: { exSec?: number }): Promise<boolean>;
  incr(key: string): Promise<number>;
  expire(key: string, sec: number): Promise<boolean>;
  ttl(key: string): Promise<number>;
  del(keys: string[]): Promise<number>;
  keys(pattern: string): Promise<string[]>;
  flushdb(): Promise<boolean>;
  mode(): 'redis' | 'memory';
}

/* ----------------------------------------------------------------- RESP2 --- */

type Reply = string | number | null | Reply[];

type Parsed =
  | { ok: true; value: Reply; rest: Buffer }
  | { ok: false; message: string; rest: Buffer }
  | null;

function encode(args: string[]): string {
  let out = `*${args.length}\r\n`;
  for (const a of args) out += `$${Buffer.byteLength(a)}\r\n${a}\r\n`;
  return out;
}

/** Parse one complete RESP2 reply from `buf`; null when incomplete. */
function tryParse(buf: Buffer): Parsed {
  const lineEnd = buf.indexOf('\r\n');
  if (lineEnd === -1) return null;
  const head = buf.subarray(0, lineEnd).toString('utf8');
  const rest = buf.subarray(lineEnd + 2);
  const t = head[0];
  if (t === '+') return { ok: true, value: head.slice(1), rest };
  if (t === '-') return { ok: false, message: head.slice(1), rest };
  if (t === ':') {
    const n = parseInt(head.slice(1), 10);
    return Number.isFinite(n) ? { ok: true, value: n, rest } : { ok: false, message: 'bad integer', rest };
  }
  if (t === '$') {
    const len = parseInt(head.slice(1), 10);
    if (len === -1) return { ok: true, value: null, rest };
    if (!Number.isFinite(len) || len < 0) return { ok: false, message: 'bad bulk length', rest };
    if (rest.length < len + 2) return null; // wait for payload + CRLF
    const value = rest.subarray(0, len).toString('utf8');
    return { ok: true, value, rest: rest.subarray(len + 2) };
  }
  if (t === '*') {
    const count = parseInt(head.slice(1), 10);
    if (count === -1) return { ok: true, value: null, rest };
    if (!Number.isFinite(count) || count < 0) return { ok: false, message: 'bad array length', rest };
    let cur = rest;
    const items: Reply[] = [];
    for (let i = 0; i < count; i++) {
      const one = tryParse(cur);
      if (!one) return null;
      if (!one.ok) return one;
      items.push(one.value);
      cur = one.rest;
    }
    return { ok: true, value: items, rest: cur };
  }
  return { ok: false, message: `unknown reply type "${t}"`, rest };
}

/* ------------------------------------------------------------ connection --- */

class RespConnection {
  private socket: net.Socket | null = null;
  private buf = Buffer.alloc(0);
  private queue: Array<{ resolve: (v: Reply) => void; reject: (e: Error) => void }> = [];
  private connecting: Promise<void> | null = null;
  dead = true;

  constructor(private host: string, private port: number, private timeoutMs: number) {}

  private connect(): Promise<void> {
    if (this.socket && !this.dead) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<void>((resolve, reject) => {
      const s = net.connect({ host: this.host, port: this.port });
      const fail = (e: Error): void => {
        s.destroy();
        this.connecting = null;
        this.dead = true;
        reject(e);
      };
      s.once('error', fail);
      s.once('connect', () => {
        this.socket = s;
        this.dead = false;
        this.connecting = null;
        s.on('data', (d: Buffer) => this.onData(d));
        s.on('error', () => this.die(new Error('connection_lost')));
        s.on('close', () => this.die(new Error('connection_closed')));
        resolve();
      });
    });
    return this.connecting;
  }

  private onData(d: Buffer): void {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const parsed = tryParse(this.buf);
      if (!parsed) return;
      this.buf = parsed.rest;
      const w = this.queue.shift();
      if (!w) return; // stray reply — ignore
      if (parsed.ok) w.resolve(parsed.value);
      else w.reject(new Error(`redis: ${parsed.message}`));
    }
  }

  private die(e: Error): void {
    this.dead = true;
    this.socket = null;
    const q = this.queue.splice(0);
    for (const w of q) w.reject(e);
  }

  close(): void {
    this.socket?.destroy();
    this.die(new Error('closed'));
  }

  async send(args: string[]): Promise<Reply> {
    await this.connect();
    const socket = this.socket;
    if (!socket) throw new Error('redis: no socket');
    return new Promise<Reply>((resolve, reject) => {
      const wrapped = {
        resolve: (v: Reply): void => { clearTimeout(to); resolve(v); },
        reject: (e: Error): void => { clearTimeout(to); reject(e); },
      };
      const to = setTimeout(() => {
        const i = this.queue.indexOf(wrapped);
        if (i >= 0) this.queue.splice(i, 1);
        reject(new Error('redis_timeout'));
      }, this.timeoutMs);
      this.queue.push(wrapped);
      socket.write(encode(args), (e) => {
        if (e) {
          const i = this.queue.indexOf(wrapped);
          if (i >= 0) this.queue.splice(i, 1);
          clearTimeout(to);
          reject(e);
        }
      });
    });
  }
}

/* ---------------------------------------------------------- memory store --- */

interface MemEntry { v: string; exp: number | null }

class MemStore {
  private m = new Map<string, MemEntry>();
  private sweeper = setInterval(() => this.sweep(), 1_000);

  private live(k: string): MemEntry | null {
    const e = this.m.get(k);
    if (!e) return null;
    if (e.exp !== null && e.exp <= Date.now()) { this.m.delete(k); return null; }
    return e;
  }
  private sweep(): void {
    const now = Date.now();
    for (const [k, e] of this.m) if (e.exp !== null && e.exp <= now) this.m.delete(k);
  }
  get(k: string): string | null { return this.live(k)?.v ?? null; }
  set(k: string, v: string, o?: { exSec?: number }): boolean {
    this.m.set(k, { v, exp: o?.exSec ? Date.now() + o.exSec * 1000 : null });
    return true;
  }
  setNx(k: string, v: string, o?: { exSec?: number }): boolean {
    if (this.live(k)) return false;
    this.set(k, v, o);
    return true;
  }
  incr(k: string): number {
    const cur = this.live(k);
    const n = cur && /^\d+$/.test(cur.v) ? parseInt(cur.v, 10) + 1 : 1;
    this.m.set(k, { v: String(n), exp: cur?.exp ?? null });
    return n;
  }
  expire(k: string, sec: number): boolean {
    const e = this.live(k);
    if (!e) return false;
    e.exp = Date.now() + sec * 1000;
    return true;
  }
  ttl(k: string): number {
    const e = this.live(k);
    if (!e) return -2;
    if (e.exp === null) return -1;
    return Math.max(0, Math.ceil((e.exp - Date.now()) / 1000));
  }
  del(ks: string[]): number { let n = 0; for (const k of ks) if (this.live(k)) { this.m.delete(k); n++; } return n; }
  keys(pattern: string): string[] {
    const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    const out: string[] = [];
    for (const k of this.m.keys) if (this.live(k) && re.test(k)) out.push(k);
    return out;
  }
  flushdb(): boolean { this.m.clear(); return true; }
}

/* ---------------------------------------------------------------- client --- */

export class RedisGateway implements RedisLike {
  private conns: RespConnection[] = [];
  private rr = 0;
  private mem = new MemStore();
  private memMode = false;
  private prober: ReturnType<typeof setInterval>;
  private poolSize: number;

  constructor(
    private host = process.env.REDIS_HOST ?? '127.0.0.1',
    private port = Number(process.env.REDIS_PORT ?? 4030),
    poolSize = 4,
  ) {
    this.poolSize = poolSize;
    this.makePool();
    this.prober = setInterval(() => void this.probe(), 10_000);
  }

  private makePool(): void {
    this.conns = Array.from({ length: this.poolSize }, () => new RespConnection(this.host, this.port, 2000));
  }

  private async probe(): Promise<void> {
    if (!this.memMode) return;
    const c = new RespConnection(this.host, this.port, 1500);
    try {
      await c.send(['PING']);
      this.memMode = false;
      this.makePool();
      console.log('[redis] distributed mode restored (RESP endpoint reachable)');
    } catch {
      // stay in per-instance memory mode
    } finally {
      c.close();
    }
  }

  private async run<T>(remote: (c: RespConnection) => Promise<T>, local: () => T | Promise<T>): Promise<T> {
    if (this.memMode) return local();
    const c = this.conns[this.rr++ % this.conns.length];
    try {
      return await remote(c);
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (/timeout|connect|ECONN|socket|closed|lost|no socket/i.test(msg)) {
        this.memMode = true;
        console.warn('[redis] unreachable — perimeter layers degrade to per-instance in-memory mode');
        return local();
      }
      throw e;
    }
  }

  async ping(): Promise<string> {
    return this.run(async (c) => String(await c.send(['PING'])), async () => 'PONG');
  }
  async get(k: string): Promise<string | null> {
    return this.run(async (c) => { const r = await c.send(['GET', k]); return r === null ? null : String(r); }, async () => this.mem.get(k));
  }
  async set(k: string, v: string, o?: { exSec?: number }): Promise<boolean> {
    return this.run(async (c) => {
      const args = ['SET', k, v];
      if (o?.exSec) args.push('EX', String(o.exSec));
      return (await c.send(args)) === 'OK';
    }, async () => this.mem.set(k, v, o));
  }
  async setNx(k: string, v: string, o?: { exSec?: number }): Promise<boolean> {
    return this.run(async (c) => {
      const args = ['SET', k, v, 'NX'];
      if (o?.exSec) args.push('EX', String(o.exSec));
      return (await c.send(args)) === 'OK';
    }, async () => this.mem.setNx(k, v, o));
  }
  async incr(k: string): Promise<number> {
    return this.run(async (c) => Number(await c.send(['INCR', k])), async () => this.mem.incr(k));
  }
  async expire(k: string, sec: number): Promise<boolean> {
    return this.run(async (c) => Number(await c.send(['EXPIRE', k, String(sec)])) === 1, async () => this.mem.expire(k, sec));
  }
  async ttl(k: string): Promise<number> {
    return this.run(async (c) => Number(await c.send(['TTL', k])), async () => this.mem.ttl(k));
  }
  async del(ks: string[]): Promise<number> {
    if (!ks.length) return 0;
    return this.run(async (c) => Number(await c.send(['DEL', ...ks])), async () => this.mem.del(ks));
  }
  async keys(pattern: string): Promise<string[]> {
    return this.run(async (c) => {
      const r = await c.send(['KEYS', pattern]);
      return Array.isArray(r) ? r.map(String) : [];
    }, async () => this.mem.keys(pattern));
  }
  async flushdb(): Promise<boolean> {
    return this.run(async (c) => (await c.send(['FLUSHDB'])) === 'OK', async () => this.mem.flushdb());
  }
  mode(): 'redis' | 'memory' { return this.memMode ? 'memory' : 'redis'; }
}
