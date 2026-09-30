import { localDb } from './sqlite.js';

const columns = localDb.prepare("PRAGMA table_info(Content)").all();
const names = new Set(columns.map(c => c.name));

const col = (...choices) => choices.find(c => names.has(c));

const idCol = col('id');
const externalCol = col('externalId', 'externalid');
const typeCol = col('type');
const titleCol = col('title');
const thumbnailCol = col('thumbnail');
const metadataCol = col('metadata');
const updatedCol = col('updatedAt', 'updatedat');

if (!idCol || !externalCol || !titleCol) {
  throw new Error('Content schema incompatible: id/externalId/title lipsesc');
}

function decode(row) {
  if (!row) return null;

  if (metadataCol && typeof row[metadataCol] === 'string') {
    try {
      row.metadata = JSON.parse(row[metadataCol]);
    } catch {
      row.metadata = {};
    }
  }

  return row;
}

export async function getLocalContentByExternalId(externalid) {
  return decode(
    localDb.prepare(
      `SELECT * FROM Content WHERE "${externalCol}" = ? LIMIT 1`
    ).get(externalid)
  );
}

export async function upsertLocalContent({
  externalid,
  type,
  title,
  thumbnail,
  metadata
}) {
  const existing = await getLocalContentByExternalId(externalid);

  const values = {
    externalid,
    ...(typeCol ? { type: type ?? 'mined' } : {}),
    title: title || externalid,
    ...(thumbnailCol ? { thumbnail: thumbnail || '' } : {}),
    ...(metadataCol ? { metadata: JSON.stringify(metadata || {}) } : {})
  };

  if (existing) {
    const entries = Object.entries(values)
      .filter(([k]) => k !== externalCol);

    const sql = entries.map(([k]) => `"${k}"=?`).join(',');

    localDb.prepare(
      `UPDATE Content SET ${sql}${updatedCol ? `,"${updatedCol}"=CURRENT_TIMESTAMP` : ''} WHERE "${idCol}"=?`
    ).run(...entries.map(([,v]) => v), existing[idCol]);

    return {
      record: await getLocalContentByExternalId(externalid),
      created: false
    };
  }

  const entries = Object.entries(values);
  const fields = entries.map(([k]) => `"${k}"`).join(',');
  const marks = entries.map(() => '?').join(',');

  localDb.prepare(
    `INSERT INTO Content (${fields}) VALUES (${marks})`
  ).run(...entries.map(([,v]) => v));

  return {
    record: await getLocalContentByExternalId(externalid),
    created: true
  };
}
