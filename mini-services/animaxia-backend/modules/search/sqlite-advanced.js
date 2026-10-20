/**
 * SQLite search executor using persisted content metadata, not simulated
 * PostgreSQL full-text or shard services.
 * Input fields and JSON paths are fixed; SQL values use bound parameters.
 */
import crypto from 'node:crypto';
import { rows, one } from '../platform/sql.js';

const META = "(CASE WHEN json_valid(c.metadata) THEN c.metadata ELSE '{}' END)";
const FIELDS = Object.freeze({
  genre: '$.genres', actor: '$.actors', studio: '$.studios',
  franchise: '$.franchise', trilogy: '$.trilogy', collection: '$.collection',
  posterId: '$.posterId',
});
const TYPES = Object.freeze({
  filme: 'movie', film: 'movie', movies: 'movie', seriale: 'tv',
  series: 'tv', telenovele: 'telenovela',
  'desene animate': 'cartoon', cartoons: 'cartoon',
  animeuri: 'anime', anime: 'anime', muzica: 'music',
  music: 'music', sport: 'sports', stiri: 'news',
  news: 'news', documentare: 'documentary', documentaries: 'documentary',
  gaming: 'gaming', divertisment: 'entertainment',
  enterteiment: 'entertainment', entertainment: 'entertainment',
  showbiz: 'showbiz', 'show biz': 'showbiz',
});

