import Database from 'better-sqlite3';
import path from 'path';

// ---- Types ----

export interface TaskRow {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  graph: string | null;   // JSON string of TaskGraph
  config: string | null;  // JSON string of config
  created_at: number;
  completed_at: number | null;
  total_cost: number;
}

export interface TaskNodeRow {
  id: string;
  task_id: string;
  agent: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  prompt: string;
  depends_on: string;     // JSON array string like '["node-1","node-2"]'
  result: string | null;
  error: string | null;
  session_id: string | null;
  started_at: number | null;
  completed_at: number | null;
  cost: number;
  retries: number;
}

export interface SessionLogRow {
  id: number;
  task_id: string | null;
  node_id: string | null;
  session_id: string | null;
  agent: string | null;
  model: string | null;
  tokens_in: number;
  tokens_out: number;
  cost: number;
  duration_ms: number;
  created_at: number;
}

export interface AgentStatRow {
  agent: string;
  total_runs: number;
  total_cost: number;
  avg_duration_ms: number;
  success_rate: number;
  last_used: number | null;
}

// ---- Database class ----

export class StateDatabase {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const resolved = dbPath || path.join(process.cwd(), '.deus', 'kb', 'orchestrator.db');
    this.db = new Database(resolved);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.initialize();
  }

  get raw(): Database.Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending', 'running', 'completed', 'failed')),
        graph TEXT,
        config TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        completed_at INTEGER,
        total_cost REAL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS task_nodes (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        agent TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending', 'running', 'completed', 'failed', 'skipped')),
        prompt TEXT NOT NULL,
        depends_on TEXT DEFAULT '[]',
        result TEXT,
        error TEXT,
        session_id TEXT,
        started_at INTEGER,
        completed_at INTEGER,
        cost REAL DEFAULT 0,
        retries INTEGER DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_task_nodes_task ON task_nodes(task_id);
      CREATE INDEX IF NOT EXISTS idx_task_nodes_status ON task_nodes(status);

      CREATE TABLE IF NOT EXISTS session_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT,
        node_id TEXT,
        session_id TEXT,
        agent TEXT,
        model TEXT,
        tokens_in INTEGER DEFAULT 0,
        tokens_out INTEGER DEFAULT 0,
        cost REAL DEFAULT 0,
        duration_ms INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_session_task ON session_log(task_id);
      CREATE INDEX IF NOT EXISTS idx_session_agent ON session_log(agent);

      CREATE TABLE IF NOT EXISTS agent_stats (
        agent TEXT PRIMARY KEY,
        total_runs INTEGER DEFAULT 0,
        total_cost REAL DEFAULT 0,
        avg_duration_ms REAL DEFAULT 0,
        success_rate REAL DEFAULT 1.0,
        last_used INTEGER
      );
    `);
  }
}
