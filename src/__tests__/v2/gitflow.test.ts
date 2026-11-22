import assert from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  attemptMerge,
  branchExists,
  headIs,
  commitWorktree,
  mergeBranch,
  pruneWorktrees,
} from "../../v2/gitflow.ts";
import { prepareWorkdir, removeWorkdir } from "../../v2/worktree.ts";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deus-gitflow-"));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function makeRepo(): string {
  const dir = tempDir();
  git(dir, "init", "-q");
  git(dir, "config", "user.name", "deus-test");
  git(dir, "config", "user.email", "deus@example.com");
  fs.writeFileSync(path.join(dir, "file.txt"), "one\n", "utf-8");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return dir;
}

function workspace(repo: string, id = "t-bt-test-a1") {
  const prepared = prepareWorkdir(repo, id, true);
  fs.mkdirSync(path.join(repo, ".deus"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".deus", ".gitignore"), "*\n", "utf-8");
  return prepared;
}

void describe("commitWorktree", () => {
  void it("commits the worktree as a branch", () => {
    const repo = makeRepo();
    const { workDir } = workspace(repo);
    fs.writeFileSync(path.join(workDir, "file.txt"), "two\n", "utf-8");

    const result = commitWorktree({
      projectDir: repo,
      workDir,
      branch: "deus/t-bt-test-a1",
      message: "deus: test",
    });

    assert.equal(result.status, "committed");
    assert.ok(result.commit);
    assert.equal(git(repo, "show", "deus/t-bt-test-a1:file.txt"), "two");
  });

  void it("reports no changes instead of creating an empty branch", () => {
    const repo = makeRepo();
    const { workDir } = workspace(repo);

    const result = commitWorktree({
      projectDir: repo,
      workDir,
      branch: "deus/t-bt-test-a1",
      message: "deus: test",
    });

    assert.equal(result.status, "no-changes");
    assert.equal(branchExists(repo, "deus/t-bt-test-a1"), false);
  });

  void it("reports an existing branch that already holds the work", () => {
    const repo = makeRepo();
    const { workDir } = workspace(repo);
    fs.writeFileSync(path.join(workDir, "file.txt"), "two\n", "utf-8");
    commitWorktree({
      projectDir: repo,
      workDir,
      branch: "deus/t-bt-test-a1",
      message: "deus: test",
    });

    const again = commitWorktree({
      projectDir: repo,
      workDir,
      branch: "deus/t-bt-test-a1",
      message: "deus: test",
    });

    assert.equal(again.status, "existing");
    assert.equal(git(repo, "rev-list", "--count", "HEAD..deus/t-bt-test-a1"), "1");
  });

  void it("refuses to report an existing branch when the worktree moved away", () => {
    const repo = makeRepo();
    const { workDir } = workspace(repo);
    fs.writeFileSync(path.join(workDir, "file.txt"), "two\n", "utf-8");
    const first = commitWorktree({
      projectDir: repo,
      workDir,
      branch: "deus/t-bt-test-a1",
      message: "deus: test",
    });
    assert.equal(first.status, "committed");

    // The agent (or another process) left the worktree on a different commit.
    git(workDir, "checkout", "-q", "--detach", "HEAD~1");

    const again = commitWorktree({
      projectDir: repo,
      workDir,
      branch: "deus/t-bt-test-a1",
      message: "deus: test",
    });

    assert.equal(again.status, "skipped");
    assert.match(again.reason ?? "", /not on the branch/);
  });

  void it("refuses to commit secret-like files", () => {
    const repo = makeRepo();
    const { workDir } = workspace(repo);
    fs.writeFileSync(path.join(workDir, ".env"), "TOKEN=1\n", "utf-8");

    const result = commitWorktree({
      projectDir: repo,
      workDir,
      branch: "deus/t-bt-test-a1",
      message: "deus: test",
    });

    assert.equal(result.status, "skipped");
    assert.match(result.reason ?? "", /secret-like/);
    // The branch is created before the secret scan (same as applyRun), but it
    // must hold no commit.
    assert.equal(branchExists(repo, "deus/t-bt-test-a1"), true);
    assert.equal(git(repo, "rev-list", "--count", "HEAD..deus/t-bt-test-a1"), "0");
  });
});

