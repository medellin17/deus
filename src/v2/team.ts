import fs from "node:fs";
import path from "node:path";

import type { Board, BoardStatus, BoardTask, Verification } from "./board.ts";
import type { OpenCodeClient } from "./client.ts";
import { SessionExecutor } from "./executor.ts";
import { applyBaseline, runGate } from "./gate.ts";
import {
  branchExists,
  commitWorktree,
  createBranch,
  deleteBranch,
  mergeBranch,
  resetHard,
  revParse,
  worktreeStatus,
} from "./gitflow.ts";
import { recordStepSession } from "./sessions.ts";
import type { CheckCommand, Executor, GateResult } from "./types.ts";
import { prepareWorkdir, removeWorkdir } from "./worktree.ts";

export const DEFAULT_MAX_PARALLEL = 3;
export const MAX_PARALLEL = 8;

/** Errors that are the operator's fault, reported as `error: <code>: <text>`. */
export class TeamError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TeamError";
  }
}

export interface CodingTeamOptions {
  projectDir: string;
  teamId: string;
  /** Must match `^run-[0-9A-Za-z]+$`: it names the run directory and branch. */
  runId: string;
  model: string;
  checks: CheckCommand[];
  /** Board actor for every mutation the runner performs. */
  actor?: string;
  /** Agent that writes the code. */
  agent?: string;
  maxParallel?: number;
  timeoutMs: number;
  /** Keep the worktree and branch after a successful merge. */
  keepWorktrees?: boolean;
  /** Explicit task list; otherwise every ready task of the team is taken. */
  taskIds?: string[];
  /** Test seam: replaces the session executor. */
  executor?: Executor;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface TaskRunResult {
  boardTaskId: string;
  title: string;
  status: "merged" | "review" | "blocked" | "error" | "skipped";
  boardStatus?: BoardStatus;
  branch?: string;
  workDir?: string;
  commit?: string;
  sessionID?: string;
  gate?: GateResult;
  verification?: Verification;
  cost?: number;
  reason?: string;
}

/** 0 — everything done, 2 — work left for a human, 1 — infrastructure error. */
export function teamExitCode(result: TeamRunResult): number {
  if (result.errors > 0) return 1;
  if (result.review + result.blocked > 0) return 2;
  // An interrupted run did not finish the queue: that is work left, not success.
  if (result.tasks.some((task) => task.reason === "interrupted")) return 2;
  return 0;
}

export interface TeamRunResult {
  runId: string;
  tasks: TaskRunResult[];
  merged: number;
  review: number;
  blocked: number;
  errors: number;
  skipped: number;
  cost: number;
}

const RUN_ID = /^run-[0-9A-Za-z]+$/;

function promptFor(task: BoardTask): string {
  const lines = [
    "Ты работаешь в отдельном git worktree этой задачи.",
    "",
    `Задача: ${task.title}`,
    `Цель: ${task.goal}`,
  ];
  if (task.doneWhen.trim().length > 0) {
    lines.push(`Готово, когда: ${task.doneWhen}`);
  }
  lines.push(
    "",
    "Правила:",
    "- меняй файлы только в этом каталоге;",
    "- не делай git commit, merge, rebase или push: коммит и слияние выполнит раннер;",
    "- не трогай `.deus/**`;",
    "- в конце перечисли изменённые файлы и что проверил.",
  );
  return lines.join("\n");
}

/**
 * Ready means: unclaimed work in this team whose dependencies are all done.
 * A claim whose lease expired is ready too: the previous runner died.
 */
export function selectReadyTasks(
  board: Board,
  teamId: string,
  taskIds?: string[],
): BoardTask[] {
  const all = board.list({ teamId, limit: 1_000 });
  const byId = new Map(all.map((task) => [task.boardTaskId, task]));

  if (taskIds !== undefined) {
    for (const id of taskIds) {
      if (!byId.has(id)) {
        throw new TeamError("not_found", `task ${id} is not in this team`);
      }
    }
  }

  const done = new Set(
    all.filter((task) => task.status === "done").map((task) => task.boardTaskId),
  );
  const now = Date.now();
  const candidates = taskIds
    ? [...new Set(taskIds)].map((id) => byId.get(id) as BoardTask)
    : all;

  return candidates
    .filter((task) => {
      if (!task.dependsOn.every((id) => done.has(id))) return false;
      if (task.status === "backlog") return true;
      if (task.status !== "claimed") return false;
      const lease = task.leaseUntil ? Date.parse(task.leaseUntil) : 0;
      return lease <= now;
    })
    .sort(
      (left, right) =>
        right.priority - left.priority || left.createdAt.localeCompare(right.createdAt),
    );
}

/** One team run per project: two runs would fight over the project worktree. */
function acquireLock(projectDir: string, runId: string): () => void {
  const file = path.join(projectDir, ".deus", "team.lock");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload = `${JSON.stringify({ pid: process.pid, runId })}\n`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // `wx` makes check-and-create a single syscall: two runs cannot both win.
      fs.writeFileSync(file, payload, { encoding: "utf-8", flag: "wx" });
      return () => {
        try {
          const owner = JSON.parse(fs.readFileSync(file, "utf-8")) as {
            pid?: number;
            runId?: string;
          };
          if (owner.pid === process.pid && owner.runId === runId) {
            fs.rmSync(file, { force: true });
          }
        } catch {
          // The lock vanished: nothing to release.
        }
      };
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;

      let owner: { pid?: number; runId?: string } = {};
      try {
        owner = JSON.parse(fs.readFileSync(file, "utf-8")) as typeof owner;
      } catch {
        owner = {};
      }
      if (typeof owner.pid === "number" && isAlive(owner.pid)) {
        throw new TeamError(
          "team_busy",
          `another team run is active (pid ${owner.pid}, run ${owner.runId ?? "?"})`,
        );
      }
      fs.rmSync(file, { force: true });
    }
  }

  throw new TeamError("team_busy", "cannot acquire .deus/team.lock");
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function shortRun(runId: string): string {
  // The tail carries the millisecond stamp; the head is the date and would make
  // every run of the same day share a worktree name.
  const tail = runId.replace(/^run-/, "").replace(/[^0-9A-Za-z]/g, "").slice(-9);
  return tail || "team";
}

