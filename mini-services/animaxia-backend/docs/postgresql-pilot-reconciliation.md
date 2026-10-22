# Animaxia — Etapa 20: reconciliere în ambele direcții pentru proiecția PostgreSQL

**Status:** pilot administrativ opțional, fără activare în producție,
fără merge în `main`. Nu comută biblioteca Animaxia de pe SQLite.

## De ce este necesară

Etapa 19 sincronizează evenimente native PostgreSQL din
`animaxia_pilot_catalog` către indexul secundar
`animaxia_pilot_search_projection`. Un contor de evenimente procesate
nu garantează că documentele sunt identice. În caz de operații administrative,
restaurare de backup sau o problemă istorică, indexul poate conține
înregistrări lipsă, vechi sau orfane.

Acest modul verifică **document cu document**, în loturi limitate, din ambele
perspective. Pentru reparare **nu rescrie direct indexul**, ci emite
evenimente durabile în `animaxia_pilot_events`; proiectorul din etapa 19
recitește starea curentă înainte să aplice UPSERT/DELETE.

## Precondiții

- PostgreSQL accesibil prin conexiunea securizată existentă;
- `ANIMAXIA_PG_CATALOG_PILOT=true`;
- `ANIMAXIA_PG_PILOT_PROJECTION=true`;
- ambele scheme pilot inițializate prin rutele explicite de setup;
- backupuri verificate; utilizatorul API are rol de administrator.

Nu modifica `ANIMAXIA_SEARCH_BACKEND`, datele SQLite și nici playerul.

## Verificare pe catalogul autoritativ al pilotului

```http
POST /api/migration/postgres/pilot/projection/reconcile
Authorization: Bearer <admin-jwt>
Content-Type: application/json

{"scope":"catalog","afterId":0,"limit":25,"dryRun":true}
```

Interoghează primele 25 de rânduri native, ordonate după `id`.
Compară identitatea, titlul, categoria, anul, posterul, JSONB și revizia
împotriva indexului secundar. Numără `matched`, `missing`,
`mismatched`, `repairCandidates`. `nextAfterId` este cursorul
paginii următoare, dacă există.

Implicit `dryRun:true` nu schimbă nimic. Pentru a programa repararea:

```json
{"scope":"catalog","afterId":0,"limit":25,"dryRun":false}
```

`repairQueued` reprezintă doar evenimentele nou-introduse.
O înregistrare deja cu eveniment în așteptare nu primește o copie
inutilă a evenimentului; interogările folosesc parametrizare PostgreSQL.
Proiectorul citește ultima versiune, nu o versiune veche din raport.

## Verificarea documentelor orfane din proiecție

```json
{"scope":"orphans","afterExternalId":"","limit":25,"dryRun":true}
```

Se parcurg în ordine alfabetică ID-urile externe ale documentelor din
indexul secundar și se verifică dacă există în catalogul nativ. Un
document fără corespondent este `orphaned`. Pentru pagina următoare
folosește `nextAfterExternalId`.

Cu `dryRun:false` sistemul programează evenimente de tip `delete`
numai dacă documentul există încă în proiecție **și nu** a reapărut în
catalog la momentul inserării evenimentului. Dacă între timp a reapărut,
proiectorul folosește starea actuală și îl recreează corect.

## Interfață

În **Admin → PostgreSQL → Audit de integritate — proiecție pilot** există
două moduri: „Lipsă sau învechite” și „Orfane în index”. Operatorul
poate verifica lotul de 25 fără modificări, naviga la pagina următoare
sau confirma explicit adăugarea evenimentelor de reparare.

## Limite și siguranță

- Maximum 50 de documente verificate per cerere.
- Nu există snapshot global între pagini în timpul scrierilor concurente.
- Un scan nu este dovada că întregul index este consistent.
- Verificarea se referă strict la catalogul PG **pilot**, nu la catalogul
  principal SQLite, OpenSearch sau videoclipuri.
- Reparațiile concurente pot adăuga ocazional evenimente redundante, deși
  proiectorul este idempotent față de starea curentă. Nu există unicitate
  strictă pentru „un eveniment pending per externalid”.
- Ștergerea documentelor din indexul pilot nu afectează datele media.
- Fără test de încărcare la miliard de titluri, cluster HA sau deployment.

Indexul PostgreSQL parțial
`idx_animaxia_pilot_projection_pending_external` accelerează
verificările pentru evenimente deja în așteptare.

## Testare CI

`tests/pg-pilot-reconciliation.test.mjs` verifică validările, SQL
parametrizat, accesul anonim respins, izolarea modului `dryRun` și
limitele paginării.

`tests/pg-pilot-reconciliation-live.test.mjs` folosește PostgreSQL 16
real într-un container temporar și testează titluri lipsă, rânduri
modificate intenționat, repararea prin jurnal, joburi deja în așteptare,
pagini succesive, orfane și reapariția unui titlu înaintea reparației.

**Rollback:** dezactivează `ANIMAXIA_PG_PILOT_PROJECTION` sau oprește
workerul prin `ANIMAXIA_PG_PILOT_PROJECTION_WORKER=false` și inspectează
evenimentele restante înainte de altă migrare. Nu șterge tabelele sau
jurnalul fără backup verificat.
