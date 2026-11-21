import assert from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { applyRun } from "../../v2/apply.ts";
import type {
  Executor,
  ExecutorInput,
  RunState,
  StepExecution,
} from "../../v2/types.ts";
import { prepareWorkdir, type PreparedWorkdir } from "../../v2/worktree.ts";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deus-apply-"));
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

function prepare(repo: string): PreparedWorkdir {
  const prepared = prepareWorkdir(repo, "run-test", true);
  fs.mkdirSync(path.join(repo, ".deus"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".deus", ".gitignore"), "*\n", "utf-8");
  return prepared;
}

function stateFor(repo: string, prepared: PreparedWorkdir): RunState {
  const now = new Date().toISOString();
  return {
    version: 1,
    runId: "run-test",
    projectDir: repo,
    workDir: prepared.workDir,
    worktree: true,
    baseCommit: prepared.baseCommit,
    baseBranch: prepared.baseBranch,
    pipeline: "build",
    task: "change file",
    model: "test/model",
    status: "succeeded",
    createdAt: now,
    updatedAt: now,
    steps: [],
  };
}

function execution(
  input: ExecutorInput,
  text: string,
  status: "succeeded" | "failed" = "succeeded",
): StepExecution {
  return {
    stepId: input.step.id,
    agent: input.step.agent,
    sessionID: "ses-resolver",
    status,
    text,
    transcript: text,
    error: status === "failed" ? "resolver failed" : undefined,
    cost: 0.001,
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    durationMs: 1,
    permissionDecisions: [],
  };
}

class FakeExecutor implements Executor {
  calls = 0;

  constructor(
    private readonly action: (input: ExecutorInput, call: number) => StepExecution,
  ) {}

  async run(input: ExecutorInput): Promise<StepExecution> {
    this.calls++;
    return this.action(input, this.calls);
  }
}

function moveHeadWithConflict(repo: string): void {
  fs.writeFileSync(path.join(repo, "file.txt"), "main\n", "utf-8");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "main edit");
}

