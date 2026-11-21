import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { detectChecks, loadConfig, resolveChecks } from "../../v2/config.ts";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deus-config-"));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

void describe("loadConfig", () => {
  void it("returns an empty config when deus.json is missing", () => {
    assert.deepEqual(loadConfig(tempDir()), {});
  });

  void it("reads settings and joins chained checks", () => {
    const dir = tempDir();
    fs.writeFileSync(
      path.join(dir, "deus.json"),
      JSON.stringify({
        model: "opencode-go/deepseek-v4.1-flash#max",
        timeoutSeconds: 600,
        maxCost: 0.1,
        pipeline: "fix",
        worktree: false,
        merge: false,
        baseline: false,
        policy: "policy.json",
        checks: {
          test: "npm test",
          lint: ["npm run lint", "npm run typecheck"],
        },
      }),
      "utf-8",
    );

    const config = loadConfig(dir);

    assert.equal(config.model, "opencode-go/deepseek-v4.1-flash#max");
    assert.equal(config.timeoutSeconds, 600);
    assert.equal(config.maxCost, 0.1);
    assert.equal(config.pipeline, "fix");
    assert.equal(config.worktree, false);
    assert.equal(config.merge, false);
    assert.equal(config.baseline, false);
    assert.equal(config.policy, "policy.json");
    assert.deepEqual(config.checks, [
      { name: "test", command: "npm test" },
      { name: "lint", command: "npm run lint && npm run typecheck" },
    ]);
  });

  void it("rejects broken JSON", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "deus.json"), "{", "utf-8");
    assert.throws(() => loadConfig(dir), /deus\.json: invalid JSON/);
  });

  void it("rejects invalid field types", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "deus.json"), JSON.stringify({ maxCost: -1 }), "utf-8");
    assert.throws(() => loadConfig(dir), /maxCost/);

    fs.writeFileSync(
      path.join(dir, "deus.json"),
      JSON.stringify({ timeoutSeconds: 0 }),
      "utf-8",
    );
    assert.throws(() => loadConfig(dir), /timeoutSeconds/);

    fs.writeFileSync(
      path.join(dir, "deus.json"),
      JSON.stringify({ checks: { test: [] } }),
      "utf-8",
    );
    assert.throws(() => loadConfig(dir), /at least one command/);
  });
});

void describe("detectChecks", () => {
  void it("detects the npm test script", () => {
    const dir = tempDir();
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "node --test" } }),
      "utf-8",
    );

    assert.deepEqual(detectChecks(dir), [{ name: "test", command: "npm test" }]);
  });

  void it("ignores the default empty npm test script", () => {
    const dir = tempDir();
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
      "utf-8",
    );

    assert.deepEqual(detectChecks(dir), []);
  });

  void it("returns nothing without package.json", () => {
    assert.deepEqual(detectChecks(tempDir()), []);
  });

  void it("prefers checks from deus.json", () => {
    const dir = tempDir();
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "node --test" } }),
      "utf-8",
    );

    assert.deepEqual(
      resolveChecks({ checks: [{ name: "custom", command: "make check" }] }, dir),
      [{ name: "custom", command: "make check" }],
    );
  });
});
