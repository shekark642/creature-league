// SQLite storage using Node's built-in driver (no native dependencies to install).
'use strict';

const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash TEXT,
  salt TEXT,
  is_bot INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Creatures a player has caught (or received in a trade). This is what grants access.
CREATE TABLE IF NOT EXISTS catches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  species TEXT NOT NULL,
  individual_seed INTEGER NOT NULL,
  stats_json TEXT NOT NULL,
  attitude TEXT NOT NULL,
  biome TEXT,
  source TEXT NOT NULL DEFAULT 'catch',
  caught_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A wild creature you've found but not caught yet.
CREATE TABLE IF NOT EXISTS encounters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  species TEXT NOT NULL,
  individual_seed INTEGER NOT NULL,
  biome TEXT NOT NULL,
  attempts_left INTEGER NOT NULL DEFAULT 3,
  status TEXT NOT NULL DEFAULT 'open'
);

CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_user INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  offer_catch_id INTEGER NOT NULL,
  request_catch_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS leagues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  commissioner_id INTEGER NOT NULL REFERENCES users(id),
  seed INTEGER NOT NULL,
  settings_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'setup',
  current_week INTEGER NOT NULL DEFAULT 0,
  draft_pick INTEGER NOT NULL DEFAULT 0,
  champion_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS league_members (
  league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_name TEXT NOT NULL,
  draft_slot INTEGER,
  lineup_json TEXT,
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (league_id, user_id)
);

-- The league pool: 3 rolled individuals per allowed species.
CREATE TABLE IF NOT EXISTS pool (
  league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  id INTEGER NOT NULL,
  species TEXT NOT NULL,
  copy INTEGER NOT NULL,
  individual_seed INTEGER NOT NULL,
  stats_json TEXT NOT NULL,
  attitude TEXT NOT NULL,
  owner_id INTEGER REFERENCES users(id),
  drafted_pick INTEGER,
  PRIMARY KEY (league_id, id)
);

CREATE TABLE IF NOT EXISTS matchups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  week INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'regular',
  home_id INTEGER NOT NULL,
  away_id INTEGER,
  winner_id INTEGER,
  reason TEXT,
  home_hp INTEGER,
  away_hp INTEGER,
  rounds INTEGER,
  replay_json TEXT,
  played_at TEXT
);

CREATE TABLE IF NOT EXISTS league_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  user_id INTEGER,
  kind TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

function openDb(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  return db;
}

// Runs fn inside a transaction; rolls back if it throws.
function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { openDb, tx };
