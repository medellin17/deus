import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { chunkMarkdown } from "./chunker.js";
import type { Embedder } from "./embeddings.js";

const SKIP_DIRS = ["node_modules", ".git", "dist", "build", ".next", "__pycache__"];

const DEFAULT_EXTENSIONS = [".md", ".txt", ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs"];

export class KBIndexer {
  private db: Database.Database;
  private embedder?: Embedder;

  constructor(db: Database.Database, embedder?: Embedder) {
    this.db = db;
    this.embedder = embedder;
  }

  indexFile(filePath: string): void {
    const content = fs.readFileSync(filePath, "utf-8");
    const hash = crypto.createHash("md5").update(content).digest("hex");

    const existing = this.db
      .prepare("SELECT id, content_hash FROM kb_documents WHERE path = ?")
      .get(filePath) as { id: number; content_hash: string } | undefined;

    if (existing && existing.content_hash === hash) {
      return;
    }

    const rawChunks = chunkMarkdown(content);
    const chunks = rawChunks.map((c, i) => ({
      index: i,
      heading: c.heading,
      level: c.level,
      text: c.content,
      tokens: c.tokenCount,
    }));

    if (existing) {
      this.db.prepare("DELETE FROM kb_chunks WHERE doc_id = ?").run(existing.id);
      this.db
        .prepare("UPDATE kb_documents SET content_hash = ?, updated_at = unixepoch() WHERE id = ?")
        .run(hash, existing.id);

      const docId = existing.id;
      const insertChunk = this.db.prepare(
        "INSERT INTO kb_chunks (doc_id, chunk_index, heading, level, content, token_count) VALUES (?, ?, ?, ?, ?, ?)"
      );
      const insertChunks = this.db.transaction((items: { index: number; heading: string; level: number; text: string; tokens: number }[]) => {
        for (const item of items) {
          insertChunk.run(docId, item.index, item.heading, item.level, item.text, item.tokens);
        }
      });
      insertChunks(chunks);
    } else {
      const result = this.db
        .prepare("INSERT INTO kb_documents (path, content_hash) VALUES (?, ?)")
        .run(filePath, hash);
      const docId = result.lastInsertRowid;
      const insertChunk = this.db.prepare(
        "INSERT INTO kb_chunks (doc_id, chunk_index, heading, level, content, token_count) VALUES (?, ?, ?, ?, ?, ?)"
      );
      const insertChunks = this.db.transaction((items: { index: number; heading: string; level: number; text: string; tokens: number }[]) => {
        for (const item of items) {
          insertChunk.run(docId, item.index, item.heading, item.level, item.text, item.tokens);
        }
      });
      insertChunks(chunks);
    }
  }

  indexDirectory(dirPath: string, extensions: string[] = DEFAULT_EXTENSIONS): void {
    const files: string[] = [];

    const walk = (dir: string) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (SKIP_DIRS.includes(entry.name)) continue;
          walk(path.join(dir, entry.name));
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name);
          if (extensions.includes(ext)) {
            files.push(path.join(dir, entry.name));
          }
        }
      }
    };

    walk(dirPath);

    for (const file of files) {
      try {
        this.indexFile(file);
      } catch {
        // skip unreadable files
      }
    }

    console.log(`[indexer] Indexed ${files.length} files`);
  }

  removeFile(filePath: string): void {
    this.db.prepare("DELETE FROM kb_documents WHERE path = ?").run(filePath);
  }

  stats(): { documents: number; chunks: number; embeddings: number } {
    const documents = (this.db.prepare("SELECT COUNT(*) as count FROM kb_documents").get() as { count: number }).count;
    const chunks = (this.db.prepare("SELECT COUNT(*) as count FROM kb_chunks").get() as { count: number }).count;
    const embeddings = (this.db.prepare("SELECT COUNT(*) as count FROM kb_embeddings").get() as { count: number }).count;
    return { documents, chunks, embeddings };
  }

  async generateEmbeddings(batchSize: number = 100): Promise<number> {
    if (!this.embedder) return 0;

    let totalProcessed = 0;
    let hasMore = true;

    while (hasMore) {
      const rows = this.db.prepare(`
        SELECT c.id, c.content, c.heading
        FROM kb_chunks c
        WHERE NOT EXISTS (SELECT 1 FROM kb_embeddings e WHERE e.chunk_id = c.id)
        LIMIT ?
      `).all(batchSize) as { id: number; content: string; heading: string | null }[];

      if (rows.length === 0) {
        hasMore = false;
        break;
      }

      // gemini-embedding-2: Document prefix format
      const texts = rows.map(r => {
        const heading = r.heading || "none";
        return `title: ${heading} | text: ${r.content}`;
      });

      let embeddings: number[][];
      try {
        embeddings = await this.embedder.embed(texts);
      } catch (err) {
        console.error(`[indexer] Ошибка генерации эмбеддингов для батча: ${err}`);
        break;
      }

      const insertStmt = this.db.prepare(`
        INSERT INTO kb_embeddings (chunk_id, model, dimension, embedding, created_at)
        VALUES (?, ?, ?, ?, unixepoch())
      `);

      const insertAll = this.db.transaction(() => {
        for (let i = 0; i < rows.length; i++) {
          const vector = embeddings[i];
          if (!vector) continue;
          const buffer = Buffer.from(new Float32Array(vector).buffer);
          insertStmt.run(rows[i].id, "gemini-embedding-2", vector.length, buffer);
        }
      });

      insertAll();
      totalProcessed += rows.length;
    }

    return totalProcessed;
  }
}
