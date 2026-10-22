# Animaxia — Etapa 18: PostgreSQL-native catalog pilot (izolat)

## Stare și scop

Etapa 18 implementează **primele scrieri native, tranzacționale, direct în
PostgreSQL**, separat de tabelele shadow din etapele 15–17 și separat de
SQLite Content. Nu migrează automat baza principală.

**Nu este activat implicit, nu este integrat în fluxul public și nu
reprezintă finalizarea migrării platformei la PostgreSQL.**

Arhitectura:

```text
API administrator
  POST /api/migration/postgres/pilot/items
     -> PostgreSQL animaxia_pilot_catalog (UNIQUE externalid)
     -> PostgreSQL animaxia_pilot_events (append-only audit)
     -> COMMIT în aceeași tranzacție
  GET /api/migration/postgres/pilot/items
     -> PostgreSQL native FTS + type/year + keyset ID
  DELETE /api/migration/postgres/pilot/items/:externalid
     -> DELETE catalog + eveniment DELETE în aceeași tranzacție

Catalogul public, sursele video, autentificarea, indexul SQLite FTS5,
OpenSearch și toate celelalte servicii existente rămân neschimbate.
```

## Configurare și activare

Configurează PostgreSQL într-o rețea privată, cu TLS, backupuri și cont
dedicat. Nu copia chei de acces în frontend sau în git.

```dotenv
ANIMAXIA_PG_SHADOW_DATABASE_URL=postgresql://catalog_user:<secret>@pg.internal:5432/animaxia
ANIMAXIA_PG_SHADOW_TLS=true
ANIMAXIA_PG_CATALOG_PILOT=true
```

**Aceste valori nu sunt activate prin commit.** Fără
`ANIMAXIA_PG_CATALOG_PILOT=true`, API-ul de scriere returnează 503.
Rutele sunt protejate suplimentar prin JWT de administrator și rate limiting.

### Creează schema explicit

```http
POST /api/migration/postgres/pilot/setup
Authorization: Bearer <admin-token>
Content-Type: application/json

{}
```

Creează tabelul `animaxia_pilot_catalog` cu un ID PostgreSQL BIGINT,
`externalid` unic, metadate JSONB, număr de revizie, index B-tree
tip/an și index GIN pentru căutare FTS. Tabelul
`animaxia_pilot_events` reține ID-ul, `externalid`, operația
și revizia; jurnalul este scris **în aceeași tranzacție** cu
conținutul, nu în SQLite.

### Inserează/actualizează un titlu pilot

```http
POST /api/migration/postgres/pilot/items
Authorization: Bearer <admin-token>
Content-Type: application/json

{
  "externalid": "api:example:movie:123",
  "title": "Film de test",
  "type": "movie",
  "year": 2026,
  "metadata": {
    "description": "Metadate de test",
    "actors": ["Actor demonstrativ"],
    "genres": ["Adventure"],
    "studios": ["Studio demonstrativ"],
    "sourceAttribution": "Example",
    "rating": 7.5
  }
}
```

Dacă `externalid` există deja, un `INSERT ... ON CONFLICT`
actualizează același document, crește `revision` și adaugă un
eveniment. Scrierile concurente cu același `externalid` sunt
serializate de constrângerea unică PostgreSQL.

**Metadate permise:** actors, genres, studios, description, franchise,
trilogy, collection, posterId, sourceAttribution și rating.
Sunt ignorate câmpurile JSON arbitrare, tokenurile, embedcode,
player.sources și URL-urile video. Thumbnail este acceptat numai ca
URL HTTPS fără credențiale. Acest API nu descarcă fișiere video.

### Etapa 22 — actualizări protejate prin revizie

Catalogul PostgreSQL nativ oferă acum o **precondiție opțională**
`expectedRevision` pentru actualizare și ștergere. Aceasta împiedică
*lost updates* când doi administratori modifică același conținut.

- `expectedRevision: 0` permite doar **crearea** unui titlu inexistent.
  Dacă `externalid` există, serverul răspunde `409 Conflict`.
- `expectedRevision: N` (număr întreg pozitiv) permite modificarea
  numai dacă rândul are exact revizia `N`. Altfel răspunde `409`.
- Câmpul absent păstrează compatibilitatea veche (**last-write-wins**).
  Pentru operațiuni administrative, trimite întotdeauna revizia.
- Valorile negative, fracționare, invalide sau peste limita întregilor
  siguri sunt respinse cu eroare de validare `400`.

Exemplu de actualizare condiționată:

```http
POST /api/migration/postgres/pilot/items
Authorization: Bearer <admin-token>
Content-Type: application/json

{
  "externalid": "api:example:movie:123",
  "title": "Film actualizat",
  "type": "movie",
  "year": 2026,
  "expectedRevision": 3,
  "metadata": { "genres": ["Adventure"] }
}
```

Ștergere condiționată:

```http
DELETE /api/migration/postgres/pilot/items/api%3Aexample%3Amovie%3A123?expectedRevision=4
Authorization: Bearer <admin-token>
```

