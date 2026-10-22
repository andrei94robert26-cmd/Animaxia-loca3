# Animaxia — OpenSearch opțional, cu outbox persistent (Etapa 12)

**Status:** implementat în Pull Request #1, cu teste automatizate folosind
răspunsuri OpenSearch simulate. Nu s-a creat și nu s-a configurat un cluster
real, nu există deployment și nu există benchmark la un miliard de titluri.

## De ce acest mecanism

SQLite FTS5 rămâne motorul de căutare implicit și baza Content rămâne sursa
de adevăr. OpenSearch este o proiecție de citire separată. Activarea nu
migrează automat catalogul SQLite în PostgreSQL și nu înseamnă că un miliard
de titluri poate fi deja procesat.

Schema `search_index_outbox` este creată numai dacă este configurat
`ANIMAXIA_OPENSEARCH_URL`. Trigger-ele `Content` adaugă sau actualizează
câte o intrare persistentă la INSERT, UPDATE, DELETE. Scrierea catalogului
și scrierea în outbox apar în aceeași tranzacție SQLite. Înregistrările sunt
acknowledged numai la succesul *individual* din răspunsul OpenSearch Bulk.
Dacă un document se schimbă în timpul unei trimiteri, numărul de versiune
din outbox împiedică ștergerea jobului nou.

## Configurare în siguranță

Pe backend, printr-un secret manager, **fără chei în cod sau în frontend**:

```dotenv
ANIMAXIA_OPENSEARCH_URL=https://search.example.net
ANIMAXIA_OPENSEARCH_INDEX=animaxia-content-v1
ANIMAXIA_OPENSEARCH_USERNAME=<username>
ANIMAXIA_OPENSEARCH_PASSWORD=<password>
# Alternativ, în loc de username+password:
# ANIMAXIA_OPENSEARCH_API_KEY=<api-key>

ANIMAXIA_OPENSEARCH_WORKER=false
ANIMAXIA_SEARCH_BACKEND=sqlite
```

Producția cere HTTPS și autentificare. HTTP este permis numai către
loopback în dezvoltare (nu în `NODE_ENV=production`). Configurația respinge
URL-uri care conțin credențiale, parametri sau căi arbitrare.

**Important:** Nu porni încă workerul. Fă backup bazei SQLite; asigură-te că
ai creat un cluster OpenSearch real, izolat în rețea, cu TLS, autentificare,
backupuri, politici de retenție, monitorizare și acces controlat.

## 1. Creează indexul

Ca administrator autentificat, din fila `#/admin/opensearch` sau:

```http
POST /api/search/opensearch/setup
Authorization: Bearer <admin-jwt>
Content-Type: application/json

{}
```

Creează indexul configurat cu mapping strict pentru:
titlu, an, categorie, descriere, actori, genuri, studiouri, franciză,
trilogie, colecție, posterId și rating. Nu indexează automat URL-uri video,
embed sau surse media private.

## 2. Backfill în pagini limitate

```http
POST /api/search/opensearch/backfill
Authorization: Bearer <admin-jwt>
Content-Type: application/json

{"afterId":0,"limit":500}
```

Folosește `nextAfterId` din răspuns pentru pagina următoare; când primești
`finished:true`, ai parcurs catalogul vizibil la acel moment. Dacă există
scrieri concurente, trigger-ele păstrează actualizările noi în outbox.
Backfillul nu suprascrie intrările deja modificate.

## 3. Indexarea efectivă

În test sau pentru operații controlate:

```http
POST /api/search/opensearch/flush
Authorization: Bearer <admin-jwt>
Content-Type: application/json

{"limit":40}
```

După validarea clusterului poți porni pe server:
`ANIMAXIA_OPENSEARCH_WORKER=true`. Workerul trimite loturi de maximum
40 de modificări la aproximativ cinci secunde, când există intrări în outbox.
Un rezultat parțial OpenSearch reîncearcă numai documentele eșuate, cu
întârziere progresivă până la o oră. Un document DELETE este idempotent:
răspunsul 404 este tratat ca succes dacă nu mai există pe cluster.

Starea se citește la
`GET /api/search/opensearch/status`, numai de către un administrator.
Fila OpenSearch arată numărul de operații în așteptare.

**Atenție:** acesta este un worker pe o singură instanță SQLite. Nu are
leasing distribuit sau coordonare între replici. Nu porni același worker pe
mai multe procese care partajează aceeași bază. Pentru HA la scară mare,
folosește o coadă distribuită durabilă și un datastore principal scalabil.

### Compară numărul documentelor înainte de comutare

`GET /api/search/opensearch/compare` (doar administrator) consultă
`COUNT(*)` din catalogul SQLite și endpointul `_count` din OpenSearch,
afișând diferența și numărul de modificări în așteptare.
Același rezultat este accesibil prin butonul „Compară documentele” din
fila `#/admin/opensearch`. **Numerele egale nu garantează identitatea
fiecărui document**, nici consistența completă în timp real.

### Verificare individuală și reparare limitată

Verificarea numărului total nu garantează că OpenSearch conține aceleași
titluri sau metadate ca SQLite. Pentru comparație reală a documentelor,
folosește endpointul administrativ:

```http
POST /api/search/opensearch/reconcile
Authorization: Bearer <admin-jwt>
Content-Type: application/json

{"afterId":0,"limit":25,"dryRun":true}
```

