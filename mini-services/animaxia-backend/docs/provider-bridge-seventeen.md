# Animaxia — 17 API metadata connectors (stage 10)

Date: 20 October 2026. Branch: `fix/p0-auth-miner-player-metadata-20261020`.

## What is actually implemented

The Animaxia Express backend contains **17 server-side JSON metadata
drivers**, with 88 catalog identities in total. Exactly **71** catalog
providers have not yet received a fetch driver in this backend.

Previously implemented: TMDB, Jikan, TVmaze, iTunes, CheapShark, GDELT,
OMDb, Kitsu, Rick & Morty API, FreeToGame, SWAPI, Scryfall.

Five added in this stage:

| Driver | Metadata only | API endpoint | Search behavior |
|---|---|---|---|
| MusicBrainz | Music recordings, artist credits, first-release year | `https://musicbrainz.org/ws/2/recording/` | Search query >=2 chars, paginated |
| PokéAPI | Pokémon game universe/character names | `https://pokeapi.co/api/v2/pokemon/` | Browse only, 20/page |
| OpenLigaDB | Bundesliga fixtures for current season, 1–10 matchdays | `https://api.openligadb.de/getmatchdata/bl1/{season}/{round}` | Browse only |
| Jolpica | F1 race schedule (2026), circuit names | `https://api.jolpi.ca/ergast/f1/{year}.json` | Browse only, 25/page |
| OpenDota | Pro Dota 2 match/team metadata | `https://api.opendota.com/api/proMatches` | Browse only, first page |

These are *metadata* providers. PokéAPI records are not playable shows;
Dota matches are not streamed matches; fixtures are not sports video rights.

### How to enable

Deploy the branch only after backup and CI verification. In the admin
`Addonuri` panel:

1. Install a JSON provider source of type `api` with the matching ID.
2. Activate the provider. Keep its generated ingest key in a secret manager.
3. Set `ANIMAXIA_METADATA_QUEUE_WORKER=true` on the single SQLite worker.
4. Invoke `POST /api/integrations/providers/{id}/sync` (administrator Bearer).
5. Inspect the persistent job state, then query `/api/search/metadata`.

For MusicBrainz:
```json
{"q":"Queen","page":1}
```

For browse-only APIs:
```json
{"q":"","page":1}
```

For scheduled refresh (opt-in only):
```dotenv
ANIMAXIA_PROVIDER_AUTO_SYNC_ENABLED=true
ANIMAXIA_PROVIDER_AUTO_SYNC_PROVIDERS=musicbrainz,pokeapi,openligadb,jolpica,opendota
ANIMAXIA_PROVIDER_AUTO_SYNC_MINUTES=180
ANIMAXIA_PROVIDER_AUTO_SYNC_QUERIES_JSON={"musicbrainz":"Queen"}
ANIMAXIA_METADATA_QUEUE_WORKER=true
```

All sources require installed+enabled manifests, and not all APIs support
generic title search. Polling is limited to a single provider per minute,
with a minimum 15-minute interval and persisted cooldown.

### Limits and upstream requirements

- **MusicBrainz:** meaningful User-Agent; maximum ONE request/second
  **per application**. This backend reserves 1150ms between calls within
  its one Node process. Multiple replicas would require a shared limiter.
  The public service is intended for non-commercial use; check paid/commercial
  licensing before monetizing the platform. No recordings are downloaded.
  Official docs: https://musicbrainz.org/doc/MusicBrainz_API
- **OpenLigaDB:** no key required, 60 requests/min/IP and recommended
  low-volume polling. This bridge fetches only fixed Bundesliga
  matchdays 1–10 of the current season, **not** every team, league or
  matchweek. Docs: https://api.openligadb.de/index.html
- **Jolpica F1:** custom User-Agent, published burst/hourly rate limits;
  data usage may have licensing restrictions. Official repository:
  https://github.com/jolpica/jolpica-f1
- **PokéAPI:** paging is `limit`/`offset`, not full-text search.
  Docs: https://pokeapi.github.io/pokeapi.co/v2/
- **OpenDota:** uses public `GET /api/proMatches`; broader pagination
  requires `less_than_match_id`, not `page=2`.
  Docs: https://docs.opendota.com/

All five routes use fixed HTTPS hosts, GET only, reject HTTP redirects,
enforce 12-second request timeout, <=1 MB JSON body and <=25 mapped
metadata items. Upstream responses are simulated in automated tests:
**live access is not verified**. The existing durable queue and search are
single-node SQLite, **not** a billion-title distributed implementation.

No branch merge, production credentials, deployment or production activation
has been performed.
