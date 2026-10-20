# Animaxia — Durable metadata sync (stage 5)

Implemented in the Express backend, currently **SQLite single-node only**.

## Two separate persistent pipelines

1. **JSON batch ingestion** from a configured hub, API or addon:
   `POST /api/ingest/metadata/queue`. The submitted JSON is persisted in
   `metadata_sync_jobs` before returning HTTP 202. A valid admin Bearer
   token OR a scoped `X-Animaxia-Ingest-Key` can enqueue, and service-key
   requests must match `ANIMAXIA_INGEST_ALLOWED_SOURCES`. It never fetches
   arbitrary remote URLs or automatically installs addon code.
2. **TMDB/Jikan fetch jobs**: the existing persistent `miner_jobs` table is
   reused, with optional scheduling through
   `ANIMAXIA_AUTO_SYNC_ENABLED=true`. Only the two built-in provider fetchers
   are supported by this scheduler. `tmdb` requires `TMDBAPIKEY`.

## Safe activation

By default, **both workers are disabled**. Back up the SQLite file and verify
the deployment uses exactly one backend instance before enabling:

```dotenv
ANIMAXIA_METADATA_QUEUE_WORKER=true
ANIMAXIA_METADATA_QUEUE_INTERVAL_MS=5000
ANIMAXIA_METADATA_QUEUE_CAP=2000
ANIMAXIA_AUTO_SYNC_ENABLED=true
ANIMAXIA_AUTO_SYNC_PROVIDERS=tmdb,jikan
ANIMAXIA_AUTO_SYNC_MINUTES=180
ANIMAXIA_INGEST_SERVICE_KEY=<long-random-secret>
ANIMAXIA_INGEST_ALLOWED_SOURCES=addon:torentino,api:tmdb,hub:internal
TMDBAPIKEY=<private-provider-key>
```

`ANIMAXIA_AUTO_SYNC_MINUTES` is limited to 15–1440. A scheduler tick checks
the persistent `miner_jobs` ledger and skips providers with recent or
in-flight jobs; it never bypasses their rate limits. The JSON worker handles
one due batch per tick and requeues interrupted `running` batches on boot.

### Queued import example

```http
POST /api/ingest/metadata/queue
Content-Type: application/json
X-Animaxia-Ingest-Key: <random-secret>

{
  "source": {"type":"addon","id":"torentino"},
  "idempotencyKey":"daily-2026-10-20-page-1",
  "items":[{"id":"episode-12","title":"Example episode","category":"seriale","year":2026}]
}
```

Response: HTTP 202 `status:queued` (or HTTP 200 when the idempotency key
has already been submitted for the same source). This does **not** mean that
the job has finished.

### Read queue status

The following endpoints require admin Bearer authentication (a service key
cannot read unrelated job states):

- `GET /api/ingest/metadata/jobs` (limit, sourceType, sourceId)
- `GET /api/ingest/metadata/jobs/:id`
- `GET /api/ingest/metadata/sources/status`
- `GET /api/miner/auto-sync` (only built-in TMDB/Jikan schedule status)

States: `queued`, `running`, `done`, `partial`, `failed`.
A queued job survives process restarts. Catastrophic processing errors retry
up to three attempts (5s, 10s, then exhausted); invalid individual records
are reported in `partial` or `failed` results rather than endlessly retried.

## Validation scope

Automated tests cover schema creation, HTTP auth, idempotency, processing,
per-provider status, restart recovery, and retry. Real multi-host failover,
provider credentials and licensing, distributed locking, storage at billion-
title scale, and playback on devices **are not verified**.

Important: `ANIMAXIA_AUTO_SYNC_ENABLED` only covers built-in TMDB and Jikan,
not 88 standalone adapters in a separate ZIP. Those adapters still need
explicit installation, provider configuration and end-to-end connection.
For production, migrate the queues to a distributed, lease-based worker
system (Postgres/Redis/SQS) before running multiple backend replicas.
