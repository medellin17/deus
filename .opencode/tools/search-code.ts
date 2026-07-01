import { tool } from "@opencode-ai/plugin"
import { spawnSync } from "child_process"

export default tool({
  description: "Search project code using BM25 + Symbol Graph + Graph Walk. Use before reading or editing code to find relevant files.",
  args: {
    query: tool.schema.string().describe("Search query (what you're looking for)"),
    project: tool.schema.string().describe("Project root path"),
    top: tool.schema.number().optional().describe("Number of results (default 10)"),
  },
  async execute(args) {
    const top = args.top || 10
    try {
      const result = spawnSync("npx", ["code-assistant", "ask", args.query, args.project, "--top", String(top)], {
        encoding: "utf-8",
        timeout: 15000,
        shell: false,
      })
      if (result.error) throw result.error
      if (result.status !== 0) throw new Error(`search-code failed with status ${result.status}: ${result.stderr}`)
      return result.stdout
    } catch (err: any) {
      return `search-code tool unavailable: smart-context-retrieving not installed. Install from local path or use grep/search instead.\nError: ${err.message}`
    }
  },
})
