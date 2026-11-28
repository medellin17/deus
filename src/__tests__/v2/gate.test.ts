import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  applyBaseline,
  failureSignatures,
  runCheck,
  runGate,
  truncateCheckOutput,
} from "../../v2/gate.ts";
import type { CheckCommand, CheckResult, GateResult } from "../../v2/types.ts";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deus-gate-"));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

void describe("runCheck", () => {
  void it("passes on exit code 0", async () => {
    const result = await runCheck({ name: "ok", command: "true" }, tempDir());
    assert.equal(result.status, "passed");
    assert.equal(result.exitCode, 0);
  });

  void it("fails on a non-zero exit code and keeps the output", async () => {
    const result = await runCheck(
      { name: "bad", command: "echo boom && exit 3" },
      tempDir(),
    );
    assert.equal(result.status, "failed");
    assert.equal(result.exitCode, 3);
    assert.match(result.output, /boom/);
  });

  void it("marks a check as timed out", async () => {
    const result = await runCheck({ name: "slow", command: "sleep 5" }, tempDir(), 100);
    assert.equal(result.status, "timedOut");
  });

  void it("aborts a running check", async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 50);
    try {
      const result = await runCheck(
        { name: "slow", command: "sleep 5" },
        tempDir(),
        5_000,
        controller.signal,
      );
      assert.equal(result.status, "failed");
      assert.ok(result.durationMs < 2_000, `abort took ${result.durationMs}ms`);
    } finally {
      clearTimeout(timer);
    }
  });
});

void describe("runGate", () => {
  void it("returns skipped without checks", async () => {
    const gate = await runGate([], tempDir());
    assert.equal(gate.status, "skipped");
    assert.deepEqual(gate.checks, []);
  });

  void it("stops at the first failing check", async () => {
    const checks: CheckCommand[] = [
      { name: "first", command: "false" },
      { name: "second", command: "true" },
    ];

    const gate = await runGate(checks, tempDir());

    assert.equal(gate.status, "failed");
    assert.equal(gate.checks.length, 1);
    assert.equal(gate.checks[0].name, "first");
    assert.match(gate.error ?? "", /check "first" failed/);
  });

  void it("runs checks in the work directory", async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "marker"), "1", "utf-8");

    const gate = await runGate([{ name: "marker", command: "test -f marker" }], dir);

    assert.equal(gate.status, "passed");
  });

  void it("does not block the event loop while a check runs", async () => {
    const started = Date.now();
    const pending = runGate([{ name: "slow", command: "sleep 0.2" }], tempDir());
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(Date.now() - started < 150, "the event loop was blocked by the check");
    const gate = await pending;
    assert.equal(gate.status, "passed");
  });

  void it("marks an interrupted gate as aborted", async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 50);
    try {
      const gate = await runGate(
        [{ name: "slow", command: "sleep 5" }],
        tempDir(),
        { signal: controller.signal },
      );
      assert.equal(gate.status, "failed");
      assert.equal(gate.aborted, true);
      assert.match(gate.error ?? "", /interrupted/);
    } finally {
      clearTimeout(timer);
    }
  });
});

void describe("truncateCheckOutput", () => {
  void it("keeps short output as is", () => {
    assert.equal(truncateCheckOutput("hello\n"), "hello");
  });

  void it("keeps the tail of long output", () => {
    const text = `${"a".repeat(100)}TAIL`;
    const result = truncateCheckOutput(text, 10);
    assert.match(result, /omitted/);
    assert.match(result, /TAIL$/);
  });
});

function checkResult(
  name: string,
  status: CheckResult["status"],
  output = "",
): CheckResult {
  return {
    name,
    command: name,
    status,
    exitCode: status === "passed" ? 0 : 1,
    durationMs: 1,
    output,
  };
}

function gateResult(
  status: GateResult["status"],
  checks: CheckResult[],
  error?: string,
): GateResult {
  return { status, checks, durationMs: 1, error };
}

void describe("failureSignatures", () => {
  void it("extracts node:test names without durations", () => {
    const signatures = failureSignatures("✖ multiply (1.2ms)\n✖ failing tests:");
    assert.deepEqual(signatures, ["failing tests:", "multiply"]);
  });

  void it("extracts pytest and go names", () => {
    const signatures = failureSignatures(
      "FAILED tests/test_x.py::test_y - AssertionError\n--- FAIL: TestX (0.00s)",
    );
    assert.ok(signatures.includes("tests/test_x.py::test_y - AssertionError"));
    assert.ok(signatures.includes("TestX"));
  });
});

