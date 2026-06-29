import Database from 'better-sqlite3';

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
  level: number | null;
  content: string;
  token_count: number | null;
  created_at: number;
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
  level: 'file' | 'module' | 'project';
  summary: string;
  token_count: number | null;
  created_at: number;
}

export class KBDatabase {
  private db: Database.Database;
  private dbPath: string;

  constructor(dbPath: string = '.agents/orchestrator.db') {
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
        level INTEGER,
        content TEXT NOT NULL,
        token_count INTEGER,
        created_at INTEGER DEFAULT (unixepoch())
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunks_fts USING fts5(
        content,
        heading,
        content='kb_chunks',
        content_rowid='id'
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
        level TEXT NOT NULL CHECK(level IN ('file', 'module', 'project')),
        summary TEXT NOT NULL,
        token_count INTEGER,
        created_at INTEGER DEFAULT (unixepoch()),
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
    `);
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
