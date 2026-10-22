# Animaxia — Etapa 19: proiecția tranzacțională a evenimentelor PostgreSQL

## Scopul și limitele etapei

**Această funcție este izolată. Nu schimbă biblioteca publică SQLite,
nu activează streamingul și nu reprezintă un cluster OpenSearch instalat.**

Etapa 18 a introdus un catalog PostgreSQL nativ experimental,
`animaxia_pilot_catalog`, cu un jurnal PostgreSQL de evenimente scris
atomic la inserare, modificare și ștergere:
`animaxia_pilot_events`.

Etapa 19 creează un consumator pentru acel jurnal. Acesta sincronizează
un **index PostgreSQL secundar și separat**:
`animaxia_pilot_search_projection`.

```text
POST Admin /pilot/items
   └─ tranzacție PostgreSQL
       ├─ animaxia_pilot_catalog (sursa nativă pilot)
       └─ animaxia_pilot_events (eveniment durabil)

   └─ proiector PostgreSQL opțional
       ├─ revendică eveniment: FOR UPDATE SKIP LOCKED
       ├─ lock per externalid + recitire rând pilot curent
       ├─ UPSERT / DELETE în animaxia_pilot_search_projection
       └─ marchează evenimentul procesat
          într-o SINGURĂ tranzacție

Admin /pilot/projection/items
   └─ citește DOAR indexul secundar pilot
```

## Configurare sigură

Păstrează credențialele în secret managerul backendului:

```dotenv
ANIMAXIA_PG_SHADOW_DATABASE_URL=postgresql://pilot:<secret>@postgres.internal:5432/animaxia
ANIMAXIA_PG_SHADOW_TLS=true
ANIMAXIA_PG_CATALOG_PILOT=true
ANIMAXIA_PG_PILOT_PROJECTION=true
ANIMAXIA_PG_PILOT_PROJECTION_WORKER=false
```

Toate cele trei flaguri pilot sunt **false implicit** în exemplul de mediu.
Un URL PostgreSQL securizat, backupuri și roluri limitate sunt obligatorii
pentru o eventuală utilizare dincolo de mediul de test.

**Ordinea inițializării:**

1. Creează catalogul pilot cu
   `POST /api/migration/postgres/pilot/setup`.
2. Creează proiecția cu
   `POST /api/migration/postgres/pilot/projection/setup`.
   Este o operație idempotentă și migrează evenimentele pilot
   preexistente la noul marcaj de livrare.
3. Interoghează starea din
   `GET /api/migration/postgres/pilot/projection/status`.
4. Procesează manual un lot limitat cu
   `POST /api/migration/postgres/pilot/projection/flush`:

```json
{"limit":20}
```

Limita este între **1 și 100** per cerere. Rezultatul include:
`processed`, `failed`, `updated`, `deleted`. Contoarele
`updated` și `deleted` cresc numai după commit.

5. Caută în proiecția secundară din
   `GET /api/migration/postgres/pilot/projection/items?q=Film&limit=10`.
   Cu `afterId=<nextAfterId>` poți pagina după ID fără OFFSET.

Toate operațiile HTTP sunt protejate prin verificarea autentificării,
rolului de administrator și rate limiting. Controalele se află în
**Admin → PostgreSQL → Proiecție de căutare PostgreSQL pilot**.

## Recuperarea după erori și concurență

Fiecare eveniment pilot are câmpurile
`projection_applied_at`, `projection_attempts`,
`projection_next_run_at`. Dacă un worker cade înainte de commit,
PostgreSQL revine automat asupra actualizării proiecției și marcajului
de livrare: evenimentul rămâne disponibil.

Mai mulți workeri nu pot revendica același eveniment simultan datorită
`FOR UPDATE SKIP LOCKED`. Evenimentele pentru același `externalid`
sunt serializate prin lock consultativ PostgreSQL.

**Important:** proiectorul nu încearcă să reconstruiască toate versiunile
istorice, deoarece jurnalul pilot existent stochează ID, operație și
revizie, nu snapshotul complet. În schimb, la procesarea fiecărui
eveniment recitește **starea curentă** a catalogului pilot și aliniază
indexul secundar cu acea stare. Astfel se pot procesa și evenimente
vechi dinaintea acestei etape.

Dacă proiecția eșuează, marcajul și actualizarea nu sunt confirmate;
`projection_attempts` crește și `projection_next_run_at` primește
un backoff de la 5 secunde până la maximum o oră.

`ANIMAXIA_PG_PILOT_PROJECTION_WORKER=true` pornește opțional o
interogare periodică la circa 3 secunde. Activarea are loc pe server,
nu prin API. **Nu o activa pe toate instanțele fără un plan pentru
conexiuni, observabilitate și capacitate.**

## Worker PostgreSQL dedicat, fără serverul web

Proiectorul poate rula și ca **proces Node.js separat**, fără SQLite
și fără pornirea aplicației Express. Folosește aceeași bază PostgreSQL
privată, cu un număr controlat de conexiuni:

