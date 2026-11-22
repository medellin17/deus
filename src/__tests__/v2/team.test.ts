import assert from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import Database from "better-sqlite3";

import { BoardError, openBoard, type Board } from "../../v2/board.ts";
import type { OpenCodeClient } from "../../v2/client.ts";
import { runCodingTeam, selectReadyTasks, teamExitCode, TeamError } from "../../v2/team.ts";
import type { Executor, ExecutorInput, StepExecution } from "../../v2/types.ts";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deus-team-"));
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
  fs.writeFileSync(path.join(dir, "readme.md"), "base\n", "utf-8");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return dir;
}

function makeBoard(repo: string): { board: Board; teamId: string } {
  const board = openBoard(repo);
  const main = board.getTeamByName("main");
  assert.ok(main);
  return { board, teamId: main.teamId };
}

function addTask(board: Board, teamId: string, title: string): string {
  return board.createTask({ teamId, title, goal: `goal for ${title}`, actor: "lead" })
    .boardTaskId;
}

function ok(input: ExecutorInput, text = "done"): StepExecution {
  const now = new Date().toISOString();
  return {
    stepId: input.step.id,
    agent: input.step.agent,
    sessionID: `ses-${input.step.id}`,
    status: "succeeded",
    text,
    transcript: text,
    cost: 0.001,
    startedAt: now,
    endedAt: now,
    durationMs: 1,
    permissionDecisions: [],
  };
}

interface FakeOptions {
  run: (input: ExecutorInput) => Promise<void> | void;
}

function fakeExecutor(options: FakeOptions): {
  executor: Executor;
  calls: string[];
  prompts: string[];
} {
  const calls: string[] = [];
  const prompts: string[] = [];
  return {
    calls,
    prompts,
    executor: {
      async run(input: ExecutorInput): Promise<StepExecution> {
        calls.push(input.workDir);
        prompts.push(input.prompt);
        await options.run(input);
        return ok(input);
      },
    },
  };
}

const ALWAYS_OK = [{ name: "readme", command: "test -f readme.md" }];
const NO_BROKEN = [{ name: "clean", command: "test ! -f broken.txt" }];

function teamOptions(repo: string, teamId: string, runId: string, executor: Executor) {
  return {
    projectDir: repo,
    teamId,
    runId,
    model: "opencode-go/deepseek-v4.1-flash",
    checks: ALWAYS_OK,
    timeoutMs: 5_000,
    executor,
  };
}

void describe("selectReadyTasks", () => {
  void it("returns backlog tasks whose dependencies are done", () => {
    const repo = makeRepo();
    const { board, teamId } = makeBoard(repo);
    const first = addTask(board, teamId, "first");
    const second = board.createTask({
      teamId,
      title: "second",
      goal: "g",
      actor: "lead",
      dependsOn: [first],
    }).boardTaskId;

    assert.deepEqual(
      selectReadyTasks(board, teamId).map((task) => task.boardTaskId),
      [first],
    );

    board.claim(first, "lead");
    const claim = board.claim(first, "other");
    assert.equal(claim, null);
    // The task is claimed and its lease is live: not ready.
    assert.equal(selectReadyTasks(board, teamId).length, 0);
    assert.equal(second.length > 0, true);
  });

  void it("takes over a claim whose lease expired", () => {
    const repo = makeRepo();
    const { board, teamId } = makeBoard(repo);
    const taskId = addTask(board, teamId, "stale claim");
    board.claim(taskId, "dead-runner");

    const db = new Database(path.join(repo, ".deus", "board.db"));
    db.prepare(`UPDATE board_tasks SET lease_until = ? WHERE board_task_id = ?`).run(
      new Date(Date.now() - 60_000).toISOString(),
      taskId,
    );
    db.close();

    assert.deepEqual(
      selectReadyTasks(board, teamId).map((task) => task.boardTaskId),
      [taskId],
    );
  });

  void it("does not run the same task twice when the list repeats it", () => {
    const repo = makeRepo();
    const { board, teamId } = makeBoard(repo);
    const taskId = addTask(board, teamId, "once");

    assert.deepEqual(
      selectReadyTasks(board, teamId, [taskId, taskId]).map((task) => task.boardTaskId),
      [taskId],
    );
  });

  void it("rejects a task from another team", () => {
    const repo = makeRepo();
    const { board, teamId } = makeBoard(repo);
    const other = board.createTeam({ name: "research", goal: "g", leadAgent: "lead" });
    const foreign = addTask(board, other.teamId, "foreign");

    assert.throws(
      () => selectReadyTasks(board, teamId, [foreign]),
      (error: unknown) => error instanceof TeamError && error.code === "not_found",
    );
  });
});