void describe("mergeBranch", () => {
  function branchWith(repo: string, branch: string, content: string) {
    const prepared = workspace(repo, branch.replace(/\//g, "-"));
    fs.writeFileSync(path.join(prepared.workDir, "file.txt"), content, "utf-8");
    const committed = commitWorktree({
      projectDir: repo,
      workDir: prepared.workDir,
      branch,
      message: `deus: ${branch}`,
    });
    assert.equal(committed.status, "committed");
    return committed.commit;
  }

  void it("merges a branch into the project", () => {
    const repo = makeRepo();
    const base = git(repo, "rev-parse", "HEAD");
    const branch = "deus/t-a";
    branchWith(repo, branch, "two\n");

    const result = mergeBranch({
      projectDir: repo,
      branch,
      baseCommit: base,
      baseBranch: "master",
      runId: "run-test",
      title: "test task",
    });

    assert.equal(result.status, "merged");
    assert.equal(fs.readFileSync(path.join(repo, "file.txt"), "utf-8"), "two\n");
  });

  void it("reports an already merged branch as merged", () => {
    const repo = makeRepo();
    const base = git(repo, "rev-parse", "HEAD");
    const branch = "deus/t-a";
    branchWith(repo, branch, "two\n");
    const options = {
      projectDir: repo,
      branch,
      baseCommit: base,
      baseBranch: "master",
      runId: "run-test",
      title: "test task",
    };
    assert.equal(mergeBranch(options).status, "merged");

    assert.equal(mergeBranch(options).status, "already-merged");
  });

  void it("aborts a conflicting merge and leaves the project clean", () => {
    const repo = makeRepo();
    const base = git(repo, "rev-parse", "HEAD");
    const branch = "deus/t-a";
    branchWith(repo, branch, "branch\n");
    fs.writeFileSync(path.join(repo, "file.txt"), "main\n", "utf-8");
    git(repo, "commit", "-aqm", "main change");

    const result = mergeBranch({
      projectDir: repo,
      branch,
      baseCommit: base,
      baseBranch: "master",
      runId: "run-test",
      title: "test task",
    });

    assert.equal(result.status, "conflict");
    assert.equal(git(repo, "status", "--porcelain"), "");
    assert.throws(() => git(repo, "rev-parse", "--verify", "MERGE_HEAD"));
    assert.equal(fs.readFileSync(path.join(repo, "file.txt"), "utf-8"), "main\n");
  });

  void it("leaves a foreign unfinished merge alone", () => {
    const repo = makeRepo();
    const base = git(repo, "rev-parse", "HEAD");
    const other = "deus/t-other";
    branchWith(repo, other, "other\n");
    branchWith(repo, "deus/t-mine", "mine\n");
    // Move master so the merge really conflicts instead of fast-forwarding.
    fs.writeFileSync(path.join(repo, "file.txt"), "main\n", "utf-8");
    git(repo, "commit", "-aqm", "main change");
    try {
      git(repo, "merge", "--no-commit", other);
    } catch {
      // expected conflict
    }
    const mergeHead = git(repo, "rev-parse", "MERGE_HEAD");

    const result = mergeBranch({
      projectDir: repo,
      branch: "deus/t-mine",
      baseCommit: base,
      baseBranch: "master",
      runId: "run-test",
      title: "test task",
    });

    assert.equal(result.status, "skipped");
    assert.match(result.reason ?? "", /another source/);
    assert.equal(git(repo, "rev-parse", "MERGE_HEAD"), mergeHead);
    git(repo, "merge", "--abort");
  });

  void it("refuses a dirty project", () => {
    const repo = makeRepo();
    const base = git(repo, "rev-parse", "HEAD");
    branchWith(repo, "deus/t-a", "two\n");
    fs.writeFileSync(path.join(repo, "file.txt"), "dirty\n", "utf-8");

    const result = mergeBranch({
      projectDir: repo,
      branch: "deus/t-a",
      baseCommit: base,
      baseBranch: "master",
      runId: "run-test",
      title: "test task",
    });

    assert.equal(result.status, "skipped");
    assert.match(result.reason ?? "", /uncommitted changes/);
  });

  void it("refuses to overwrite ignored files", () => {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, ".gitignore"), "ignored.txt\n", "utf-8");
    fs.writeFileSync(path.join(repo, "ignored.txt"), "local\n", "utf-8");
    git(repo, "add", ".gitignore");
    git(repo, "commit", "-qm", "ignore");
    const base = git(repo, "rev-parse", "HEAD");

    const prepared = workspace(repo, "ignored");
    fs.writeFileSync(path.join(prepared.workDir, "ignored.txt"), "branch\n", "utf-8");
    git(prepared.workDir, "add", "-f", "ignored.txt");
    assert.equal(
      commitWorktree({
        projectDir: repo,
        workDir: prepared.workDir,
        branch: "deus/t-ignored",
        message: "deus: ignored",
      }).status,
      "committed",
    );

    const result = mergeBranch({
      projectDir: repo,
      branch: "deus/t-ignored",
      baseCommit: base,
      baseBranch: "master",
      runId: "run-test",
      title: "test task",
    });

    assert.equal(result.status, "skipped");
    assert.match(result.reason ?? "", /ignored files/);
    assert.equal(fs.readFileSync(path.join(repo, "ignored.txt"), "utf-8"), "local\n");
  });

  void it("refuses a detached project", () => {
    const repo = makeRepo();
    const base = git(repo, "rev-parse", "HEAD");
    branchWith(repo, "deus/t-a", "two\n");
    git(repo, "checkout", "-q", "--detach");

    const result = mergeBranch({
      projectDir: repo,
      branch: "deus/t-a",
      baseCommit: base,
      baseBranch: "master",
      runId: "run-test",
      title: "test task",
    });

    assert.equal(result.status, "skipped");
    assert.match(result.reason ?? "", /detached HEAD/);
  });
});

