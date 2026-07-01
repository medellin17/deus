import { describe, it } from "node:test";
import assert from "node:assert";
import { NoopKbProvider } from "../../kb/noop-provider.js";
import type { KbProvider } from "../../kb/provider.js";

void describe("NoopKbProvider", () => {
  void it("indexFile does nothing", () => {
    const p = new NoopKbProvider();
    assert.doesNotThrow(() => p.indexFile("/some/path"));
  });

  void it("indexDirectory does nothing", () => {
    const p = new NoopKbProvider();
    assert.doesNotThrow(() => p.indexDirectory("/some/dir"));
    assert.doesNotThrow(() => p.indexDirectory("/some/dir", [".ts"]));
  });

  void it("removeFile does nothing", () => {
    const p = new NoopKbProvider();
    assert.doesNotThrow(() => p.removeFile("/some/path"));
  });

  void it("search returns empty array", () => {
    const p = new NoopKbProvider();
    assert.deepStrictEqual(p.search("query"), []);
    assert.deepStrictEqual(p.search("query", 10), []);
  });

  void it("getContext returns empty string", () => {
    const p = new NoopKbProvider();
    assert.strictEqual(p.getContext("task"), "");
    assert.strictEqual(p.getContext("task", 1000), "");
  });

  void it("hasContext returns false", () => {
    const p = new NoopKbProvider();
    assert.strictEqual(p.hasContext(), false);
  });

  void it("upsertMemory does nothing", () => {
    const p = new NoopKbProvider();
    assert.doesNotThrow(() => p.upsertMemory("/path", "file", "summary"));
    assert.doesNotThrow(() => p.upsertMemory("/path", "module", "summary"));
    assert.doesNotThrow(() => p.upsertMemory("/path", "project", "summary"));
  });

  void it("getMemory returns null", () => {
    const p = new NoopKbProvider();
    assert.strictEqual(p.getMemory("/path"), null);
  });

  void it("stats returns all zeros", () => {
    const p = new NoopKbProvider();
    const s = p.stats();
    assert.strictEqual(s.documents, 0);
    assert.strictEqual(s.chunks, 0);
    assert.strictEqual(s.embeddings, 0);
  });

  void it("close does nothing", () => {
    const p = new NoopKbProvider();
    assert.doesNotThrow(() => p.close());
  });

  void it("implements KbProvider interface", () => {
    // Compile-time check — if it compiles, interface is satisfied
    const p: KbProvider = new NoopKbProvider();
    assert.ok(p instanceof NoopKbProvider);
  });
});
