/**
 * Client RESP minimal pe TCP (node:net) pentru redis-global :4030.
 * Doar comenzile de care are nevoie scraper-ul: PING, DBSIZE.
 * Timeout 2s per comandă, conexiune nouă per ciclu (simplu + robust).
 */
import net from 'node:net';
import { SOURCES } from '../config.ts';

export interface RedisProbe {
  ok: boolean;
  keys: number | null;
  latencyMs: number | null;
  error: string | null;
}

/** Rulează o listă de comenzi RESP pe o singură conexiune și intoarce
 *  răspunsurile brute (fără parsare profundă). */
function respCommands(
  commands: string[],
  timeoutMs = 2000,
): Promise<{ replies: string[]; error: string | null; latencyMs: number }> {
  return new Promise((resolve) => {
    const started = Date.now();
    let buffer = '';
    let replies = 0;
    const out: string[] = [];
    let settled = false;

    const sock = net.createConnection(
      { host: SOURCES.redis.host, port: SOURCES.redis.port },
      () => {
        const payload = commands.map((c) => `*1\r\n$${c.length}\r\n${c}\r\n`).join('');
        sock.write(payload);
      },
    );

    const finish = (error: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve({ replies: out, error, latencyMs: Date.now() - started });
    };

    const timer = setTimeout(() => finish('timeout'), timeoutMs);

    sock.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      // Un răspuns minimal se termină la primul CRLF după marker (+ / : / $ / -).
      while (replies < commands.length) {
        const lineEnd = buffer.indexOf('\r\n');
        if (lineEnd === -1) return;
        const line = buffer.slice(0, lineEnd);
        buffer = buffer.slice(lineEnd + 2);
        if (line.startsWith('$')) {
          // Bulk string: consumăm și payload-ul de pe linia următoare.
          const len = parseInt(line.slice(1), 10);
          if (Number.isNaN(len)) continue;
          if (len === -1) {
            out.push('');
            replies++;
            continue;
          }
          if (buffer.length < len + 2) {
            // încă incomplet — punem linia înapoi și așteptăm.
            buffer = `${line}\r\n${buffer}`;
            return;
          }
          out.push(buffer.slice(0, len));
          buffer = buffer.slice(len + 2);
          replies++;
          continue;
        }
        out.push(line);
        replies++;
      }
      if (replies >= commands.length) finish(null);
    });
    sock.on('error', (err) => finish(err.message));
    sock.on('close', () => finish(null));
  });
}

/** Probe complet: PING (up) + DBSIZE (numărul de chei). */
export async function probeRedis(): Promise<RedisProbe> {
  const { replies, error, latencyMs } = await respCommands(['PING', 'DBSIZE']);
  if (error) return { ok: false, keys: null, latencyMs: null, error };
  const pong = replies[0] ?? '';
  const size = replies[1] ?? '';
  if (!pong.startsWith('+PONG')) {
    return { ok: false, keys: null, latencyMs, error: `pong=${pong.slice(0, 40)}` };
  }
  const keys = size.startsWith(':') ? parseInt(size.slice(1), 10) : null;
  return { ok: true, keys, latencyMs, error: null };
}
