import Database from "better-sqlite3";
import type { Embedder } from "./embeddings.js";
import { cosineSimilarity } from "./embeddings.js";
import { escapeFts } from "./fts5.js";

export interface SearchResult {
  source: "fts5" | "memory" | "both" | "semantic";
  path?: string;
  heading?: string;
  content: string;
  rank: number;
}

export class HybridSearch {
  private db: Database.Database;
  private embedder?: Embedder;

  constructor(db: Database.Database, embedder?: Embedder) {
    this.db = db;
    this.embedder = embedder;
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
    const ftsQuery = escapeFts(query);
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
    const escaped = query.replace(/[%_]/g, "\\$&");
    const pattern = `%${escaped}%`;
    const stmt = this.db.prepare(
      "SELECT path, summary FROM kb_memory_tree WHERE summary LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\' LIMIT ?"
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

  async semanticSearch(query: string, limit: number = 10): Promise<SearchResult[]> {
    if (!this.embedder) return [];

    // gemini-embedding-2: Query prefix format
    const prefixedQuery = `task: search result | query: ${query}`;
    const queryEmbedding = await this.embedder.embedSingle(prefixedQuery);

    const rows = this.db.prepare(`
      SELECT e.chunk_id, e.embedding, e.dimension,
             c.content, c.heading,
             d.path
      FROM kb_embeddings e
      JOIN kb_chunks c ON c.id = e.chunk_id
      JOIN kb_documents d ON d.id = c.doc_id
      WHERE e.model = 'gemini-embedding-2'
    `).all() as {
      chunk_id: number;
      embedding: Buffer;
      dimension: number;
      content: string;
      heading: string | null;
      path: string;
    }[];

    const scored: SearchResult[] = [];
    for (const row of rows) {
      const floatArray = new Float32Array(
        row.embedding.buffer,
        row.embedding.byteOffset,
        row.embedding.byteLength / 4
      );
      const storedVector = Array.from(floatArray);
      const score = cosineSimilarity(queryEmbedding, storedVector);
      scored.push({
        source: "semantic",
        path: row.path,
        heading: row.heading || undefined,
        content: row.content,
        rank: 1 - score, // lower = better (0 = perfect match)
      });
    }

    scored.sort((a, b) => a.rank - b.rank);
    return scored.slice(0, limit);
  }
}
