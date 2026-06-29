import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const SKIP_DIRS = ["node_modules", ".git", "dist", "build", ".next", "__pycache__"];

const DEFAULT_EXTENSIONS = [".md", ".txt", ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs"];

export class KBIndexer {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
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

    const chunks = this.chunkContent(content);

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

  private chunkContent(content: string): { index: number; heading: string; level: number; text: string; tokens: number }[] {
    const lines = content.split("\n");
    const chunks: { index: number; heading: string; level: number; text: string; tokens: number }[] = [];
    let currentLines: string[] = [];
    let chunkIndex = 0;
    let currentHeading = "";
    let currentLevel = 0;

    const flush = () => {
      if (currentLines.length === 0) return;
      const text = currentLines.join("\n").trim();
      if (text.length > 0) {
        chunks.push({
          index: chunkIndex++,
          heading: currentHeading,
          level: currentLevel,
          text,
          tokens: Math.ceil(text.length / 4),
        });
      }
      currentLines = [];
    };

    for (const line of lines) {
      const headerMatch = line.match(/^(#{1,3})\s+(.+)/);
      if (headerMatch) {
        flush();
        currentLevel = headerMatch[1].length;
        currentHeading = headerMatch[2];
      }
      currentLines.push(line);
    }

    flush();
    return chunks;
  }
}
