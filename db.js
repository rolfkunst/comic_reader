'use strict';

const { Database } = require('node-sqlite3-wasm');
const path         = require('path');
const crypto       = require('crypto');

let db;

function initDB(dataDir) {
  db = new Database(path.join(dataDir, 'comic-reader.db'));

  db.run('PRAGMA journal_mode=WAL');
  db.run('PRAGMA foreign_keys=ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS config (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      is_admin      INTEGER DEFAULT 0,
      created_at    TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS series (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT NOT NULL,
      smb_path     TEXT UNIQUE NOT NULL,
      cover_cache  TEXT,
      comic_count  INTEGER DEFAULT 0,
      last_scanned TEXT
    );

    CREATE TABLE IF NOT EXISTS comics (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      series_id   INTEGER REFERENCES series(id) ON DELETE CASCADE,
      title       TEXT NOT NULL,
      smb_path    TEXT UNIQUE NOT NULL,
      volume      TEXT,
      sort_key    TEXT,
      cover_cache TEXT,
      page_count  INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS progress (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
      comic_id     INTEGER REFERENCES comics(id) ON DELETE CASCADE,
      current_page INTEGER DEFAULT 0,
      total_pages  INTEGER DEFAULT 0,
      completed    INTEGER DEFAULT 0,
      last_read    TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, comic_id)
    );
  `);

  return db;
}

function getDB()               { return db; }
function getConfig(key)        { return db.get('SELECT value FROM config WHERE key=?', [key])?.value ?? null; }
function setConfig(key, value) { db.run('INSERT OR REPLACE INTO config (key,value) VALUES(?,?)', [key, String(value)]); }

function getOrCreateSessionSecret() {
  let secret = getConfig('session_secret');
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    setConfig('session_secret', secret);
  }
  return secret;
}

module.exports = { initDB, getDB, getConfig, setConfig, getOrCreateSessionSecret };