async function pool<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const size = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length) {
        const index = next++;
        await worker(items[index], index);
      }
    }),
  );
}

interface Deps {
  client: OpenCodeClient;
  board: Board;
  options: Required<Pick<CodingTeamOptions, "projectDir" | "runId" | "model" | "timeoutMs">> &
    CodingTeamOptions;
  actor: string;
  agent: string;
  executor: Executor;
  mergeLock: <T>(fn: () => Promise<T> | T) => Promise<T>;
  count: { value: number };
}

/**
 * Gates the current HEAD in a throwaway worktree. Running in `projectDir`
 * would expose the checks to the worktrees of agents that are still working.
 */
function gateAtHead(deps: Deps, baseline: GateResult | undefined): GateResult {
  const id = `scratch-${shortRun(deps.options.runId)}-${deps.count.value++}`;
  const prepared = prepareWorkdir(deps.options.projectDir, id, true);
  if (!prepared.worktree) {
    throw new TeamError("not_git", "the post-merge gate needs a git worktree");
  }
  try {
    return applyBaseline(baseline, runGate(deps.options.checks, prepared.workDir));
  } finally {
    removeWorkdir(deps.options.projectDir, prepared.workDir);
  }
}

function verificationOf(status: Verification["status"], checks: unknown): Verification {
  return { status, checks };
}

