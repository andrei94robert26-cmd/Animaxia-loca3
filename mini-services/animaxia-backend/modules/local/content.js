/**
 * Compatibility adapter for legacy miner call sites.
 * The canonical content writer/reader is db.js; do not maintain a second
 * SQL implementation with a different schema and discarded JSON metadata.
 */
import { getContentByExternalId, upsertContent } from '../../db.js';

export function getLocalContentByExternalId(externalid) {
  return getContentByExternalId(externalid);
}

export async function upsertLocalContent({ externalid, title, metadata = {}, type, thumbnail }) {
  return upsertContent({
    externalid,
    title: title || String(externalid || 'Untitled'),
    metadata,
    type: type || metadata?.mediaType,
    thumbnail: thumbnail || metadata?.thumbnail,
  });
}
