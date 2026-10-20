/**
 * SQLite FTS5 (full-text) index over the canonical Content table.
 * Supports title and serialized metadata (description, cast, genre, studio).
 * No distributed search claims. Writes use native SQLite triggers so
 * updates from ANY backend path remain in sync.
 */
import { localDb } from '../local/sqlite.js';

export function ensureContentFts() {
  const existing = localDb.prepare(
    "SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='content_fts'"
  ).get();
  // FTS5 virtual tables are available in the Node SQLite build used by CI.
  localDb.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS content_fts USING fts5(
      title, metadata,
      content='Content',
      content_rowid='id',
      tokenize='unicode61 remove_diacritics 2',
      prefix='2 3 4'
    );
    CREATE TRIGGER IF NOT EXISTS content_fts_ai AFTER INSERT ON Content BEGIN
      INSERT INTO content_fts(rowid,title,metadata)
      VALUES (new.id,new.title,coalesce(new.metadata,''));
    END;
    CREATE TRIGGER IF NOT EXISTS content_fts_ad AFTER DELETE ON Content BEGIN
      INSERT INTO content_fts(content_fts,rowid,title,metadata)
      VALUES ('delete',old.id,old.title,coalesce(old.metadata,''));
    END;
    CREATE TRIGGER IF NOT EXISTS content_fts_au AFTER UPDATE OF title,metadata ON Content BEGIN
      INSERT INTO content_fts(content_fts,rowid,title,metadata)
      VALUES ('delete',old.id,old.title,coalesce(old.metadata,''));
      INSERT INTO content_fts(rowid,title,metadata)
      VALUES (new.id,new.title,coalesce(new.metadata,''));
    END;
  `);
  // Existing Content records predate the first FTS installation. Backfill
  // once; never rebuild on every boot because that is an O(N) operation.
  if (!existing) {
    localDb.prepare("INSERT INTO content_fts(content_fts) VALUES('rebuild')").run();
  }
  return {
    engine: 'sqlite-fts5',
    initialized: true,
    rebuilt: !existing,
    distributed: false,
  };
}
export function rebuildContentFts() {
  ensureContentFts();
  localDb.prepare("INSERT INTO content_fts(content_fts) VALUES('rebuild')").run();
  return countFtsRows();
}
export function countFtsRows() {
  ensureContentFts();
  return Number(localDb.prepare('SELECT COUNT(*) AS n FROM content_fts').get().n);
}
/** Prevent FTS syntax injection and bound complexity of each search request. */
export function prepareFtsQuery(raw) {
  if (typeof raw !== 'string') return null;
  const input = raw.trim().normalize('NFKC');
  // FTS5 tokenization is word/prefix based, not a replacement for arbitrary
  // substring search. Retain legacy LIKE for punctuation-containing queries.
  if (!/^[\p{L}\p{N}]{3,64}$/u.test(input)) return null;
  return '"' + input.replaceAll('"', '""') + '"*';
}
