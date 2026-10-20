# Animaxia — JSON metadata imports (Stage 4)

This endpoint accepts normalized JSON pushed by configured API, hub or addon
integrations. **It does not crawl external websites, auto-install addons, or
automatically call all 88 API adapters.** It uses the current SQLite catalog and
is intended as a validated migration step before distributed ingestion.

## Endpoint

`POST /api/ingest/metadata` on the Express backend, default port 4000.

Headers:

```http
Authorization: Bearer <admin access token>
Content-Type: application/json
```

Body example:

```json
{
  "source": { "type": "addon", "id": "torentino" },
  "items": [
    {
      "id": "film-1001",
      "title": "Example Film",
      "category": "filme",
      "year": 2024,
      "actors": ["Actor 1", "Actor 2"],
      "genres": ["Adventure", "Fantasy"],
      "studios": ["Studio A"],
      "franchise": "Example Universe",
      "trilogy": "Example Trilogy",
      "collection": "Example Collection",
      "posterId": "poster-1001",
      "thumbnail": "https://example.org/poster.jpg",
      "description": "Example description",
      "rating": 8.2,
      "sources": [
        { "url": "https://example.org/media/video.m3u8", "type": "m3u8" }
      ]
    }
  ]
}
```

An authenticated admin client can use:

```bash
curl -fsS -X POST "http://127.0.0.1:4000/api/ingest/metadata" \
  -H "Authorization: Bearer ${ANIMAXIA_ADMIN_TOKEN}" \
  -H "Content-Type: application/json" \
  --data @metadata.json
```

Each request handles **1–100 items**. Server JSON body limit is 2MB. Items
require a stable provider ID, title and category. Supported provider types:
`api`, `hub`, `addon`. Provider name must be a slug (`tmdb`,
`torentino`, etc.). The stable ID is constructed as
`<provider-type>:<provider-name>:<canonical-category>:<item-id>`.
Submitting an existing ID updates that document; omitted optional fields
remain untouched. Invalid items are reported in `errors` without silently
aborting the entire batch. Invalid media URLs (JavaScript, data URLs, local
files and URL credentials) are excluded.

The response reports `accepted`, `created`, `updated`, `rejected` and
`data` with item IDs. `indexed: "scheduled"` means a local index event was
emitted; it **does not assert completion of a remote index update**.

## Categories

The existing search normalizer accepts the 13 requested Romanian categories:

- Filme → `movie`
- Seriale → `tv`
- Desene animate → `cartoon`
- Muzică → `music`
- Sport → `sports`
- Documentare → `documentary`
- Gaming → `gaming`
- Știri → `news` (ASCII input `stiri`)
- Entertainment → `entertainment`
- Showbiz → `showbiz`
- Divertisment → `entertainment`
- Telenovele → `telenovela`
- Animeuri → `anime`

Note: entertainment and divertisment use the same canonical type. Add alias
normalization for accented category spellings where needed.

## Search examples

```text
GET /api/search/metadata?category=filme&year=2024&actor=Actor%201
GET /api/search/advanced?q=Example&genre=Fantasy&studio=Studio%20A&franchise=Example%20Universe
GET /api/search/filters
```

## Operational limits and next production steps

- SQLite is single-node, lacks multi-tenant isolation for a global library,
  and is **not tested for one billion titles**.
- Imports require an administrator; addon programs should use a tightly
  scoped service credential rather than sharing an admin user's token.
  A dedicated service token/scope layer is still **not implemented**.
- There is no automatic upstream synchronization, scheduling, provider
  availability tracking or durable job queue for this route.
- Provider copyright/licensing and playback authorization must be checked
  separately. Metadata ingestion never grants rights to stream a title.
- Migration to Postgres with a distributed search index, normalized source
  identity, incremental queues, and operational retries remains required for
  large scale.
- **Never place API keys, secrets or admin bearer tokens in the repository.**
