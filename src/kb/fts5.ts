import Database from "better-sqlite3";

export interface FTS5Result {
  chunkId: number;
  content: string;
  heading: string;
  rank: number;
}

export function escapeFts(query: string): string {
  return `"${query.replace(/"/g, '""').replace(/\b(AND|OR|NOT|NEAR)\b/gi, '').replace(/[*()]/g, '')}"`;
}

export class FTS5Index {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  search(query: string, limit: number = 10): FTS5Result[] {
    const rows = this.db
      .prepare(
        `SELECT rowid, content, heading, rank FROM kb_chunks_fts WHERE kb_chunks_fts MATCH ? ORDER BY rank LIMIT ?`
      )
      .all(escapeFts(query), limit) as Array<{
      rowid: number;
      content: string;
      heading: string;
      rank: number;
    }>;

    return rows.map((r) => ({
      chunkId: r.rowid,
      content: r.content,
      heading: r.heading,
      rank: r.rank,
    }));
  }

  reindex(): void {
    this.db.prepare(`INSERT INTO kb_chunks_fts(kb_chunks_fts) VALUES('rebuild')`).run();
  }

  removeChunk(chunkId: number): void {
    this.db.prepare(`DELETE FROM kb_chunks WHERE id = ?`).run(chunkId);
  }
}
