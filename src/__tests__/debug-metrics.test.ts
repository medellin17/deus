import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  getMetric,
  closeMetrics,
  incrementMetric,
} from "../metrics.js";

let tempDir: string;
let originalCwd: string;

beforeEach(() => {
  closeMetrics();
  originalCwd = process.cwd();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "debug-"));
  process.chdir(tempDir);
  console.log("beforeEach CWD:", process.cwd());
});

afterEach(() => {
  closeMetrics();
  process.chdir(originalCwd);
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch { }
});

void describe("debug metrics isolation", () => {
  void it("first test", () => {
    console.log("test1 CWD:", process.cwd());
    incrementMetric("totalCreated", 1);
    const v = getMetric("totalCreated");
    console.log("test1 totalCreated:", v);
    assert.strictEqual(v, 1);
  });

  void it("second test", () => {
    console.log("test2 CWD:", process.cwd());
    incrementMetric("totalCreated", 1);
    const v = getMetric("totalCreated");
    console.log("test2 totalCreated:", v);
    assert.strictEqual(v, 1);
  });

  void it("third test", () => {
    console.log("test3 CWD:", process.cwd());
    incrementMetric("totalCreated", 1);
    const v = getMetric("totalCreated");
    console.log("test3 totalCreated:", v);
    assert.strictEqual(v, 1);
  });
});
