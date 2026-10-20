# Animaxia — Registru de addonuri JSON (etapa 6)

Acest registru instalează și activează **surse de metadate JSON**, nu
pachete executabile din internet. Poate primi metadate de la addonuri,
huburi sau API-uri ce folosesc protocolul `json-push-v1`. Nu execută
JavaScript nesigur, nu descarcă automat filme și nu ocolește protecția DRM.

## 1. Instalează un manifest JSON

`POST /api/integrations/sources` — necesită Bearer token de administrator:

```json
{
  "source": { "type": "addon", "id": "torentino" },
  "name": "Torentino Metadata",
  "description": "Catalog metadata sent by an independently configured addon",
  "version": "1.0",
  "protocol": "json-push-v1",
  "categories": ["filme", "seriale", "anime"]
}
```

La instalare, sursa are `enabled:false`. Răspunsul conține o
`credential` aleatoare **o singură dată**. Baza SQLite stochează doar
hash-ul cheii. Salvează cheia în secret manager și NU o include în
interfață, în localStorage ori în codul frontend.

## 2. Activează sursa

`PATCH /api/integrations/sources/addon/torentino` cu un Bearer admin și:

```json
{"enabled": true}
```

Un addon instalat, dar dezactivat, nu poate trimite metadate, indiferent
dacă folosește tokenul propriu sau tokenul de administrator.

## 3. Trimite metadate în coada persistentă

`POST /api/ingest/metadata/queue`

```http
X-Animaxia-Ingest-Key: <credential-returned-at-install>
Content-Type: application/json
```

```json
{
  "source": { "type": "addon", "id": "torentino" },
  "idempotencyKey": "2026-10-20-page-1",
  "items": [
    {
      "id": "film-1001", "title": "Sample Film", "category": "filme",
      "year": 2024, "genres": ["Action"], "actors": ["Example actor"]
    }
  ]
}
```

Pentru aceeași `idempotencyKey`, retransmiterea aceluiași conținut este
idempotentă; alt conținut cu aceeași cheie primește HTTP 409.

Dacă `ANIMAXIA_METADATA_QUEUE_WORKER=true` este configurat pe server,
workerul consumă joburile și actualizează catalogul. Dacă workerul este
oprit, cererile acceptate rămân în starea `queued` până la activare.

## 4. Verifică starea

Aceste rute sunt accesibile doar unui administrator:

- `GET /api/integrations/sources` — sursele instalate, fără chei.
- `GET /api/integrations/sources/addon/torentino` — starea și manifestul.
- `GET /api/ingest/metadata/sources/status` — statistici pe furnizor.
- `GET /api/ingest/metadata/jobs` — coada și rezultatele joburilor.

## 5. Rotește cheia sau dezactivează sursa

- `POST /api/integrations/sources/addon/torentino/rotate-key` —
  returnează o nouă cheie **o singură dată**, invalidând cheia veche.
- `PATCH /api/integrations/sources/addon/torentino` cu
  `{"enabled":false}` — blochează importurile noi și marchează ca
  eșuate joburile încă în așteptare. Nu șterge biblioteca.
  Un job deja în execuție nu este întrerupt la mijlocul scrierii.

## Ce NU este implementat încă

- Crawler sau polling HTTPS automat al URL-urilor externe de addon.
- Instalarea/rularea codului Stremio/JavaScript ori rezolvarea streamurilor.
- Sincronizarea completă a pachetului separat cu 88 de adaptoare API.
- Sistem distribuit multi-server, leasing/locks pe Redis/SQS sau PostgreSQL.
- Audit complet al surselor video, drepturi de difuzare și verificare playback.
- Migrarea acestui registru SQLite la un datastore distribuit pentru miliarde.

Registry-ul este un pas real, persistent și testat pentru integrare JSON,
nu o afirmație că toate addonurile sunt instalate sau că se poate reda orice
stream extern. Pentru producție verifică secretele, migrarea, backupul bazei
și testele CI înainte de merge/deploy.
