import { localDb } from './sqlite.js';

function detectYear(title, metadata = {}) {
  const direct = Number(metadata?.year);

  if (Number.isInteger(direct) && direct >= 1000 && direct <= 9999) {
    return direct;
  }

  const match = String(title || '').match(/\b(19|20)\d{2}\b/);
  return match ? Number(match[0]) : null;
}

function decode(row) {
  if (!row) return null;

  const sources = [];

  if (row.url) {
    sources.push({
      url: row.url,
      type: /youtube\.com\/embed\//i.test(row.url)
        ? 'youtube'
        : row.embedcode === row.url
          ? 'iframe'
        : /\.m3u8(?:[?#]|$)|[?&]r_file=chunklist\.m3u8/i.test(row.url)
          ? 'm3u8'
          : /\.mp4(?:[?#]|$)/i.test(row.url)
            ? 'mp4'
            : 'video'
    });
  }

  if (row.embedcode && row.embedcode !== row.url) {
    sources.push({
      url: row.embedcode,
      type: 'iframe'
    });
  }

  return {
    ...row,
    metadata: {
      year: row.year ?? null,
      player: { sources }
    }
  };
}

export async function getLocalContentByExternalId(externalid) {
  const source = localDb.prepare(`
    SELECT contentId
    FROM contentsources
    WHERE originalUrl = ? OR url = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(externalid, externalid);

  if (!source?.contentId) return null;

  return decode(
    localDb.prepare(`
      SELECT id,title,year,url,embedcode
      FROM Content
      WHERE id=?
      LIMIT 1
    `).get(source.contentId)
  );
}

export async function upsertLocalContent({
  externalid,
  title,
  metadata = {}
}) {
  const existing = await getLocalContentByExternalId(externalid);

  const sources = Array.isArray(metadata?.player?.sources)
    ? metadata.player.sources
    : [];

  const first = sources[0] ?? null;

  const embed = sources.find(s =>
    ['iframe', 'youtube'].includes(String(s?.type || '').toLowerCase())
  );

  const year = detectYear(title, metadata);
  const url = first?.url ?? existing?.url ?? null;
  const embedcode = embed?.url ?? existing?.embedcode ?? null;

  if (existing) {
    localDb.prepare(`
      UPDATE Content
      SET title=?, year=?, url=?, embedcode=?
      WHERE id=?
    `).run(
      title || existing.title,
      year,
      url,
      embedcode,
      existing.id
    );

    return {
      record: decode(
        localDb.prepare(`
          SELECT id,title,year,url,embedcode
          FROM Content WHERE id=?
        `).get(existing.id)
      ),
      created: false
    };
  }

  const finalTitle = title || externalid || 'untitled';

  const result = localDb.prepare(`
    INSERT INTO Content(title,year,url,embedcode)
    VALUES(?,?,?,?)
    ON CONFLICT DO NOTHING
  `).run(finalTitle, year, url, embedcode);

  let id;

  if (Number(result.changes || 0) > 0) {
    id = Number(result.lastInsertRowid);
  } else {
    const duplicate = localDb.prepare(`
      SELECT id
      FROM Content
      WHERE lower(trim(title)) = lower(trim(?))
        AND ifnull(year,-1) = ifnull(?,-1)
        AND ifnull(url,'') = ifnull(?,'')
        AND ifnull(embedcode,'') = ifnull(?,'')
      LIMIT 1
    `).get(finalTitle, year, url, embedcode);

    if (!duplicate?.id)
      throw new Error('Content duplicate detected but canonical row not found');

    id = Number(duplicate.id);
  }

  return {
    record: decode(
      localDb.prepare(`
        SELECT id,title,year,url,embedcode
        FROM Content WHERE id=?
      `).get(id)
    ),
    created: true
  };
}
