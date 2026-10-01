/**
 * worker/src/websocket.ts — WebSocket proxy for the assistant live channel
 * (/ws/*). The gateway terminates the client WebSocket (WebSocketPair) and
 * opens an outbound WebSocket to WS_ORIGIN, piping frames both ways so the
 * assistant live service can live in the cloud while clients connect to the
 * edge.
 *
 * Notes:
 *   • Headers cannot ride a WebSocket handshake — clients pass credentials
 *     as query parameters and the upstream re-authenticates.
 *   • Non-WebSocket requests get a 426 with the upgrade hint.
 *   • Runtimes without WebSocketPair (the bun local harness) get an explicit
 *     501 so smoke tests can assert the graceful path.
 */

import type { EdgeEnv } from '../../shared/types';
import { jsonError } from '../../shared/http';
import { originFor } from '../../shared/upstream';

export function proxyWebSocket(request: Request, env: EdgeEnv, url: URL): Response {
  const upgrade = (request.headers.get('upgrade') || '').toLowerCase();
  if (upgrade !== 'websocket') {
    return jsonError(
      426,
      'upgrade_required',
      'This endpoint speaks WebSocket (Animaxia assistant live). Reconnect with a WebSocket client.',
      {},
      { upgrade: 'websocket' },
    );
  }

  if (typeof WebSocketPair === 'undefined') {
    return jsonError(
      501,
      'ws_unsupported_runtime',
      'WebSocketPair is unavailable in this runtime — deploy on Cloudflare Workers for assistant live.',
    );
  }

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();

  const origin = originFor(env, 'ws'); // ws:// or wss:// base
  const target = `${origin}${url.pathname}${url.search}`;

  let upstream: WebSocket | null = null;
  try {
    upstream = new WebSocket(target);
  } catch {
    try {
      server.close(1011, 'edge: cannot open upstream websocket');
    } catch {
      /* already closed */
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  const sendToClient = (data: unknown): void => {
    try {
      server.send(data as string);
    } catch {
      /* client went away */
    }
  };
  const sendToUpstream = (data: unknown): void => {
    try {
      upstream?.send(data as string);
    } catch {
      /* upstream went away */
    }
  };

  upstream.addEventListener('message', (ev) => sendToClient((ev as MessageEvent).data));
  server.addEventListener('message', (ev) => sendToUpstream((ev as MessageEvent).data));

  upstream.addEventListener('close', (ev) => {
    const close = ev as CloseEvent;
    try {
      server.close(close.code, close.reason);
    } catch {
      /* already closed */
    }
  });
  upstream.addEventListener('error', () => {
    try {
      server.close(1011, 'edge: upstream websocket error');
    } catch {
      /* already closed */
    }
  });
  server.addEventListener('close', () => {
    try {
      upstream?.close();
    } catch {
      /* already closed */
    }
  });

  // The 101 response carries the client socket — it must NOT pass through
  // the gateway's response decoration (src/index.ts returns it as-is).
  return new Response(null, { status: 101, webSocket: client });
}
