# animaxia-edge-live — FAZA 28-E public launch edge

Runnable twin of **`Caddyfile.faza28-live`** (project root). Implements the exact
same routing table so the public launch chain is verifiable end-to-end in the
sandbox. 100% infrastructure — the protected monolith (FAZA 18/20/21/23/24/25/28,
real Neon FTS, 30B logic simulation, pipeline, real hub, real player, AI Hub/Home)
is only ever **proxied**, never modified.

## Listeners

| Port  | Role | Notes |
|-------|------|-------|
| :8080 | redirect | **308 permanent** HTTP → `https://{host}:8443{uri}` (method-preserving, RFC 7538) |
| :8443 | public HTTPS edge | TLS 1.2–1.3, **ALPN h2 + http/1.1** (`node:http2` secure server, `allowHTTP1`), **HSTS strict** (RFC 6797 §7.2 — TLS only), security headers |
| :8181 | internal HTTP mirror | same routing table, no TLS/HSTS; sandbox public path = `:81?XTransformPort=8181`; transparent WS (socket.io) TCP relay |

## Normalized upstream map (FAZA 28-E)

All config uses **container hostnames** — never `localhost`. The edge resolves
them through the internal DNS alias layer (`upstreams.ts`), the sandbox
equivalent of the production container network / Docker DNS.

| Container name | Canonical upstream | Sandbox address | Service |
|---|---|---|---|
| `frontend` | `http://frontend:3000` | `127.0.0.1:3000` | Next.js SPA (public UI) |
| `backend` | `http://backend:4000` | `127.0.0.1:4000` | PROTECTED monolith (FAZA 18/20/21, Neon FTS, 30B, pipeline, hub) |
| `realtime` | `http://realtime:4010` | `127.0.0.1:4010` | socket.io realtime |
| `watchdog` | `http://watchdog:4020` | `127.0.0.1:4020` | process supervisor |
| `redis-global` | `redis://redis-global:4030` | `127.0.0.1:4030` | RESP/TCP — health via PING probe |
| `gateway` | `http://gateway:4040` | `127.0.0.1:4040` | FAZA 22 global gateway (eu/us/asia → backend:4000) |
| `observability` | `http://observability:4050` | `127.0.0.1:4050` | FAZA 23 OTel collector |
| `stability` | `http://stability:4060` | `127.0.0.1:4060` | FAZA 24 control plane |

Env overrides: `UPSTREAM_BACKEND`, `UPSTREAM_GATEWAY`, `UPSTREAM_OBSERVABILITY`,
`UPSTREAM_STABILITY`, `UPSTREAM_REALTIME`, `UPSTREAM_FRONTEND`, `UPSTREAM_REDIS`,
`EDGE_HTTP_PORT`, `EDGE_HTTPS_PORT`, `EDGE_REDIRECT_PORT`, `FAZA28_RUNTIME_DIR`.

**Gateway region topology note:** the FAZA 22 gateway resolves its regions
(`eu`/`us`/`asia` → `http://127.0.0.1:4000`) — the documented sandbox equivalent
of `http://backend:4000` (container name → address mapping above).

## Routing table (= Caddyfile.faza28-live)

| Route | Match | Failover chain |
|---|---|---|
| `edge-self` | `/api/edge/*` | self (health / status / mapping) |
| `hub` | `/api/hub/*` | **gateway:4040 → backend:4000** |
| `infra` | `/api/infra/*` | gateway:4040 |
| `observability` | `/api/observability/*`, `/api/summary*`, `/v1/traces*`, `/v1/metrics*` | observability:4050 |
| `stability` | `/api/stability/*`, `/api/lb/*`, `/api/scale/*`, `/api/shaping/*` | stability:4060 |
| `realtime` | `/socket.io/*`, `/api/realtime/*` | realtime:4010 (+ WS relay on :8181) |
| `api` | `/api/*`, `/v1/*` | backend:4000 (PROTECTED — proxy only) |
| `static` | `/_next/static/*`, `/favicon.ico`, `/icons/*`, `/images/*`, `/manifest.webmanifest` | frontend:3000 + `Cache-Control: immutable` |
| `frontend` | default | frontend:3000 |

## Zero-502 guarantee (by construction)

1. Per-route failover chains (hub: gateway → backend direct).
2. Network-level upstream failure ⇒ next candidate in chain automatically
   (`X-Animaxia-Fallback: true` response header).
3. Legitimate upstream answers (incl. FAZA 18 honest `503 queue-full` +
   `Retry-After`, FAZA 22 `429` rate limits) pass through **unmodified**.
4. All upstreams dead ⇒ edge answers **503 + Retry-After** (honest), never 502.
5. Active health probes every 5 s per upstream (2 s timeout).

## Self endpoints (all listeners)

- `GET /api/edge/health` — liveness
- `GET /api/edge/status` — listeners, upstream states (health + latency),
  routing table, counters (failovers, 502 counter that must stay 0), redis RESP probe
- `GET /api/edge/mapping` — the normalization table above, machine-readable

## TLS certificate

Self-signed generated at first boot into `/home/z/faza28-runtime/certs/`
(CN=`animaxia.live`, SAN: `*.animaxia.live`, `localhost`, all container names,
`127.0.0.1`, 365 days). In production the Caddyfile mounts real certificates.

## Run

```bash
cd mini-services/edge-live && bun run dev   # 8181 / 8443 / 8080
```
