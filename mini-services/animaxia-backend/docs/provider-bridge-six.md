# Animaxia — API connector bridge (Stage 8, 20 October 2026)

## What was actually delivered

- The existing `Animaxia_Universal_Metadata_Search_v2.zip` package provides
  **88 TypeScript API adapters**, previously delivered as a separate archive.
- This GitHub PR now includes an **88-ID inventory**, grouped as films,
  anime, music, news, sports, gaming, entertainment and culture.
  These 88 inventory entries are **not** 88 installed, configured or verified
  live services.
- **Six server-side JSON connectors are implemented in this PR**:
  `tmdb`, `jikan`, `tvmaze`, `itunes`, `cheapshark`, `gdelt`.
  The other 82 remain catalog-only in the Express backend.
- All six use hardcoded public HTTPS provider origins, GET-only requests,
  a 12-second timeout, disabled redirects and a streaming JSON response
  cap of 1 MB. Up to 25 metadata items are normalized per request.
- Results are passed to the existing durable SQLite ingestion queue. No
  playable video is downloaded or rights automatically granted.

## Before first use

Configure a trusted administrator account, a persistent SQLite volume and
the protected JSON metadata worker (see durable-metadata-sync.md).
Run exactly one SQLite worker replica. Never commit secrets to Git.

Only TMDB requires a key among these six:

```dotenv
TMDBAPIKEY=<server-side-key>
# or TMDB_API_KEY=<server-side-key>
ANIMAXIA_METADATA_QUEUE_WORKER=true
```

Using a bearer token belonging to an administrator, install a JSON manifest
for the provider. Example using Jikan, which does not require an API key:

```http
POST /api/integrations/sources
Authorization: Bearer <admin-token>
Content-Type: application/json

{"source":{"type":"api","id":"jikan"},"name":"Jikan","version":"1",
 "protocol":"json-push-v1","categories":["anime"]}
```

Keep the source credential returned at install time in a secret manager,
even if using only server-side fetches. New sources are **disabled**.

```http
PATCH /api/integrations/sources/api/jikan
Authorization: Bearer <admin-token>
Content-Type: application/json

{"enabled":true}
```

## Actual JSON fetch → durable queue

```http
POST /api/integrations/providers/jikan/sync
Authorization: Bearer <admin-token>
Content-Type: application/json

{"q":"Naruto","page":1}
```

A successful provider JSON response with supported metadata returns HTTP 202
and a persistent `jobId`, or HTTP 200 for an already-queued identical batch.
A response with zero mapped metadata returns HTTP 200 with `fetched:0`;
it is not a database import. A job in `queued` state has **not** been
persisted to the media library until the worker processes it.

Read job status at `GET /api/ingest/metadata/jobs/:id`, then query the
catalog via `/api/search/advanced` or `/api/search/metadata`.

### Provider-specific behavior

| Provider | Main metadata | Search q required? | Credential |
|---|---|---|---|
| TMDB | Films and TV | No (trending fallback) | TMDBAPIKEY or TMDB_API_KEY |
| Jikan | Anime | No (top anime fallback) | Public |
| TVmaze | Series | No (browse fallback) | Public |
| iTunes | Music | Yes, at least 2 characters | Public |
| CheapShark | Games | Yes, at least 2 characters | Public |
| GDELT | News | Yes, at least 2 characters | Public |

Requests for catalog-only providers receive HTTP 501. Unknown IDs receive
HTTP 404. Installed-but-disabled providers receive HTTP 409. Missing
credentials receive HTTP 503. Only admin users can invoke these routes;
scoped addon push keys cannot fetch arbitrary upstream APIs.

## Registry status and observability

`GET /api/integrations/providers` returns `catalogCount:88`,
`implementedDrivers:6`, a nonsecret list of missing credential names,
source installation/activation flags and recorded fetch attempts.

`fetchHealth.lastStatus` is `never-checked`, `success`, or `error`,
based on **actual attempted provider HTTP requests**. The UI displays
the last request and timestamp. `liveVerified` means one successful
request within the last 24 hours and is not an uptime guarantee.

The admin UI offers the six configurable connectors in the **Addonuri** tab,
plus the existing JSON addon registry. A manual `sync` action performs
an upstream GET, then queues normalized JSON.

## Safety, reliability and limits

- Upstream calls are fixed-origin, not arbitrary URLs. Redirects are denied,
  responses must be JSON and are limited to 1 MB / 12 seconds. Credentials
  remain server-side. HTML pages, executable addons, hidden embedded video
  links, bypassing DRM, and scraping blocked sites are not supported.
- Responses and metadata may be subject to API terms, quotas, licensing and
  copyright. The platform operator must check allowed usage.
- No real-world provider availability has been tested in CI: HTTP
  provider responses are mocked. **Do not mark these six as active on a real
  deployment** until credentials and actual calls are verified.
- Errors in the remote fetch phase return to the admin caller and update
  health status; the persistent retry queue only begins *after* a successful
  JSON fetch. Automatic HTTP polling of these six connectors is not yet
  implemented. Existing automatic miner scheduling is a separate TMDB/Jikan
  pipeline and uses different legacy providers.
- Current SQLite queue, FTS5 index and registry are **single-node only**,
  with no distributed locks, autoscaling, replication or billion-record
  throughput benchmark. Full integration of the 88 TypeScript adapters
  remains a separate workstream.
