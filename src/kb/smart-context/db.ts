import type Database from 'better-sqlite3';

const SC_SCHEMA = `
CREATE TABLE IF NOT EXISTS sc_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  mtime INTEGER,
  size INTEGER,
  lang TEXT,
  indexed_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sc_files_path ON sc_files(path);

CREATE TABLE IF NOT EXISTS sc_symbols (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES sc_files(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  line INTEGER,
  col INTEGER,
  signature TEXT
);

CREATE INDEX IF NOT EXISTS idx_sc_symbols_file ON sc_symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_sc_symbols_name ON sc_symbols(name);

CREATE TABLE IF NOT EXISTS sc_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES sc_files(id) ON DELETE CASCADE,
  imported_module TEXT,
  imported_name TEXT,
  is_relative INTEGER DEFAULT 0,
  resolved_path TEXT,
  line INTEGER,
  imported_basename TEXT
);

CREATE INDEX IF NOT EXISTS idx_sc_imports_file ON sc_imports(file_id);
CREATE INDEX IF NOT EXISTS idx_sc_imports_basename ON sc_imports(imported_basename);

CREATE TABLE IF NOT EXISTS sc_call_graph (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  caller_file_id INTEGER NOT NULL REFERENCES sc_files(id) ON DELETE CASCADE,
  caller_symbol TEXT,
  callee_file_id INTEGER REFERENCES sc_files(id) ON DELETE CASCADE,
  callee_symbol TEXT NOT NULL,
  confidence REAL DEFAULT 1.0,
  line INTEGER
);

CREATE INDEX IF NOT EXISTS idx_sc_call_graph_caller ON sc_call_graph(caller_file_id);
CREATE INDEX IF NOT EXISTS idx_sc_call_graph_callee ON sc_call_graph(callee_file_id);

CREATE TABLE IF NOT EXISTS sc_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  created_at INTEGER,
  updated_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sc_sessions_sid ON sc_sessions(session_id);

CREATE TABLE IF NOT EXISTS sc_session_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sc_sessions(id) ON DELETE CASCADE,
  timestamp INTEGER,
  query TEXT,
  category TEXT,
  selected_file_ids TEXT,
  entities TEXT
);

CREATE TABLE IF NOT EXISTS sc_file_ema (
  file_id INTEGER PRIMARY KEY REFERENCES sc_files(id) ON DELETE CASCADE,
  weight REAL DEFAULT 1.0,
  samples INTEGER DEFAULT 0,
  updated_at INTEGER
);

CREATE VIRTUAL TABLE IF NOT EXISTS sc_content_fts USING fts5(
  path UNINDEXED,
  content,
  tokenize='unicode61 remove_diacritics 1'
);
`;

/**
 * Create all smart-context tables (sc_* prefix) in the shared KB database.
 * Called during KB initialization.
 */
export function ensureSmartContextSchema(db: Database.Database): void {
  db.exec(SC_SCHEMA);
}

/**
 * Passthrough helper for API compatibility.
 * Returns the same Database.Database instance.
 */
export function getSmartContextDb(db: Database.Database): Database.Database {
  return db;
}
