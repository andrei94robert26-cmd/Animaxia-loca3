# Animaxia — SQLite FTS5 pentru căutarea metadatelor (etapa 7)

**Implementare reală în backend:** `mini-services/animaxia-backend/modules/search/content-fts.js`.

## Ce indexează

- Titlul din `Content.title`.
- JSON-ul persistent din `Content.metadata`: descriere, actori, genuri,
  studiouri, franciză, colecții și alte câmpuri.
- Indexul este creat odată cu migrarea SQLite și populat din conținutul deja
  existent la prima instalare.
- Trigger-ele SQL păstrează indexul sincronizat după inserări, actualizări
  și ștergeri realizate prin toate căile care scriu în `Content`.

## Căutare

- `GET /api/search/advanced?q=Galaxy&type=movie`
- `GET /api/search/metadata?q=cosmic&genre=Fantasy`
- `GET /api/search/status` raportează `fullTextIndex` și `extensions.fts5`.

Pentru un singur cuvânt fără punctuație, cu 3–64 caractere, backendul
folosește FTS5 `MATCH` și căutare cu prefix. Interogările complexe
folosesc fallbackul anterior `LIKE` pentru compatibilitate.

**Limita semantică:** FTS5 este bazat pe cuvinte/prefixe, nu pe potriviri
arbitrare în interiorul unui cuvânt. Nu există încă analiză lingvistică
avansată în română, fuzzy matching distribuit ori căutare semantică
validată ca funcțională.

## Repararea indexului

Realizează un backup și oprește aplicația sau scrierile înainte de reparare:

```bash
cd mini-services/animaxia-backend
node scripts/rebuild-content-fts.mjs --confirm
```

Această operațiune reconstruiește indexul și poate bloca procesul pe
biblioteci foarte mari. Nu este executată la fiecare pornire.

## Verificarea integrității

GitHub Actions rulează `tests/content-fts.test.mjs` și testul HTTP
`tests/metadata-search.test.mjs`. Acestea verifică:

- Inserarea unei înregistrări și căutarea după titlu, actor și descriere.
- Actualizarea metadatelor fără rezultate vechi.
- Ștergerea conținutului și eliminarea intrării din index.
- Protecția `MATCH` prin construirea expresiei FTS din text validat.
- Fallbackul LIKE pentru interogările cu semne speciale.

## Scalare și limite

Acesta este un index **SQLite local, într-o singură bază**, nu OpenSearch,
Elasticsearch ori un motor distribuit. Nu afirmăm că poate garanta
disponibilitate sau latență acceptabilă la un miliard de titluri.

Pentru scalare globală: catalog distribuit, partiționare, replicare,
indexare asincronă durabilă, monitorizare, failover, benchmarkuri și
audit al costurilor. Nu au fost încă implementate în această etapă.
