import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  incrementMetric,
  setMetric,
  getMetric,
  getMetrics,
  updateAvgDuration,
  upsertSession,
  getSession,
  deleteSession,
  getAllSessions,
  closeMetrics,
} from "../metrics.js";

let tempDir: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "metrics-test-"));
  process.chdir(tempDir);
});

afterEach(async () => {
  await closeMetrics();
  process.chdir(originalCwd);
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
});

void describe("metrics module", () => {
  void it("incrementMetric increases value by delta", async () => {
    await incrementMetric("totalCreated", 1);
    await incrementMetric("totalCreated", 1);
    assert.strictEqual(await getMetric("totalCreated"), 2);
  });

  void it("incrementMetric defaults to delta=1", async () => {
    await incrementMetric("totalCreated");
    assert.strictEqual(await getMetric("totalCreated"), 1);
  });

  void it("setMetric sets a specific value", async () => {
    await setMetric("activeSessions", 5);
    assert.strictEqual(await getMetric("activeSessions"), 5);
  });

  void it("getMetrics returns all expected keys with correct values", async () => {
    await setMetric("totalCreated", 3);
    await setMetric("totalCompleted", 2);
    await setMetric("totalFailed", 1);
    await setMetric("activeSessions", 4);
    await setMetric("avgDurationMs", 1500);

    const metrics = await getMetrics();
    assert.strictEqual(metrics.totalCreated, 3);
    assert.strictEqual(metrics.totalCompleted, 2);
    assert.strictEqual(metrics.totalFailed, 1);
    assert.strictEqual(metrics.activeSessions, 4);
    assert.strictEqual(metrics.avgDurationMs, 1500);
  });

  void it("getMetric returns 0 for unknown key", async () => {
    assert.strictEqual(await getMetric("nonexistent"), 0);
  });

  void it("updateAvgDuration handles first completion (completed=0)", async () => {
    await setMetric("totalCompleted", 0);
    await updateAvgDuration(1000);
    assert.strictEqual(await getMetric("avgDurationMs"), 1000);
  });

  void it("updateAvgDuration handles second completion (completed=1)", async () => {
    await setMetric("totalCompleted", 0);
    await updateAvgDuration(1000);
    // Simulate second completion: totalCompleted incremented to 1
    await setMetric("totalCompleted", 1);
    await updateAvgDuration(2000);
    assert.strictEqual(await getMetric("avgDurationMs"), 2000);
  });

  void it("updateAvgDuration computes running average for 3+ completions", async () => {
    // Setup: first two completions to establish baseline
    await setMetric("totalCompleted", 0);
    await updateAvgDuration(1000);
    await setMetric("totalCompleted", 1);
    await updateAvgDuration(2000);

    // Third completion: totalCompleted = 2
    // avg = 2000 + (3000 - 2000) / 2 = 2500
    await setMetric("totalCompleted", 2);
    await updateAvgDuration(3000);
    assert.strictEqual(await getMetric("avgDurationMs"), 2500);

    // Fourth: totalCompleted = 3
    // avg = 2500 + (1000 - 2500) / 3 = 2000
    await setMetric("totalCompleted", 3);
    await updateAvgDuration(1000);
    assert.strictEqual(await getMetric("avgDurationMs"), 2000);
  });

  void it("upsertSession and getSession round-trip a session", async () => {
    const session = {
      id: "test-1",
      title: "Test Session",
      directory: "/tmp",
      agent: "test-agent",
      status: "active",
      startedAt: Date.now(),
      completedAt: null,
      durationMs: null,
    };
    await upsertSession(session);
    const retrieved = await getSession("test-1");
    assert.notStrictEqual(retrieved, null);
    assert.strictEqual(retrieved!.id, session.id);
    assert.strictEqual(retrieved!.title, session.title);
    assert.strictEqual(retrieved!.directory, session.directory);
    assert.strictEqual(retrieved!.agent, session.agent);
    assert.strictEqual(retrieved!.status, session.status);
    assert.strictEqual(retrieved!.startedAt, session.startedAt);
    assert.strictEqual(retrieved!.completedAt, session.completedAt);
    assert.strictEqual(retrieved!.durationMs, session.durationMs);
  });

  void it("upsertSession overwrites existing session", async () => {
    await upsertSession({
      id: "test-1",
      title: "Original",
      directory: "/tmp",
      agent: "a1",
      status: "active",
      startedAt: 1000,
      completedAt: null,
      durationMs: null,
    });
    await upsertSession({
      id: "test-1",
      title: "Updated",
      directory: "/tmp",
      agent: "a1",
      status: "completed",
      startedAt: 1000,
      completedAt: 2000,
      durationMs: 1000,
    });
    const retrieved = await getSession("test-1");
    assert.strictEqual(retrieved!.title, "Updated");
    assert.strictEqual(retrieved!.status, "completed");
    assert.strictEqual(retrieved!.completedAt, 2000);
  });

  void it("getSession returns null for non-existent session", async () => {
    assert.strictEqual(await getSession("nonexistent"), null);
  });

  void it("deleteSession removes a session", async () => {
    await upsertSession({
      id: "test-2",
      title: "To Delete",
      directory: "/tmp",
      agent: "agent",
      status: "active",
      startedAt: 1000,
      completedAt: null,
      durationMs: null,
    });
    await deleteSession("test-2");
    assert.strictEqual(await getSession("test-2"), null);
  });

  void it("getAllSessions returns sessions ordered by startedAt DESC", async () => {
    const sessions = [
      { id: "s1", title: "First", directory: "/tmp", agent: "a1", status: "active", startedAt: 1000, completedAt: null, durationMs: null },
      { id: "s2", title: "Second", directory: "/tmp", agent: "a2", status: "completed", startedAt: 2000, completedAt: 3000, durationMs: 1000 },
      { id: "s3", title: "Third", directory: "/tmp", agent: "a3", status: "failed", startedAt: 3000, completedAt: 4000, durationMs: 1000 },
    ];
    for (const s of sessions) {
      await upsertSession(s);
    }
    const all = await getAllSessions();
    assert.strictEqual(all.length, 3);
    // Ordered by started_at DESC: s3, s2, s1
    assert.strictEqual(all[0].id, "s3");
    assert.strictEqual(all[1].id, "s2");
    assert.strictEqual(all[2].id, "s1");
  });
});