async function runTask(task: BoardTask, deps: Deps, baseline: { value: GateResult }): Promise<TaskRunResult> {
  const { board, options, actor, agent } = deps;
  const base = { boardTaskId: task.boardTaskId, title: task.title };
  const claim = board.claim(task.boardTaskId, actor);
  if (!claim) {
    return { ...base, status: "skipped", reason: "another runner holds the task" };
  }

  // The baseline this task is judged against: the HEAD its worktree is cut
  // from. A concurrent merge may move the shared baseline; this task must not
  // inherit that move.
  const taskBaseline = baseline.value;
  const worktreeId = `t-${task.boardTaskId}-a${claim.attempt}-${shortRun(options.runId)}`;
  const branch = `deus/${worktreeId}`;
  let started = false;
  let workDir: string | undefined;
  let sessionID: string | undefined;
  let gate: GateResult | undefined;
  let cost = 0;

  const fail = (reason: string, status: TaskRunResult["status"]): TaskRunResult => {
    const current = board.getTask(task.boardTaskId)?.status;
    if (current === "done" || current === "cancelled") {
      return { ...base, status: current === "done" ? "merged" : "skipped", boardStatus: current, reason };
    }
    const note = reason.slice(0, 500);
    try {
      if (started && current !== "blocked") {
        board.block(task.boardTaskId, actor, note, claim.claimToken);
      } else if (!started && current === "claimed") {
        if (workDir !== undefined) removeWorkdir(options.projectDir, workDir);
        board.release(task.boardTaskId, claim.claimToken);
      }
    } catch {
      // A failed bookkeeping write must not hide the task: try once without the
      // token (the lead path) and, if even that fails, say so loudly.
      try {
        board.block(task.boardTaskId, actor, note);
      } catch {
        options.onProgress?.(
          `warn: task ${task.boardTaskId} is still ${board.getTask(task.boardTaskId)?.status ?? "unknown"}; ` +
            `run --board-task block --board-id ${task.boardTaskId} --board-actor ${actor}`,
        );
      }
    }
    return {
      ...base,
      status,
      boardStatus: board.getTask(task.boardTaskId)?.status,
      branch: branchExists(options.projectDir, branch) ? branch : undefined,
      workDir,
      sessionID,
      gate,
      cost,
      reason,
    };
  };

  try {
    const prepared = prepareWorkdir(options.projectDir, worktreeId, true);
    workDir = prepared.workDir;
    if (!prepared.worktree || !prepared.baseCommit || !prepared.baseBranch) {
      throw new TeamError(
        "not_git",
        "--team-run needs a git repository with a checked-out branch",
      );
    }

    board.start(task.boardTaskId, claim.claimToken, `${options.runId}/${task.boardTaskId}`);
    started = true;

    const execution = await deps.executor.run({
      step: { id: task.boardTaskId, agent, task: promptFor(task) },
      prompt: promptFor(task),
      runId: options.runId,
      index: deps.count.value++,
      workDir,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });
    sessionID = execution.sessionID || undefined;
    cost = execution.cost ?? 0;

    // Even a failed session must be findable: a rework wake goes to it.
    if (sessionID) {
      recordStepSession(options.projectDir, options.runId, {
        stepId: task.boardTaskId,
        sessionID,
        agent,
      });
    }

    if (execution.status !== "succeeded") {
      return fail(`executor failed: ${execution.error ?? "no answer"}`, "blocked");
    }

    gate = applyBaseline(taskBaseline, runGate(options.checks, workDir));
    if (gate.status === "failed") {
      board.submit(
        task.boardTaskId,
        claim.claimToken,
        verificationOf("failed", { gate }),
        { summary: `gate failed: ${gate.error ?? "checks failed"}`, artifacts: sessionID ? [sessionID] : [] },
      );
      board.addMessage(task.boardTaskId, actor, `gate failed: ${gate.error ?? "checks failed"}`.trim());
      return {
        ...base,
        status: "review",
        boardStatus: "review",
        workDir,
        sessionID,
        gate,
        cost,
        reason: gate.error,
      };
    }

    // An agent that ignored the rule and committed leaves a clean tree whose
    // HEAD moved: attach the branch to that commit instead of losing the work.
    const head = revParse(workDir, "HEAD");
    if (head !== undefined && head !== prepared.baseCommit) {
      if (worktreeStatus(workDir) === "" && !branchExists(options.projectDir, branch)) {
        if (!createBranch(workDir, branch)) {
          return fail("cannot attach a branch to the agent's commit", "blocked");
        }
      }
    }

    const committed = commitWorktree({
      projectDir: options.projectDir,
      workDir,
      branch,
      message: `deus: ${task.title}\n\nRun: ${options.runId}\nTask: ${task.boardTaskId}\nAttempt: ${claim.attempt}`,
    });

    if (committed.status === "no-changes") {
      board.submit(
        task.boardTaskId,
        claim.claimToken,
        verificationOf("skipped", { gate }),
        { summary: "the worktree has no changes", artifacts: sessionID ? [sessionID] : [] },
      );
      return {
        ...base,
        status: "review",
        boardStatus: "review",
        workDir,
        sessionID,
        gate,
        cost,
        reason: "no changes",
      };
    }

    if (committed.status === "skipped") {
      return fail(committed.reason ?? "commit failed", "blocked");
    }

    return await deps.mergeLock(async () => {
      // The exact commit this task merges into. `ORIG_HEAD` is shared mutable
      // state: another git command may have moved it, so it must not decide a
      // rollback.
      const headBeforeMerge = revParse(options.projectDir, "HEAD");
      const merge = mergeBranch({
        projectDir: options.projectDir,
        branch,
        baseCommit: prepared.baseCommit as string,
        baseBranch: prepared.baseBranch as string,
        runId: options.runId,
        title: task.title,
      });

      if (merge.status === "merged" || merge.status === "already-merged") {
        let post: GateResult;
        try {
          post = gateAtHead(deps, taskBaseline);
        } catch (error) {
          post = {
            status: "failed",
            checks: [],
            durationMs: 0,
            error: `post-merge gate crashed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
        if (post.status !== "passed") {
          // Only undo a merge this run created, and only to the commit we saw.
          // `already-merged` means the project moved some other way: resetting
          // there would throw away someone else's work.
          const rolledBack =
            merge.status === "merged" &&
            headBeforeMerge !== undefined &&
            resetHard(options.projectDir, headBeforeMerge);
          const suffix =
            merge.status === "already-merged"
              ? " (the branch was already merged; the project was left as is)"
              : rolledBack
                ? " (merge rolled back)"
                : " (rollback failed: check the project by hand)";
          return fail(
            `post-merge gate failed: ${post.error ?? "checks failed"}${suffix}`,
            "blocked",
          );
        }
        baseline.value = post;

        board.submit(
          task.boardTaskId,
          claim.claimToken,
          verificationOf("passed", { gate, merge: merge.status, post }),
          {
            summary: `merged ${branch}`,
            artifacts: [branch, ...(sessionID ? [sessionID] : [])],
          },
        );
        board.accept(task.boardTaskId, actor);

        if (!options.keepWorktrees) {
          removeWorkdir(options.projectDir, prepared.workDir);
          deleteBranch(options.projectDir, branch);
        }

        return {
          ...base,
          status: "merged",
          boardStatus: "done",
          branch,
          workDir: options.keepWorktrees ? workDir : undefined,
          commit: merge.commit ?? committed.commit,
          sessionID,
          gate,
          cost,
        };
      }

      board.submit(
        task.boardTaskId,
        claim.claimToken,
        verificationOf("failed", { gate, merge }),
        {
          summary: `merge ${merge.status}: ${merge.reason ?? "not merged"}`,
          artifacts: [branch, ...(sessionID ? [sessionID] : [])],
        },
      );
      board.addMessage(
        task.boardTaskId,
        actor,
        `branch ${branch} was not merged: ${merge.reason ?? merge.status}`,
      );
      return {
        ...base,
        status: "review",
        boardStatus: "review",
        branch,
        workDir,
        sessionID,
        gate,
        cost,
        reason: merge.reason ?? merge.status,
      };
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return fail(reason, "error");
  }
}

export async function runCodingTeam(
  client: OpenCodeClient,
  board: Board,
  options: CodingTeamOptions,
): Promise<TeamRunResult> {
  if (!RUN_ID.test(options.runId)) {
    throw new TeamError("invalid_input", `run id must look like run-<id>, got ${options.runId}`);
  }
  if (options.checks.length === 0) {
    throw new TeamError(
      "no_checks",
      "a coding team cannot mark work done without checks; configure \"checks\" or pass --check",
    );
  }

  const parallel = Math.min(
    MAX_PARALLEL,
    Math.max(1, Math.trunc(options.maxParallel ?? DEFAULT_MAX_PARALLEL)),
  );
  const projectDir = options.projectDir;

  const status = worktreeStatus(projectDir);
  if (status === undefined) {
    throw new TeamError("not_git", "cannot read the project worktree");
  }
  if (status.length > 0) {
    throw new TeamError(
      "dirty_worktree",
      "commit or stash your changes first: a team run merges into a clean project",
    );
  }

  const release = acquireLock(projectDir, options.runId);
  try {
    const short = shortRun(options.runId);
    const baselineId = `baseline-${short}`;
    const prepared = prepareWorkdir(projectDir, baselineId, true);
    if (!prepared.worktree) {
      throw new TeamError("not_git", "--team-run needs a git repository with a checked-out branch");
    }
    let baseline: GateResult;
    try {
      baseline = applyBaseline(undefined, runGate(options.checks, prepared.workDir));
      options.onProgress?.(`baseline: ${baseline.status}`);
    } finally {
      removeWorkdir(projectDir, prepared.workDir);
    }

    const tasks = selectReadyTasks(board, options.teamId, options.taskIds);
    options.onProgress?.(`tasks: ${tasks.length}, parallel: ${parallel}`);

    const actor = options.actor ?? "team";
    const agent = options.agent ?? "build";
    const executor: Executor =
      options.executor ??
      new SessionExecutor(client, {
        model: options.model,
        onLog: (line) => options.onProgress?.(line),
      });

    let mergeTail: Promise<unknown> = Promise.resolve();
    const mergeLock = <T>(fn: () => Promise<T> | T): Promise<T> => {
      const run = mergeTail.then(fn, fn);
      mergeTail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    };

    const baselineBox = { value: baseline };
    const deps: Deps = {
      client,
      board,
      options,
      actor,
      agent,
      executor,
      mergeLock,
      count: { value: 0 },
    };

    const results: TaskRunResult[] = new Array(tasks.length);
    await pool(tasks, parallel, async (task, index) => {
      if (options.signal?.aborted) {
        results[index] = {
          boardTaskId: task.boardTaskId,
          title: task.title,
          status: "skipped",
          boardStatus: task.status,
          reason: "interrupted",
        };
        return;
      }
      const result = await runTask(task, deps, baselineBox);
      results[index] = result;
      options.onProgress?.(
        `task ${task.boardTaskId}: ${result.status}${result.reason ? ` (${result.reason})` : ""}`,
      );
    });

    const summary: TeamRunResult = {
      runId: options.runId,
      tasks: results,
      merged: results.filter((task) => task.status === "merged").length,
      review: results.filter((task) => task.status === "review").length,
      blocked: results.filter((task) => task.status === "blocked").length,
      errors: results.filter((task) => task.status === "error").length,
      skipped: results.filter((task) => task.status === "skipped").length,
      cost: results.reduce((total, task) => total + (task.cost ?? 0), 0),
    };
    return summary;
  } finally {
    release();
  }
}
