import { tool } from "@opencode-ai/plugin"
import Database from "better-sqlite3"
import path from "path"
import fs from "fs"

export default tool({
  description: "Search project code using Smart Context (BM25 + symbol graph + import graph). Returns relevant code snippets with context.",
  args: {
    query: tool.schema.string().describe("Search query — describe what you're looking for (e.g., 'user authentication', 'database connection pool')"),
    project: tool.schema.string().optional().describe("Project root path. Defaults to the current workspace."),
    topN: tool.schema.number().optional().describe("Number of results to return (default: 10)"),
  },
  async execute(args, context) {
    const projectRoot = args.project || context.worktree || context.directory

    // Find the KB database
    const dbPath = path.join(projectRoot, ".deus", "kb", "orchestrator.db")

    if (!fs.existsSync(dbPath)) {
      return `Smart Context index not found at ${dbPath}. Run the orchestrator with --index flag first to create the index.\n\nExample: npx tsx src/orchestrator.ts --index ${projectRoot}`
    }

    let db: Database.Database | null = null
    try {
      // Open DB connection (separate from orchestrator's connection)
      db = new Database(dbPath, { readonly: true })
      db.pragma("journal_mode = WAL")
      db.pragma("busy_timeout = 5000")

      // Import SmartContextEngine dynamically (project module, may not always be resolvable)
      const { SmartContextEngine } = await import("../../src/kb/smart-context/index.ts")

      const engine = new SmartContextEngine(db)
      const result = engine.search(args.query, projectRoot, args.topN ?? 10)

      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return `Smart Context search failed: ${message}\n\nMake sure the project is indexed: npx tsx src/orchestrator.ts --index ${projectRoot}`
    } finally {
      if (db) {
        db.close()
      }
    }
  },
})