void describe("runCodingTeam", () => {
  void it("merges a task and marks it done", async () => {
    const repo = makeRepo();
    const { board, teamId } = makeBoard(repo);
    const taskId = addTask(board, teamId, "write alpha");
    const { executor, calls } = fakeExecutor({
      run: (input) => fs.writeFileSync(path.join(input.workDir, "a.txt"), "alpha\n", "utf-8"),
    });

    const result = await runCodingTeam(
      {} as OpenCodeClient,
      board,
      teamOptions(repo, teamId, "run-happy", executor),
    );

    assert.equal(result.merged, 1);
    assert.equal(result.tasks[0].status, "merged");
    assert.equal(board.getTask(taskId)?.status, "done");
    assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf-8"), "alpha\n");
    assert.equal(git(repo, "status", "--porcelain"), "");
    assert.equal(calls.length, 1);
    assert.equal(fs.readdirSync(path.join(repo, ".deus", "worktrees")).length, 0);
  });

  void it("stops at a failing gate and leaves the task for review", async () => {
    const repo = makeRepo();
    const { board, teamId } = makeBoard(repo);
    const taskId = addTask(board, teamId, "break it");
    const { executor } = fakeExecutor({
      run: (input) => fs.writeFileSync(path.join(input.workDir, "broken.txt"), "x\n", "utf-8"),
    });

    const result = await runCodingTeam({} as OpenCodeClient, board, {
      ...teamOptions(repo, teamId, "run-gate", executor),
      checks: NO_BROKEN,
    });

    assert.equal(result.review, 1);
    assert.equal(board.getTask(taskId)?.status, "review");
    assert.equal(board.getTask(taskId)?.verification?.status, "failed");
    assert.throws(
      () => board.accept(taskId, "lead"),
      (error: unknown) => error instanceof BoardError && error.code === "verification_required",
    );
    assert.equal(fs.existsSync(path.join(repo, "broken.txt")), false);
  });

  void it("blocks the task when the agent fails", async () => {
    const repo = makeRepo();
    const { board, teamId } = makeBoard(repo);
    const taskId = addTask(board, teamId, "no answer");
    const executor: Executor = {
      async run(input: ExecutorInput): Promise<StepExecution> {
        return { ...ok(input), status: "failed", error: "provider timeout" };
      },
    };

    const result = await runCodingTeam(
      {} as OpenCodeClient,
      board,
      teamOptions(repo, teamId, "run-failed", executor),
    );

    assert.equal(result.blocked, 1);
    assert.equal(board.getTask(taskId)?.status, "blocked");
    assert.match(board.getTask(taskId)?.blockedReason ?? "", /executor failed/);
    assert.equal(git(repo, "branch", "--list", "deus/*"), "");
  });

  void it("merges one of two conflicting tasks and keeps the other for review", async () => {
    const repo = makeRepo();
    const { board, teamId } = makeBoard(repo);
    const first = addTask(board, teamId, "first writer");
    const second = addTask(board, teamId, "second writer");

    // Both worktrees must exist before either merge, so hold both executors.
    let arrived = 0;
    let open: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => {
      open = resolve;
    });
    let index = 0;
    const { executor } = fakeExecutor({
      run: async (input) => {
        const content = index++ === 0 ? "one\n" : "two\n";
        fs.writeFileSync(path.join(input.workDir, "readme.md"), content, "utf-8");
        arrived++;
        if (arrived === 2) open?.();
        await barrier;
      },
    });

    const result = await runCodingTeam({} as OpenCodeClient, board, {
      ...teamOptions(repo, teamId, "run-conflict", executor),
      maxParallel: 2,
    });

    assert.equal(result.merged, 1);
    assert.equal(result.review, 1);
    const statuses = [board.getTask(first)?.status, board.getTask(second)?.status].sort();
    assert.deepEqual(statuses, ["done", "review"]);
    assert.equal(git(repo, "branch", "--list", "deus/*").split("\n").length, 1);
  });

  void it("rolls the merge back when the post-merge gate fails", async () => {
    const repo = makeRepo();
    const { board, teamId } = makeBoard(repo);
    addTask(board, teamId, "add a");
    addTask(board, teamId, "add b");

    let arrived = 0;
    let open: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => {
      open = resolve;
    });
    let index = 0;
    const { executor } = fakeExecutor({
      run: async (input) => {
        const name = index++ === 0 ? "a.txt" : "b.txt";
        fs.writeFileSync(path.join(input.workDir, name), `${name}\n`, "utf-8");
        arrived++;
        if (arrived === 2) open?.();
        await barrier;
      },
    });

    // Passes while one text file is present, fails once both are merged.
    const result = await runCodingTeam({} as OpenCodeClient, board, {
      ...teamOptions(repo, teamId, "run-rollback", executor),
      maxParallel: 2,
      checks: [{ name: "only-one", command: 'test "$(ls *.txt 2>/dev/null | wc -l)" -lt 2' }],
    });

    assert.equal(result.merged, 1);
    assert.equal(result.blocked, 1);
    const txt = fs.readdirSync(repo).filter((name) => name.endsWith(".txt"));
    assert.equal(txt.length, 1, `project should keep one merged file, got ${txt.join(",")}`);
    assert.match(
      result.tasks.find((task) => task.status === "blocked")?.reason ?? "",
      /post-merge gate/,
    );
  });

  void it("starts a second attempt in a fresh worktree after a gate failure", async () => {
    const repo = makeRepo();
    const { board, teamId } = makeBoard(repo);
    const taskId = addTask(board, teamId, "retry me");

    let broken = true;
    const { executor } = fakeExecutor({
      run: (input) => {
        const name = broken ? "broken.txt" : "fixed.txt";
        fs.writeFileSync(path.join(input.workDir, name), "x\n", "utf-8");
      },
    });

    const first = await runCodingTeam({} as OpenCodeClient, board, {
      ...teamOptions(repo, teamId, "run-attempt1", executor),
      checks: NO_BROKEN,
    });
    assert.equal(first.review, 1);

    board.rework(taskId, "lead", "remove the broken file");
    assert.equal(board.getTask(taskId)?.attempt, 2);
    broken = false;

    const second = await runCodingTeam({} as OpenCodeClient, board, {
      ...teamOptions(repo, teamId, "run-attempt2", executor),
      checks: NO_BROKEN,
    });

    assert.equal(second.merged, 1, second.tasks[0]?.reason ?? "");
    assert.equal(board.getTask(taskId)?.status, "done");
    assert.equal(git(repo, "log", "--oneline", "--all").split("\n").length >= 3, true);
  });

  void it("carries the rework note and the previous diff into the next attempt", async () => {
    const repo = makeRepo();
    const { board, teamId } = makeBoard(repo);
    const taskId = addTask(board, teamId, "fix the note");

    let first = true;
    const { executor, prompts } = fakeExecutor({
      run: (input) => {
        if (first) {
          fs.writeFileSync(path.join(input.workDir, "broken.txt"), "x\n", "utf-8");
        } else {
          fs.writeFileSync(path.join(input.workDir, "fixed.txt"), "y\n", "utf-8");
        }
      },
    });

    const attempt1 = await runCodingTeam({} as OpenCodeClient, board, {
      ...teamOptions(repo, teamId, "run-loop1", executor),
      checks: NO_BROKEN,
    });
    assert.equal(attempt1.review, 1);
    const returned = board.getTask(taskId);
    assert.equal(returned?.artifacts.some((artifact) => artifact.startsWith("deus/")), true);

    board.rework(taskId, "lead", "remove the broken file and write fixed.txt");
    first = false;

    const attempt2 = await runCodingTeam({} as OpenCodeClient, board, {
      ...teamOptions(repo, teamId, "run-loop2", executor),
      checks: NO_BROKEN,
    });

    assert.equal(attempt2.merged, 1, attempt2.tasks[0]?.reason ?? "");
    assert.equal(board.getTask(taskId)?.status, "done");
    assert.equal(prompts.length, 2, "the second attempt must run an agent");
    assert.match(prompts[1], /remove the broken file and write fixed\.txt/);
    assert.match(prompts[1], /Предыдущая попытка отклонена/);
    // The previous branch carried broken.txt; its diff is shown, not re-run blindly.
    assert.match(prompts[1], /broken\.txt/);
    assert.match(prompts[1], /```diff/);
  });

  void it("blocks a task that exhausted its attempts instead of looping", async () => {
    const repo = makeRepo();
    const { board, teamId } = makeBoard(repo);
    const taskId = addTask(board, teamId, "never good enough");

    for (let round = 0; round < 3; round++) {
      const claim = board.claim(taskId, "lead");
      assert.ok(claim);
      board.start(taskId, claim.claimToken, `run-loop/${taskId}`);
      board.submit(taskId, claim.claimToken, { status: "passed" }, { summary: "again" });
      board.rework(taskId, "lead", `round ${round + 1}`);
    }
    assert.equal(board.getTask(taskId)?.attempt, 4);

    const { executor, calls } = fakeExecutor({ run: () => undefined });
    const result = await runCodingTeam({} as OpenCodeClient, board, {
      ...teamOptions(repo, teamId, "run-limit", executor),
      maxAttempts: 3,
    });

    assert.equal(result.blocked, 1);
    assert.equal(calls.length, 0);
    assert.equal(board.getTask(taskId)?.status, "blocked");
    assert.match(board.getTask(taskId)?.blockedReason ?? "", /rework limit/);
  });

  void it("does not spend the rework budget on a manual retry", async () => {
    const repo = makeRepo();
    const { board, teamId } = makeBoard(repo);
    const taskId = addTask(board, teamId, "retried by hand");

    for (let round = 0; round < 2; round++) {
      const claim = board.claim(taskId, "lead");
      assert.ok(claim);
      board.start(taskId, claim.claimToken, `run-manual/${taskId}`);
      board.submit(taskId, claim.claimToken, { status: "passed" }, { summary: "again" });
      board.rework(taskId, "lead", `note ${round + 1}`);
    }
    // A manual stop and retry bumps `attempt` but is not a rework: it must not
    // push the task over the ceiling.
    board.block(taskId, "lead", "stopped by hand");
    board.retry(taskId, "lead");
    assert.equal(board.getTask(taskId)?.attempt, 4);

    const { executor } = fakeExecutor({
      run: (input) => fs.writeFileSync(path.join(input.workDir, "done.txt"), "x\n", "utf-8"),
    });
    const result = await runCodingTeam({} as OpenCodeClient, board, {
      ...teamOptions(repo, teamId, "run-manual", executor),
      maxAttempts: 3,
    });

    assert.equal(result.merged, 1, result.tasks[0]?.reason ?? "");
    assert.equal(board.getTask(taskId)?.status, "done");
  });

  void it("reports work it could not start instead of claiming success", async () => {
    const repo = makeRepo();
    const { board, teamId } = makeBoard(repo);
    const first = addTask(board, teamId, "first");
    const second = board.createTask({
      teamId,
      title: "second",
      goal: "g",
      actor: "lead",
      dependsOn: [first],
    }).boardTaskId;

    const { executor } = fakeExecutor({ run: () => undefined });
    const result = await runCodingTeam({} as OpenCodeClient, board, {
      ...teamOptions(repo, teamId, "run-waiting", executor),
      taskIds: [second],
    });

    assert.equal(result.tasks.length, 0);
    assert.equal(result.waiting, 2, "both the dependency and the waiting task remain");
    assert.equal(teamExitCode(result), 2);
  });

  void it("never runs more agents than the parallel limit", async () => {
    const repo = makeRepo();
    const { board, teamId } = makeBoard(repo);
    for (const title of ["a", "b", "c", "d"]) addTask(board, teamId, title);

    let active = 0;
    let peak = 0;
    let written = 0;
    const executor: Executor = {
      async run(input: ExecutorInput): Promise<StepExecution> {
        fs.writeFileSync(path.join(input.workDir, `f${written++}.txt`), "x\n", "utf-8");
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 30));
        active--;
        return ok(input);
      },
    };

    const result = await runCodingTeam({} as OpenCodeClient, board, {
      ...teamOptions(repo, teamId, "run-parallel", executor),
      maxParallel: 2,
    });

    assert.equal(result.merged, 4);
    assert.equal(peak, 2);
  });

  void it("stops taking work once the run is interrupted", async () => {
    const repo = makeRepo();
    const { board, teamId } = makeBoard(repo);
    const first = addTask(board, teamId, "first");
    const second = addTask(board, teamId, "second");
    const controller = new AbortController();
    controller.abort();
    const { executor, calls } = fakeExecutor({ run: () => undefined });

    const result = await runCodingTeam({} as OpenCodeClient, board, {
      ...teamOptions(repo, teamId, "run-aborted", executor),
      signal: controller.signal,
    });

    assert.equal(result.skipped, 2);
    assert.equal(calls.length, 0);
    assert.equal(board.getTask(first)?.status, "backlog");
    assert.equal(board.getTask(second)?.status, "backlog");
  });

  void it("does not jam on a leftover worktree after a failed start", async () => {
    const repo = makeRepo();
    const { board, teamId } = makeBoard(repo);
    const taskId = addTask(board, teamId, "detached project");
    // A detached project cannot name a base branch, so the run fails before the
    // agent starts. Without attempt+run in the worktree name the next run would
    // hit "worktree already exists" forever.
    git(repo, "checkout", "-q", "--detach");
    const { executor } = fakeExecutor({ run: () => undefined });

    const first = await runCodingTeam(
      {} as OpenCodeClient,
      board,
      teamOptions(repo, teamId, "run-detached1", executor),
    );
    assert.equal(first.errors, 1);
    assert.equal(board.getTask(taskId)?.status, "backlog");

    const second = await runCodingTeam(
      {} as OpenCodeClient,
      board,
      teamOptions(repo, teamId, "run-detached2", executor),
    );
    assert.equal(second.errors, 1);
    assert.match(second.tasks[0]?.reason ?? "", /git repository/);
    assert.equal(fs.readdirSync(path.join(repo, ".deus", "worktrees")).length, 0);
  });

  void it("refuses to start on a dirty project", async () => {
    const repo = makeRepo();
    const { board, teamId } = makeBoard(repo);
    fs.writeFileSync(path.join(repo, "readme.md"), "dirty\n", "utf-8");
    const { executor } = fakeExecutor({ run: () => undefined });

    await assert.rejects(
      runCodingTeam({} as OpenCodeClient, board, teamOptions(repo, teamId, "run-dirty", executor)),
      (error: unknown) => error instanceof TeamError && error.code === "dirty_worktree",
    );
  });

  void it("refuses to run without checks", async () => {
    const repo = makeRepo();
    const { board, teamId } = makeBoard(repo);
    const { executor } = fakeExecutor({ run: () => undefined });

    await assert.rejects(
      runCodingTeam({} as OpenCodeClient, board, {
        ...teamOptions(repo, teamId, "run-nochecks", executor),
        checks: [],
      }),
      (error: unknown) => error instanceof TeamError && error.code === "no_checks",
    );
  });

  void it("rejects a run id that would not name a run directory", async () => {
    const repo = makeRepo();
    const { board, teamId } = makeBoard(repo);
    const { executor } = fakeExecutor({ run: () => undefined });

    await assert.rejects(
      runCodingTeam({} as OpenCodeClient, board, {
        ...teamOptions(repo, teamId, "team-1", executor),
      }),
      (error: unknown) => error instanceof TeamError && error.code === "invalid_input",
    );
  });

  void it("refuses a second run while the lock is held", async () => {
    const repo = makeRepo();
    const { board, teamId } = makeBoard(repo);
    const { executor } = fakeExecutor({ run: () => undefined });
    fs.writeFileSync(
      path.join(repo, ".deus", "team.lock"),
      `${JSON.stringify({ pid: process.pid, runId: "run-other" })}\n`,
      "utf-8",
    );

    await assert.rejects(
      runCodingTeam({} as OpenCodeClient, board, teamOptions(repo, teamId, "run-locked", executor)),
      (error: unknown) => error instanceof TeamError && error.code === "team_busy",
    );
  });
});
