/**
 * Provider catalog derived from the 88-item Animaxia API integration pack
 * delivered 2026-10-20. Catalog ≠ active connector.
 * Only IDs with real 'driverImplemented' support are fetchable here.
 */
import { getSourceRecord } from '../ingest/source-registry.js';
import { getProviderFetchHealth } from './health.js';
import { EXTRA_DRIVER_IDS } from './extra-fetch.js';
import { COMMUNITY_DRIVER_IDS } from './community-fetch.js';

const IDS_BY_GROUP = {
  "films": "tmdb omdb tvmaze thetvdb trakt watchmode opensubtitles swapi archive loc",
  "anime": "jikan anilist kitsu animechan waifu nekosbest catboys ghibli rickmorty mangadex",
  "music": "musicbrainz deezer itunes radiobrowser lyricsovh listenbrainz audius lastfm spotify jamendo soundcloud",
  "news": "gdelt hackernews reddit bbcrss cnnrss nhkrss aljazeerarss publicrss newsapi gnews nyt",
  "sports": "espn thesportsdb openligadb jolpica openf1 balldontlie footballdata lichess chesscom mlb nhl apifootball sportmonks",
  "gaming": "pokeapi scryfall opendota steamstore minecraft freetogame cheapshark steam rawg igdb riot",
  "entertainment": "opentrivia chucknorris jokeapi bored quotable randomfox shibe tvmazepeople",
  "culture": "wikipedia wikidata wiktionary openlibrary restcountries geodb openmeteo nasa giphy unsplash pexels europeana fanart openverse"
};
const ENV_BY_ID = {
  "tmdb": [
    "TMDB_API_KEY",
    "TMDBAPIKEY"
  ],
  "omdb": [
    "OMDB_API_KEY"
  ],
  "thetvdb": [
    "THE_TVDB_API_KEY"
  ],
  "trakt": [
    "TRAKT_CLIENT_ID"
  ],
  "watchmode": [
    "WATCHMODE_API_KEY"
  ],
  "opensubtitles": [
    "OPENSUBTITLES_API_KEY"
  ],
  "lastfm": [
    "LASTFM_API_KEY"
  ],
  "spotify": [
    "SPOTIFY_CLIENT_ID",
    "SPOTIFY_CLIENT_SECRET"
  ],
  "jamendo": [
    "JAMENDO_CLIENT_ID"
  ],
  "soundcloud": [
    "SOUNDCLOUD_CLIENT_ID",
    "SOUNDCLOUD_CLIENT_SECRET"
  ],
  "newsapi": [
    "NEWSAPI_KEY"
  ],
  "gnews": [
    "GNEWS_API_KEY"
  ],
  "nyt": [
    "NYT_API_KEY"
  ],
  "balldontlie": [
    "BALLDONTLIE_API_KEY"
  ],
  "footballdata": [
    "FOOTBALL_DATA_API_KEY"
  ],
  "apifootball": [
    "API_FOOTBALL_KEY"
  ],
  "sportmonks": [
    "SPORTMONKS_API_KEY"
  ],
  "steam": [
    "STEAM_API_KEY"
  ],
  "rawg": [
    "RAWG_API_KEY"
  ],
  "igdb": [
    "IGDB_CLIENT_ID",
    "IGDB_CLIENT_SECRET"
  ],
  "riot": [
    "RIOT_API_KEY"
  ],
  "geodb": [
    "GEODB_API_KEY"
  ],
  "nasa": [
    "NASA_API_KEY"
  ],
  "giphy": [
    "GIPHY_API_KEY"
  ],
  "unsplash": [
    "UNSPLASH_ACCESS_KEY"
  ],
  "pexels": [
    "PEXELS_API_KEY"
  ],
  "europeana": [
    "EUROPEANA_API_KEY"
  ],
  "fanart": [
    "FANART_API_KEY"
  ]
};
export const DRIVER_IDS = Object.freeze(['tmdb','jikan','tvmaze','itunes','cheapshark','gdelt',...EXTRA_DRIVER_IDS,...COMMUNITY_DRIVER_IDS]);

const items = Object.entries(IDS_BY_GROUP).flatMap(([category, names]) =>
  names.split(' ').map((id) => ({
    id, category, requiredEnv: ENV_BY_ID[id] || [],
    driverImplemented: DRIVER_IDS.includes(id),
  }))
);
if (items.length !== 88 || new Set(items.map((x) => x.id)).size !== 88) {
  throw new Error('Invalid 88-provider catalog manifest');
}
export const PROVIDER_CATALOG = Object.freeze(items.map((x) => Object.freeze(x)));
export function getProviderDefinition(id) {
  return PROVIDER_CATALOG.find((x) => x.id === String(id || '').toLowerCase()) || null;
}
export function providerReadiness(entry) {
  const provider = typeof entry === 'string' ? getProviderDefinition(entry) : entry;
  if (!provider) return null;
  const source = getSourceRecord({ type: 'api', id: provider.id });
  const requirements = provider.id === 'tmdb' ? [['TMDB_API_KEY','TMDBAPIKEY']]
    : provider.id === 'omdb' ? [['OMDB_API_KEY','OMDBAPIKEY']]
    : provider.requiredEnv.map((key) => [key]);
  const credentialsPresent = requirements.every((choice) => choice.some((key) =>
    typeof process.env[key] === 'string' && process.env[key].length > 0));
  const enabled = Boolean(source && Number(source.enabled) === 1);
  const fetchHealth = getProviderFetchHealth(provider.id);
  return {
    ...provider,
    installed: Boolean(source),
    enabled,
    credentialsPresent,
    readyForSync: provider.driverImplemented && enabled && credentialsPresent,
    // Live availability requires a successful actual network call, never guessed.
    // Last HTTP attempt is evidence of one fetch, not a live uptime SLA.
    liveVerified: fetchHealth.lastStatus === 'success'
      && Date.now() - Date.parse(fetchHealth.lastAttemptAt || '') < 86_400_000,
    fetchHealth,
  };
}
