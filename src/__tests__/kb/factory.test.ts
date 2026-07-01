import { describe, it } from "node:test";
import assert from "node:assert";
import path from "node:path";
import os from "node:os";
import { createKB, RagKbProvider, NoopKbProvider } from "../../kb/index.js";

// Use temp directory for DB paths that actually create a database
const tmpDb = path.join(os.tmpdir(), "orchestrator-factory-test.db");

void describe("createKB factory", () => {
  void it("returns RagKbProvider by default (no args)", () => {
    const kb = createKB();
    assert.ok(kb instanceof RagKbProvider);
  });

  void it("returns RagKbProvider when useRag is true", () => {
    const kb = createKB(undefined, true);
    assert.ok(kb instanceof RagKbProvider);
  });

  void it("returns NoopKbProvider when useRag is false", () => {
    const kb = createKB(undefined, false);
    assert.ok(kb instanceof NoopKbProvider);
  });

  void it("returns RagKbProvider when only dbPath given (backward compat)", () => {
    const kb = createKB(tmpDb);
    assert.ok(kb instanceof RagKbProvider);
  });

  void it("returns correct type for all combinations", () => {
    assert.ok(createKB(tmpDb, true) instanceof RagKbProvider);
    assert.ok(createKB(tmpDb, false) instanceof NoopKbProvider);
    assert.ok(createKB(undefined, true) instanceof RagKbProvider);
    assert.ok(createKB(undefined, false) instanceof NoopKbProvider);
  });
});
