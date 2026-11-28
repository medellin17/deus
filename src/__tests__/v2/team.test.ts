import assert from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import Database from "better-sqlite3";

import { BoardError, openBoard, type Board } from "../../v2/board.ts";
import type { OpenCodeClient } from "../../v2/client.ts";
import { RunBusyError } from "../../v2/lock.ts";
import { runCodingTeam, selectReadyTasks, teamExitCode, TeamError } from "../../v2/team.ts";
import type { LeadAdvisor, LeadDecision, LeadEvidence } from "../../v2/lead.ts";
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

function fakeAdvisor(byTask: Map<string, LeadDecision[]>) {
  const calls: LeadEvidence[] = [];
  const advisor: LeadAdvisor = async (evidence) => {
    calls.push(evidence);
    const queue = byTask.get(evidence.task.boardTaskId) ?? [];
    const decision =
      queue.shift() ??
      ({ decision: "escalate", reason: "test: no decision left" } as LeadDecision);
    return { decision, cost: 0.0001 };
  };
  return { advisor, calls };
}

const LEAD_NOTE = "remove broken.txt and create a.txt instead";

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

  void it("does not merge when aborted during the task gate", async () => {
    const repo = makeRepo();
    const { board, teamId } = makeBoard(repo);
    const taskId = addTask(board, teamId, "slow gate");
    const { executor, calls } = fakeExecutor({
      run: (input) => {
        fs.writeFileSync(path.join(input.workDir, "slow"), "1\n", "utf-8");
        fs.writeFileSync(path.join(input.workDir, "a.txt"), "a\n", "utf-8");
      },
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 100);
    try {
      const result = await runCodingTeam({} as OpenCodeClient, board, {
        ...teamOptions(repo, teamId, "run-abortgate", executor),
        checks: [{ name: "slow", command: "if test -f slow; then sleep 5; else exit 0; fi" }],
        signal: controller.signal,
      });
      assert.equal(calls.length, 1);
      assert.equal(result.tasks[0].status, "skipped");
      assert.match(result.tasks[0].reason ?? "", /interrupted/);
      assert.equal(board.getTask(taskId)?.status, "blocked");
      assert.equal(fs.existsSync(path.join(repo, "a.txt")), false);
      assert.equal(fs.existsSync(path.join(repo, ".deus", "run.lock")), false);
    } finally {
      clearTimeout(timer);
    }
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

  void it("closes a failing task through the lead and counts it once", async () => {
    const repo = makeRepo();
    const { board, teamId } = makeBoard(repo);
    const fixed = addTask(board, teamId, "fixable");
    const hopeless = addTask(board, teamId, "hopeless");
    const attempts = new Map<string, number>();
    const { executor } = fakeExecutor({
      run: (input) => {
        const attempt = (attempts.get(input.step.id) ?? 0) + 1;
        attempts.set(input.step.id, attempt);
        if (input.step.id === fixed && attempt > 1) {
          fs.writeFileSync(path.join(input.workDir, "a.txt"), "a\n", "utf-8");
        } else {
          fs.writeFileSync(path.join(input.workDir, "broken.txt"), "x\n", "utf-8");
        }
      },
    });
    const { advisor, calls } = fakeAdvisor(
      new Map([
        [
          fixed,
          [{ decision: "rework", note: LEAD_NOTE, reason: "the check forbids broken.txt" }],
        ],
      ]),
    );

    const result = await runCodingTeam({} as OpenCodeClient, board, {
      ...teamOptions(repo, teamId, "run-leadcycle", executor),
      checks: NO_BROKEN,
      autoLead: true,
      maxRounds: 3,
      advisor,
    });

    // One record per task, not one per attempt.
    assert.equal(result.tasks.length, 2);
    assert.equal(result.merged, 1);
    assert.equal(result.review, 1);
    assert.equal(result.waiting, 0);
    assert.equal(result.rounds, 2);
    assert.equal(teamExitCode(result), 2);
    // 3 worker sessions at 0.001 plus 2 advisor calls at 0.0001.
    assert.ok(Math.abs(result.cost - 0.0032) < 1e-9, `cost ${result.cost}`);
    assert.ok(Math.abs(result.leadCost - 0.0002) < 1e-9, `leadCost ${result.leadCost}`);
    assert.equal(board.getTask(fixed)?.status, "done");
    assert.equal(board.getTask(hopeless)?.status, "review");
    // The failing task was tried twice; the escalated one only once.
    assert.equal(attempts.get(fixed), 2);
    assert.equal(attempts.get(hopeless), 1);
    // Each task is adjudicated once per run, even across rounds.
    assert.equal(calls.length, 2);
    assert.equal(result.tasks.find((task) => task.boardTaskId === fixed)?.lead?.decision, "rework");
    assert.equal(
      result.tasks.find((task) => task.boardTaskId === hopeless)?.lead?.decision,
      "escalate",
    );
    assert.match(
      board
        .events({ taskId: hopeless, limit: 50 })
        .map((event) => (event.payload as { text?: string }).text ?? "")
        .join("\n"),
      /auto-lead: escalated/,
    );
  });

  void it("does not call the lead when the run has a single round", async () => {
    const repo = makeRepo();
    const { board, teamId } = makeBoard(repo);
    addTask(board, teamId, "one shot");
    const { executor } = fakeExecutor({
      run: (input) => fs.writeFileSync(path.join(input.workDir, "broken.txt"), "x\n", "utf-8"),
    });
    let advised = 0;

    const result = await runCodingTeam({} as OpenCodeClient, board, {
      ...teamOptions(repo, teamId, "run-singleround", executor),
      checks: NO_BROKEN,
      autoLead: true,
      maxRounds: 1,
      advisor: async () => {
        advised += 1;
        return { decision: { decision: "escalate", reason: "should not be asked" } };
      },
    });

    assert.equal(advised, 0, "a single round has nothing to correct");
    assert.equal(result.rounds, 1);
    assert.equal(result.review, 1);
  });

  void it("stops before the next round when the cost cap is reached", async () => {
    const repo = makeRepo();
    const { board, teamId } = makeBoard(repo);
    addTask(board, teamId, "expensive");
    const { executor } = fakeExecutor({
      run: (input) => fs.writeFileSync(path.join(input.workDir, "broken.txt"), "x\n", "utf-8"),
    });
    const { advisor, calls } = fakeAdvisor(new Map());

    const result = await runCodingTeam({} as OpenCodeClient, board, {
      ...teamOptions(repo, teamId, "run-cost", executor),
      checks: NO_BROKEN,
      autoLead: true,
      maxRounds: 3,
      maxCost: 0,
      advisor,
    });

    assert.equal(calls.length, 0);
    assert.equal(result.costCapped, true);
    assert.equal(result.rounds, 1);
    assert.equal(teamExitCode(result), 1);
  });

  void it("hands the task to a human when the rework budget is spent", async () => {
    const repo = makeRepo();
    const { board, teamId } = makeBoard(repo);
    const taskId = addTask(board, teamId, "always red");
    const { executor } = fakeExecutor({
      run: (input) => fs.writeFileSync(path.join(input.workDir, "broken.txt"), "x\n", "utf-8"),
    });
    const { advisor, calls } = fakeAdvisor(
      new Map([[taskId, [
        { decision: "rework", note: LEAD_NOTE, reason: "first" },
        { decision: "rework", note: "another concrete instruction for the agent", reason: "second" },
      ]]]),
    );

    const result = await runCodingTeam({} as OpenCodeClient, board, {
      ...teamOptions(repo, teamId, "run-budget", executor),
      checks: NO_BROKEN,
      autoLead: true,
      maxAttempts: 2,
      maxRounds: 3,
      advisor,
    });

    // The second decision can only be an escalate, so it is taken without a
    // paid advisor call.
    assert.equal(calls.length, 1);
    assert.equal(result.tasks[0].lead?.decision, "escalate");
    assert.match(result.tasks[0].lead?.reason ?? "", /budget is spent/);
    // The runner's own block never fires: the lead stops one step earlier.
    assert.equal(board.getTask(taskId)?.status, "review");
    assert.doesNotMatch(board.getTask(taskId)?.blockedReason ?? "", /rework limit/);
  });

  void it("does not return a task with a note the lead already tried", async () => {
    const repo = makeRepo();
    const { board, teamId } = makeBoard(repo);
    addTask(board, teamId, "stuck");
    const { executor } = fakeExecutor({
      run: (input) => fs.writeFileSync(path.join(input.workDir, "broken.txt"), "x\n", "utf-8"),
    });
    const same = { decision: "rework", note: LEAD_NOTE, reason: "same advice" } as LeadDecision;
    const { advisor, calls } = fakeAdvisor(new Map());

    const result = await runCodingTeam({} as OpenCodeClient, board, {
      ...teamOptions(repo, teamId, "run-stuck", executor),
      checks: NO_BROKEN,
      autoLead: true,
      maxAttempts: 5,
      maxRounds: 4,
      advisor: async (evidence, runId, index) => {
        calls.push(evidence);
        return { decision: { ...same }, cost: 0.0001 };
      },
    });

    assert.equal(calls.length, 2);
    assert.equal(result.tasks[0].lead?.decision, "escalate");
    assert.match(result.tasks[0].lead?.reason ?? "", /repeated an earlier note/);
  });

  void it("heals a merge conflict by starting the next attempt from the merged HEAD", async () => {
    const repo = makeRepo();
    const { board, teamId } = makeBoard(repo);
    const first = addTask(board, teamId, "first");
    const second = addTask(board, teamId, "second");

    // Both agents finish before either merge, otherwise the second worktree is
    // simply cut after the first merge and the conflict never happens.
    let arrived = 0;
    let open: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => {
      open = resolve;
    });
    const { executor } = fakeExecutor({
      run: async (input) => {
        fs.writeFileSync(
          path.join(input.workDir, "readme.md"),
          input.step.id === first ? "one\n" : "two\n",
          "utf-8",
        );
        arrived += 1;
        if (arrived === 2) open?.();
        if (arrived <= 2) await barrier;
      },
    });
    const { advisor, calls } = fakeAdvisor(
      new Map([
        [first, [{ decision: "rework", note: LEAD_NOTE, reason: "try again" }]],
        [second, [{ decision: "rework", note: LEAD_NOTE, reason: "try again" }]],
      ]),
    );

    const result = await runCodingTeam({} as OpenCodeClient, board, {
      ...teamOptions(repo, teamId, "run-conflictlead", executor),
      autoLead: true,
      maxRounds: 3,
      maxParallel: 2,
      advisor,
    });

    // Round 1: both run, the second merge conflicts. Round 2: the returned task
    // is cut from the HEAD that already holds the first one, so it merges.
    assert.equal(result.merged, 2);
    assert.equal(result.review, 0);
    assert.equal(result.rounds, 2);
    assert.equal(calls.length, 1, "only the conflicting task is adjudicated");
    assert.equal(calls[0].merge, "conflict");
    assert.equal(result.tasks.filter((task) => task.lead?.decision === "rework").length, 1);
  });

  void it("runs a dependent task in the same run once its dependency merges", async () => {
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
    const { executor } = fakeExecutor({
      run: (input) =>
        fs.writeFileSync(path.join(input.workDir, `${input.step.id}.txt`), "x\n", "utf-8"),
    });
    const { advisor, calls } = fakeAdvisor(new Map());

    const result = await runCodingTeam({} as OpenCodeClient, board, {
      ...teamOptions(repo, teamId, "run-chain", executor),
      autoLead: true,
      maxRounds: 3,
      advisor,
    });

    assert.equal(result.merged, 2);
    assert.equal(result.rounds, 2);
    assert.equal(result.waiting, 0);
    assert.equal(calls.length, 0, "no failure, so the lead is never asked");
    assert.equal(board.getTask(second)?.status, "done");
  });

  void it("escalates instead of looping when an advisor returns no note", async () => {
    const repo = makeRepo();
    const { board, teamId } = makeBoard(repo);
    const taskId = addTask(board, teamId, "no note");
    const { executor } = fakeExecutor({
      run: (input) => fs.writeFileSync(path.join(input.workDir, "broken.txt"), "x\n", "utf-8"),
    });
    let asked = 0;

    const result = await runCodingTeam({} as OpenCodeClient, board, {
      ...teamOptions(repo, teamId, "run-nonote", executor),
      checks: NO_BROKEN,
      autoLead: true,
      maxRounds: 4,
      advisor: async () => {
        asked += 1;
        return { decision: { decision: "rework" } as LeadDecision, cost: 0 };
      },
    });

    assert.equal(asked, 1);
    assert.equal(result.tasks[0].lead?.decision, "escalate");
    assert.match(result.tasks[0].lead?.reason ?? "", /without a usable note/);
    assert.equal(board.getTask(taskId)?.status, "review");
  });

  void it("does not retry an infrastructure failure round after round", async () => {
    const repo = makeRepo();
    const { board, teamId } = makeBoard(repo);
    addTask(board, teamId, "detached");
    git(repo, "checkout", "-q", "--detach");
    const { executor, calls } = fakeExecutor({ run: () => undefined });
    const { advisor, calls: advised } = fakeAdvisor(new Map());

    const result = await runCodingTeam({} as OpenCodeClient, board, {
      ...teamOptions(repo, teamId, "run-norespin", executor),
      autoLead: true,
      maxRounds: 5,
      advisor,
    });

    // Nothing merged, nothing was returned: another round would repeat the
    // same broken start.
    assert.equal(result.rounds, 1);
    assert.equal(calls.length, 0);
    assert.equal(advised.length, 0);
    assert.equal(result.errors, 1);
  });

  void it("leaves worktrees of other runs alone", async () => {
    const repo = makeRepo();
    const { board, teamId } = makeBoard(repo);
    addTask(board, teamId, "own tree");
    const foreign = path.join(repo, ".deus", "worktrees", "run-other");
    fs.mkdirSync(foreign, { recursive: true });
    fs.writeFileSync(path.join(foreign, "notes.txt"), "someone else\n", "utf-8");
    const { executor } = fakeExecutor({
      run: (input) => fs.writeFileSync(path.join(input.workDir, "mine.txt"), "x\n", "utf-8"),
    });

    const result = await runCodingTeam(
      {} as OpenCodeClient,
      board,
      teamOptions(repo, teamId, "run-own", executor),
    );

    assert.equal(result.merged, 1);
    assert.ok(fs.existsSync(foreign), "a foreign worktree must survive the sweep");
  });

  void it("keeps a tree across runs when asked", async () => {
    const repo = makeRepo();
    const { board, teamId } = makeBoard(repo);
    addTask(board, teamId, "keep me");
    const { executor, calls } = fakeExecutor({
      run: (input) => fs.writeFileSync(path.join(input.workDir, "kept.txt"), "x\n", "utf-8"),
    });

    const first = await runCodingTeam({} as OpenCodeClient, board, {
      ...teamOptions(repo, teamId, "run-keep1", executor),
      keepWorktrees: true,
    });
    const kept = first.tasks[0].workDir;
    assert.ok(kept && fs.existsSync(kept));

    addTask(board, teamId, "second");
    await runCodingTeam({} as OpenCodeClient, board, teamOptions(repo, teamId, "run-keep2", executor));

    assert.ok(fs.existsSync(kept), "the kept tree must survive the next run");
    assert.equal(calls.length, 2);
  });

  void it("does not roll the merge back when HEAD moved after it", async () => {
    const repo = makeRepo();
    const { board, teamId } = makeBoard(repo);
    const taskId = addTask(board, teamId, "moves head");
    const { executor } = fakeExecutor({
      run: (input) => fs.writeFileSync(path.join(input.workDir, "a.txt"), "a\n", "utf-8"),
    });

    // Passes before the merge, then fails after it and moves the project HEAD,
    // so the rollback would throw away a commit that is not ours.
    const command =
      `if git -C "${repo}" log -1 --format=%s | grep -q '^Merge deus'; then ` +
      `git -C "${repo}" commit --allow-empty -qm moved-by-check; exit 1; fi; exit 0`;

    const result = await runCodingTeam({} as OpenCodeClient, board, {
      ...teamOptions(repo, teamId, "run-moved", executor),
      checks: [{ name: "moved", command }],
    });

    assert.equal(result.blocked, 1, result.tasks[0]?.reason ?? "");
    assert.match(result.tasks[0].reason ?? "", /HEAD moved after the merge/);
    assert.equal(git(repo, "log", "-1", "--format=%s"), "moved-by-check");
    assert.equal(board.getTask(taskId)?.status, "blocked");
  });

  void it("recovers a task left running by a dead run", async () => {
    const repo = makeRepo();
    const { board, teamId } = makeBoard(repo);
    const taskId = addTask(board, teamId, "orphan");
    const claim = board.claim(taskId, "main");
    assert.ok(claim);
    board.start(taskId, claim.claimToken, `run-dead/${taskId}`);
    // A lock whose owner is dead is the evidence that a run died here.
    const child = spawnSync(process.execPath, ["-e", ""]);
    fs.writeFileSync(
      path.join(repo, ".deus", "run.lock"),
      `${JSON.stringify({ pid: child.pid, runId: "run-dead", kind: "team" })}\n`,
      "utf-8",
    );
    const { executor, calls } = fakeExecutor({ run: () => undefined });

    const result = await runCodingTeam(
      {} as OpenCodeClient,
      board,
      teamOptions(repo, teamId, "run-recover", executor),
    );

    assert.equal(calls.length, 0, "a dead run must not be continued blindly");
    assert.equal(board.getTask(taskId)?.status, "blocked");
    const reason = board.getTask(taskId)?.blockedReason ?? "";
    assert.match(reason, /previous run run-dead did not finish/);
    assert.match(reason, /git log --grep run-dead/);
    assert.equal(fs.existsSync(path.join(repo, ".deus", "crashed-run.json")), false);
    assert.equal(result.blocked, 1);
    assert.equal(result.tasks.length, 1);
    assert.equal(teamExitCode(result), 2);
  });

  void it("does not touch a task a human started by hand", async () => {
    const repo = makeRepo();
    const { board, teamId } = makeBoard(repo);
    const taskId = addTask(board, teamId, "manual");
    const claim = board.claim(taskId, "main");
    assert.ok(claim);
    board.start(taskId, claim.claimToken, "run-manual/step");
    // No lock: no run died, so `running` belongs to someone alive.
    const { executor, calls } = fakeExecutor({ run: () => undefined });

    await runCodingTeam({} as OpenCodeClient, board, teamOptions(repo, teamId, "run-manual", executor));

    assert.equal(calls.length, 0);
    assert.equal(board.getTask(taskId)?.status, "running");
  });

  void it("is blocked by a live pipeline lock", async () => {
    const repo = makeRepo();
    const { board, teamId } = makeBoard(repo);
    const { executor } = fakeExecutor({ run: () => undefined });
    fs.writeFileSync(
      path.join(repo, ".deus", "run.lock"),
      `${JSON.stringify({ pid: process.pid, runId: "run-pipe", kind: "pipeline" })}\n`,
      "utf-8",
    );

    await assert.rejects(
      runCodingTeam({} as OpenCodeClient, board, teamOptions(repo, teamId, "run-team", executor)),
      (error: unknown) => error instanceof RunBusyError && /pipeline/.test(error.message),
    );
  });

  void it("releases the lock after success and after an interrupt", async () => {
    const repo = makeRepo();
    const { board, teamId } = makeBoard(repo);
    addTask(board, teamId, "one");
    const { executor } = fakeExecutor({ run: () => undefined });
    await runCodingTeam({} as OpenCodeClient, board, teamOptions(repo, teamId, "run-rel1", executor));
    assert.equal(fs.existsSync(path.join(repo, ".deus", "run.lock")), false);

    addTask(board, teamId, "two");
    const controller = new AbortController();
    controller.abort();
    await runCodingTeam({} as OpenCodeClient, board, {
      ...teamOptions(repo, teamId, "run-rel2", executor),
      signal: controller.signal,
    });
    assert.equal(fs.existsSync(path.join(repo, ".deus", "run.lock")), false);
  });

  void it("rolls the merge back without touching an unrelated local edit", async () => {
    const repo = makeRepo();
    const { board, teamId } = makeBoard(repo);
    const taskId = addTask(board, teamId, "dirty during post-gate");
    const { executor } = fakeExecutor({
      run: (input) => fs.writeFileSync(path.join(input.workDir, "a.txt"), "a\n", "utf-8"),
    });

    // Fails the post-merge gate and edits a tracked file the merge did not
    // touch: `reset --keep` rolls back and keeps the edit.
    const command =
      `if git -C "${repo}" log -1 --format=%s | grep -q '^Merge deus'; then ` +
      `echo human-edit >> "${repo}/readme.md"; exit 1; fi; exit 0`;

    const result = await runCodingTeam({} as OpenCodeClient, board, {
      ...teamOptions(repo, teamId, "run-dirtyguard", executor),
      checks: [{ name: "guard", command }],
    });

    assert.equal(result.blocked, 1, result.tasks[0]?.reason ?? "");
    assert.match(result.tasks[0].reason ?? "", /merge rolled back/);
    assert.match(fs.readFileSync(path.join(repo, "readme.md"), "utf-8"), /human-edit/);
    assert.equal(fs.existsSync(path.join(repo, "a.txt")), false);
    assert.equal(board.getTask(taskId)?.status, "blocked");
  });

  void it("refuses the rollback when a local edit would be destroyed", async () => {
    const repo = makeRepo();
    const { board, teamId } = makeBoard(repo);
    addTask(board, teamId, "edited merge result");
    const { executor } = fakeExecutor({
      run: (input) => fs.writeFileSync(path.join(input.workDir, "a.txt"), "a\n", "utf-8"),
    });

    // The human edits the very file the merge added; removing it would lose
    // that edit, so --keep aborts and the task reports it.
    const command =
      `if git -C "${repo}" log -1 --format=%s | grep -q '^Merge deus'; then ` +
      `echo human-edit >> "${repo}/a.txt"; exit 1; fi; exit 0`;

    const result = await runCodingTeam({} as OpenCodeClient, board, {
      ...teamOptions(repo, teamId, "run-keepguard", executor),
      checks: [{ name: "guard", command }],
    });

    assert.equal(result.blocked, 1, result.tasks[0]?.reason ?? "");
    assert.match(result.tasks[0].reason ?? "", /rollback failed/);
    assert.match(fs.readFileSync(path.join(repo, "a.txt"), "utf-8"), /human-edit/);
  });

  void it("does not accept when HEAD no longer contains the merge", async () => {
    const repo = makeRepo();
    const { board, teamId } = makeBoard(repo);
    const taskId = addTask(board, teamId, "reset during post-gate");
    const { executor } = fakeExecutor({
      run: (input) => fs.writeFileSync(path.join(input.workDir, "a.txt"), "a\n", "utf-8"),
    });

    // Post-gate passes, but the project is rolled back before `accept`.
    const command =
      `if git -C "${repo}" log -1 --format=%s | grep -q '^Merge deus'; then ` +
      `git -C "${repo}" reset --hard HEAD~1 >/dev/null; fi; exit 0`;

    const result = await runCodingTeam({} as OpenCodeClient, board, {
      ...teamOptions(repo, teamId, "run-acceptguard", executor),
      checks: [{ name: "guard", command }],
    });

    assert.equal(result.blocked, 1, result.tasks[0]?.reason ?? "");
    assert.match(result.tasks[0].reason ?? "", /no longer contains the merge/);
    assert.equal(board.getTask(taskId)?.status, "blocked");
    assert.equal(fs.existsSync(path.join(repo, "a.txt")), false);
  });

  void it("warns about runner debris when the lock was removed by hand", async () => {
    const repo = makeRepo();
    const { board, teamId } = makeBoard(repo);
    const taskId = addTask(board, teamId, "left behind");
    const claim = board.claim(taskId, "main");
    assert.ok(claim);
    board.start(taskId, claim.claimToken, `run-dead/${taskId}`);
    const progress: string[] = [];
    const { executor } = fakeExecutor({ run: () => undefined });

    const result = await runCodingTeam({} as OpenCodeClient, board, {
      ...teamOptions(repo, teamId, "run-warn", executor),
      onProgress: (line) => progress.push(line),
    });

    // No stale lock: a run may not have died, so nothing is blocked.
    assert.equal(board.getTask(taskId)?.status, "running");
    assert.equal(result.tasks.length, 0);
    assert.match(progress.join("\n"), /is still running from run-dead/);
    assert.match(progress.join("\n"), /--board-task block --board-id/);
  });

  void it("leaves a hand-started task alone even after a stale lock", async () => {
    const repo = makeRepo();
    const { board, teamId } = makeBoard(repo);
    const taskId = addTask(board, teamId, "manual ref");
    const claim = board.claim(taskId, "main");
    assert.ok(claim);
    board.start(taskId, claim.claimToken, "run-manual/step");
    const child = spawnSync(process.execPath, ["-e", ""]);
    fs.writeFileSync(
      path.join(repo, ".deus", "run.lock"),
      `${JSON.stringify({ pid: child.pid, runId: "run-dead", kind: "team" })}\n`,
      "utf-8",
    );
    const { executor } = fakeExecutor({ run: () => undefined });

    await runCodingTeam({} as OpenCodeClient, board, teamOptions(repo, teamId, "run-manual2", executor));

    assert.equal(board.getTask(taskId)?.status, "running");
  });

  void it("recovers a task using a crash note left by another run", async () => {
    const repo = makeRepo();
    const { board, teamId } = makeBoard(repo);
    const taskId = addTask(board, teamId, "noted crash");
    const claim = board.claim(taskId, "main");
    assert.ok(claim);
    board.start(taskId, claim.claimToken, `run-old/${taskId}`);
    // No lock here: another run took the lock, found the crash and left a note.
    fs.writeFileSync(
      path.join(repo, ".deus", "crashed-run.json"),
      `${JSON.stringify({ pid: 1, runId: "run-old", kind: "team" })}\n`,
      "utf-8",
    );
    const { executor } = fakeExecutor({ run: () => undefined });

    await runCodingTeam({} as OpenCodeClient, board, teamOptions(repo, teamId, "run-noted", executor));

    assert.equal(board.getTask(taskId)?.status, "blocked");
    assert.match(board.getTask(taskId)?.blockedReason ?? "", /previous run run-old/);
    assert.equal(fs.existsSync(path.join(repo, ".deus", "crashed-run.json")), false);
  });

  void it("recovers a stuck task of another team", async () => {
    const repo = makeRepo();
    const { board, teamId } = makeBoard(repo);
    const other = board.createTeam({ name: "other", goal: "g", leadAgent: "otherlead" });
    const taskId = board.createTask({
      teamId: other.teamId,
      title: "stuck elsewhere",
      goal: "g",
      actor: "lead",
    }).boardTaskId;
    const claim = board.claim(taskId, "otherlead");
    assert.ok(claim);
    board.start(taskId, claim.claimToken, `run-other/${taskId}`);
    fs.writeFileSync(
      path.join(repo, ".deus", "crashed-run.json"),
      `${JSON.stringify({ pid: 1, runId: "run-other", kind: "team" })}\n`,
      "utf-8",
    );
    const { executor } = fakeExecutor({ run: () => undefined });

    // A run of a different team notices it first: the note is project-wide.
    await runCodingTeam({} as OpenCodeClient, board, teamOptions(repo, teamId, "run-cross", executor));

    assert.equal(board.getTask(taskId)?.status, "blocked");
    assert.match(board.getTask(taskId)?.blockedReason ?? "", /previous run run-other/);
    assert.equal(fs.existsSync(path.join(repo, ".deus", "crashed-run.json")), false);
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
      path.join(repo, ".deus", "run.lock"),
      `${JSON.stringify({ pid: process.pid, runId: "run-other", kind: "team" })}\n`,
      "utf-8",
    );

    await assert.rejects(
      runCodingTeam({} as OpenCodeClient, board, teamOptions(repo, teamId, "run-locked", executor)),
      (error: unknown) => error instanceof RunBusyError && error.code === "run_busy",
    );
  });
});
