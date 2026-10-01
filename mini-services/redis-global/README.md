# animaxia-redis-global (FAZA 22 — Global Infrastructure)

Instanță de validare locală cu **protocol Redis (RESP2)** pe portul **4030**, folosită de straturile distribuite globale ale platformei (perimetrul `global-gateway` de pe :4040 — anti-spam, rate-limit, cooldown, cache — și, pe viitor, shared-state distribuit).

## De ce un server RESP local

- Toate componentele globale vorbesc cu Redis **doar prin protocolul RESP2** standard (comenzi: `PING`, `GET`, `SET ... EX`, `SET ... NX`, `INCR`, `EXPIRE`, `TTL`, `DEL`, `KEYS`, `FLUSHDB`, `INFO`).
- În **producție** straturile globale se leagă la **Upstash / Redis Cloud** — exact același protocol, zero modificări de cod în clienți. Instanțele managed sunt provizionate prin artefactele **Terraform** din `animaxia-ops/` (proiectate de echipa de infrastructură — nu fac parte din acest mini-serviciu).
- Instanța locală validează comportamentul real: TTL (expirare leneșă + sweep periodic la 1s), semantica `SET NX/EX`, `INCR` (păstrează TTL-ul cheii), pipelining (mai multe comenzi într-un singur buffer TCP).

## Comenzi suportate

`PING`, `ECHO`, `SET key value [EX sec | PX ms] [NX | XX]`, `GET`, `DEL`, `EXISTS`, `EXPIRE`, `TTL`, `PTTL`, `INCR`, `INCRBY`, `DECR`, `KEYS pattern` (glob `*`, `?`, `[...]`), `DBSIZE`, `FLUSHDB`, `SELECT 0`, `COMMAND`, `INFO`, `QUIT`.

Acceptă și **comenzi inline** (linie terminată cu `\r\n`) pentru testare manuală rapidă (ex. `printf 'PING\r\n' | ...`).

## Caracteristici

- **Doar în memorie**: fără persistență, fără AUTH — instanță de validare.
- **Robustețe**: input malformat → răspuns `-ERR` + resincronizare; erori de socket prinse; procesul nu cade niciodată pe trafic greșit.
- **Statistici**: contoare per comandă (`INFO` → `# Stats`, `total_commands_processed`), clienți conectați.
- Header `INFO` onest: `animaxia_role:resp_validation-instance`, `redis_version:7.4.0-animaxia-global`.

## Rulare

```bash
cd mini-services/redis-global
bun run dev          # bun --hot index.ts — ascultă pe :4030
```

Test rapid (fără client redis instalat):

```bash
bun -e "import net from 'node:net'; const s = net.connect(4030,'127.0.0.1'); s.on('connect',()=>s.write('*1\r\n\$4\r\nPING\r\n')); s.on('data',d=>{console.log(d.toString());process.exit(0)});"
# → +PONG\r\n
```

## Mapare sandbox → producție

| Sandbox | Producție |
|---|---|
| `redis-global` pe `127.0.0.1:4030` | Upstash / Redis Cloud (RESP2, TLS) |
| chei `rl:*`, `spam:*`, `cdviol:*`, `cdlock:*`, `cache:*` | identice |
| fără AUTH / persistență | AUTH + persistență gestionate de provider |

Provizionarea resurselor din producție (Upstash/Redis Cloud) se face prin Terraform în `animaxia-ops/` — acest mini-serviciu rămâne 100% local, de validare.
