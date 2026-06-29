import Database from "better-sqlite3";

export class SuperContext {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  getContext(task: string, maxTokens: number = 2000): string {
    const chunks = this.db
      .prepare(
        "SELECT rowid, content, heading, rank FROM kb_chunks_fts WHERE kb_chunks_fts MATCH ? ORDER BY rank LIMIT 5"
      )
      .all(task) as Array<{
      rowid: number;
      content: string;
      heading: string;
      rank: number;
    }>;

    const summaries = this.db
      .prepare(
        "SELECT path, summary FROM kb_memory_tree WHERE summary LIKE ? LIMIT 5"
      )
      .all(`%${task}%`) as Array<{ path: string; summary: string }>;

    const projectSummary = this.db
      .prepare(
        "SELECT summary FROM kb_memory_tree WHERE level = 'project' LIMIT 1"
      )
      .get() as { summary: string } | undefined;

    const lines: string[] = [];
    lines.push("## Project Context (auto-generated)");
    lines.push("");
    lines.push("### Project Overview");
    lines.push(
      projectSummary?.summary ?? "No project summary available"
    );
    lines.push("");

    if (chunks.length > 0) {
      lines.push("### Relevant Code");
      for (const chunk of chunks) {
        const preview = chunk.content.slice(0, 500);
        lines.push(`- **${chunk.heading}**: ${preview}`);
      }
      lines.push("");
    }

    if (summaries.length > 0) {
      lines.push("### Relevant Documentation");
      for (const s of summaries) {
        lines.push(`- **${s.path}**: ${s.summary}`);
      }
      lines.push("");
    }

    const keyFiles = new Set<string>();
    for (const chunk of chunks) {
      keyFiles.add(chunk.heading);
    }
    for (const s of summaries) {
      keyFiles.add(s.path);
    }

    if (keyFiles.size > 0) {
      lines.push("### Key Files");
      for (const f of keyFiles) {
        lines.push(`- ${f}`);
      }
      lines.push("");
    }

    let context = lines.join("\n");
    const maxChars = maxTokens * 4;
    if (context.length > maxChars) {
      context = context.slice(0, maxChars);
    }
    return context;
  }

  hasContext(): boolean {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM kb_chunks")
      .get() as { count: number };
    return row.count > 0;
  }
}
