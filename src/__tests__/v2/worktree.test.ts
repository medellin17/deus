import assert from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { prepareWorkdir } from "../../v2/worktree.ts";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deus-worktree-"));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function makeRepo(ignoreNodeModules: boolean): string {
  const dir = tempDir();
  git(dir, "init", "-q");
  git(dir, "config", "user.name", "deus-test");
  git(dir, "config", "user.email", "deus@example.com");
  fs.writeFileSync(path.join(dir, "package.json"), "{}\n", "utf-8");
  if (ignoreNodeModules) {
    fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules/\n", "utf-8");
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");

  fs.mkdirSync(path.join(dir, "node_modules"));
  fs.writeFileSync(path.join(dir, "node_modules", "marker"), "1", "utf-8");
  return dir;
}

void describe("prepareWorkdir", () => {
  void it("links node_modules into the worktree when git ignores it", () => {
    const repo = makeRepo(true);
    const prepared = prepareWorkdir(repo, "run-link", true);

    const target = path.join(prepared.workDir, "node_modules");
    assert.ok(fs.existsSync(target));
    assert.equal(fs.readFileSync(path.join(target, "marker"), "utf-8"), "1");
  });

  void it("keeps the linked node_modules out of the git index", () => {
    const repo = makeRepo(true);
    const prepared = prepareWorkdir(repo, "run-ignored", true);
    const target = path.join(prepared.workDir, "node_modules");

    assert.equal(fs.lstatSync(target).isDirectory(), true);
    assert.doesNotThrow(() => git(prepared.workDir, "check-ignore", "node_modules"));

    git(prepared.workDir, "add", "-A");
    const staged = execFileSync("git", ["diff", "--cached", "--name-only"], {
      cwd: prepared.workDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    assert.equal(staged, "");
  });

  void it("does not link node_modules when it would be committed", () => {
    const repo = makeRepo(false);
    const prepared = prepareWorkdir(repo, "run-nolink", true);

    assert.equal(fs.existsSync(path.join(prepared.workDir, "node_modules")), false);
  });

  void it("rejects a cwd that is not the repository root", () => {
    const repo = makeRepo(false);
    const sub = path.join(repo, "packages", "app");
    fs.mkdirSync(sub, { recursive: true });

    assert.throws(
      () => prepareWorkdir(sub, "run-sub", true),
      /repository root/,
    );
  });
});