Acesta citește maximum 50 de înregistrări locale dintr-o pagină stabilă
după ID, solicită documentele corespunzătoare prin OpenSearch `/{index}/_mget`
și compară câmpurile indexate. Răspunsul conține `matched`, `missing`,
`mismatched`, `repairCandidates`, `nextAfterId` și `finished`.

Implicit, `dryRun:true` **nu scrie nimic**. După verificarea rezultatelor,
administratorul poate retrimite aceeași pagină cu `dryRun:false`. Numai
documentele lipsă sau diferite sunt înscrise pentru reindexare în outbox.
Joburile deja în așteptare sunt păstrate (nu li se suprascrie versiunea).
În interfața `#/admin/opensearch` sunt butoane separate pentru verificare
și reparare, cu confirmare pentru modificări.

Dacă OpenSearch răspunde cu o eroare de shard, cu un document în altă ordine
sau cu un răspuns incomplet, **nu se programează reparații din acea pagină**.
Continuă cu `nextAfterId` până la `finished:true`; pentru un catalog mare,
această verificare are un cost de citire proporțional cu numărul titlurilor.

**Limite:** verificarea nu enumeră documentele orfane care există numai în
OpenSearch. Nici nu oferă un snapshot consistent sub scrieri concurente.
Este o operație de diagnostic și corectare pe loturi mici, nu dovada
capacității de a gestiona 1 miliard de titluri.

### Detectarea documentelor orfane din indexul extern

Etapa 14 adaugă și verificarea în direcția inversă: documente care încă
există în OpenSearch, dar **nu mai există** în `Content` din SQLite.

```http
POST /api/search/opensearch/orphans
Authorization: Bearer <admin-jwt>
Content-Type: application/json

{"afterId":0,"limit":25,"dryRun":true}
```

Un apel examinează maximum 50 de ID-uri OpenSearch, în ordine numerică,
folosind `search_after`, `_source:false` și `track_total_hits:false`.
Compară apoi fiecare ID cu catalogul autoritativ SQLite. Răspunsul
conține `scanned`, `present`, `orphaned`, `nextAfterId`, `finished`.

Implicit, `dryRun:true` nu modifică nimic. Cu `dryRun:false`,
**administratorul programează numai ștergerea ID-urilor orfane**, nu
execută direct ștergerea în cluster. Înainte de înscriere, SQLite verifică
din nou inexistența ID-ului; joburile deja în coadă nu sunt înlocuite.
Workerul OpenSearch folosește aceeași coadă persistentă pentru ștergeri.

**Important:** nu programa eliminarea documentelor orfane înainte de
verificarea completă a sursei de adevăr și a backupurilor SQLite. Nu
este indicată pe un cluster al cărui index este partajat cu alte aplicații.
Dacă OpenSearch raportează shard eșuat, timeout, ID invalid sau rezultate
nesortate, cererea eșuează fără reparații.

Nu există garanție de snapshot între surse în timpul scrierilor concurente.
Scannerul nu poate detecta documentele fără un câmp `id` numeric, ori
documentele care nu respectă mappingul Animaxia. Un rezultat de verificare
este un eșantion paginat, **nu** o certificare a întregului index.

## 4. Comută gradual motorul pentru metadate

Numai după backfill complet, număr de elemente comparat, testare pe exemple
și monitorizarea erorilor:

```dotenv
ANIMAXIA_SEARCH_BACKEND=opensearch
```

Aceasta comută **doar `GET /api/search/metadata`**, inclusiv filtrarea după
categorie/an/actor/gen/studio/franciză/trilogie/colecție/descriere/poster.
Răspunsul conține `engine: animaxia-opensearch-v1`, `searchMode: opensearch`
și cursor `search_after`. Pentru peste 10.000 de rezultate, `totalRelation:gte`
indică o limită inferioară, nu un total exact, pentru a evita numărări
costisitoare la scară mare. `GET /api/search/advanced`, autocomplete și
alte căi rămân în continuare pe implementarea actuală SQLite; migrarea lor
necesită o etapă distinctă.

Un cluster indisponibil **nu provoacă fallback tăcut la SQLite** atunci când
OpenSearch este selectat explicit, deoarece aceasta ar masca pierderea de
acoperire și ar face rezultatele greu de verificat.

## 5. Revenire imediată (rollback)

Setează înapoi:

```dotenv
ANIMAXIA_SEARCH_BACKEND=sqlite
ANIMAXIA_OPENSEARCH_WORKER=false
```

Datele catalogului și indexul SQLite FTS5 nu sunt eliminate când folosești
OpenSearch. Poți opri clusterul de căutare fără să pierzi catalogul local.
Asigură un backup/retention plan pentru outbox înainte să elimini volumul.

## Validarea din CI

`tests/opensearch.test.mjs` verifică: restricțiile HTTPS/autentificare,
mappingul, construirea filtrului de căutare, cursorul legat de filtre,
trigger-ele insert/update/delete, proiecția fără URL-urile video,
procesarea Bulk NDJSON, succesul parțial și retry, precum și backfillul
limitat. Testul nu contactează un cluster OpenSearch real.

Referințe oficiale OpenSearch:
https://docs.opensearch.org/latest/api-reference/document-apis/bulk/
https://docs.opensearch.org/latest/query-dsl/full-text/multi-match/

## Probleme încă deschise

Nu există cluster de producție, replicare, backupuri testate, TLS validat
live, benchmark, autoscaling, cache distribuit, migrare Postgres, leasing de
worker, migrarea completă a celorlalte căi de căutare sau demonstrarea
suportului pentru 1.000.000.000 de titluri. Capacitatea reală și latența
la scară globală **nu au fost încă măsurate**.
