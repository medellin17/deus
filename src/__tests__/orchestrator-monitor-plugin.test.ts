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

function cast<T>(value: unknown): T {
  return value as T
}

describe("OrchestratorMonitor Plugin", () => {
  it("exports default plugin function", async () => {
    const mod = await import("../../.opencode/plugins/orchestrator-monitor.ts")
    assert.ok(mod.default)
    assert.strictEqual(typeof mod.default, "function")
  })

  it("returns hooks object with event, tool.execute.before, tool.execute.after", async () => {
    const { default: plugin } = await import("../../.opencode/plugins/orchestrator-monitor.ts")
    type Ctx = Parameters<typeof plugin>[0]
    const ctx = cast<Ctx>({
      project: { id: "test", worktree: tempDir, time: { created: Date.now() } },
      client: { app: { log: async () => {} }, session: { list: async () => ({ data: [] }) } },
      directory: tempDir,
      worktree: tempDir,
      experimental_workspace: { register: () => {} },
      serverUrl: new URL("http://localhost:4096"),
      $: cast<Ctx["$"]>(async () => ({ stdout: "", stderr: "", exitCode: 0, success: true })),
    })
    const hooks = await plugin(ctx)
    assert.ok(typeof hooks.event === "function", "event hook exists")
    assert.ok(typeof hooks["tool.execute.before"] === "function", "tool.execute.before hook exists")
    assert.ok(typeof hooks["tool.execute.after"] === "function", "tool.execute.after hook exists")
  })

  it("event handler does not throw on session.created", async () => {
    const { default: plugin } = await import("../../.opencode/plugins/orchestrator-monitor.ts")
    type Ctx = Parameters<typeof plugin>[0]
    type Hooks = Awaited<ReturnType<typeof plugin>>
    type EventInput = Parameters<NonNullable<Hooks["event"]>>[0]
    const ctx = cast<Ctx>({
      project: { id: "test", worktree: tempDir, time: { created: Date.now() } },
      client: { app: { log: async () => {} }, session: { list: async () => ({ data: [] }) } },
      directory: tempDir,
      worktree: tempDir,
      experimental_workspace: { register: () => {} },
      serverUrl: new URL("http://localhost:4096"),
      $: cast<Ctx["$"]>(async () => ({ stdout: "", stderr: "", exitCode: 0, success: true })),
    })
    const hooks = await plugin(ctx)

    const input = cast<EventInput>({
      event: {
        type: "session.created",
        properties: {
          info: {
            id: "test-session-1",
            projectID: "test",
            title: "Test Session",
            directory: tempDir,
            version: "1",
            time: { created: Date.now(), updated: Date.now() },
          },
        },
      },
    })
    await hooks.event!(input)
  })

  it("tool.execute.before does not throw", async () => {
    const { default: plugin } = await import("../../.opencode/plugins/orchestrator-monitor.ts")
    type Ctx = Parameters<typeof plugin>[0]
    type Hooks = Awaited<ReturnType<typeof plugin>>
    type ToolInput = Parameters<NonNullable<Hooks["tool.execute.before"]>>[0]
    type ToolOutput = Parameters<NonNullable<Hooks["tool.execute.before"]>>[1]
    const ctx = cast<Ctx>({
      project: { id: "test", worktree: tempDir, time: { created: Date.now() } },
      client: { app: { log: async () => {} }, session: { list: async () => ({ data: [] }) } },
      directory: tempDir,
      worktree: tempDir,
      experimental_workspace: { register: () => {} },
      serverUrl: new URL("http://localhost:4096"),
      $: cast<Ctx["$"]>(async () => ({ stdout: "", stderr: "", exitCode: 0, success: true })),
    })
    const hooks = await plugin(ctx)

    const input = cast<ToolInput>({ tool: "read", sessionID: "test-session", callID: "call-1", args: { filePath: "/test.ts" } })
    const output = cast<ToolOutput>({ args: { filePath: "/test.ts" } })
    await hooks["tool.execute.before"]!(input, output)
  })

  it("tool.execute.after does not throw", async () => {
    const { default: plugin } = await import("../../.opencode/plugins/orchestrator-monitor.ts")
    type Ctx = Parameters<typeof plugin>[0]
    type Hooks = Awaited<ReturnType<typeof plugin>>
    type ToolInput = Parameters<NonNullable<Hooks["tool.execute.after"]>>[0]
    type ToolOutput = Parameters<NonNullable<Hooks["tool.execute.after"]>>[1]
    const ctx = cast<Ctx>({
      project: { id: "test", worktree: tempDir, time: { created: Date.now() } },
      client: { app: { log: async () => {} }, session: { list: async () => ({ data: [] }) } },
      directory: tempDir,
      worktree: tempDir,
      experimental_workspace: { register: () => {} },
      serverUrl: new URL("http://localhost:4096"),
      $: cast<Ctx["$"]>(async () => ({ stdout: "", stderr: "", exitCode: 0, success: true })),
    })
    const hooks = await plugin(ctx)

    const input = cast<ToolInput>({ tool: "read", sessionID: "test-session", callID: "call-1", args: { filePath: "/test.ts" } })
    const output = cast<ToolOutput>({ args: { filePath: "/test.ts" } })
    await hooks["tool.execute.after"]!(input, output)
  })
})
