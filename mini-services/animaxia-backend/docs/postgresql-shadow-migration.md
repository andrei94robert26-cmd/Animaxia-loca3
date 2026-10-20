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

## Ce mai lipsește pentru 1.000.000.000 de titluri

- Migrarea autorității de scriere pentru toate modulele din SQLite în PG.
- Partiționarea reală, replicarea, backup + restore verificate, failover.
- Cozi distribuite și leasing pentru multipli workeri.
- Migrarea autentificării, uploadului, istoricului, căutării și playerului.
- Benchmarkuri cu volume reprezentative și simularea căderii nodurilor.
- Audit de confidențialitate, securitate și drepturi de distribuție.

**Această etapă este o etapă verificabilă de compatibilitate PG,
nu o promisiune de scalare la 1 miliard de titluri.**
