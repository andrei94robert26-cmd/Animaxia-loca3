# Animaxia: 22 API JSON bridges (stage 11)

Branch: `fix/p0-auth-miner-player-metadata-20261020`

## Verified implementation scope

The Express API catalog contains **88 provider identities**. Of those,
**22 fixed-host JSON metadata drivers are implemented** and **66 remain
catalog entries only**. All are disabled/uninstalled until an administrator
creates and enables a JSON-only provider manifest. Production reachability
and account-level licensing are **not verified** by CI.

The new five:

| ID | Endpoint type | Metadata stored | Query behavior |
|---|---|---|---|
| `deezer` | `https://api.deezer.com/search` | Music tracks, artist, album, artwork | Requires `q` >=2 characters; page 1–10 |
| `radiobrowser` | `https://de1.api.radio-browser.info/json/stations/search` | Radio station names, genre tags, provenance | Requires `q` >=2 characters; page 1–10 |
| `hackernews` | `https://hn.algolia.com/api/v1/search` | Community-submitted technology news, original URLs | Requires `q` >=2 characters; page 1–10 |
| `openf1` | `https://api.openf1.org/v1/meetings` | Current-year F1 race meetings, tracks | Browse only, page 1 |
| `nhl` | `https://api-web.nhle.com/v1/schedule/YYYY-MM-DD` | Current date NHL schedules and teams | Browse only, page 1 |

These items are catalog metadata, not actual playable streams, sports
broadcasts, radio/audio proxies, or verified news reports. The underlying
providers can have separate terms, quotas and attribution obligations.
No unknown provider URLs are fetched: each connector uses a fixed HTTPS host,
GET-only, no redirects, a request timeout (12 sec), a bounded response
(1 MB JSON) and at most 25 mapped items per request.

## Activation example

After a verified server deployment and database backup:

1. With a backend admin Bearer token:
   `POST /api/integrations/sources` with
   `{"source":{"type":"api","id":"openf1"},"name":"OpenF1","protocol":"json-push-v1"}`.
2. Enable: `PATCH /api/integrations/sources/api/openf1` with
   `{"enabled":true}`.
3. Activate the single-host JSON queue worker with
   `ANIMAXIA_METADATA_QUEUE_WORKER=true`.
4. Request metadata:
   `POST /api/integrations/providers/openf1/sync` with
   `{"q":"","page":1}`.
5. Inspect the returned job ID at
   `GET /api/ingest/metadata/jobs/{id}`, then search the content library.

For an API with search, such as Deezer, provide a term:
`{"q":"jazz","page":1}`.
A 202 response means **queued**, not indexed or playable.

## Optional, carefully bounded polling

With the queue worker enabled and each provider installed/activated:

```dotenv
ANIMAXIA_PROVIDER_AUTO_SYNC_ENABLED=true
ANIMAXIA_PROVIDER_AUTO_SYNC_PROVIDERS=openf1,nhl,deezer,radiobrowser,hackernews
ANIMAXIA_PROVIDER_AUTO_SYNC_MINUTES=180
ANIMAXIA_PROVIDER_AUTO_SYNC_QUERIES_JSON={"deezer":"jazz","radiobrowser":"rock","hackernews":"AI"}
```

These are examples only. Nothing is enabled remotely by this PR.
Browse-only providers reject `q`; search-only providers require it.
Scheduler skips incompatible configurations before attempting HTTP.
Polling runs one provider at a time per minute, with persisted cooldown.

### Provider references

- Deezer developer API: https://developers.deezer.com/api/search
- Radio Browser API: https://docs.radio-browser.info
- HN Algolia API: https://hn.algolia.com/api
- OpenF1 API: https://openf1.org/docs/
- NHL schedule endpoints: https://github.com/Zmalski/NHL-API-Reference

Check these upstream rules before commercial or public launch. Some APIs
change availability, require registration, or restrict redistribution.

## Tests and outstanding constraints

`tests/provider-catalog.test.mjs` covers all 22 drivers with mock JSON.
`tests/expansion-providers.test.mjs` validates fixed URLs, pagination,
query/browse guards, metadata shapes and absence of invented playback URLs.
CI never supplies live API credentials and **does not verify network access**.

The catalog/FTS5 index, queue and autosync scheduler remain single-host SQLite
and have not been benchmarked for one billion content items or many millions
of simultaneous users. The separate, previously delivered 88-adapter archive
is not installed automatically by this PR. This work does not merge into main
or activate a production server.
