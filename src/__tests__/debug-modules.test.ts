import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import * as testMetrics from "../metrics.js";
import { OrchestratorMonitor } from "../../.opencode/plugins/orchestrator-monitor.js";

let tempDir: string;
let originalCwd: string;

beforeEach(() => {
  testMetrics.closeMetrics();
  originalCwd = process.cwd();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mod-"));
  process.chdir(tempDir);
});

afterEach(() => {
  testMetrics.closeMetrics();
  process.chdir(originalCwd);
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { }
});

let hookCache: any;

async function makeHooks() {
  const hooks = await (OrchestratorMonitor as Function)({
    client: { app: { log: async () => {} }, session: { list: async () => ({ data: [] }) } },
    project: { id: "t", name: "t" },
    directory: "/tmp",
    worktree: "/tmp",
    $: async () => ({}),
  }) as any;
  hookCache = hooks;
  return hooks;
}

function emit(type: string, props: any) {
  return hookCache.event({ event: { type, properties: props } });
}

void describe("module singleton check", () => {
  void it("first - create session", async () => {
    const hooks = await makeHooks();
    console.log("CWD:", process.cwd());
    console.log("BEFORE event - totalCreated:", testMetrics.getMetric("totalCreated"));
    await emit("session.created", { info: { id: "x", title: "X", directory: "/tmp", time: { created: Date.now() } } });
    console.log("AFTER event - totalCreated:", testMetrics.getMetric("totalCreated"));
    assert.strictEqual(testMetrics.getMetric("totalCreated"), 1);
  });

  void it("second - create session again", async () => {
    const hooks = await makeHooks();
    console.log("CWD:", process.cwd());
    console.log("BEFORE event - totalCreated:", testMetrics.getMetric("totalCreated"));
    await emit("session.created", { info: { id: "y", title: "Y", directory: "/tmp", time: { created: Date.now() } } });
    console.log("AFTER event - totalCreated:", testMetrics.getMetric("totalCreated"));
    assert.strictEqual(testMetrics.getMetric("totalCreated"), 1);
  });
});
