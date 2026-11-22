import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { agentModel, clampBudget, loadRegistry } from "../../v2/registry.ts";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deus-registry-"));
  tempDirs.push(dir);
  return dir;
}

function writeAgent(dir: string, name: string, frontmatter: string): void {
  const agents = path.join(dir, ".opencode", "agents");
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(path.join(agents, `${name}.md`), `---\n${frontmatter}\n---\n\n# ${name}\n`, "utf-8");
}

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

void describe("loadRegistry", () => {
  void it("returns an empty registry without an agents directory", () => {
    assert.deepEqual(loadRegistry(tempDir()).list(), []);
  });

  void it("skips files without frontmatter", () => {
    const dir = tempDir();
    const agents = path.join(dir, ".opencode", "agents");
    fs.mkdirSync(agents, { recursive: true });
    fs.writeFileSync(path.join(agents, "plain.md"), "# no frontmatter\n", "utf-8");

    assert.deepEqual(loadRegistry(dir).list(), []);
  });

  void it("parses a BOM-prefixed frontmatter and an empty block", () => {
    const dir = tempDir();
    writeAgent(dir, "bom", "role: lead");
    writeAgent(dir, "empty", "");
    const agents = path.join(dir, ".opencode", "agents");
    fs.writeFileSync(
      path.join(agents, "bom.md"),
      `\uFEFF---\nrole: lead\n---\n`,
      "utf-8",
    );

    const registry = loadRegistry(dir);
    assert.equal(registry.get("bom")?.role, "lead");
    assert.equal(registry.get("empty")?.role, "worker");
  });

  void it("rejects an unterminated frontmatter", () => {
    const dir = tempDir();
    const agents = path.join(dir, ".opencode", "agents");
    fs.mkdirSync(agents, { recursive: true });
    fs.writeFileSync(path.join(agents, "open.md"), "---\nrole: worker\n", "utf-8");

    assert.throws(() => loadRegistry(dir), /open\.md: unterminated YAML frontmatter/);
  });

  void it("does not end the block at an indented delimiter", () => {
    const dir = tempDir();
    writeAgent(
      dir,
      "block",
      ["description: |", "  line one", "  ---", "  line three", "role: lead"].join("\n"),
    );

    const record = loadRegistry(dir).get("block");
    assert.equal(record?.role, "lead");
    assert.match(record?.description ?? "", /line three/);
  });

  void it("treats a comment-only block as an empty object", () => {
    const dir = tempDir();
    writeAgent(dir, "comments", "# just a comment");

    assert.equal(loadRegistry(dir).get("comments")?.role, "worker");
  });

  void it("treats empty native fields as absent", () => {
    const dir = tempDir();
    writeAgent(dir, "blank", "tools:\nmodel:");

    const record = loadRegistry(dir).get("blank");
    assert.equal(record?.tools, undefined);
    assert.equal(record?.model, undefined);
  });

  void it("rejects a model that is not provider/model", () => {
    const dir = tempDir();
    writeAgent(dir, "bare", "model: deepseek-v4.1-flash");

    assert.throws(() => loadRegistry(dir), /"model" must look like provider\/model/);
  });

  void it("reads our fields and the native ones", () => {
    const dir = tempDir();
    writeAgent(dir, "root", "description: Root\nrole: lead");
    writeAgent(
      dir,
      "builder",
      [
        "description: Builds code",
        "role: worker",
        "reports_to: root",
        "workspace: repo",
        "model: opencode-go/deepseek-v4.1-flash#high",
        "budget:",
        "  maxCost: 0.5",
        "  maxSteps: 10",
        "tools:",
        "  edit: true",
        "  bash: false",
      ].join("\n"),
    );

    const registry = loadRegistry(dir);
    const builder = registry.get("builder");

    assert.ok(builder);
    assert.equal(builder.id, "builder");
    assert.equal(builder.description, "Builds code");
    assert.equal(builder.role, "worker");
    assert.equal(builder.reportsTo, "root");
    assert.deepEqual(builder.workspace, { kind: "path", path: "repo" });
    assert.deepEqual(builder.budget, { maxCost: 0.5, maxSteps: 10 });
    assert.deepEqual(builder.tools, { edit: true, bash: false });
    assert.equal(builder.model, "opencode-go/deepseek-v4.1-flash#high");
  });

  void it("defaults role and workspace when the fields are absent", () => {
    const dir = tempDir();
    writeAgent(dir, "plain", "description: Plain");

    const record = loadRegistry(dir).get("plain");

    assert.ok(record);
    assert.equal(record.role, "worker");
    assert.deepEqual(record.workspace, { kind: "inherit" });
    assert.equal(record.budget, undefined);
  });

  void it("accepts a read-only workspace", () => {
    const dir = tempDir();
    writeAgent(dir, "reader", "workspace: read-only");

    assert.deepEqual(loadRegistry(dir).get("reader")?.workspace, { kind: "read-only" });
  });

  void it("rejects an invalid frontmatter and names the file", () => {
    const dir = tempDir();
    writeAgent(dir, "broken", "role: [unclosed");

    assert.throws(() => loadRegistry(dir), /broken\.md: invalid YAML frontmatter/);
  });

  void it("rejects a workspace outside the project", () => {
    const dir = tempDir();
    writeAgent(dir, "absolute", "workspace: /etc");
    assert.throws(() => loadRegistry(dir), /absolute\.md: "workspace" must be relative/);

    const other = tempDir();
    writeAgent(other, "escape", "workspace: ../outside");
    assert.throws(() => loadRegistry(other), /escape\.md: "workspace" must stay inside/);
  });

  void it("rejects Windows, UNC and root-relative workspaces", () => {
    for (const value of ["C:\\tmp\\x", "\\\\server\\share", "\\etc"]) {
      const dir = tempDir();
      writeAgent(dir, "escape", `workspace: '${value}'`);
      assert.throws(() => loadRegistry(dir), /"workspace" must be relative/);
    }
  });

  void it("rejects control characters in workspace", () => {
    const dir = tempDir();
    writeAgent(dir, "ctrl", 'workspace: "a\\0b"');

    assert.throws(() => loadRegistry(dir), /control characters/);
  });

  void it("treats the project root as an inherited workspace", () => {
    const dir = tempDir();
    writeAgent(dir, "root", "workspace: .");

    assert.deepEqual(loadRegistry(dir).get("root")?.workspace, { kind: "inherit" });
  });

  void it("rejects an invalid budget", () => {
    const negative = tempDir();
    writeAgent(negative, "cost", "budget:\n  maxCost: -1");
    assert.throws(() => loadRegistry(negative), /budget\.maxCost/);

    const fractional = tempDir();
    writeAgent(fractional, "steps", "budget:\n  maxSteps: 1.5");
    assert.throws(() => loadRegistry(fractional), /budget\.maxSteps/);

    for (const body of [
      "budget:\n  maxCost: .nan",
      "budget:\n  maxCost: .inf",
      "budget:\n  maxSteps: 0",
    ]) {
      const dir = tempDir();
      writeAgent(dir, "bad", body);
      assert.throws(() => loadRegistry(dir), /budget\./);
    }
  });

  void it("rejects a tools map with non-boolean values", () => {
    const dir = tempDir();
    // `tools.edit` must be a real boolean, not a free-form string.
    writeAgent(dir, "tools", "tools:\n  edit: sometimes");

    assert.throws(() => loadRegistry(dir), /tools\.edit/);
  });

  void it("rejects an unknown reports_to target", () => {
    const dir = tempDir();
    writeAgent(dir, "worker", "reports_to: ghost");

    assert.throws(() => loadRegistry(dir), /reports_to" refers to an unknown agent/);
  });

  void it("rejects self-reporting and cycles", () => {
    const self = tempDir();
    writeAgent(self, "solo", "reports_to: solo");
    assert.throws(() => loadRegistry(self), /cannot point at the agent itself/);

    const cycle = tempDir();
    writeAgent(cycle, "a", "reports_to: b");
    writeAgent(cycle, "b", "reports_to: a");
    assert.throws(() => loadRegistry(cycle), /forms a cycle/);
  });

  void it("allows depth two and rejects depth three", () => {
    const ok = tempDir();
    writeAgent(ok, "a", "reports_to: b");
    writeAgent(ok, "b", "reports_to: c");
    writeAgent(ok, "c", "role: lead");
    assert.equal(loadRegistry(ok).get("a")?.reportsTo, "b");

    const deep = tempDir();
    writeAgent(deep, "a", "reports_to: b");
    writeAgent(deep, "b", "reports_to: c");
    writeAgent(deep, "c", "reports_to: d");
    writeAgent(deep, "d", "role: lead");
    assert.throws(() => loadRegistry(deep), /deeper than 2 levels/);
  });

  void it("parses the agents shipped with this repository", () => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const registry = loadRegistry(root);

    assert.ok(registry.list().length > 0);
    assert.ok(registry.get("implementer-builder"));
  });
});

void describe("agentModel", () => {
  void it("prefers the agent model and falls back to the run model", () => {
    const dir = tempDir();
    writeAgent(dir, "with-model", "model: opencode-go/agent#high");
    writeAgent(dir, "plain", "role: worker");

    const registry = loadRegistry(dir);
    assert.equal(agentModel(registry, "with-model", "run/model"), "opencode-go/agent#high");
    assert.equal(agentModel(registry, "plain", "run/model"), "run/model");
    assert.equal(agentModel(registry, "missing", "run/model"), "run/model");
  });
});

void describe("clampBudget", () => {
  void it("only lowers an agent budget to the run ceiling", () => {
    assert.deepEqual(clampBudget({ maxCost: 0.5, maxSteps: 10 }, 0.2), {
      maxCost: 0.2,
      maxSteps: 10,
    });
    assert.deepEqual(clampBudget({ maxCost: 0.1 }, 0.2), { maxCost: 0.1 });
    assert.deepEqual(clampBudget({ maxCost: 0.5 }, undefined), { maxCost: 0.5 });
    assert.equal(clampBudget(undefined, 0.2), undefined);
  });
});