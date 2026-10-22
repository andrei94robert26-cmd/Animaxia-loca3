# Animaxia — Etapa 15: copiere graduală a catalogului în PostgreSQL

**Stare:** implementare opțională în PR #1; fără merge și fără deployment în producție.
**Scop:** pregătirea unei migrări controlate de la catalogul SQLite la PostgreSQL,
fără pierderea datelor și fără schimbarea implicită a bazei principale.

## Ce este și ce NU este

Catalogul principal `Content`, conturile, tokenurile, istoricul, sursele
video, căutarea FTS5, ingestia și playerul **rămân în SQLite**.
PostgreSQL primește exclusiv **o copie shadow** a metadatelor:
titlu, an, tip, externalid, miniatură, descriere, actori, genuri, studio,
franciză, trilogie, colecție, poster ID, proveniență, rating.

Proiecția nu include URL-uri video, coduri embed, player sources ori câmpuri
arbitrare/secrete din JSON original. Nu este un înlocuitor funcțional pentru
toată schema Content și nu permite acum migrarea utilizatorilor, căutării,
loginului, datelor media sau multi-serverului.

## 1. PostgreSQL privat, configurat de operator

Se recomandă un cluster PostgreSQL real cu backup, TLS, monitorizare,
un cont dedicat cu permisiuni minime și acces numai din rețeaua backendului.
Cheia se configurează în secret managerul serverului, **niciodată în frontend**:

```dotenv
ANIMAXIA_PG_SHADOW_DATABASE_URL=postgresql://shadow_user:<secret>@pg.internal.example:5432/animaxia_shadow
ANIMAXIA_PG_SHADOW_TLS=true
ANIMAXIA_PG_SHADOW_WORKER=false
```

Un URL configurat instalează trigger-ele SQLite și outboxul persistent la
inițializarea backendului, dar **nu** creează automat tabele pe serverul PG
și **nu** pornește workerul.

TLS cu `rejectUnauthorized:true` este activ implicit. TLS dezactivat este
acceptat numai pentru `localhost`/loopback în dezvoltare, nu în producție.
Nu pune parole în repository sau în `.env.example`; rotește orice chei
anterior publicate.

## 2. Inițializarea tabelelor și a indexurilor PostgreSQL

Cu un JWT de administrator, după un backup verificat:

```http
POST /api/migration/postgres/setup
Authorization: Bearer <admin-jwt>
Content-Type: application/json

{}
```

Creează tabelul `animaxia_shadow_content`, index B-tree `(type,year,id)`
și index GIN pentru metadatele JSONB. Interogările SQL folosesc parametri
`$1`–`$7`, fără concatenarea textului utilizatorului.

## 3. Backfill controlat al catalogului existent

```http
POST /api/migration/postgres/backfill
Authorization: Bearer <admin-jwt>
Content-Type: application/json

{"afterId":0,"limit":500}
```

Răspunsul conține `scanned`, `nextAfterId`, `finished`. Parcurge toate
paginile după ID până la `finished:true`. Maximum 1.000 înregistrări/pagină.
Joburile deja în așteptare nu se suprascriu la backfill.

Inserările/actualizările/ștergerile ulterioare sunt surprinse de trigger-ele
`Content` în aceeași tranzacție SQLite. Un job conține `contentid`,
operația, un număr de revizie, data următoarei încercări și numărul de
încercări. Actualizările între citirea jobului și confirmarea PostgreSQL
nu se pierd: confirmarea face compare-and-swap pe revizie.

## 4. Sincronizare manuală, apoi worker opțional

```http
POST /api/migration/postgres/flush
Authorization: Bearer <admin-jwt>
Content-Type: application/json

{"limit":40}
```

Verifică răspunsul `processed`, `failed`, `pending`. Cererile PG reușite
sunt confirmate în outbox; după eșec, jobul este reluat cu backoff de până
la o oră. Ștergerile din SQLite sunt proiectate ca `DELETE` în PostgreSQL.

După testarea conexiunii, a performanței și a copiilor de siguranță,
poți porni un **singur** worker SQLite:

```dotenv
ANIMAXIA_PG_SHADOW_WORKER=true
```

Workerul trimite până la 40 de operații aproximativ o dată la cinci secunde.
**Nu există leasing distribuit sau lock multi-replică.**

## 5. Comparație și rollback

`GET /api/migration/postgres/status` (admin) afișează configurația fără
parolă, joburile restante, numărul de retryuri și starea workerului.

`GET /api/migration/postgres/compare` (admin) compară `COUNT(*)`
SQLite cu `COUNT(*)` în PG, plus joburile restante.
Numerele egale nu dovedesc identitatea fiecărui document; nu înlocuiesc
auditul de integritate.

Rollback imediat:

