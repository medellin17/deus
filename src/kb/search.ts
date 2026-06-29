import Database from "better-sqlite3";

export interface SearchResult {
  source: "fts5" | "memory" | "both";
  path?: string;
  heading?: string;
  content: string;
  rank: number;
}

export class HybridSearch {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  search(query: string, limit: number = 10): SearchResult[] {
    const ftsResults = this.searchChunks(query, limit);
    const memoryResults = this.searchMemory(query, limit);

    const merged = new Map<string, SearchResult>();

    for (const r of ftsResults) {
      const key = r.content;
      merged.set(key, { ...r, source: "fts5" });
    }

    for (const r of memoryResults) {
      const key = r.content;
      if (merged.has(key)) {
        const existing = merged.get(key)!;
        existing.source = "both";
        existing.rank = Math.min(existing.rank, r.rank);
      } else {
        merged.set(key, { ...r, source: "memory" });
      }
    }

    return [...merged.values()]
      .sort((a, b) => a.rank - b.rank)
      .slice(0, limit);
  }

  searchChunks(query: string, limit: number = 10): SearchResult[] {
    const ftsQuery = this.escapeFts(query);
    const stmt = this.db.prepare(
      "SELECT rowid, content, heading, rank FROM kb_chunks_fts WHERE kb_chunks_fts MATCH ? ORDER BY rank LIMIT ?"
    );
    const rows = stmt.all(ftsQuery, limit) as {
      rowid: number;
      content: string;
      heading: string;
      rank: number;
    }[];
    return rows.map((r) => ({
      source: "fts5" as const,
      heading: r.heading,
      content: r.content,
      rank: r.rank,
    }));
  }

  searchMemory(query: string, limit: number = 10): SearchResult[] {
    const pattern = `%${query}%`;
    const stmt = this.db.prepare(
      "SELECT path, summary FROM kb_memory_tree WHERE summary LIKE ? OR path LIKE ? LIMIT ?"
    );
    const rows = stmt.all(pattern, pattern, limit) as {
      path: string;
      summary: string;
    }[];
    return rows.map((r) => ({
      source: "memory" as const,
      path: r.path,
      content: r.summary,
      rank: 0,
    }));
  }

  private escapeFts(query: string): string {
    return `"${query.replace(/["*()]/g, "")}"`;
  }
}
