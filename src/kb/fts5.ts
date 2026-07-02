import Database from "better-sqlite3";

export interface FTS5Result {
  chunkId: number;
  content: string;
  heading: string;
  rank: number;
}

export function escapeFts(query: string): string {
  // FTS5 treats AND, OR, NOT, NEAR as operators — keep them
  // Only escape special chars that cause syntax errors
  return query
    .replace(/"/g, '""')   // escape double-quotes for FTS5 phrase
    .replace(/[()]/g, '')  // remove bare parentheses (not needed for simple queries)
    .replace(/\*/g, '');   // remove wildcard asterisks
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