const safeString = (value) => typeof value === 'string' ? value.trim().slice(0, 160) : '';
export const normalizedType = (input) => {
  const type = safeString(input).toLowerCase()
    .normalize('NFD').replace(/\p{M}/gu, '');
  return TYPES[type] || type;
};
const searchText = (value) => 'instr(lower(coalesce(' + value + ", '')),lower(?)) > 0";
function stableSig(input) {
  return crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 16);
}
function decodeCursor(raw, sig, sort) {
  if (!raw || typeof raw !== 'string' || raw.length > 512) {
    throw Object.assign(new Error('Invalid search cursor'), { status: 400 });
  }
  let data;
  try { data = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid search cursor'), { status: 400 }); }
  const valueValid = sort === 'title' ? typeof data?.v === 'string' : Number.isFinite(data?.v);
  if (!Number.isSafeInteger(data?.id) || data.id <= 0 || data?.sig !== sig || !valueValid || data.sort !== sort) {
    throw Object.assign(new Error('Search cursor does not match filters or sort'), { status: 400 });
  }
  return data;
}
function contentRow(row) {
  let metadata = {};
  try { metadata = JSON.parse(row.metadata || '{}'); } catch { /* legacy malformed */ }
  return {
    id: Number(row.id), title: row.title, year: row.year == null ? null : Number(row.year),
    type: row.type || 'content', category: row.type || 'content',
    thumbnail: row.thumbnail || null, externalid: row.externalid || null,
    url: row.url || null, embedcode: row.embedcode || null,
    metadata, _score: Number(row._score || 0),
  };
}

/**
 * Paginates stable, deterministic sorts through an opaque filter-bound cursor.
 * All metadata is sourced from Content JSON, whether written by API or miner.
 */
export async function sqliteAdvancedSearch({
  q, type, genre, year, minRating, actor, studio, category,
  franchise, trilogy, collection, description, posterId,
  sort = 'score', limit = 20, page = 1, cursor = null,
} = {}) {
  const conditions = [];
  const filterParams = [];
  const add = (sql, ...values) => { conditions.push(sql); filterParams.push(...values); };
  const query = safeString(q);
  if (query) {
    add('(' + [searchText('c.title'), searchText('c.externalid'), searchText('c.metadata')].join(' OR ') + ')',
      query, query, query);
  }
  const typeFilter = normalizedType(type || category);
  if (typeFilter) add('lower(c.type) = ?', typeFilter);
  if (year != null && year !== '') {
    const y = Number(year);
    if (!Number.isInteger(y) || y < 1000 || y > 9999) {
      throw Object.assign(new Error('Invalid year'), { status: 400 });
    }
    add('c.year = ?', y);
  }
  if (minRating != null && minRating !== '') {
    const rating = Number(minRating);
    if (!Number.isFinite(rating) || rating < 0 || rating > 10) {
      throw Object.assign(new Error('Invalid minimum rating'), { status: 400 });
    }
    add("CAST(COALESCE(json_extract(" + META + ", '$.rating'),json_extract(" + META + ", '$.score'),0) AS REAL) >= ?", rating);
  }
  for (const [key, path] of Object.entries(FIELDS)) {
    const value = safeString({ genre, actor, studio, franchise, trilogy, collection, posterId }[key]);
    if (!value) continue;
    add("EXISTS (SELECT 1 FROM json_each(" + META + ", '" + path + "') f WHERE instr(lower(CAST(f.value AS TEXT)),lower(?))>0)", value);
  }
  const descriptionFilter = safeString(description);
  if (descriptionFilter) add('(' +
    [searchText("json_extract(" + META + ", '$.overview')"),
     searchText("json_extract(" + META + ", '$.description')"),
     searchText("json_extract(" + META + ", '$.synopsis')")].join(' OR ') + ')',
    descriptionFilter, descriptionFilter, descriptionFilter);
  if (!conditions.length) {
    throw Object.assign(new Error('Missing query or filters'), { status: 400 });
  }

  const effectiveSort = ['year', 'rating', 'title', 'score'].includes(sort) ? sort : 'score';
  const boundedLimit = Math.max(1, Math.min(50, Number(limit) || 20));
  const pageNumber = Math.max(1, Number(page) || 1);
  const where = conditions.join(' AND ');
  const sig = stableSig({ query, typeFilter, year, minRating, genre, actor, studio, franchise, trilogy, collection, description, posterId, effectiveSort });
  const orderParams = [];
  let orderExpr = 'c.id';
  if (effectiveSort === 'title') orderExpr = 'lower(c.title)';
  if (effectiveSort === 'year') orderExpr = 'COALESCE(c.year, 0)';
  if (effectiveSort === 'rating') {
    orderExpr = "CAST(COALESCE(json_extract(" + META + ", '$.rating'),json_extract(" + META + ", '$.score'),0) AS REAL)";
  }
  if (effectiveSort === 'score') {
    orderExpr = query ? "CASE WHEN lower(c.title)=lower(?) THEN 3 WHEN instr(lower(c.title),lower(?))=1 THEN 2 ELSE 1 END" : '0';
    if (query) orderParams.push(query, query);
  }
  const descending = effectiveSort !== 'title';
  const cmp = descending ? '<' : '>';
  const ordering = descending ? 'DESC' : 'ASC';
  const cursorState = cursor ? decodeCursor(cursor, sig, effectiveSort) : null;
  const continuation = cursorState
    ? 'WHERE (_sort ' + cmp + ' ? OR (_sort = ? AND id ' + cmp + ' ?))'
    : '';
  const offset = cursorState ? 0 : (pageNumber - 1) * boundedLimit;
  const count = await one('SELECT COUNT(*) AS total FROM Content c WHERE ' + where, filterParams);
  const raw = await rows(
    'WITH filtered AS (SELECT c.*, ' + orderExpr + ' AS _sort FROM Content c WHERE ' + where + ') ' +
    'SELECT * FROM filtered ' + continuation + ' ORDER BY _sort ' + ordering + ', id ' + ordering +
    ' LIMIT ? OFFSET ?',
    [...orderParams, ...filterParams,
      ...(cursorState ? [cursorState.v, cursorState.v, cursorState.id] : []),
      boundedLimit + 1, offset],
  );
  const more = raw.length > boundedLimit;
  const slice = raw.slice(0, boundedLimit);
  const data = slice.map((row) => ({ ...contentRow(row),
    _score: effectiveSort === 'score' ? Number(row._sort) : 0 }));
  const last = slice.at(-1);
  const nextCursor = more && last
    ? Buffer.from(JSON.stringify({ id: Number(last.id), v: last._sort, sort: effectiveSort, sig })).toString('base64url')
    : null;
  return {
    total: Number(count?.total || 0), page: pageNumber,
    max_score: data.length ? Math.max(...data.map((row) => row._score)) : 0,
    data, nextCursor, paginationMode: cursorState ? 'cursor' : 'offset',
  };
}
