import Database from "better-sqlite3";

export interface MemoryNode {
  id: number;
  path: string;
  level: "file" | "module" | "project";
  summary: string;
  tokenCount: number | null;
  createdAt: number;
}

export class MemoryTree {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  upsert(
    path: string,
    level: "file" | "module" | "project",
    summary: string,
    tokenCount?: number
  ): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO kb_memory_tree(path, level, summary, token_count) VALUES(?, ?, ?, ?)"
      )
      .run(path, level, summary, tokenCount ?? null);
  }

  get(path: string): MemoryNode | null {
    const row = this.db
      .prepare("SELECT * FROM kb_memory_tree WHERE path = ?")
      .get(path) as
      | {
          id: number;
          path: string;
          level: string;
          summary: string;
          token_count: number | null;
          created_at: number;
        }
      | undefined;

    if (!row) return null;

    return {
      id: row.id,
      path: row.path,
      level: row.level as "file" | "module" | "project",
      summary: row.summary,
      tokenCount: row.token_count,
      createdAt: row.created_at,
    };
  }

  getByLevel(level: "file" | "module" | "project"): MemoryNode[] {
    const rows = this.db
      .prepare("SELECT * FROM kb_memory_tree WHERE level = ?")
      .all(level) as {
      id: number;
      path: string;
      level: string;
      summary: string;
      token_count: number | null;
      created_at: number;
    }[];

    return rows.map((row) => ({
      id: row.id,
      path: row.path,
      level: row.level as "file" | "module" | "project",
      summary: row.summary,
      tokenCount: row.token_count,
      createdAt: row.created_at,
    }));
  }

  search(query: string, limit?: number): MemoryNode[] {
    const like = `%${query}%`;
    const rows = this.db
      .prepare(
        "SELECT * FROM kb_memory_tree WHERE summary LIKE ? OR path LIKE ? LIMIT ?"
      )
      .all(like, like, limit ?? 100) as {
      id: number;
      path: string;
      level: string;
      summary: string;
      token_count: number | null;
      created_at: number;
    }[];

    return rows.map((row) => ({
      id: row.id,
      path: row.path,
      level: row.level as "file" | "module" | "project",
      summary: row.summary,
      tokenCount: row.token_count,
      createdAt: row.created_at,
    }));
  }

  delete(path: string): void {
    this.db
      .prepare("DELETE FROM kb_memory_tree WHERE path = ?")
      .run(path);
  }
}