```dotenv
ANIMAXIA_PG_CATALOG_PILOT=true
ANIMAXIA_PG_PILOT_PROJECTION=true
ANIMAXIA_PG_PILOT_PROJECTION_WORKER=true
ANIMAXIA_PG_SHADOW_DATABASE_URL=postgresql://pilot:<secret>@postgres.internal:5432/animaxia
ANIMAXIA_PG_SHADOW_TLS=true
```

```bash
cd mini-services/animaxia-backend
npm ci
npm run worker:postgres-pilot-projection
```

Procesul ascultă `SIGTERM` și `SIGINT`; la oprire închide conexiunile
PostgreSQL. Evenimentele neconfirmate rămân în tabela durabilă. Pentru
un cluster cu mai multe instanțe, workerii folosesc
`FOR UPDATE SKIP LOCKED`, fără partajarea volumului SQLite.

**Nu activa simultan un număr arbitrar de workeri** fără dimensionarea
conexiunilor, limite de resurse și monitorizare. În etapa 19 nu s-a
implementat încă niciun orchestrator Kubernetes pentru acești workeri.

## Validarea pe PostgreSQL 16 real

GitHub Actions rulează acum:

- `tests/pg-pilot-projection.test.mjs`: refuzul accesului anonim,
  funcție dezactivată implicit, limite și SQL parametrizat;
- `tests/pg-pilot-projection-live.test.mjs`: PostgreSQL 16 efemer,
  creare repetabilă de schemă, evenimente native, workeri concurenți,
  căutare FTS, izolare de date private, rollback, retry atomic,
  actualizări succesive, ștergere și recreare a unui externalid,
plus rularea unui proces Node separat și oprirea lui prin SIGTERM.

Aceste teste sunt pentru **corectitudinea unui mediu mic**. Nu sunt
teste de performanță la 1 miliard de titluri, HA regional, redare video
sau un deployment real de producție.

## Etapa 21 — carantină pentru evenimentele care eșuează permanent

Proiectorul nu mai reîncearcă automat fără limită evenimentele pilot.
Operatorul configurează pragul numeric (1–100, valoarea implicită 8):

```dotenv
ANIMAXIA_PG_PILOT_MAX_ATTEMPTS=8
```

După a opta încercare eșuată, evenimentul rămâne în
`animaxia_pilot_events`, iar `projection_quarantined_at` este setat.
Joburile în carantină nu mai sunt selectate de workerul obișnuit. Noua
schemă este aditivă: `projection_quarantined_at` și
`projection_error_code` sunt create prin `ADD COLUMN IF NOT EXISTS`,
iar indexul `idx_animaxia_pilot_projection_events_ready` exclude
evenimentele deja carantinate.

Salvăm numai un cod SQLSTATE de cinci caractere sau `WORKER_ERROR`,
**nu** textul brut al erorii, credentiale, payloaduri video sau mesaje SQL.
Dacă un eveniment eșuează, operația asupra proiecției se anulează la
SAVEPOINT, dar numărul de încercări, întârzierea și eventual carantina
sunt confirmate împreună în tranzacția PostgreSQL.

Rutele necesită autentificare, rol administrator și limitare a cererilor:

```http
GET /api/migration/postgres/pilot/projection/quarantine?limit=20&afterEventId=0
Authorization: Bearer <admin-jwt>
```

Răspunsul este o pagină cu maximum 50 de evenimente, ordonate descrescător
după ID, fără payloadul evenimentelor. După verificarea cauzei, operatorul
poate permite din nou procesarea unui singur eveniment:

```http
POST /api/migration/postgres/pilot/projection/quarantine/123/retry
Authorization: Bearer <admin-jwt>
Content-Type: application/json

{}
```

Retryul se aplică numai dacă acel ID este încă neconfirmat și în
carantină. Resetează încercările și reprogramarea; proiectorul recitește
starea **curentă** din catalogul pilot, nu un snapshot istoric.
În **Admin → PostgreSQL** există și panoul „Carantină evenimente”.

**Testare:** `pg-pilot-projection.test.mjs` verifică limitele,
configurația, paginarea și refuzul accesului anonim.
`pg-pilot-projection-live.test.mjs` folosește PostgreSQL 16 real:
introduce o constrângere care face un eveniment să eșueze de două ori,
verifică izolarea lui și faptul că workerul îl ignoră, apoi înlătură
constrângerea și validează reluarea explicită și livrarea lui.

Aceasta nu este o soluție generală de dead-letter pentru toate cozile
Animaxia; se aplică **doar evenimentelor pilot PostgreSQL**.
Nu s-a activat pe serverul de producție și nu demonstrează capacitatea
de procesare a unui miliard de titluri.

## Oprire și rollback

Setează pe backend:

```dotenv
ANIMAXIA_PG_PILOT_PROJECTION_WORKER=false
ANIMAXIA_PG_PILOT_PROJECTION=false
```

Apoi repornește serviciul. Datele din PostgreSQL rămân intacte.
Nu șterge automat tabelele de evenimente și nu modifica catalogul
principal SQLite ca parte a rollbackului.

**Urmează pentru migrarea reală:** inventarierea tuturor operațiilor
SQLite, alegerea unei surse PostgreSQL autoritative, transferul
datelor/ID-urilor, livrarea evenimentelor către OpenSearch, cozi de
ingestie distribuite, backup/restore testat și benchmarkuri de scalare.
