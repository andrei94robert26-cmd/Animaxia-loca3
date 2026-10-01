# Animaxia — Redis Global (Upstash) — FAZA 22

Infrastructura Redis globală a platformei: un grup de replicare **global**
(multi-region) pentru straturile de perimetru ale global-gateway și o bază de
date **single-region** pentru cache-ul de răspunsuri. Provisionată prin
Terraform (provider `upstash/upstash`), 100% aditivă — nu atinge niciun cod
protejat.

## Arhitectura

```
                        ┌──────────────────────────────────────────────┐
                        │  upstash_redis_cloud "animaxia_global"       │
                        │  aws · region "global" · multi_region         │
                        │  eviction OFF · TLS                           │
                        │                                               │
  global-gateway  ────► │  CONSUMATOR: straturile de PERIMETRU          │
  (FAZA 22, :4040)      │   • rate-limit distribuit ( contoare pe IP/   │
                        │     user, partajate între regiuni )           │
                        │   • cooldown ( markere anti-abuz )            │
                        │   • anti-spam ( amprente cereri repetitive )  │
                        └──────────────────────────────────────────────┘

                        ┌──────────────────────────────────────────────┐
                        │  upstash_redis_database "animaxia_gateway"    │
                        │  eu-central-1 · eviction ON · TLS             │
                        │                                               │
  global-gateway  ────► │  CONSUMATOR: cache de răspunsuri ( PERIMETRU )│
                        │   • /api/search   ( GET public )              │
                        │   • /api/hub      ( GET public )              │
                        └──────────────────────────────────────────────┘
```

### Ce consumă Redis global

| Resursă | Consumator | Straturi |
|---------|-----------|----------|
| `animaxia_global` (global, multi-region) | global-gateway | rate-limit distribuit, cooldown, anti-spam |
| `animaxia_gateway` (eu-central-1, eviction) | global-gateway | cache răspunsuri `/api/search` + `/api/hub` |

**Important — PERIMETRU, nu interior:** cache-ul de pe `animaxia_gateway`
stă ÎN FAȚA backendului protejat. Pipeline-ul FAZA 18 (cele 10 straturi:
anti-spam, rate-limit, cooldown, queue, priority, windowing, dedup,
batching, cache, neon-fts) rămâne 100% neatins în
`mini-services/animaxia-backend` — Redis global nu este conectat la el și nu
îl modifică în niciun fel.

### De ce eviction OFF pe grupul global

Contoarele de rate-limit și amprentele anti-spam trebuie să NU fie evicate
silencios — o evictare ar reseta bugetul unui atacator. Spațiul de chei este
bound de TTL-urile pe care le setează gateway-ul (fiecare counter expiră cu
fereastra lui). Pe baza de cache eviction este ON (sigur — e cache, orice
cheie poate fi refăcută din origin).

### Consistență

Grupul „global" Upstash este un deployment cu read-replica-e multi-region:
scrierile converg prin regiunea primară, deci contoarele strict-consistente
rămân în Durable Objects (edge, `shared/rate-limit.ts`), iar Redis global
este perimetrul cross-region eventual-consistent — exact ca în documentația
Upstash pentru deployment-urile global.

## Protocol RESP — identic cu instanța locală de validare

Protocolul este **RESP/RESP2 standard**. Instanța locală de validare
`mini-services/redis-global:4030` (serverul RESP2 din sandbox) implementează
același protocol: orice client care vorbește RESP cu `:4030` vorbește RESP cu
bazele Upstash — se schimbă doar endpoint-ul (URL + TLS + credentials):

```
# sandbox (validare locală):
redis-cli -p 4030 PING                     # → PONG

# producție (după apply):
redis-cli -u rediss://<animaxia-global-endpoint> -a <password> PING
```

Cheile folosite de global-gateway sunt documentate în
`mini-services/global-gateway` (alt agent, FAZA 22-a) — ex. prefixe de tip
`rl:`, `cooldown:`, `spam:` pe grupul global și `cache:` pe baza de cache.

## Pași de activare

1. **Cont Upstash** — creează un team pe https://console.upstash.com.
2. **Chei** — din console → Team → API Keys ia o cheie de tip *Management* și
   team id-ul din Team → Settings.
3. **Plan**:
   ```bash
   cd animaxia-cloud/domain/redis/terraform
   terraform init
   terraform plan \
     -var="upstash_api_key=<cheia>" \
     -var="team_id=<team id>"
   ```
   Verifică planul: 2 resurse noi (`animaxia_global`, `animaxia_gateway`),
   zero modificări în afara acestora.
4. **Apply**:
   ```bash
   terraform apply -var="upstash_api_key=…" -var="team_id=…"
   ```
   La final, console Upstash → Redis → fiecare bază → își arată endpoint-ul
   și parolele (TLS port 6379 `rediss://`).
5. **Conectare servicii** — endpoint-urile se injectează prin variabile de
   mediu în global-gateway (ex. `REDISGLOBALURL`, `REDISCACHEURL`), niciodată
   prin Terraform state. Modul sandbox rămâne pe `mini-services/redis-global:4030`.
6. **Verificare**:
   ```bash
   redis-cli -u rediss://<endpoint-global> -a <pass> PING   # PONG
   redis-cli -u rediss://<endpoint-cache>  -a <pass> PING   # PONG
   curl https://api.animaxia.com/api/search?q=test          # prin perimetru
   ```

## Ce NU face acest modul

- Nu modifică codul backendului protejat (FAZA 18 pipeline, motorul FTS,
  sharding, 30B, player, AI) — toate rămân 100% neatinsе.
- Nu este „conectat" automat nicăieri: global-gateway (alt agent) decide când
  citește aceste endpoint-uri; până atunci resursele există doar ca IaC.
- Nu înlocuiește KV-ul edge (Cloudflare) sau Durable Objects — este stratul
  cross-region dintre ele.
