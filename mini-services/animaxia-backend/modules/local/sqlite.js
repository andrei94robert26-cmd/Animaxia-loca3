import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.resolve(here, '../../../..', 'db/custom.db');

fs.mkdirSync(path.dirname(dbPath), { recursive: true });
export const localDb = new DatabaseSync(dbPath);
localDb.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');

export function localOne(sql, params = []) {
  return localDb.prepare(sql).get(...params) ?? null;
}

export function localAll(sql, params = []) {
  return localDb.prepare(sql).all(...params);
}

export function localRun(sql, params = []) {
  return localDb.prepare(sql).run(...params);
}
