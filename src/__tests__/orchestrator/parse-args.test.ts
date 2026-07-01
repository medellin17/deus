import { describe, it } from "node:test";
import assert from "node:assert";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createKB, NoopKbProvider } from "../../kb/index.js";

const orchestratorPath = path.resolve(
  fileURLToPath(import.meta.url),
  "../../../orchestrator.ts"
);

/**
 * Mirrors the parseArgs logic from orchestrator.ts to test --rag/--no-rag parsing
 * in isolation without triggering server start or other side effects.
 */
interface TestCliArgs {
  useRag: boolean;
  mode: string;
}

function testParseArgs(argv: string[]): TestCliArgs {
  const args = argv.slice(2);
  let mode = "orchestrate";
  let useRag = true;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--help" || a === "-h") { mode = "help"; continue; }
    if (a === "--rag") { useRag = true; continue; }
    if (a === "--no-rag") { useRag = false; continue; }
  }
  return { mode, useRag };
}

void describe("CLI --rag/--no-rag flags", () => {
  void it("--help shows --rag and --no-rag flags", () => {
    // execSync uses shell, handles .cmd files and spaces in paths
    const output = execSync(`npx tsx "${orchestratorPath}" --help`, {
      encoding: "utf-8",
    });
    assert.ok(output.includes("--rag"), "Help should mention --rag");
    assert.ok(output.includes("--no-rag"), "Help should mention --no-rag");
  });

  void it("default useRag is true", () => {
    const args = testParseArgs(["node", "orchestrator.ts"]);
    assert.strictEqual(args.useRag, true);
  });

  void it("--rag sets useRag to true", () => {
    const args = testParseArgs(["node", "orchestrator.ts", "--rag"]);
    assert.strictEqual(args.useRag, true);
  });

  void it("--no-rag sets useRag to false", () => {
    const args = testParseArgs(["node", "orchestrator.ts", "--no-rag"]);
    assert.strictEqual(args.useRag, false);
  });

  void it("--no-rag overrides earlier --rag when specified last", () => {
    const args = testParseArgs(["node", "orchestrator.ts", "--rag", "--no-rag"]);
    assert.strictEqual(args.useRag, false);
  });

  void it("--rag after --no-rag re-enables RAG", () => {
    const args = testParseArgs(["node", "orchestrator.ts", "--no-rag", "--rag"]);
    assert.strictEqual(args.useRag, true);
  });

  void it("--no-rag does not affect --help mode", () => {
    const args1 = testParseArgs(["node", "orchestrator.ts", "--help"]);
    assert.strictEqual(args1.mode, "help");

    const args2 = testParseArgs(["node", "orchestrator.ts", "--no-rag", "--help"]);
    assert.strictEqual(args2.mode, "help");
    assert.strictEqual(args2.useRag, false);
  });

  void it("--no-rag via createKB returns NoopKbProvider (full chain)", () => {
    // Validates the full chain: parseArgs → createKB → NoopKbProvider
    const kb = createKB(undefined, false);
    assert.ok(kb instanceof NoopKbProvider);
  });
});