void describe("attemptMerge", () => {
  void it("leaves the merge in progress when asked", () => {
    const repo = makeRepo();
    const prepared = workspace(repo, "conflict");
    fs.writeFileSync(path.join(prepared.workDir, "file.txt"), "branch\n", "utf-8");
    commitWorktree({
      projectDir: repo,
      workDir: prepared.workDir,
      branch: "deus/t-conflict",
      message: "deus: conflict",
    });
    fs.writeFileSync(path.join(repo, "file.txt"), "main\n", "utf-8");
    git(repo, "commit", "-aqm", "main change");

    const result = attemptMerge({
      projectDir: repo,
      branch: "deus/t-conflict",
      runId: "run-test",
      title: "test",
      abortOnConflict: false,
    });

    assert.equal(result.status, "conflict");
    assert.equal(git(repo, "rev-parse", "--verify", "MERGE_HEAD").length > 0, true);
    git(repo, "merge", "--abort");
  });
});

void describe("headIs", () => {
  void it("matches the current HEAD and rejects another commit", () => {
    const repo = makeRepo();
    const head = git(repo, "rev-parse", "HEAD");
    const short = git(repo, "rev-parse", "--short", "HEAD");
    git(repo, "commit", "--allow-empty", "-qm", "next");
    const next = git(repo, "rev-parse", "HEAD");

    assert.equal(headIs(repo, head), false, "HEAD moved past it");
    assert.equal(headIs(repo, next), true);
    assert.equal(headIs(repo, next.slice(0, 7)), true);
    assert.equal(headIs(repo, short), false);
  });
});

void describe("removeWorkdir", () => {
  void it("never deletes the project directory itself", () => {
    const repo = makeRepo();

    removeWorkdir(repo, repo);

    assert.ok(fs.existsSync(path.join(repo, "file.txt")));
    assert.ok(fs.existsSync(path.join(repo, ".git")));
  });

  void it("never deletes a directory outside .deus/worktrees", () => {
    const repo = makeRepo();
    const outside = path.join(repo, "precious");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "keep.txt"), "keep\n", "utf-8");

    removeWorkdir(repo, outside);

    assert.ok(fs.existsSync(path.join(outside, "keep.txt")));
  });
});

void describe("prepareWorkdir id validation", () => {
  void it("refuses an id that would leave the worktree directory", () => {
    const repo = makeRepo();
    assert.throws(() => prepareWorkdir(repo, "t-../../tmp/x", true), /invalid worktree id/);
    assert.throws(() => prepareWorkdir(repo, "a/b", true), /invalid worktree id/);
  });
});

void describe("pruneWorktrees", () => {
  void it("frees a path whose directory was removed by hand", () => {
    const repo = makeRepo();
    const prepared = prepareWorkdir(repo, "t-crashed-a1", true);
    fs.rmSync(prepared.workDir, { recursive: true, force: true });

    pruneWorktrees(repo);

    const again = prepareWorkdir(repo, "t-crashed-a1", true);
    assert.ok(fs.existsSync(again.workDir));
    removeWorkdir(repo, again.workDir);
  });
});
