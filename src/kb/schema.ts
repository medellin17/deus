import Database from 'better-sqlite3';
import { ensureSmartContextSchema } from './smart-context/db.ts';

export interface Document {
  id: number;
  path: string;
  title: string | null;
  category: string | null;
  content_hash: string | null;
  created_at: number;
  updated_at: number;
}

export interface Chunk {
  id: number;
  doc_id: number;
  chunk_index: number;
  heading: string | null;
  level: number;
  content: string;
  token_count: number;
  created_at: number;
  updated_at: number;
}

export interface Embedding {
  id: number;
  chunk_id: number;
  model: string;
  dimension: number;
  embedding: Buffer;
  created_at: number;
}

export interface MemoryNode {
  id: number;
  path: string;
  level: 'file' | 'section' | 'project' | 'checkpoint';
  summary: string;
  token_count: number;
  parent_id: number | null;
  created_at: number;
  updated_at: number;
}

export class KBDatabase {
  private db: Database.Database;
  private dbPath: string;

  constructor(dbPath: string = '.deus/kb/orchestrator.db') {
    this.dbPath = dbPath;
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
  }

  initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kb_documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL UNIQUE,
        title TEXT,
        category TEXT,
        content_hash TEXT,
        created_at INTEGER DEFAULT (unixepoch()),
        updated_at INTEGER DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS kb_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        doc_id INTEGER NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL,
        heading TEXT,
        level INTEGER NOT NULL,
        content TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        created_at INTEGER DEFAULT (unixepoch()),
        updated_at INTEGER DEFAULT (unixepoch())
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunks_fts USING fts5(
        content,
        heading,
        content='kb_chunks',
        content_rowid='id',
        tokenize='porter unicode61'
      );

      CREATE TABLE IF NOT EXISTS kb_embeddings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chunk_id INTEGER NOT NULL REFERENCES kb_chunks(id) ON DELETE CASCADE,
        model TEXT NOT NULL,
        dimension INTEGER NOT NULL,
        embedding BLOB NOT NULL,
        created_at INTEGER DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS kb_memory_tree (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL,
        level TEXT NOT NULL CHECK(level IN ('file', 'section', 'project', 'checkpoint')),
        summary TEXT NOT NULL,
        token_count INTEGER NOT NULL DEFAULT 0,
        parent_id INTEGER REFERENCES kb_memory_tree(id),
        created_at INTEGER DEFAULT (unixepoch()),
        updated_at INTEGER DEFAULT (unixepoch()),
        UNIQUE(path, level)
      );

      CREATE TRIGGER IF NOT EXISTS kb_chunks_ai AFTER INSERT ON kb_chunks BEGIN
        INSERT INTO kb_chunks_fts(rowid, content, heading) VALUES (new.id, new.content, new.heading);
      END;

      CREATE TRIGGER IF NOT EXISTS kb_chunks_ad AFTER DELETE ON kb_chunks BEGIN
        INSERT INTO kb_chunks_fts(kb_chunks_fts, rowid, content, heading) VALUES('delete', old.id, old.content, old.heading);
      END;

      CREATE TRIGGER IF NOT EXISTS kb_chunks_au AFTER UPDATE ON kb_chunks BEGIN
        INSERT INTO kb_chunks_fts(kb_chunks_fts, rowid, content, heading) VALUES('delete', old.id, old.content, old.heading);
        INSERT INTO kb_chunks_fts(rowid, content, heading) VALUES (new.id, new.content, new.heading);
      END;

      CREATE INDEX IF NOT EXISTS idx_chunks_doc_id ON kb_chunks(doc_id);
      CREATE INDEX IF NOT EXISTS idx_embeddings_chunk_id ON kb_embeddings(chunk_id);
      CREATE INDEX IF NOT EXISTS idx_memory_tree_level ON kb_memory_tree(level);
      CREATE INDEX IF NOT EXISTS idx_memory_parent ON kb_memory_tree(parent_id);
    `);

    // --- Migration logic for existing databases ---
    this.runMigrations();

    // --- Smart-context tables (sc_* prefix) ---
    ensureSmartContextSchema(this.db);
  }

  private runMigrations(): void {
    // 1. Migrate kb_memory_tree if it has old schema (missing parent_id column)
    try {
      const memoryCols = this.db.prepare("PRAGMA table_info(kb_memory_tree)").all() as { name: string }[];
      const hasParentId = memoryCols.some(c => c.name === 'parent_id');
      if (!hasParentId) {
        this.db.exec(`
          ALTER TABLE kb_memory_tree RENAME TO kb_memory_tree_old;

