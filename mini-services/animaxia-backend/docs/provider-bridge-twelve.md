# Animaxia — 12 fixed-host JSON provider drivers + scheduled synchronization

**Date:** 20 October 2026  
**State:** code and mocked integration tests in Pull Request #1; **not deployed**.

## Catalog and implemented connectors

There are 88 provider identities in the inventory. This stage implements 12
specific server-side fixed-host JSON drivers (not 88 active services):

| Provider | Category imported | Supports `q` | Credentials | Upstream |
|---|---|---|---|---|
| TMDB | Films, TV | Optional | `TMDBAPIKEY` or `TMDB_API_KEY` | https://developer.themoviedb.org |
| Jikan | Anime | Optional | Public | https://docs.api.jikan.moe |
| TVmaze | Series | Optional | Public | https://www.tvmaze.com/api |
| iTunes | Music | Required | Public | https://performance-partners.apple.com/search-api |
| CheapShark | Gaming metadata | Required | Public | https://www.cheapshark.com/api |
| GDELT | News | Required | Public | https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/ |
| OMDb | Films and series | Required | `OMDB_API_KEY` or `OMDBAPIKEY` | https://www.omdbapi.com/ |
| Kitsu | Anime | Optional | Public | https://kitsu.io/api/edge/anime |
| Rick & Morty API | Cartoon episodes | Optional | Public | https://rickandmortyapi.com/documentation |
| FreeToGame | Game metadata | **Browse only** | Public | https://www.freetogame.com/api-doc |
| SWAPI | Star Wars films | Optional | Public | https://swapi.dev/documentation |
| Scryfall | Trading-card game metadata | Required | Public | https://scryfall.com/docs/api |

Game metadata and trading cards are catalog entries; they are **not**
playable game packages or video streams. Rick and Morty records represent
episode metadata, not licensed episode streams. No DRM bypass or arbitrary
external script execution is present.

### Operator activation

After deploying the PR, configure `AUTHSECRET`, SMTP as needed, and a
permanent SQLite volume. With an authenticated administrator:

1. `POST /api/integrations/sources`: register a JSON-only source manifest,
   e.g. `{"source":{"type":"api","id":"kitsu"},"name":"Kitsu","protocol":"json-push-v1"}`.
2. `PATCH /api/integrations/sources/api/kitsu` with `{"enabled":true}`.
3. `POST /api/integrations/providers/kitsu/sync` with
   `{"q":"naruto","page":1}`. This fetches up to 25 normalized records
   and **enqueues** them (HTTP 202), not an immediate library insert.
4. Enable `ANIMAXIA_METADATA_QUEUE_WORKER=true` to process the durable queue.
5. `GET /api/ingest/metadata/jobs/:id` to inspect completion.
   Then `GET /api/search/advanced?q=...` for local indexed results.

`GET /api/integrations/providers` exposes implemented driver counts,
provider configuration readiness and the last **real HTTP** attempt status.
The response never exposes API keys. The `Addonuri` tab uses the same routes.

### Optional periodic polling (new)

All polling is disabled by default. Activate only on **one SQLite backend
instance** after creating backups, registering/activating the source and
enabling the metadata worker:

```dotenv
ANIMAXIA_METADATA_QUEUE_WORKER=true
ANIMAXIA_PROVIDER_AUTO_SYNC_ENABLED=true
ANIMAXIA_PROVIDER_AUTO_SYNC_PROVIDERS=kitsu,tvmaze,rickmorty,swapi,freetogame
ANIMAXIA_PROVIDER_AUTO_SYNC_MINUTES=180
ANIMAXIA_PROVIDER_AUTO_SYNC_QUERIES_JSON={}
```

The scheduler wakes every minute, processes **at most one provider per tick**,
respects a minimum 15-minute interval per source, persists the next poll in
SQLite `provider_poll_state`, and uses a backoff on failures. This prevents
flooding public providers and accidentally scheduling uninstalled sources.

Sources that only have a search endpoint (`omdb`, `itunes`,
`cheapshark`, `gdelt`, `scryfall`) need an explicit query, e.g.:

```dotenv
ANIMAXIA_PROVIDER_AUTO_SYNC_PROVIDERS=omdb,scryfall,itunes
ANIMAXIA_PROVIDER_AUTO_SYNC_QUERIES_JSON={"omdb":"Star Wars","scryfall":"Sol Ring","itunes":"jazz"}
```

The FreeToGame upstream offers a list endpoint rather than generic full-text
search; this bridge imports up to 25 browse results and refuses `q` in
backend requests. The admin UI automatically sends an empty query for it.

`GET /api/integrations/providers/auto-sync/status` returns the single-node
scheduler state and durable per-provider attempt/failure ledger.
Provider scheduler uses a separate pipeline from the legacy TMDB/Jikan
`miner_jobs` scheduler. Avoid enabling both pipelines for identical sources
without explicitly accepting duplicate provider traffic.

### Permissions, limitations and rights

- **Do not treat this as 12 verified live production APIs.** CI tests use
  mocked JSON payloads to validate parsing, timeouts, body limits, fixed
  domains, persistent queueing, cooldown, and ingestion/search integration.
  Live provider availability requires actual configured requests.
- Upstream license, API terms and quotas must be reviewed individually.
  OMDb's licensing and image use need appropriate rights and API access.
  FreeToGame requires source attribution and a link to FreeToGame.com;
  normalized metadata includes `sourceAttribution` and `sourceUrl`,
  but production user-visible attribution still needs validation.
  Scryfall asks clients to respect API rate limits and identify traffic.
- The 76 catalog-only providers remain unimplemented in this backend.
  The standalone 88 TypeScript-adapter ZIP has **not** been merged into
  the repository. No claims of production-ready global scale.
- The SQLite catalog, queue and auto-sync ledger support **one worker host**;
  there is no Redis/Postgres distributed leasing or proven 1B-title capacity.
- Don't commit credentials. Rotate any previously leaked values.
- Auto-polling does not fetch media files, execute remote JS or resolve
  external embedded playback sources.