void describe("applyBaseline", () => {
  void it("keeps strict behaviour when the baseline is green", () => {
    const baseline = gateResult("passed", [checkResult("test", "passed")]);
    const current = gateResult("failed", [checkResult("test", "failed", "✖ new")]);

    assert.equal(applyBaseline(baseline, current).status, "failed");
  });

  void it("passes when the same failures existed before the run", () => {
    const baseline = gateResult("failed", [
      checkResult("test", "failed", "✖ old (1ms)"),
    ]);
    const current = gateResult("failed", [
      checkResult("test", "failed", "✖ old (2ms)"),
    ]);

    const result = applyBaseline(baseline, current);

    assert.equal(result.status, "passed");
    assert.equal(result.baselineStatus, "failed");
    assert.match(result.warnings?.join(" ") ?? "", /same failures/);
  });

  void it("fails on a failure that was not in the baseline", () => {
    const baseline = gateResult("failed", [
      checkResult("test", "failed", "✖ old"),
    ]);
    const current = gateResult("failed", [
      checkResult("test", "failed", "✖ old\n✖ new"),
    ]);

    const result = applyBaseline(baseline, current);

    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /new failures: new/);
  });

  void it("passes when the baseline was red and is green now", () => {
    const baseline = gateResult("failed", [checkResult("test", "failed", "✖ old")]);
    const current = gateResult("passed", [checkResult("test", "passed")]);

    const result = applyBaseline(baseline, current);

    assert.equal(result.status, "passed");
    assert.match(result.warnings?.join(" ") ?? "", /are green now/);
  });

  void it("treats identical unparsed output as pre-existing", () => {
    const baseline = gateResult("failed", [checkResult("test", "failed", "boom")]);
    const current = gateResult("failed", [checkResult("test", "failed", "boom")]);

    const result = applyBaseline(baseline, current);

    assert.equal(result.status, "passed");
    assert.match(result.warnings?.join(" ") ?? "", /identical output/);
  });

  void it("fails when unparsed output changed", () => {
    const baseline = gateResult("failed", [checkResult("test", "failed", "boom")]);
    const current = gateResult("failed", [checkResult("test", "failed", "boom again")]);

    const result = applyBaseline(baseline, current);

    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /cannot be compared/);
  });

  void it("fails when a parsed failure becomes an unparsed error", () => {
    const baseline = gateResult("failed", [
      checkResult("test", "failed", "✖ old"),
    ]);
    const current = gateResult("failed", [
      checkResult("test", "failed", "error TS2322: type mismatch"),
    ]);

    const result = applyBaseline(baseline, current);

    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /new fatal output|TS2322/);
  });

  void it("fails when a check was green in the baseline", () => {
    const baseline = gateResult("failed", [
      checkResult("test", "failed", "✖ old"),
    ]);
    const current = gateResult("failed", [
      checkResult("test", "passed"),
      checkResult("lint", "failed", "✖ lint"),
    ]);

    const result = applyBaseline(baseline, current);

    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /lint: check was green/);
  });

  void it("fails on a new fatal line next to a known failure", () => {
    const baseline = gateResult("failed", [
      checkResult("test", "failed", "✖ old"),
    ]);
    const current = gateResult("failed", [
      checkResult("test", "failed", "✖ old\nerror TS2322: type mismatch"),
    ]);

    const result = applyBaseline(baseline, current);

    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /new fatal output: error TS2322/);
  });

  void it("fails on other new fatal lines next to a known failure", () => {
    const baseline = gateResult("failed", [
      checkResult("test", "failed", "✖ old"),
    ]);

    for (const line of [
      "Error: Cannot find module 'x'",
      "AssertionError: expected 1 to be 2",
      "Killed",
      "out of memory",
      "error: unknown type name 'foo'",
      "src/foo.c:10:5: error: unknown type name 'x'",
      "error[E0308]: mismatched types",
      "make: *** [all] Error 1",
      "ENOENT: no such file or directory",
      "sh: 1: foo: not found",
      "sh: line 1: foo: not found",
      "bash: foo: command not found",
      "npm error code ELIFECYCLE",
      "UnhandledPromiseRejectionWarning: boom",
    ]) {
      const current = gateResult("failed", [
        checkResult("test", "failed", `✖ old\n${line}`),
      ]);

      const result = applyBaseline(baseline, current);

      assert.equal(result.status, "failed", line);
    }
  });

  void it("does not fail when a known assertion message changes", () => {
    const baseline = gateResult("failed", [
      checkResult("test", "failed", "✖ old\nAssertionError: expected 1 got 2"),
    ]);
    const current = gateResult("failed", [
      checkResult("test", "failed", "✖ old\nAssertionError: expected 1 got 3"),
    ]);

    const result = applyBaseline(baseline, current);

    assert.equal(result.status, "passed");
    assert.match(result.warnings?.join(" ") ?? "", /same failures/);
  });

  void it("fails when a new error class appears", () => {
    const baseline = gateResult("failed", [
      checkResult("test", "failed", "✖ old\nAssertionError: x"),
    ]);
    const current = gateResult("failed", [
      checkResult("test", "failed", "✖ old\nTypeError: x"),
    ]);

    const result = applyBaseline(baseline, current);

    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /class:TypeError/);
  });

  void it("fails when a check times out", () => {
    const baseline = gateResult("failed", [
      checkResult("test", "failed", "✖ old"),
    ]);
    const current = gateResult("failed", [checkResult("test", "timedOut", "")]);

    const result = applyBaseline(baseline, current);

    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /timed out/);
  });

  void it("fails when the baseline timed out and the current check fails", () => {
    const baseline = gateResult("failed", [checkResult("test", "timedOut", "")]);
    const current = gateResult("failed", [
      checkResult("test", "failed", "✖ old"),
    ]);

    const result = applyBaseline(baseline, current);

    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /comparison is not reliable/);
  });
});
