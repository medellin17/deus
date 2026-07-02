import Database from "better-sqlite3";
import type { MemoryNode } from "./schema.js";

export type { MemoryNode };

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export class MemoryTree {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  upsert(
    path: string,
    level: "file" | "section" | "project" | "checkpoint",
    summary: string,
    tokenCount?: number,
    parentId?: number | null
  ): number {
    const row = this.db
      .prepare(
        `INSERT INTO kb_memory_tree(path, level, summary, token_count, parent_id) VALUES(?, ?, ?, ?, ?)
         ON CONFLICT(path, level) DO UPDATE SET
           summary = excluded.summary,
           token_count = excluded.token_count,
           parent_id = COALESCE(excluded.parent_id, parent_id),
           updated_at = unixepoch()
         RETURNING id`
      )
      .get(path, level, summary, tokenCount ?? 0, parentId ?? null) as { id: number };

    return row.id;
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
          token_count: number;
          parent_id: number | null;
          created_at: number;
          updated_at: number;
        }
      | undefined;

    if (!row) return null;

    return {
      id: row.id,
      path: row.path,
      level: row.level as "file" | "section" | "project" | "checkpoint",
      summary: row.summary,
      token_count: row.token_count,
      parent_id: row.parent_id,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  getByLevel(level: "file" | "section" | "project" | "checkpoint"): MemoryNode[] {
    const rows = this.db
      .prepare("SELECT * FROM kb_memory_tree WHERE level = ?")
      .all(level) as {
      id: number;
      path: string;
      level: string;
      summary: string;
      token_count: number;
      parent_id: number | null;
      created_at: number;
      updated_at: number;
    }[];

    return rows.map((row) => ({
      id: row.id,
      path: row.path,
      level: row.level as "file" | "section" | "project" | "checkpoint",
      summary: row.summary,
      token_count: row.token_count,
      parent_id: row.parent_id,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));
  }

  search(query: string, limit?: number): MemoryNode[] {
    const escaped = query.replace(/[%_]/g, "\\$&");
    const like = `%${escaped}%`;
    const rows = this.db
      .prepare(
        "SELECT * FROM kb_memory_tree WHERE summary LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\' LIMIT ?"
      )
      .all(like, like, limit ?? 100) as {
      id: number;
      path: string;
      level: string;
      summary: string;
      token_count: number;
      parent_id: number | null;
      created_at: number;
      updated_at: number;
    }[];

    return rows.map((row) => ({
      id: row.id,
      path: row.path,
      level: row.level as "file" | "section" | "project" | "checkpoint",
      summary: row.summary,
      token_count: row.token_count,
      parent_id: row.parent_id,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));
  }

  delete(path: string): void {
    this.db
      .prepare("DELETE FROM kb_memory_tree WHERE path = ?")
      .run(path);
  }

  async generateSummary(
    path: string,
    content: string
  ): Promise<{ summary: string; tokenCount: number }> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY required for auto-summary");

    const prompt = `Summarize the following content in Russian or English (match the language of the content). Keep the summary under 500 tokens. Focus on key functionality, data flow, public API, and important decisions. Be concise.

Content:
${content.slice(0, 10000)}`;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 500, temperature: 0.3 },
        }),
      }
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`LLM API error ${response.status}: ${text.slice(0, 200)}`);
    }

    const data = (await response.json()) as {
      candidates?: Array<{
        content?: {
          parts?: Array<{ text?: string }>;
        };
      }>;
    };
    const summary =
      data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    const tokenCount = estimateTokens(summary);

    return { summary, tokenCount };
  }

  async autoSummarize(
    path: string,
    content: string,
    level: "file" | "section" | "project" | "checkpoint",
    parentId?: number
  ): Promise<MemoryNode> {
    const { summary, tokenCount } = await this.generateSummary(path, content);

    // Truncate if exceeded 500 tokens
    const validSummary =
      tokenCount > 500 ? summary.slice(0, Math.floor(500 * 4)) : summary;
    const validTokenCount = estimateTokens(validSummary);

    const id = this.upsert(path, level, validSummary, validTokenCount, parentId ?? null);

    return {
      id,
      path,
      level,
      summary: validSummary,
      token_count: validTokenCount,
      parent_id: parentId ?? null,
      created_at: Math.floor(Date.now() / 1000),
      updated_at: Math.floor(Date.now() / 1000),
    } as MemoryNode;
  }
}