```dotenv
ANIMAXIA_PG_SHADOW_WORKER=false
```

SQLite, FTS5, importurile și căutarea nu se modifică. Datele deja trimise
în PostgreSQL rămân acolo până la o eliminare separată, autorizată.

## 6. Teste

`tests/pg-shadow.test.mjs` verifică schema, TLS, respingerea conexiunilor
nesigure, integritatea outboxului, retryul, actualizările concurente,
interdicția copierii linkurilor private și accesul numai al administratorului.

`tests/pg-shadow-live.test.mjs` testează împotriva unui server **PostgreSQL 16
real într-un container GitHub Actions**, cu credențiale efemere de CI:
crearea tabelelor, backfillul, JSONB, inserare, modificare, ștergere și
compararea numărului de înregistrări. Nu reprezintă un test pe cluster
de producție și nu demonstrează funcționalitatea la un miliard de titluri.

## Etapa 16 — citire PostgreSQL și verificarea metadatelor

Etapa 16 păstrează SQLite **baza principală**. PostgreSQL are acum două
operații ADMIN separate de fluxul public și fără surse video.

### A. Căutare și citire cu filtre direct în PostgreSQL

```http
GET /api/migration/postgres/catalog?q=Adventure&category=filme&year=2026&limit=10
Authorization: Bearer <admin-jwt>
```

Suportă `q` (titlu/descriere prin PostgreSQL FTS), `category` sau
`type`, `year`, `actor`, `genre`, `studio`, `franchise`,
`trilogy`, `collection`, `description`, `posterId`.

Sortarea este `id DESC`, cu **paginare keyset**, fără `OFFSET`.
Limita este 1–50. Răspunsul returnează `data`, `hasMore`, `nextCursor`.
La pagina următoare adaugă `cursor=<nextCursor>`, păstrând filtrele.
Cursorul este asociat criptografic prin hash cu filtrele; nu este o
semnătură anti-manipulare sau un snapshot consistent pe termen lung.
Nu se execută un `COUNT(*)` costisitor la fiecare pagină.

Schema PostgreSQL primește suplimentar un index GIN pe expresia
`to_tsvector('simple', title || ' ' || metadata.description)`.
Conținutul rezultat este limitat la câmpurile de metadate; playerul,
adresele video și câmpurile JSON secrete nu sunt expuse.

Interfața **Admin → PostgreSQL** conține acum un formular de căutare
și navigare în această copie, fără să comute catalogul utilizatorilor.

### B. Audit document cu document și reparație controlată

```http
POST /api/migration/postgres/verify
Authorization: Bearer <admin-jwt>
Content-Type: application/json

{"afterId":0,"limit":25,"dryRun":true}
```

Verifică într-un singur lot cel mult 50 de titluri din SQLite după ID și
compară înregistrările PostgreSQL efective (inclusiv metadatele JSONB).
Răspunsul arată `matched`, `missing`, `mismatched`,
`repairCandidates`, `repairQueued` și `nextAfterId`.

Modul implicit `dryRun:true` **nu modifică nimic**. Numai un
administrator poate trimite `dryRun:false`; atunci înregistrările
lipsă sau diferite sunt înscrise pentru sincronizare în outboxul SQLite.
Nicio reparație nu suprascrie joburile deja în coadă sau un eveniment
nouer; sincronizarea efectivă are loc prin workerul normal.

Testul CI `tests/pg-shadow-live.test.mjs` execută acum asupra
**PostgreSQL 16 real** căutări full-text, filtre de categorie/an/actor/gen,
paginare keyset, alterarea intenționată a unui rând PostgreSQL,
detectarea nepotrivirii și restabilirea lui din SQLite.

Testele `tests/pg-shadow-read.test.mjs` și
`tests/pg-shadow-verify.test.mjs` verifică validarea inputului,
parametrizarea SQL, cursorii, permisiunile și recuperarea.

**Limite:** auditul inspectează doar rândurile prezente în SQLite;
nu enumeră intrările PostgreSQL orfane. Modificările simultane pot
schimba rezultatele între pagini. Citirea PostgreSQL este numai
administrativă și nu demonstrează distribuirea bazei principale.

## Ce mai lipsește pentru 1.000.000.000 de titluri

- Migrarea autorității de scriere pentru toate modulele din SQLite în PG.
- Partiționarea reală, replicarea, backup + restore verificate, failover.
- Cozi distribuite și leasing pentru multipli workeri.
- Migrarea autentificării, uploadului, istoricului, căutării și playerului.
- Benchmarkuri cu volume reprezentative și simularea căderii nodurilor.
- Audit de confidențialitate, securitate și drepturi de distribuție.

**Această etapă este o etapă verificabilă de compatibilitate PG,
nu o promisiune de scalare la 1 miliard de titluri.**