Verificarea se face **în tranzacția PostgreSQL după obținerea aceleiași
blocări consultative pe `externalid`** pe care o folosesc deja
scrierile și proiecția de căutare. O încercare respinsă nu creează
eveniment `animaxia_pilot_events` și nu schimbă catalogul.

În **Admin → PostgreSQL**, formularul pornește cu revizia `0`
(creare-only). Butonul „Editează cu revizia N” de lângă titlurile
afișate încarcă ID-ul, titlul, categoria, anul și revizia curentă.
**Câmpurile de metadate existente sunt păstrate** la actualizarea
titlului — nu sunt suprascrise accidental cu text generic.
După salvare, revizia din formular este actualizată cu versiunea
confirmată de PostgreSQL. Butonul „Șterge pilot cu revizie” necesită
selectarea unui titlu, o revizie pozitivă și confirmare explicită.
Dacă între timp titlul s-a schimbat, ștergerea primește `409` și
nu afectează datele actuale.

Testele reale PostgreSQL 16 verifică două scrieri simultane cu aceeași
revizie, actualizări refuzate și ștergeri stale. Numai un scriitor
câștigă, iar jurnalul de evenimente nu primește intrări pentru cereri
respinse.

**Limită:** aceasta este protecție împotriva suprascrierii în
**catalogul pilot izolat**, nu tranzacționalizarea întregii platforme.
Nu schimbă comportamentul scrierilor publice în SQLite și nu dovedește
scalarea la 1 miliard de titluri.

### Citește catalogul pilot

```http
GET /api/migration/postgres/pilot/items?q=Film&type=movie&year=2026&limit=20
Authorization: Bearer <admin-token>
```

Căutarea folosește FTS PostgreSQL; filtrele sunt parametrizate.
Rezultatele se ordonează după ID descrescător și se paginează prin
`afterId=<nextAfterId>`, fără `OFFSET`. Se acceptă între 1 și 50
înregistrări pe pagină.

### Încarcă direct un titlu după ID-ul extern

```http
GET /api/migration/postgres/pilot/items/api%3Aexample%3Amovie%3A123
Authorization: Bearer <admin-token>
```

Ruta administrativă caută un singur document în indexul unic PostgreSQL
`externalid` și întoarce `{ "found": true, "data": { ... } }` cu
revizia curentă, ori `{ "found": false, "data": null }` dacă lipsește.
Această funcție nu folosește SQLite și nu citește surse video.

În interfața **Admin → PostgreSQL**, introdu ID-ul stabil și folosește
„Încarcă după ID extern”. Formularul va prelua titlul, categoria, anul,
revizia și metadatele necesare pentru editarea condiționată, inclusiv
pentru titluri care nu se află între ultimele cinci rezultate.
Cererea necesită JWT de administrator și respectă limitarea ratei.

### Ștergere explicită

```http
DELETE /api/migration/postgres/pilot/items/api%3Aexample%3Amovie%3A123
Authorization: Bearer <admin-token>
```

Ștergerea și evenimentul asociat sunt atomice. Un ID inexistent
returnează `deleted:false` și nu introduce eveniment suplimentar.

### Stare administrativă

```http
GET /api/migration/postgres/pilot/status
Authorization: Bearer <admin-token>
```

Afișează starea activării și, dacă este activ, numărul documentelor
și evenimentelor. Aceste numere sunt pentru pilot, nu pentru biblioteca
globală; nu există SLA de disponibilitate.

## Ce este testat

`tests/pg-catalog-pilot.test.mjs`: validare, intrări
malformate, limite, metadate private excluse, interogări parametrizate,
rute inaccesibile utilizatorilor neautentificați și flag dezactivat.

`tests/pg-catalog-pilot-live.test.mjs`: PostgreSQL **16 real** în
GitHub Actions: creare DDL/indexuri, insert/update/idempotency,
scrieri concurente pe același identificator, creșterea reviziilor,
jurnalizare tranzacțională, FTS, categorii, an, cursor și ștergere.
Un test provoacă intenționat eșecul jurnalizării ca să confirme
că modificarea catalogului se anulează în aceeași tranzacție.

Testele folosesc baze efemere de CI; **nu** verifică clusterul de
producție, performanța unui miliard de titluri, cross-region failover
sau redarea media.

## Limite și rollback

- Nu există cutover automat al `Content` SQLite și nici dual-write
  în fluxul public. Tabelul pilot are ID-uri proprii care nu trebuie
  confundate cu ID-urile SQLite.
- Evenimentele native PostgreSQL au jurnal durabil, dar **nu există
  încă un dispatcher** către OpenSearch sau către alte servicii.
- Nu există migrare de watchlist, autentificare, player, upload, joburi
  miner sau API-urile de conținut existente.
- Pentru a dezactiva funcția: setează
  `ANIMAXIA_PG_CATALOG_PILOT=false` și repornește backendul.
  Tabelele pilot rămân în PostgreSQL pentru audit până la o
  operație administrativă separată. Nu șterge baza SQLite.
- Pentru producție la scară mare urmează migrare completă a datelor,
  operații consistente multi-serviciu, backup/restore, replicare,
  partitionare și teste de performanță.
