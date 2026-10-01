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
  title TEXT NOT NULL,
  year INTEGER,
  url TEXT,
  embedcode TEXT
);

CREATE INDEX IF NOT EXISTS idx_content_title
ON Content(title COLLATE NOCASE);

CREATE INDEX IF NOT EXISTS idx_content_year
ON Content(year);
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

/* ===== SQLITE LOCAL SCHEMA: USERS + AUTH ===== */

localDb.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  username TEXT NOT NULL,
  passwordhash TEXT NOT NULL,
  avatar TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  plan TEXT NOT NULL DEFAULT 'free',
  planexpiresat TEXT,
  preferences TEXT NOT NULL DEFAULT '{}',
  createdat TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lastloginat TEXT
);

CREATE INDEX IF NOT EXISTS idx_users_username
ON users(username);

CREATE TABLE IF NOT EXISTS refreshtokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  userid INTEGER NOT NULL,
  tokenhash TEXT UNIQUE NOT NULL,
  expiresat TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  createdat TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(userid) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_refreshtokens_user
ON refreshtokens(userid);

CREATE TABLE IF NOT EXISTS passwordresets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  userid INTEGER NOT NULL,
  codehash TEXT NOT NULL,
  expiresat TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  createdat TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(userid) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_passwordresets_user
ON passwordresets(userid, createdat DESC);
`);

/* ===== SQLITE LOCAL SCHEMA: WATCHLIST + HISTORY ===== */

localDb.exec(`
CREATE TABLE IF NOT EXISTS watchlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  userid INTEGER NOT NULL,
  contentid INTEGER NOT NULL,
  createdat TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(userid, contentid),
  FOREIGN KEY(userid) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(contentid) REFERENCES Content(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_watchlist_user
ON watchlist(userid);

CREATE TABLE IF NOT EXISTS watchhistory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  userid INTEGER NOT NULL,
  contentid INTEGER NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0,
  watchedat TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(userid, contentid),
  FOREIGN KEY(userid) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(contentid) REFERENCES Content(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_watchhistory_user
ON watchhistory(userid);

CREATE INDEX IF NOT EXISTS idx_watchhistory_content
ON watchhistory(contentid);
`);


/* SQLITE LOCAL: COMMENTS */
localDb.exec(`
CREATE TABLE IF NOT EXISTS comments (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 contentid INTEGER NOT NULL,
 userid INTEGER NOT NULL,
 parentid INTEGER,
 body TEXT NOT NULL,
 createdat TEXT DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(contentid) REFERENCES Content(id) ON DELETE CASCADE,
 FOREIGN KEY(userid) REFERENCES users(id) ON DELETE CASCADE,
 FOREIGN KEY(parentid) REFERENCES comments(id) ON DELETE CASCADE
);
`);
/* SQLITE LOCAL: COMMENTVOTES */
localDb.exec(`
CREATE TABLE IF NOT EXISTS commentvotes (
 userid INTEGER NOT NULL,
 commentid INTEGER NOT NULL,
 value INTEGER NOT NULL,
 createdat TEXT DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(userid, commentid),
 FOREIGN KEY(userid) REFERENCES users(id) ON DELETE CASCADE,
 FOREIGN KEY(commentid) REFERENCES comments(id) ON DELETE CASCADE
);
`);

localDb.exec(`CREATE TABLE IF NOT EXISTS contentlikes (contentid INTEGER NOT NULL, userid INTEGER NOT NULL, value INTEGER NOT NULL, createdat TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(contentid,userid), FOREIGN KEY(contentid) REFERENCES Content(id) ON DELETE CASCADE, FOREIGN KEY(userid) REFERENCES users(id) ON DELETE CASCADE);`);

localDb.exec(`CREATE TABLE IF NOT EXISTS viewevents (id INTEGER PRIMARY KEY AUTOINCREMENT, contentid INTEGER NOT NULL, userid INTEGER, event TEXT NOT NULL DEFAULT "view", createdat TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(contentid) REFERENCES Content(id) ON DELETE CASCADE, FOREIGN KEY(userid) REFERENCES users(id) ON DELETE SET NULL); CREATE INDEX IF NOT EXISTS idx_viewevents_content ON viewevents(contentid); CREATE INDEX IF NOT EXISTS idx_viewevents_created ON viewevents(createdat DESC);`);

localDb.exec(`
CREATE TABLE IF NOT EXISTS searchdocs (
  contentid INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  year INTEGER,
  FOREIGN KEY(contentid) REFERENCES Content(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_searchdocs_title
ON searchdocs(title COLLATE NOCASE);

CREATE INDEX IF NOT EXISTS idx_searchdocs_year
ON searchdocs(year);
`);

localDb.exec(`CREATE TABLE IF NOT EXISTS aienrichment (externalid TEXT PRIMARY KEY, payload TEXT NOT NULL, updatedat TEXT DEFAULT CURRENT_TIMESTAMP);`);

localDb.exec(`CREATE TABLE IF NOT EXISTS aitrailercache (cachekey TEXT PRIMARY KEY, payload TEXT NOT NULL, updatedat TEXT DEFAULT CURRENT_TIMESTAMP);`);

localDb.exec(`CREATE TABLE IF NOT EXISTS aisettings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updatedat TEXT DEFAULT CURRENT_TIMESTAMP);`);
