# animaxia-global-gateway (FAZA 22)

Gateway global multi-regiune pentru Animaxia — echivalentul **local rulabil** al
geo-routing-ului de producție de la Cloudflare Edge. Include straturile
perimetrale distribuite (anti-spam, cooldown, rate-limit, cache) cu stare în
Redis.

## Topologie

| Regiune | Label | Upstream-uri (sandbox) |
|---|---|---|
| `eu` | EU (Frankfurt) | `http://127.0.0.1:4000` (backend-ul real) |
| `us` | US (Virginia) | `http://127.0.0.1:4098` (mort, intenționat — demo failover) → `http://127.0.0.1:4000` |
| `asia` | ASIA (Singapore) | `http://127.0.0.1:4000` |

- În sandbox, toate upstream-urile sănătoase punctează backend-ul real `:4000`.
- În producție: `ANIMAXIA_REGIONS_FILE=./regions.production.json` cu originile
  reale per regiune (eu/us/asia-api.animaxia.com).
- Failover: lanț `eu → us → asia`; dacă regiunea cerută nu are upstream sănătos,
  cererea trece automat la următoarea regiune (header `x-animaxia-fallback`).
- Health-check la fiecare 5s pe `/api/health` + circuit breaker per upstream
  (request eșuat → marcat unhealthy instant, reîncercat de monitor).

## Straturi perimetrale (ordinea: anti-spam → cooldown → rate-limit → cache)

Toate cu stare distribuită în Redis (protocol RESP):

1. **Anti-spam** — hash SHA1 pe (metodă, cale, query, body ≤4KB); >25 cereri
   identice / 10s → blocare 30s; query >512 caractere sau caractere de control → respins.
2. **Cooldown** — după 3 violări de rate-limit în 5 minute → lock 60s
   (verificat înaintea limiterului, ca clienții blocați să fie respinși cât mai devreme).
3. **Rate-limit** — fereastră fixă distribuită, per clasă de rută:
   `/api/search` 120/min · `/api/hub` 240/min · `/api/ai` 60/min · general 600/min.
   Headere `x-ratelimit-*` + `Retry-After`.
4. **Cache** — doar GET public (fără `Authorization`) pe `/api/search/*` (TTL 45s)
   și `/api/hub/*` (TTL 60s), răspunsuri 200 ≤ 256KB, headere `x-cache: MISS|HIT|BYPASS`.

**Important:** aceste straturi sunt apărare în adâncime la **perimetru**.
Pipeline-ul FAZA 18 din interiorul backend-ului rămâne neatins și rămâne
autoritatea pentru motorul de căutare. Niciun fișier protejat nu este modificat.

## Rute infra (gestionate local, niciodată proxiate)

- `GET /` — topologia + descriere
- `GET /api/infra/health` — liveness
- `GET /api/infra/status` — regiuni + health + cache + contoare
- `POST /api/infra/cache/purge` — `{ "prefix": "cache:" }`
- `POST /api/infra/regions/{eu|us|asia}/down|up` — override de health (teste failover)

## Redis

- Sandbox: `mini-services/redis-global` (:4030) — instanță de validare locală
  cu protocolul RESP (subset). Producție: Upstash / Redis Cloud — **același
  protocol** (artefacte Terraform în `animaxia-cloud/domain/redis/`).
- Dacă Redis este inaccesibil, clientul degradează transparent la un store
  in-memory per-instanță (limită per instanță — degradare onestă, raportată în
  `x-animaxia-redis` și `/api/infra/status`) și reîncearcă conectarea la 10s.

## Securitate

- `TRUST_XFF=1` doar în sandbox (permite QA-ului să simuleze clienți distinși
  prin `X-Forwarded-For`). **În producție rămâne OFF** — la edge, Cloudflare
  setează `CF-Connecting-IP`.

## FAZA 23 (observability) — `/metrics` + OTLP span push

- `GET /metrics` (local, niciodată proxiat) — text Prometheus:
  `animaxia_gateway_requests_total{region,cache: hit|miss|bypass}`,
  `animaxia_gateway_failovers_total{from,to}` + `_all_total`,
  `animaxia_gateway_upstream_errors_total{region}`,
  `animaxia_gateway_{ratelimited,antispam,cooldown}_total`,
  `animaxia_gateway_cache_{hits,misses,bypasses}_total`,
  `animaxia_gateway_upstreams_healthy{region}`, `animaxia_gateway_uptime_seconds`,
  `animaxia_gateway_redis_mode{mode}`, `animaxia_gateway_otel_*` (spans
  exportate / erori / dropped / enabled). Contorii de perimetru REUSE
  structurile existente `layers.stats` — zero relogică.
- Span push OTLP către `${OTEL_EXPORTER_ENDPOINT:-http://localhost:4050}/v1/traces`
  (collectorul global FAZA 23): `service.name=animaxia-gateway`, span
  `gateway.proxy` cu atribute `{region, upstream, status, durationMs, fallback,
  cache}`, traceId derivat din `x-request-id`-ul generat per request. Batch la
  3s, coadă bounded 500 (drop-oldest), fetch fire-and-forget cu `.catch` SILENT,
  interval `.unref()`, `OTEL_ENABLED=0` dezactivează exportul (contorii locali rămân).
- Eșecurile de export sunt întotdeauna silențioase — observabilitatea nu poate
  afecta traficul; se văd doar în `animaxia_gateway_otel_export_errors_total`.

## Maparea producție

| Local (sandbox) | Producție |
|---|---|
| `global-gateway :4040` | Cloudflare Worker gateway (animaxia-edge/worker) + geo-routing (shared/geo.ts) |
| `redis-global :4030` | Upstash / Redis Cloud (animaxia-cloud/domain/redis) |
| `regions.production.json` | origini reale eu/us/asia + Neon multi-region (animaxia-cloud/domain/neon) |
