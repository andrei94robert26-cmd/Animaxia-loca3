/**
 * SQLite-backed metadata catalog search. Works on canonical Content JSON.
 * Bounded keyset pagination (id DESC), never scans external provider URLs.
 * Filters are parameterized; input cannot modify SQL syntax.
 */
import express from 'express';
import { rows, one } from '../platform/sql.js';
import { normalizedType } from './sqlite-advanced.js';
import { prepareFtsQuery } from './content-fts.js';
import { distributedSearch } from './opensearch.js';

const router = express.Router();
const scalarFields = Object.freeze({
  actor: '$.actors',
  genre: '$.genres',
  studio: '$.studios',
  franchise: '$.franchise',
  trilogy: '$.trilogy',
  collection: '$.collection',
  posterId: '$.posterId',
});
function safeText(input, cap = 160) {
  return typeof input === 'string' ? input.trim().slice(0, cap) : '';
}
function likeTerm(value) {
  return '%' + value.replace(/[\\%_]/g, (m) => '\\' + m) + '%';
}
function containsJsonField(fieldPath) {
  // Strings, arrays of names, or provider-specific JSON objects.
  return `EXISTS (
    SELECT 1 FROM json_each(
      CASE WHEN json_valid(c.metadata) THEN c.metadata ELSE '{}' END,
      '${fieldPath}'
    ) j
    WHERE CAST(j.value AS TEXT) LIKE ? ESCAPE '\\' COLLATE NOCASE
  )`;
}
router.get('/metadata', async (req, res, next) => {
  try {
    if (process.env.ANIMAXIA_SEARCH_BACKEND === 'opensearch') {
      return res.json(await distributedSearch(req.query));
    }
    const filters = [];
    const params = [];
    const add = (sql, value) => { filters.push(sql); params.push(value); };
    const q = safeText(req.query.q);
    const fts = prepareFtsQuery(q);
    if (fts) {
      add('c.id IN (SELECT rowid FROM content_fts WHERE content_fts MATCH ?)', fts);
    } else if (q) {
      const needle = likeTerm(q);
      filters.push(`(c.title LIKE ? ESCAPE '\\' COLLATE NOCASE OR
        c.externalid LIKE ? ESCAPE '\\' COLLATE NOCASE OR
        c.metadata LIKE ? ESCAPE '\\' COLLATE NOCASE)`);
      params.push(needle, needle, needle);
    }
    const category = safeText(req.query.category || req.query.type);
    if (category) add('c.type = ? COLLATE NOCASE', normalizedType(category));
    const year = req.query.year == null ? '' : String(req.query.year);
    if (year) {
      if (!/^[0-9]{4}$/.test(year)) return res.status(400).json({ error: 'Invalid year' });
      add('c.year = ?', Number(year));
    }
    for (const [field, path] of Object.entries(scalarFields)) {
      const value = safeText(req.query[field]);
      if (value) add(containsJsonField(path), likeTerm(value));
    }
    if (!filters.length) return res.status(400).json({ error: 'Provide q or at least one filter' });
    const cursor = req.query.cursor == null ? '' : String(req.query.cursor);
    if (cursor && !/^[1-9][0-9]*$/.test(cursor)) return res.status(400).json({ error: 'Invalid cursor' });
    const limit = Math.max(1, Math.min(50, Number.parseInt(req.query.limit, 10) || 20));
    const where = filters.join(' AND ');
    // COUNT excludes the pagination cursor so clients see a stable filter total.
    const count = await one(`SELECT COUNT(*) AS total FROM Content c WHERE ${where}`, params);
    const pageParams = [...params];
    let pageWhere = where;
    if (cursor) { pageWhere += ' AND c.id < ?'; pageParams.push(Number(cursor)); }
    pageParams.push(limit + 1);
    const list = await rows(`
      SELECT c.id, c.title, c.year, c.type, c.thumbnail, c.externalid, c.metadata
      FROM Content c WHERE ${pageWhere}
      ORDER BY c.id DESC LIMIT ?
    `, pageParams);
    const hasMore = list.length > limit;
    const items = list.slice(0, limit).map((row) => {
      let metadata = {};
      try { metadata = JSON.parse(row.metadata || '{}'); } catch { /* legacy malformed JSON */ }
      return {
        id: Number(row.id), title: row.title, year: row.year,
        category: row.type, type: row.type, thumbnail: row.thumbnail,
        externalid: row.externalid, metadata,
      };
    });
    return res.json({
      engine: 'animaxia-sqlite-metadata-v1', total: Number(count?.total || 0),
      data: items, limit, nextCursor: hasMore ? String(items.at(-1).id) : null,
      paginationMode: 'keyset', searchMode: fts ? 'sqlite-fts5' : (q ? 'sqlite-like-fallback' : 'filters-only'),
    });
  } catch (error) { next(error); }
});
export default router;
