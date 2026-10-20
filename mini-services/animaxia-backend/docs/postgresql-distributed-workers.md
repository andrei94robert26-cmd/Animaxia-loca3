# Animaxia — Etapa 17: joburi PostgreSQL cu workeri concurenți

**Stare:** implementare opțională în PR #1; nu există merge sau
activare în producție. Nu reprezintă migrarea bazei principale.

## Arhitectura construită

Traseul existent rămâne funcțional:

```text
SQLite Content (sursa autoritativă)
 └── trigger SQLite -> pg_shadow_outbox (durabilă)
      └── UN SINGUR feeder SQLite -> PostgreSQL animaxia_shadow_tasks
           ├── PostgreSQL-only Worker A (proces independent)
           ├── PostgreSQL-only Worker B (proces independent)
           └── PostgreSQL-only Worker N
                └── animaxia_shadow_content (copie metadate)
```

Numai feederul are nevoie de catalogul SQLite. Workerii separați
importă `pg` și modulul `distributed-pg-worker.js`, nu baza SQLite.
Tabelul PostgreSQL al joburilor are un singur rând per `contentid`,
`generation` monoton pentru modificări, `next_run_at`, numărul de
încercări și un payload JSONB limitat la metadate.

Un worker revendică un job prin `SELECT ... FOR UPDATE SKIP LOCKED`
în tranzacția PostgreSQL. Aplicarea metadatelor și eliminarea jobului
se fac **în aceeași tranzacție**; la căderea procesului, PostgreSQL
revine la starea dinaintea tranzacției și jobul rămâne disponibil.
La un eșec al unui document, tranzacția folosește `SAVEPOINT` și
înregistrează atomic un backoff progresiv (5 secunde până la 1 oră).

Feederul scrie mai întâi în coada PostgreSQL, apoi confirmă jobul din
outboxul SQLite prin `contentid + revision`. Un eșec între cele două
operații poate repeta publicarea; upsertul PostgreSQL coalescează rândul
după `contentid`, fără a deschide mai multe joburi separate.
Dacă între timp SQLite s-a modificat, confirmarea reviziei vechi eșuează,
iar modificarea nouă va fi expediată ulterior.

## Pornire controlată

Pregătește mai întâi PostgreSQL, backupul SQLite, conturile/permisiunile
și schema shadow din etapele 15–16:

```http
POST /api/migration/postgres/setup
Authorization: Bearer <admin-jwt>

{}
```

Creează explicit schema **cozii distribuite**:

```http
POST /api/migration/postgres/distributed/setup
Authorization: Bearer <admin-jwt>

{}
```

În procesul backend unde locuiește SQLite, activează **doar feederul**:

```dotenv
ANIMAXIA_PG_SHADOW_DATABASE_URL=postgresql://user:<secret>@pg.internal:5432/animaxia
ANIMAXIA_PG_SHADOW_TLS=true
ANIMAXIA_PG_SHADOW_WORKER=false
ANIMAXIA_PG_DISTRIBUTED_BRIDGE=true
ANIMAXIA_PG_DISTRIBUTED_WORKER=false
```

Nu porni vechiul `ANIMAXIA_PG_SHADOW_WORKER` împreună cu feederul nou.
Operarea simultană este respinsă pentru a evita două trasee de
publicare/aplicare. **Un singur feeder SQLite** este permis; codul
încă nu are leasing distribuit pentru feeder sau writeri SQLite.

Pe fiecare server dedicat workerului configurează secretul PostgreSQL
prin managerul de secrete, apoi:

```dotenv
ANIMAXIA_PG_SHADOW_DATABASE_URL=postgresql://user:<secret>@pg.internal:5432/animaxia
ANIMAXIA_PG_SHADOW_TLS=true
ANIMAXIA_PG_DISTRIBUTED_WORKER=true
```

```sh
cd mini-services/animaxia-backend
npm ci
npm run worker:postgres-shadow
```

Procesul dedicat nu importă Express sau baza SQLite. Folosește doar
PostgreSQL; poți porni mai multe exemplare pentru a procesa aceeași
coadă, cu un număr moderat de conexiuni. Pentru oprire ordonată,
trimite SIGTERM/SIGINT. **Nu folosi volumele SQLite** ale backendului pe
serverele dedicate workerilor.

## Operare manuală și diagnostic

Operațiile noi sunt disponibile **numai pentru administrator**:

- `GET /api/migration/postgres/distributed/status` — numărul de joburi
  PG în așteptare, retryuri, stare feeder și joburi SQLite rămase.
- `POST /api/migration/postgres/distributed/stage`
  cu `{"limit":40}` — mută până la 40 de snapshoturi în coada PG.
- `POST /api/migration/postgres/distributed/process`
  cu `{"limit":10}` — procesează până la 10 joburi PG imediat.
- `POST /api/migration/postgres/distributed/setup` — creează schema.

Limitări: maxim 100 de joburi per apel și backoff la erori; nu este
activat implicit un job de curățare definitivă. Nu publica adresele
joburilor fără autorizare și nu adăuga tokenuri/surse video în JSONB.
Fișierele învechite/deconectate sunt gestionate de vechiul player,
nu de această coadă.

## Validare

`tests/pg-distributed-live.test.mjs` rulează pe un server PostgreSQL **16
real** în GitHub Actions. Testele verifică:

- schema și publicarea din outbox SQLite către PG;
- preluarea de către două instanțe independente de worker;
- atomicitatea aplicării/confirmării și absența dublurilor;
- eșecul și retryul unei sarcini cu document invalid;
- sosirea unui snapshot mai nou și aplicarea lui;
- ștergerea sincronizată;
- procesul separat `node cli/postgres-shadow-worker.mjs`, oprirea prin
  semnal și procesarea fără acces la SQLite.

Acesta este un test funcțional cu puține înregistrări, **nu un benchmark**
de performanță, latență, replicare multi-regiune sau failover controlat.
Nu s-a demonstrat suportul pentru 1 miliard de titluri.

## Ce mai trebuie înainte de producție

PostgreSQL este tot o **copie shadow**. Autentificarea, uploadul, sursele
video, recomandările, istoricul și biblioteca autoritativă rămân SQLite.
Pentru un deployment distribuit complet trebuie migrate fluxurile de
scriere/citire, implementat un design de outbox/tranzacții PostgreSQL
autoritativ, adăugate monitorizare, backup/restore, rate control, quotas,
poison-job/dead-letter handling și teste de failover pentru infrastructura
reală.

### Rollback

Oprește `ANIMAXIA_PG_DISTRIBUTED_BRIDGE` și procesele dedicate worker;
revino la `ANIMAXIA_PG_SHADOW_WORKER=false`, fără schimbarea
bazei autoritative sau a `ANIMAXIA_SEARCH_BACKEND`. Joburile PG
rămase trebuie reconciliate manual înainte de schimbarea fluxului.
Nu șterge automat tabelele PostgreSQL sau fișierul SQLite.
