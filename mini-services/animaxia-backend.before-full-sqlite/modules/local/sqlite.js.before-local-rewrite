import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.resolve(here, '../../../..', 'db/custom.db');

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const localDb = new DatabaseSync(dbPath);

localDb.exec(`
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
PRAGMA busy_timeout=5000;

CREATE TABLE IF NOT EXISTS Content (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  externalid TEXT UNIQUE,
  type TEXT,
  title TEXT NOT NULL,
  metadata TEXT,
  thumbnail TEXT,
  createdat TEXT DEFAULT CURRENT_TIMESTAMP,
  updatedat TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_content_type
ON Content(type);

CREATE INDEX IF NOT EXISTS idx_content_createdat
ON Content(createdat);
`);

export function localOne(sql, params = []) {
  return localDb.prepare(sql).get(...params) ?? null;
}

export function localAll(sql, params = []) {
  return localDb.prepare(sql).all(...params);
}

export function localRun(sql, params = []) {
  return localDb.prepare(sql).run(...params);
}