void describe("applyRun", () => {
  void it("merges a successful run when the project is untouched", async () => {
    const repo = makeRepo();
    const prepared = prepare(repo);
    fs.writeFileSync(path.join(prepared.workDir, "file.txt"), "two\n", "utf-8");

    const result = await applyRun({
      projectDir: repo,
      workDir: prepared.workDir,
      state: stateFor(repo, prepared),
      merge: true,
    });

    assert.equal(result.status, "merged");
    assert.equal(fs.readFileSync(path.join(repo, "file.txt"), "utf-8"), "two\n");
    assert.match(git(repo, "log", "-1", "--format=%s"), /^Merge deus run-test/);
    assert.equal(git(repo, "status", "--porcelain"), "");
  });

  void it("keeps the branch when merging is disabled", async () => {
    const repo = makeRepo();
    const prepared = prepare(repo);
    fs.writeFileSync(path.join(prepared.workDir, "file.txt"), "two\n", "utf-8");

    const result = await applyRun({
      projectDir: repo,
      workDir: prepared.workDir,
      state: stateFor(repo, prepared),
      merge: false,
    });

    assert.equal(result.status, "branch");
    assert.equal(result.branch, "deus/run-test");
    assert.match(result.mergeCommand ?? "", /merge --no-ff deus\/run-test/);
    assert.equal(fs.readFileSync(path.join(repo, "file.txt"), "utf-8"), "one\n");
    assert.match(git(repo, "branch", "--list", "deus/run-test"), /deus\/run-test/);
  });

  void it("does not merge into a dirty project", async () => {
    const repo = makeRepo();
    const prepared = prepare(repo);
    fs.writeFileSync(path.join(prepared.workDir, "file.txt"), "two\n", "utf-8");
    fs.writeFileSync(path.join(repo, "dirty.txt"), "local work\n", "utf-8");

    const result = await applyRun({
      projectDir: repo,
      workDir: prepared.workDir,
      state: stateFor(repo, prepared),
      merge: true,
    });

    assert.equal(result.status, "branch");
    assert.match(result.reason ?? "", /uncommitted changes/);
    assert.equal(fs.readFileSync(path.join(repo, "file.txt"), "utf-8"), "one\n");
  });

  void it("merges when HEAD moved without conflicts", async () => {
    const repo = makeRepo();
    const prepared = prepare(repo);
    fs.writeFileSync(path.join(prepared.workDir, "file.txt"), "two\n", "utf-8");
    fs.writeFileSync(path.join(repo, "other.txt"), "new commit\n", "utf-8");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "moved");

    const result = await applyRun({
      projectDir: repo,
      workDir: prepared.workDir,
      state: stateFor(repo, prepared),
      merge: true,
    });

    assert.equal(result.status, "merged");
    assert.equal(fs.readFileSync(path.join(repo, "file.txt"), "utf-8"), "two\n");
    assert.equal(fs.readFileSync(path.join(repo, "other.txt"), "utf-8"), "new commit\n");
  });

  void it("resolves a conflict with the agent and merges", async () => {
    const repo = makeRepo();
    const prepared = prepare(repo);
    fs.writeFileSync(path.join(prepared.workDir, "file.txt"), "branch\n", "utf-8");
    moveHeadWithConflict(repo);

    const executor = new FakeExecutor((input) => {
      fs.writeFileSync(path.join(repo, "file.txt"), "merged\n", "utf-8");
      return execution(input, "resolved");
    });

    const result = await applyRun({
      projectDir: repo,
      workDir: prepared.workDir,
      state: stateFor(repo, prepared),
      merge: true,
      resolve: {
        executor,
        timeoutMs: 1000,
        checks: [{ name: "content", command: "grep -q merged file.txt" }],
      },
    });

    assert.equal(result.status, "merged", result.reason ?? "");
    assert.equal(result.resolution?.status, "succeeded");
    assert.equal(result.resolution?.gate?.status, "passed");
    assert.equal(fs.readFileSync(path.join(repo, "file.txt"), "utf-8"), "merged\n");
    assert.match(git(repo, "log", "-1", "--format=%s"), /^Merge deus run-test/);
    assert.equal(git(repo, "status", "--porcelain"), "");
  });

  void it("aborts the merge when the resolver fails", async () => {
    const repo = makeRepo();
    const prepared = prepare(repo);
    fs.writeFileSync(path.join(prepared.workDir, "file.txt"), "branch\n", "utf-8");
    moveHeadWithConflict(repo);

    const executor = new FakeExecutor((input) => execution(input, "", "failed"));

    const result = await applyRun({
      projectDir: repo,
      workDir: prepared.workDir,
      state: stateFor(repo, prepared),
      merge: true,
      resolve: { executor, timeoutMs: 1000, checks: [] },
    });

    assert.equal(result.status, "branch");
    assert.match(result.reason ?? "", /resolver failed/);
    assert.equal(fs.readFileSync(path.join(repo, "file.txt"), "utf-8"), "main\n");
    assert.equal(git(repo, "status", "--porcelain"), "");
  });

  void it("aborts the merge when conflicts remain", async () => {
    const repo = makeRepo();
    const prepared = prepare(repo);
    fs.writeFileSync(path.join(prepared.workDir, "file.txt"), "branch\n", "utf-8");
    moveHeadWithConflict(repo);

    const executor = new FakeExecutor((input) => execution(input, "could not resolve"));

    const result = await applyRun({
      projectDir: repo,
      workDir: prepared.workDir,
      state: stateFor(repo, prepared),
      merge: true,
      resolve: { executor, timeoutMs: 1000, checks: [] },
    });

    assert.equal(result.status, "branch");
    assert.match(result.reason ?? "", /conflict markers remain/);
    assert.equal(git(repo, "status", "--porcelain"), "");
  });

  void it("aborts when checks fail after conflict resolution", async () => {
    const repo = makeRepo();
    const prepared = prepare(repo);
    fs.writeFileSync(path.join(prepared.workDir, "file.txt"), "branch\n", "utf-8");
    moveHeadWithConflict(repo);

    const executor = new FakeExecutor((input) => {
      fs.writeFileSync(path.join(repo, "file.txt"), "merged\n", "utf-8");
      return execution(input, "resolved");
    });

    const result = await applyRun({
      projectDir: repo,
      workDir: prepared.workDir,
      state: stateFor(repo, prepared),
      merge: true,
      resolve: {
        executor,
        timeoutMs: 1000,
        checks: [{ name: "content", command: "grep -q expected file.txt" }],
      },
    });

    assert.equal(result.status, "branch");
    assert.match(result.reason ?? "", /checks failed after conflict resolution/);
    assert.equal(fs.readFileSync(path.join(repo, "file.txt"), "utf-8"), "main\n");
    assert.equal(git(repo, "status", "--porcelain"), "");
  });

  void it("reports runs without changes", async () => {
    const repo = makeRepo();
    const prepared = prepare(repo);

    const result = await applyRun({
      projectDir: repo,
      workDir: prepared.workDir,
      state: stateFor(repo, prepared),
      merge: true,
    });

    assert.equal(result.status, "no-changes");
    assert.equal(git(repo, "log", "-1", "--format=%s"), "init");
  });

  void it("reuses an existing branch on resume and is idempotent", async () => {
    const repo = makeRepo();
    const prepared = prepare(repo);
    fs.writeFileSync(path.join(prepared.workDir, "file.txt"), "two\n", "utf-8");

    const first = await applyRun({
      projectDir: repo,
      workDir: prepared.workDir,
      state: stateFor(repo, prepared),
      merge: false,
    });
    assert.equal(first.status, "branch");

    const second = await applyRun({
      projectDir: repo,
      workDir: prepared.workDir,
      state: stateFor(repo, prepared),
      merge: true,
    });
    assert.equal(second.status, "merged");
    assert.equal(fs.readFileSync(path.join(repo, "file.txt"), "utf-8"), "two\n");

    const third = await applyRun({
      projectDir: repo,
      workDir: prepared.workDir,
      state: stateFor(repo, prepared),
      merge: true,
    });
    assert.equal(third.status, "merged");
    assert.match(third.reason ?? "", /already merged/);
  });

  void it("commits to an empty existing branch instead of reporting merged", async () => {
    const repo = makeRepo();
    const prepared = prepare(repo);
    git(prepared.workDir, "switch", "-c", "deus/run-test");
    fs.writeFileSync(path.join(prepared.workDir, "file.txt"), "two\n", "utf-8");

    const result = await applyRun({
      projectDir: repo,
      workDir: prepared.workDir,
      state: stateFor(repo, prepared),
      merge: true,
    });

    assert.equal(result.status, "merged", result.reason ?? "");
    assert.equal(fs.readFileSync(path.join(repo, "file.txt"), "utf-8"), "two\n");
  });

  void it("does not treat a clean empty branch as merged", async () => {
    const repo = makeRepo();
    const prepared = prepare(repo);
    git(prepared.workDir, "switch", "-c", "deus/run-test");

    const result = await applyRun({
      projectDir: repo,
      workDir: prepared.workDir,
      state: stateFor(repo, prepared),
      merge: true,
    });

    assert.equal(result.status, "skipped");
    assert.match(result.reason ?? "", /no commits/);
    assert.equal(fs.readFileSync(path.join(repo, "file.txt"), "utf-8"), "one\n");
  });

  void it("merges tracked files even when an ignore pattern matches them", async () => {
    const repo = makeRepo();
    fs.mkdirSync(path.join(repo, "dist"));
    fs.writeFileSync(path.join(repo, "dist/tracked.txt"), "old\n", "utf-8");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "tracked dist");
    fs.writeFileSync(path.join(repo, ".gitignore"), "dist/\n", "utf-8");
    git(repo, "add", ".gitignore");
    git(repo, "commit", "-qm", "ignore dist");

    const prepared = prepare(repo);
    fs.writeFileSync(path.join(prepared.workDir, "dist/tracked.txt"), "new\n", "utf-8");

    const result = await applyRun({
      projectDir: repo,
      workDir: prepared.workDir,
      state: stateFor(repo, prepared),
      merge: true,
    });

    assert.equal(result.status, "merged", result.reason ?? "");
    assert.equal(fs.readFileSync(path.join(repo, "dist/tracked.txt"), "utf-8"), "new\n");
  });

  void it("refuses a merge when checks create files outside the conflicts", async () => {
    const repo = makeRepo();
    const prepared = prepare(repo);
    fs.writeFileSync(path.join(prepared.workDir, "file.txt"), "branch\n", "utf-8");
    moveHeadWithConflict(repo);

    const executor = new FakeExecutor((input) => {
      fs.writeFileSync(path.join(repo, "file.txt"), "merged\n", "utf-8");
      return execution(input, "resolved");
    });

    const result = await applyRun({
      projectDir: repo,
      workDir: prepared.workDir,
      state: stateFor(repo, prepared),
      merge: true,
      resolve: {
        executor,
        timeoutMs: 1000,
        checks: [{ name: "gen", command: "touch generated.txt" }],
      },
    });

    assert.equal(result.status, "branch");
    assert.match(result.reason ?? "", /untracked files: generated\.txt/);
    assert.equal(fs.readFileSync(path.join(repo, "file.txt"), "utf-8"), "main\n");
  });

  void it("refuses a merge when a check stages a file outside the conflicts", async () => {
    const repo = makeRepo();
    const prepared = prepare(repo);
    fs.writeFileSync(path.join(prepared.workDir, "file.txt"), "branch\n", "utf-8");
    moveHeadWithConflict(repo);

    const executor = new FakeExecutor((input) => {
      fs.writeFileSync(path.join(repo, "file.txt"), "merged\n", "utf-8");
      return execution(input, "resolved");
    });

    const result = await applyRun({
      projectDir: repo,
      workDir: prepared.workDir,
      state: stateFor(repo, prepared),
      merge: true,
      resolve: {
        executor,
        timeoutMs: 1000,
        checks: [
          { name: "stage", command: "echo leaked > leaked.txt && git add leaked.txt" },
        ],
      },
    });

    assert.equal(result.status, "branch");
    assert.match(result.reason ?? "", /checks changed unrelated files: leaked\.txt/);
    assert.equal(fs.readFileSync(path.join(repo, "file.txt"), "utf-8"), "main\n");
    assert.equal(git(repo, "status", "--porcelain"), "");
  });

  void it("aborts an unfinished merge even without baseBranch", async () => {
    const repo = makeRepo();
    const prepared = prepare(repo);
    fs.writeFileSync(path.join(prepared.workDir, "file.txt"), "branch\n", "utf-8");
    git(prepared.workDir, "switch", "-c", "deus/run-test");
    git(prepared.workDir, "add", "-A");
    git(prepared.workDir, "commit", "-qm", "branch");
    moveHeadWithConflict(repo);

    try {
      git(repo, "merge", "--no-commit", "deus/run-test");
    } catch {
      // expected conflict
    }

    const state = stateFor(repo, prepared);
    delete state.baseBranch;

    const result = await applyRun({
      projectDir: repo,
      workDir: prepared.workDir,
      state,
      merge: true,
    });

    assert.equal(result.status, "branch");
    assert.match(result.reason ?? "", /base branch is unknown/);

    let mergeHeadAlive = true;
    try {
      git(repo, "rev-parse", "-q", "--verify", "MERGE_HEAD");
    } catch {
      mergeHeadAlive = false;
    }
    assert.equal(mergeHeadAlive, false);
    assert.equal(git(repo, "status", "--porcelain"), "");
  });

  void it("refuses to merge into a different branch", async () => {
    const repo = makeRepo();
    const original = git(repo, "rev-parse", "--abbrev-ref", "HEAD");
    git(repo, "checkout", "-b", "feature");
    const prepared = prepare(repo);
    fs.writeFileSync(path.join(prepared.workDir, "file.txt"), "two\n", "utf-8");
    git(repo, "checkout", original);

    const result = await applyRun({
      projectDir: repo,
      workDir: prepared.workDir,
      state: stateFor(repo, prepared),
      merge: true,
    });

    assert.equal(result.status, "branch");
    assert.match(result.reason ?? "", /switched from feature/);
    assert.equal(fs.readFileSync(path.join(repo, "file.txt"), "utf-8"), "one\n");
  });

  void it("refuses to merge paths ignored by the project", async () => {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, ".gitignore"), "ignored.txt\n", "utf-8");
    fs.writeFileSync(path.join(repo, "ignored.txt"), "local\n", "utf-8");
    git(repo, "add", ".gitignore");
    git(repo, "commit", "-qm", "ignore");

    const prepared = prepare(repo);
    fs.writeFileSync(path.join(prepared.workDir, "ignored.txt"), "branch\n", "utf-8");
    git(prepared.workDir, "switch", "-c", "deus/run-test");
    git(prepared.workDir, "add", "-f", "ignored.txt");
    git(prepared.workDir, "commit", "-qm", "add ignored");

    const result = await applyRun({
      projectDir: repo,
      workDir: prepared.workDir,
      state: stateFor(repo, prepared),
      merge: true,
    });

    assert.equal(result.status, "branch");
    assert.match(result.reason ?? "", /ignored files: ignored\.txt/);
    assert.equal(fs.readFileSync(path.join(repo, "ignored.txt"), "utf-8"), "local\n");
  });
});
