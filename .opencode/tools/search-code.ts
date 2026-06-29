import { tool } from "@opencode-ai/plugin"
import { execSync } from "child_process"

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
      const result = execSync(
        `npx code-assistant ask "${args.query}" "${args.project}" --top ${top}`,
        { encoding: "utf-8", timeout: 15000 }
      )
      return result
    } catch (err: any) {
      return `search-code tool unavailable: smart-context-retrieving not installed. Install from local path or use grep/search instead.\nError: ${err.message}`
    }
  },
})
