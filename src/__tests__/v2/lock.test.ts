import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  acquireProjectLock,
  isAlive,
  projectLockPath,
  RunBusyError,
} from "../../v2/lock.ts";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deus-lock-"));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function writeLock(dir: string, owner: Record<string, unknown>): void {
  fs.mkdirSync(path.join(dir, ".deus"), { recursive: true });
  fs.writeFileSync(projectLockPath(dir), `${JSON.stringify(owner)}\n`, "utf-8");
}

void describe("isAlive", () => {
  void it("sees a dead process through ESRCH", () => {
    assert.equal(
      isAlive(1234, () => {
        const error = new Error("no such process") as NodeJS.ErrnoException;
        error.code = "ESRCH";
        throw error;
      }),
      false,
    );
  });

  void it("treats EPERM as alive: the process exists, it is just not ours", () => {
    assert.equal(
      isAlive(1234, () => {
        const error = new Error("operation not permitted") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      }),
      true,
    );
  });

  void it("is alive for the current process", () => {
    assert.equal(isAlive(process.pid), true);
  });
});

void describe("acquireProjectLock", () => {
  void it("takes and releases the lock", () => {
    const dir = tempDir();
    const lock = acquireProjectLock(dir, "run-a", "team");

    assert.ok(fs.existsSync(projectLockPath(dir)));
    assert.equal(lock.runId, "run-a");
    lock.release();
    assert.equal(fs.existsSync(projectLockPath(dir)), false);
  });

  void it("refuses a second run while the first is alive", () => {
    const dir = tempDir();
    const lock = acquireProjectLock(dir, "run-a", "team");
    try {
      assert.throws(
        () => acquireProjectLock(dir, "run-b", "pipeline"),
        (error: unknown) => error instanceof RunBusyError && /another run is active/.test(error.message),
      );
    } finally {
      lock.release();
    }
  });

  void it("steals a lock whose owner is dead", () => {
    const dir = tempDir();
    // A child that has already exited: its pid is a real, dead pid.
    const child = spawnSync(process.execPath, ["-e", ""]);
    assert.equal(typeof child.pid, "number");
    writeLock(dir, { pid: child.pid, runId: "run-dead", kind: "team" });

    const lock = acquireProjectLock(dir, "run-new", "team");
    try {
      const owner = JSON.parse(fs.readFileSync(projectLockPath(dir), "utf-8")) as {
        runId: string;
      };
      assert.equal(owner.runId, "run-new");
    } finally {
      lock.release();
    }
  });

  void it("does not release a lock that belongs to someone else", () => {
    const dir = tempDir();
    const lock = acquireProjectLock(dir, "run-a", "team");
    // Simulate a lock taken over by another process with the same pid (as a
    // restart would), then release ours: it must survive.
    writeLock(dir, { pid: process.pid, runId: "run-other", kind: "pipeline" });

    lock.release();

    assert.ok(fs.existsSync(projectLockPath(dir)));
    const owner = JSON.parse(fs.readFileSync(projectLockPath(dir), "utf-8")) as {
      runId: string;
    };
    assert.equal(owner.runId, "run-other");
  });

  void it("steals an unreadable lock once it is old enough", () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, ".deus"), { recursive: true });
    fs.writeFileSync(projectLockPath(dir), "not json", "utf-8");
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(projectLockPath(dir), old, old);

    const lock = acquireProjectLock(dir, "run-after", "team");
    try {
      const owner = JSON.parse(fs.readFileSync(projectLockPath(dir), "utf-8")) as {
        runId: string;
      };
      assert.equal(owner.runId, "run-after");
    } finally {
      lock.release();
    }
  });

  void it("treats a fresh unreadable lock as busy instead of stealing it", () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, ".deus"), { recursive: true });
    fs.writeFileSync(projectLockPath(dir), "not json", "utf-8");

    assert.throws(
      () => acquireProjectLock(dir, "run-a", "team"),
      (error: unknown) => error instanceof RunBusyError,
    );
  });
});