          CREATE TABLE kb_memory_tree (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT NOT NULL,
            level TEXT NOT NULL CHECK(level IN ('file', 'section', 'project', 'checkpoint')),
            summary TEXT NOT NULL,
            token_count INTEGER NOT NULL DEFAULT 0,
            parent_id INTEGER REFERENCES kb_memory_tree(id),
            created_at INTEGER DEFAULT (unixepoch()),
            updated_at INTEGER DEFAULT (unixepoch()),
            UNIQUE(path, level)
          );

          INSERT INTO kb_memory_tree(id, path, level, summary, token_count, created_at, updated_at)
            SELECT id, path,
              CASE WHEN level = 'module' THEN 'section' ELSE level END,
              summary, COALESCE(token_count, 0), created_at, created_at
            FROM kb_memory_tree_old;

          DROP TABLE kb_memory_tree_old;
        `);
      }
    } catch (e) {
      console.warn('[kb] memory_tree migration skipped:', (e as Error).message);
    }

    // 2. Add updated_at to kb_chunks if missing (old schema)
    try {
      const chunkCols = this.db.prepare("PRAGMA table_info(kb_chunks)").all() as { name: string }[];
      const hasUpdatedAt = chunkCols.some(c => c.name === 'updated_at');
      if (!hasUpdatedAt) {
        this.db.exec("ALTER TABLE kb_chunks ADD COLUMN updated_at INTEGER DEFAULT (unixepoch())");
      }
    } catch (e) {
      console.warn('[kb] chunks migration skipped:', (e as Error).message);
    }

    // 3. Recreate FTS5 with tokenize if it exists and was created without it
    try {
      const ftsDef = this.db.prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='kb_chunks_fts'"
      ).get() as { sql: string } | undefined;

      if (ftsDef && !ftsDef.sql.includes('porter')) {
        this.db.exec(`
          DROP TRIGGER IF EXISTS kb_chunks_ai;
          DROP TRIGGER IF EXISTS kb_chunks_ad;
          DROP TRIGGER IF EXISTS kb_chunks_au;
          DROP TABLE IF EXISTS kb_chunks_fts;
        `);

        this.db.exec(`
          CREATE VIRTUAL TABLE kb_chunks_fts USING fts5(
            content, heading,
            content='kb_chunks',
            content_rowid='id',
            tokenize='porter unicode61'
          );

          INSERT INTO kb_chunks_fts(rowid, content, heading)
            SELECT id, content, heading FROM kb_chunks;

          CREATE TRIGGER IF NOT EXISTS kb_chunks_ai AFTER INSERT ON kb_chunks BEGIN
            INSERT INTO kb_chunks_fts(rowid, content, heading) VALUES (new.id, new.content, new.heading);
          END;

          CREATE TRIGGER IF NOT EXISTS kb_chunks_ad AFTER DELETE ON kb_chunks BEGIN
            INSERT INTO kb_chunks_fts(kb_chunks_fts, rowid, content, heading) VALUES('delete', old.id, old.content, old.heading);
          END;

          CREATE TRIGGER IF NOT EXISTS kb_chunks_au AFTER UPDATE ON kb_chunks BEGIN
            INSERT INTO kb_chunks_fts(kb_chunks_fts, rowid, content, heading) VALUES('delete', old.id, old.content, old.heading);
            INSERT INTO kb_chunks_fts(rowid, content, heading) VALUES (new.id, new.content, new.heading);
          END;
        `);
      }
    } catch (e) {
      console.warn('[kb] FTS5 migration skipped:', (e as Error).message);
    }
  }

  get raw(): Database.Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }
}

export function openKB(dbPath?: string): KBDatabase {
  const kb = new KBDatabase(dbPath);
  kb.initialize();
  return kb;
}
