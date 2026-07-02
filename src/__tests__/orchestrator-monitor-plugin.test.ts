import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert"
import fs from "fs"
import path from "path"
import os from "os"

// ---------------------------------------------------------------------------
// Each test gets a fresh temp directory so the plugin's metrics DB is
// isolated. This is a STRUCTURAL test — metrics logic is covered by
// metrics.test.ts, so we only verify the plugin exports and hook shapes.
// ---------------------------------------------------------------------------

let tempDir: string
let originalCwd: string

beforeEach(() => {
  originalCwd = process.cwd()
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-test-"))
  process.chdir(tempDir)
})

afterEach(() => {
  process.chdir(originalCwd)
  try {
    fs.rmSync(tempDir, { recursive: true, force: true })
  } catch {
    // ignore cleanup errors
  }
})

describe("OrchestratorMonitor Plugin", () => {
  it("exports OrchestratorMonitor as a function", async () => {
    const mod = await import("../../.opencode/plugins/orchestrator-monitor.ts")
    assert.ok(mod.OrchestratorMonitor)
    assert.strictEqual(typeof mod.OrchestratorMonitor, "function")
  })

  it("returns hooks object with event, tool.execute.before, tool.execute.after", async () => {
    const { OrchestratorMonitor } = await import("../../.opencode/plugins/orchestrator-monitor.ts")
    const mockCtx = {
      project: { id: "test", name: "test" },
      client: {
        app: { log: async () => {} },
        session: { list: async () => ({ data: [] }) },
      },
      $: async () => ({}),
      directory: tempDir,
      worktree: tempDir,
    }
    const hooks = await OrchestratorMonitor(mockCtx as any)
    assert.ok(typeof hooks.event === "function", "event hook exists")
    assert.ok(typeof hooks["tool.execute.before"] === "function", "tool.execute.before hook exists")
    assert.ok(typeof hooks["tool.execute.after"] === "function", "tool.execute.after hook exists")
  })

  it("event handler does not throw on session.created", async () => {
    const { OrchestratorMonitor } = await import("../../.opencode/plugins/orchestrator-monitor.ts")
    const mockCtx = {
      project: { id: "test", name: "test" },
      client: {
        app: { log: async () => {} },
        session: { list: async () => ({ data: [] }) },
      },
      $: async () => ({}),
      directory: tempDir,
      worktree: tempDir,
    }
    const hooks = await OrchestratorMonitor(mockCtx as any)

    await hooks.event!({
      event: {
        type: "session.created",
        properties: {
          info: {
            id: "test-session-1",
            title: "Test Session",
            directory: tempDir,
            time: { created: Date.now(), updated: Date.now() },
          },
        },
      },
    } as any)
  })

  it("tool.execute.before does not throw", async () => {
    const { OrchestratorMonitor } = await import("../../.opencode/plugins/orchestrator-monitor.ts")
    const mockCtx = {
      project: { id: "test", name: "test" },
      client: {
        app: { log: async () => {} },
        session: { list: async () => ({ data: [] }) },
      },
      $: async () => ({}),
      directory: tempDir,
      worktree: tempDir,
    }
    const hooks = await OrchestratorMonitor(mockCtx as any)

    const input = { tool: "read", sessionID: "test-session" }
    const output = { args: { filePath: "/test.ts" } }
    await hooks["tool.execute.before"]!(input as any, output as any)
  })

  it("tool.execute.after does not throw", async () => {
    const { OrchestratorMonitor } = await import("../../.opencode/plugins/orchestrator-monitor.ts")
    const mockCtx = {
      project: { id: "test", name: "test" },
      client: {
        app: { log: async () => {} },
        session: { list: async () => ({ data: [] }) },
      },
      $: async () => ({}),
      directory: tempDir,
      worktree: tempDir,
    }
    const hooks = await OrchestratorMonitor(mockCtx as any)

    const input = { tool: "read", sessionID: "test-session" }
    const output = { args: { filePath: "/test.ts" } }
    await hooks["tool.execute.after"]!(input as any, output as any)
  })
})
