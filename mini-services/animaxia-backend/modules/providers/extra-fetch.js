/**
 * Additional fixed-host JSON media metadata adapters.
 * Do not execute external addon code, fetch arbitrary URLs, or stream media.
 * API upstream availability is verified separately from adapter unit tests.
 */
export const EXTRA_DRIVER_IDS = Object.freeze([
  'omdb', 'kitsu', 'rickmorty', 'freetogame', 'swapi', 'scryfall',
]);
const year = (value) => {
  if (value == null) return undefined;
  const match = String(value).match(/(?:^|[^0-9])((?:18|19|20|21)[0-9]{2})(?:[^0-9]|$)/);
  if (match) return Number(match[1]);
  const timestamp = Date.parse(String(value));
  return Number.isFinite(timestamp) ? new Date(timestamp).getUTCFullYear() : undefined;
};
const str = (v, max = 300) => typeof v === 'string' ? v.trim().slice(0,max) : '';
const list = (data) => Array.isArray(data) ? data : [];
const compact = (v) => v.filter((x) => x && x.id !== 'undefined' && x.id !== 'null' && x.id && x.title);
export function buildExtraProviderRequest(id, query, page, env = process.env) {
  const q = str(query, 120).trim();
  const n = Math.max(1, Math.min(10, Number.parseInt(page, 10) || 1));
  const url = (base, extra) => {
    const dest = new URL(base);
    for (const [name, value] of Object.entries(extra)) {
      if (value !== undefined && value !== null && value !== '') dest.searchParams.set(name,String(value));
    }
    return dest;
  };
  switch (id) {
    case 'omdb': {
      const key = env.OMDB_API_KEY || env.OMDBAPIKEY;
      if (!key) throw Object.assign(new Error('OMDb credentials not configured'), { status: 503 });
      if (q.length < 2) throw Object.assign(new Error('OMDb requires a title query (2+ characters)'), { status: 400 });
      return url('https://www.omdbapi.com/', { apikey: key, s: q, page: n, r: 'json' });
    }
    case 'kitsu':
      return url('https://kitsu.io/api/edge/anime',
        { ...(q ? { 'filter[text]': q } : {}), 'page[limit]': 20,
          'page[offset]': (n - 1) * 20 });
    case 'rickmorty':
      return url('https://rickandmortyapi.com/api/episode',
        { ...(q ? { name: q } : {}), page: n });
    case 'freetogame':
      // FreeToGame offers list/category endpoints, NOT arbitrary full-text search.
      // Browsing only, to avoid falsely representing an unsupported query.
      if (q) throw Object.assign(new Error('FreeToGame connector supports browsing; clear q'), { status: 400 });
      if (n !== 1) throw Object.assign(new Error('FreeToGame does not support pagination on /games'), { status: 400 });
      return url('https://www.freetogame.com/api/games', { 'sort-by': 'release-date' });
    case 'swapi':
      return url('https://swapi.dev/api/films/',
        { ...(q ? { search: q } : {}), page: n });
    case 'scryfall':
      if (q.length < 2) throw Object.assign(new Error('Scryfall requires a card query (2+ characters)'), { status: 400 });
      return url('https://api.scryfall.com/cards/search', { q, page: n });
    default:
      throw Object.assign(new Error('Unknown extra provider driver'), { status: 501 });
  }
}
export function mapExtraProviderItems(id, json) {
  let items;
  switch (id) {
    case 'omdb':
      if (json?.Response === 'False' && /invalid api key/i.test(String(json?.Error))) {
        throw Object.assign(new Error('OMDb rejected API key'), { status: 502 });
      }
      items = list(json?.Search).map((v) => ({
        id: String(v?.imdbID), title: str(v?.Title), category: v?.Type === 'series' ? 'seriale' : 'filme',
        year: year(v?.Year), thumbnail: v?.Poster && v.Poster !== 'N/A' ? v.Poster : undefined,
        posterId: v?.imdbID,
      }));
      break;
    case 'kitsu':
      items = list(json?.data).map((v) => {
        const a = v?.attributes || {};
        return { id: String(v?.id), title: str(a?.canonicalTitle || a?.titles?.en || a?.slug),
          category: 'anime', year: year(a?.startDate), description: str(a?.synopsis, 3000),
          rating: a?.averageRating != null ? Number(a.averageRating) / 10 : undefined,
          thumbnail: a?.posterImage?.medium || a?.posterImage?.small };
      });
      break;
    case 'rickmorty':
      items = list(json?.results).map((v) => ({
        id: String(v?.id), title: str(v?.name), category: 'desene animate',
        year: year(v?.air_date), franchise: 'Rick and Morty',
        collection: str(v?.episode), description: 'Rick and Morty episode ' + str(v?.episode),
      }));
      break;
    case 'freetogame':
      items = list(json).map((v) => ({
        id: String(v?.id), title: str(v?.title), category: 'gaming',
        year: year(v?.release_date), genres: v?.genre ? [str(v.genre,120)] : [],
        studios: v?.publisher ? [str(v.publisher,120)] : [],
        description: str(v?.short_description, 3000),
        thumbnail: v?.thumbnail, sourceAttribution: 'FreeToGame.com',
        sourceUrl: typeof v?.game_url === 'string' && v.game_url.startsWith('https://www.freetogame.com/')
          ? v.game_url : 'https://www.freetogame.com/', 
      }));
      break;
    case 'swapi':
      items = list(json?.results).map((v) => ({
        id: String(v?.episode_id),
        title: str(v?.title), category: 'filme',
        year: year(v?.release_date), franchise: 'Star Wars',
        description: str(v?.opening_crawl, 3000), studios: v?.producer ? [str(v.producer,120)] : [],
      }));
      break;
    case 'scryfall':
      items = list(json?.data).map((v) => ({
        id: String(v?.id), title: str(v?.name), category: 'gaming',
        year: year(v?.released_at), collection: str(v?.set_name),
        genres: v?.type_line ? [str(v.type_line,120)] : [],
        description: str(v?.oracle_text, 3000),
        thumbnail: v?.image_uris?.normal || v?.card_faces?.[0]?.image_uris?.normal,
      }));
      break;
    default: return [];
  }
  return compact(items).slice(0,25);
}
