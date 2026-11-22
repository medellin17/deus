import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { BoardError } from "./board.ts";
import type { Board, BoardEvent, BoardStatus, BoardTask, Verification } from "./board.ts";
import type { OpenCodeClient } from "./client.ts";
import { SessionExecutor } from "./executor.ts";
import { applyBaseline, runGate } from "./gate.ts";
import {
  branchDiff,
  branchExists,
  branchesMatching,
  headIs,
  commitWorktree,
  createBranch,
  deleteBranch,
  mergeBranch,
  isAncestor,
  resetKeeping,
  revParse,
  worktreeStatus,
} from "./gitflow.ts";
import {
  createLeadAdvisor,
  gateFromVerification,
  mergeFromVerification,
  type LeadAdvisor,
  type LeadDecision,
} from "./lead.ts";
import { acquireProjectLock, clearCrashMarker, readCrashMarker } from "./lock.ts";
import { recordStepSession } from "./sessions.ts";
import type { CheckCommand, Executor, GateResult } from "./types.ts";
import { prepareWorkdir, removeWorkdir } from "./worktree.ts";

export const DEFAULT_MAX_PARALLEL = 3;
export const MAX_PARALLEL = 8;
/** A task that keeps coming back is stopped instead of looping forever. */
export const DEFAULT_MAX_ATTEMPTS = 3;
/** Hard ceiling for the auto-lead loop; each round is a full pool of agents. */
export const MAX_ROUNDS = 9;

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
  /** Attempts a task may have before the runner blocks it. */
  maxAttempts?: number;
  timeoutMs: number;
  /** Keep the worktree and branch after a successful merge. */
  keepWorktrees?: boolean;
  /** Explicit task list; otherwise every ready task of the team is taken. */
  taskIds?: string[];
  /** Let a tool-less advisor decide rework/escalate for failed tasks. */
  autoLead?: boolean;
  /** Pools per run, including the first one. Defaults to maxAttempts, capped. */
  maxRounds?: number;
  /** Stop the run (and the loop) once the total cost reaches this. */
  maxCost?: number;
  /** Board actor for the advisor's decisions. */
  leadActor?: string;
  /** Agent for the advisor session; it runs under deny-all permissions. */
  leadAgent?: string;
  /** Test seam: replaces the model call with a decision function. */
  advisor?: LeadAdvisor;
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
  /** How the auto-lead closed this task, when it ran. */
  lead?: { decision: LeadDecision["decision"]; reason: string };
}

/** 0 — everything done, 2 — work left for a human, 1 — infrastructure error. */
export function teamExitCode(result: TeamRunResult): number {
  if (result.errors > 0) return 1;
  // A cost cap is a runner-side stop, like the pipeline's own cap.
  if (result.costCapped) return 1;
  if (result.review + result.blocked > 0) return 2;
  // An interrupted run did not finish the queue: that is work left, not success.
  if (result.tasks.some((task) => task.reason === "interrupted")) return 2;
  if (result.tasks.some((task) => task.reason?.startsWith("returned for rework"))) return 2;
  if (result.waiting > 0) return 2;
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
  /** Tasks of the team still waiting for their turn after the run. */
  waiting: number;
  /** Pools actually executed. */
  rounds: number;
  /** Part of `cost` spent on the advisor. */
  leadCost: number;
  /** The run stopped because it reached `maxCost`. */
  costCapped: boolean;
  cost: number;
}

/** Same instruction, different whitespace and case. */
function sameNote(left: string, right: string): boolean {
  const norm = (value: string) => value.toLowerCase().replace(/\s+/g, " ").trim();
  return norm(left) === norm(right);
}

const RUN_ID = /^run-[0-9A-Za-z]+$/;
/** The execution ref the runner writes: `<runId>/<boardTaskId>`. */
const RUNNER_REF = /^run-[0-9A-Za-z]+\/bt-[0-9a-f]{12}$/;

/** The times the lead sent this task back, newest first. */
function reworkEvents(board: Board, taskId: string) {
  return board
    .events({ taskId, order: "desc", limit: 5_000 })
    .filter((event) => event.type === "task/reworked");
}

function notesFromEvents(events: BoardEvent[], limit = 3): string[] {
  return events
    .map((event) => (event.payload as { note?: unknown }).note)
    .filter((note): note is string => typeof note === "string" && note.trim().length > 0)
    .slice(0, limit)
    .reverse();
}

/** Notes the lead attached to the times this task was sent back. */
export function reworkNotes(board: Board, taskId: string, limit = 3): string[] {
  return notesFromEvents(reworkEvents(board, taskId), limit);
}

/** The branch a previous attempt left behind, if the board still knows it. */
function previousBranch(task: BoardTask): string | undefined {
  return task.artifacts.find((artifact) => artifact.startsWith("deus/"));
}

function promptFor(
  task: BoardTask,
  context: { notes: string[]; diff?: string },
): string {
  const lines = [
    "Ты работаешь в отдельном git worktree этой задачи.",
    "",
    `Задача: ${task.title}`,
  ];

  // The lead's notes come before the goal: when they disagree, the note wins,
  // and the goal is usually the thing that was just rejected.
  if (context.notes.length > 0) {
    lines.push("", "Предыдущая попытка отклонена. Это важнее цели ниже:");
    for (const note of context.notes) lines.push(`- ${note}`);
  }

  lines.push("", `Цель: ${task.goal}`);
  if (task.doneWhen.trim().length > 0) {
    lines.push(`Готово, когда: ${task.doneWhen}`);
  }

  if (context.diff !== undefined) {
    lines.push(
      "",
      "Что уже сделано в предыдущей попытке (diff её ветки):",
      "```diff",
      context.diff,
      "```",
    );
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

function shortRun(runId: string): string {
  // A hash of the whole id: a slice of the timestamp dropped an hour digit and
  // let two runs of the same day share a worktree name.
  return crypto.createHash("sha1").update(runId).digest("hex").slice(0, 10);
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

/**
 * An agent that ignored the rule and committed leaves a clean tree whose HEAD
 * moved. Attach the branch to that commit so the work is not lost.
 */
function attachAgentCommit(
  projectDir: string,
  workDir: string,
  branch: string,
  baseCommit: string,
): boolean {
  const head = revParse(workDir, "HEAD");
  if (head === undefined || head === baseCommit) return true;
  if (worktreeStatus(workDir) !== "") return true;
  if (branchExists(projectDir, branch)) return true;
  return createBranch(workDir, branch);
}

async function runTask(task: BoardTask, deps: Deps, baseline: { value: GateResult }): Promise<TaskRunResult> {
  const { board, options, actor, agent } = deps;
  const base = { boardTaskId: task.boardTaskId, title: task.title };
  let claim: ReturnType<Board["claim"]>;
  try {
    claim = board.claim(task.boardTaskId, actor);
  } catch (error) {
    // The board moved between selection and claim (another process accepted,
    // cancelled or blocked the task). That is a normal race. A storage failure
    // is not: it must not look like "nothing to do".
    if (!(error instanceof BoardError)) {
      const reason = error instanceof Error ? error.message : String(error);
      return { ...base, status: "error", reason: `cannot claim the task: ${reason}` };
    }
    return { ...base, status: "skipped", reason: `the board moved: ${error.message}` };
  }
  if (!claim) {
    return { ...base, status: "skipped", reason: "another runner holds the task" };
  }

  // The budget counts times the lead sent the task back, not board attempts:
  // a manual `retry` or a lost lease must not spend it.
  const maxReworks = Math.max(1, Math.trunc(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
  const reworks = reworkEvents(board, task.boardTaskId).length;
  if (reworks >= maxReworks) {
    const branches = task.artifacts.filter((artifact) => artifact.startsWith("deus/"));
    const reason =
      `rework limit reached (${reworks}/${maxReworks}); raise --team-max-attempts or split the task` +
      (branches.length > 0 ? `; attempts: ${branches.join(", ")}` : "");
    try {
      board.block(task.boardTaskId, actor, reason.slice(0, 500), claim.claimToken);
    } catch {
      // The board moved under us; report the limit without changing state.
    }
    return {
      ...base,
      status: "blocked",
      boardStatus: board.getTask(task.boardTaskId)?.status,
      reason,
    };
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
      return {
        ...base,
        status: "skipped",
        boardStatus: current,
        reason: `closed elsewhere: ${reason}`,
      };
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

    const notes = reworkNotes(board, task.boardTaskId);
    if (notes.length === 0 && task.resultSummary && task.resultSummary.trim().length > 0) {
      // No note from the lead: the runner's own verdict is the next best input.
      notes.push(task.resultSummary.trim());
    }
    const prevBranch = previousBranch(task);
    const diff = prevBranch ? branchDiff(options.projectDir, prevBranch) : undefined;
    if (prevBranch && diff === undefined) {
      options.onProgress?.(
        `task ${task.boardTaskId}: previous branch ${prevBranch} has no readable diff`,
      );
    }
    const prompt = promptFor(task, { notes, diff });

    const execution = await deps.executor.run({
      step: { id: task.boardTaskId, agent, task: prompt },
      prompt,
      runId: options.runId,
      index: deps.count.value++,
      workDir,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });
    sessionID = execution.sessionID || undefined;
    cost = execution.cost ?? 0;

    // Even a failed session must be findable: messageTask and the board use it.
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
      // Keep the attempt as a branch even though it failed the gate: the next
      // attempt reads its diff, and nothing is merged, so the project never
      // sees unverified code.
      if (!attachAgentCommit(options.projectDir, workDir, branch, prepared.baseCommit)) {
        return fail("cannot attach a branch to the agent's commit", "blocked");
      }
      const kept = commitWorktree({
        projectDir: options.projectDir,
        workDir,
        branch,
        message: `deus: ${task.title} (attempt ${claim.attempt}, gate failed)\n\nRun: ${options.runId}`,
      });
      const keptBranch =
        kept.status === "committed" || kept.status === "existing" ? branch : undefined;

      board.submit(
        task.boardTaskId,
        claim.claimToken,
        verificationOf("failed", { gate }),
        {
          summary: `gate failed: ${gate.error ?? "checks failed"}`,
          artifacts: [
            ...(keptBranch ? [keptBranch] : []),
            ...(sessionID ? [sessionID] : []),
          ],
        },
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

    if (!attachAgentCommit(options.projectDir, workDir, branch, prepared.baseCommit)) {
      return fail("cannot attach a branch to the agent's commit", "blocked");
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
        if (merge.commit === undefined) {
          return fail("the merge commit is unknown; nothing was accepted", "blocked");
        }
        if (!isAncestor(options.projectDir, merge.commit, "HEAD")) {
          return fail("HEAD no longer contains the merge; nothing was accepted", "blocked");
        }

        if (post.status !== "passed") {
          // Only undo a merge this run created, and only to the commit we saw.
          // `already-merged` means the project moved some other way: resetting
          // there would throw away someone else's work.
          const moved = merge.commit !== undefined && !headIs(options.projectDir, merge.commit);
          const rolledBack =
            merge.status === "merged" &&
            merge.commit !== undefined &&
            !moved &&
            headBeforeMerge !== undefined &&
            resetKeeping(options.projectDir, headBeforeMerge);
          const suffix =
            merge.status === "already-merged"
              ? " (the branch was already merged; the project was left as is)"
              : moved
                ? " (HEAD moved after the merge; the project was not rolled back)"
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

/**
 * A run that starts while the lock is free is looking at tasks left `running`
 * by a run that died. Their executor is gone and `claim` never takes them, so
 * without this they wait for a human who does not know they exist.
 */
function recoverRunningTasks(
  board: Board,
  fallbackActor: string,
  projectDir: string,
  onProgress?: (message: string) => void,
): TaskRunResult[] {
  const recovered: TaskRunResult[] = [];
  const leads = new Map(board.listTeams().map((team) => [team.teamId, team.leadAgent]));

  // Project-wide on purpose: the crash note is project-wide, and holding the
  // lock proves no run is alive, so a stuck task may belong to any team.
  for (const task of board.list({ status: "running", limit: 1_000 })) {
    // The runner writes `<runId>/<boardTaskId>`. Anything else was set by a
    // human or another tool through --board-task start and is not ours to end.
    if (!RUNNER_REF.test(task.executionRef ?? "")) {
      onProgress?.(
        `${task.boardTaskId} is running without a runner ref; leave it to its owner ` +
          `or run --board-task block --board-id ${task.boardTaskId}`,
      );
      continue;
    }

    const actor = leads.get(task.teamId) ?? fallbackActor;
    const run = task.executionRef?.split("/")[0];
    const branches = branchesMatching(projectDir, `deus/t-${task.boardTaskId}-*`);
    const reason =
      `the previous run${run ? ` ${run}` : ""} did not finish (attempt ${task.attempt}); ` +
      `check git log --grep ${run ?? task.boardTaskId} — the merge may have landed` +
      (branches.length > 0
        ? `; branches: ${branches.slice(0, 3).join(", ")}`
        : "; the attempt left no branch");

    try {
      board.block(task.boardTaskId, actor, reason.slice(0, 500));
      recovered.push({
        boardTaskId: task.boardTaskId,
        title: task.title,
        status: "blocked",
        boardStatus: "blocked",
        reason,
        branch: branches[0],
      });
      onProgress?.(`recovered ${task.boardTaskId}: ${reason}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // If the task left `running` in the meantime, someone else acted; that is
      // not a failure. If it is still running, the operator must know.
      if (board.getTask(task.boardTaskId)?.status === "running") {
        recovered.push({
          boardTaskId: task.boardTaskId,
          title: task.title,
          status: "error",
          boardStatus: "running",
          reason: `cannot recover a task left running: ${message}`,
        });
        onProgress?.(
          `error: ${task.boardTaskId} is still running and cannot be recovered (${message})`,
        );
      }
    }
  }

  return recovered;
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
      "a coding team cannot mark work done without checks; add \"checks\" to deus.json",
    );
  }

  const parallel = Math.min(
    MAX_PARALLEL,
    Math.max(1, Math.trunc(options.maxParallel ?? DEFAULT_MAX_PARALLEL)),
  );
  const projectDir = options.projectDir;

  const lock = acquireProjectLock(projectDir, options.runId, "team");
  let leadDir: string | undefined;
  let shortRunId: string | undefined;
  let recovered: TaskRunResult[] = [];
  try {
    // Recovery comes before any other check: a run killed inside `git merge`
    // leaves a dirty tree, and the dirty check would otherwise hide the task
    // that is stuck in `running`.
    const ownerTeam = board.listTeams().find((row) => row.teamId === options.teamId);
    const recoveryActor = ownerTeam?.leadAgent ?? options.actor ?? "team";
    const crashed = readCrashMarker(projectDir);

    if (lock.tookOverStale || crashed !== undefined) {
      recovered = recoverRunningTasks(board, recoveryActor, projectDir, options.onProgress);
    } else {
      // Someone may have deleted a stale lock by hand. We cannot be sure a run
      // died, so we only point at what looks like runner debris.
      for (const task of board.list({ teamId: options.teamId, status: "running", limit: 1_000 })) {
        if (!RUNNER_REF.test(task.executionRef ?? "")) continue;
        options.onProgress?.(
          `warn: ${task.boardTaskId} is still running from ${task.executionRef}; ` +
            `run --board-task block --board-id ${task.boardTaskId} --board-actor ${recoveryActor}`,
        );
      }
    }

    // The note is project-wide, so it may describe a crash in another team. It
    // is cleared only when no runner-owned task is left running anywhere.
    if (crashed !== undefined) {
      const stillRunning = board
        .list({ status: "running", limit: 1_000 })
        .some((task) => RUNNER_REF.test(task.executionRef ?? ""));
      if (!stillRunning) clearCrashMarker(projectDir);
    }

    // Everything below is per run, not per round: one lock, one baseline, one
    // merge queue, one sweep.
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

    const short = shortRun(options.runId);
    shortRunId = short;
    const prepared = prepareWorkdir(projectDir, `baseline-${short}`, true);
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

    const maxAttempts = Math.max(1, Math.trunc(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
    const maxRounds = Math.min(
      MAX_ROUNDS,
      Math.max(1, Math.trunc(options.maxRounds ?? maxAttempts)),
    );
    if (options.maxRounds === undefined && maxAttempts > MAX_ROUNDS) {
      options.onProgress?.(
        `auto-lead: rounds default ${maxAttempts} clamped to ${MAX_ROUNDS}; pass --team-max-rounds`,
      );
    }

    const leadActor = options.leadActor ?? "auto-lead";
    // One round cannot correct anything, so there is nothing for a lead to do.
    const autoLead = options.autoLead === true && maxRounds > 1;
    if (options.autoLead === true && !autoLead) {
      options.onProgress?.("auto-lead: skipped, a single round cannot correct anything");
    }
    // An empty directory: even a tool the deny list does not name would find
    // nothing to read or change.
    leadDir = autoLead ? path.join(projectDir, ".deus", "lead", short) : undefined;
    if (leadDir !== undefined) fs.mkdirSync(leadDir, { recursive: true });

    const advisor: LeadAdvisor | undefined = autoLead
      ? options.advisor ??
        createLeadAdvisor(client, {
          model: options.model,
          timeoutMs: options.timeoutMs,
          agent: options.leadAgent ?? agent,
          workDir: leadDir as string,
          signal: options.signal,
          onLog: (line) => options.onProgress?.(line),
        })
      : undefined;

    // One record per task, last write wins: a task that fails in round 1 and
    // merges in round 2 must not be counted twice.
    const results = new Map<string, TaskRunResult>(
      recovered.map((task) => [task.boardTaskId, task]),
    );
    const attempted = new Set<string>();
    const adjudicated = new Set<string>();
    let workCost = 0;
    let leadCost = 0;
    let rounds = 0;
    let costCapped = false;
    let mergedThisRound = 0;
    const costNow = () => workCost + leadCost;
    const cap = options.maxCost;

    for (let round = 1; round <= maxRounds; round++) {
      // On the first round an abort still lets the pool mark every ready task
      // as skipped; the run did not touch the board, and the summary says so.
      if (round > 1 && options.signal?.aborted) break;
      if (round > 1 && cap !== undefined && costNow() >= cap) {
        costCapped = true;
        options.onProgress?.(`cost cap reached (~$${costNow().toFixed(4)}), stopping`);
        break;
      }

      const ready = selectReadyTasks(board, options.teamId, options.taskIds);
      if (ready.length === 0) break;
      rounds = round;
      options.onProgress?.(`round ${round}/${maxRounds}: ${ready.length} task(s), parallel: ${parallel}`);

      mergedThisRound = 0;
      await pool(ready, parallel, async (task) => {
        if (options.signal?.aborted) {
          const previous = results.get(task.boardTaskId);
          results.set(task.boardTaskId, {
            boardTaskId: task.boardTaskId,
            title: task.title,
            status: "skipped",
            boardStatus: task.status,
            reason: "interrupted",
            lead: previous?.lead,
          });
          return;
        }

        if (cap !== undefined && costNow() >= cap) {
          costCapped = true;
          results.set(task.boardTaskId, {
            boardTaskId: task.boardTaskId,
            title: task.title,
            status: "skipped",
            boardStatus: task.status,
            reason: "stopped by the cost cap",
            lead: results.get(task.boardTaskId)?.lead,
          });
          return;
        }

        attempted.add(task.boardTaskId);
        const result = await runTask(task, deps, baselineBox);
        // A task that merged in a later round keeps the decision that got it
        // there: the record is per task, the history is not thrown away.
        const previous = results.get(task.boardTaskId);
        results.set(task.boardTaskId, { ...result, lead: previous?.lead ?? result.lead });
        workCost += result.cost ?? 0;
        if (result.status === "merged") mergedThisRound += 1;
        options.onProgress?.(
          `task ${task.boardTaskId}: ${result.status}${result.reason ? ` (${result.reason})` : ""}`,
        );
      });

      // The last round has nothing to feed: a rework there would never run.
      if (!advisor || round >= maxRounds) break;

      const reviews = board
        .list({ teamId: options.teamId, status: "review", limit: 1_000 })
        .filter(
          (task) =>
            attempted.has(task.boardTaskId) &&
            !adjudicated.has(task.boardTaskId) &&
            results.get(task.boardTaskId)?.status === "review",
        );

      let reworked = 0;
      for (const task of reviews) {
        if (options.signal?.aborted) break;
        if (cap !== undefined && costNow() >= cap) {
          costCapped = true;
          options.onProgress?.(`cost cap reached (~$${costNow().toFixed(4)}), stopping`);
          break;
        }

        const gate = gateFromVerification(task.verification);
        const mergeStatus = mergeFromVerification(task.verification);
        const branch = previousBranch(task);
        const diff = branch ? branchDiff(projectDir, branch) : undefined;
        if (branch && diff === undefined) {
          options.onProgress?.(`lead: ${task.boardTaskId} branch ${branch} has no readable diff`);
        }
        const events = reworkEvents(board, task.boardTaskId);
        const notes = notesFromEvents(events);
        const reworks = events.length;

        // A call that can only end in an escalate is not worth paying for.
        let decision: LeadDecision;
        if (reworks + 1 >= maxAttempts) {
          decision = {
            decision: "escalate",
            reason: `rework budget is spent (${reworks}/${Math.max(0, maxAttempts - 1)})`,
          };
        } else {
          const verdict = await advisor(
            { task, gate, diff, merge: mergeStatus, notes, reworks },
            options.runId,
            deps.count.value++,
          );
          leadCost += verdict.cost ?? 0;
          decision = verdict.decision;

          const note = typeof decision.note === "string" ? decision.note.trim() : "";
          if (decision.decision === "rework" && note.length === 0) {
            // The shipped parser never lets this through; a custom advisor can.
            decision = { decision: "escalate", reason: "advisor returned rework without a usable note" };
          } else if (decision.decision === "rework" && notes.some((old) => sameNote(old, note))) {
            decision = {
              decision: "escalate",
              reason: "auto-lead repeated an earlier note; the next attempt would be the same",
            };
          } else if (
            decision.decision === "rework" &&
            mergeStatus !== undefined &&
            mergeStatus !== "merged" &&
            reworks >= 1
          ) {
            decision = {
              decision: "escalate",
              reason: `merge ${mergeStatus} again; ordering of tasks is a human decision`,
            };
          }
        }

        if (decision.decision === "rework") {
          try {
            board.addMessage(task.boardTaskId, leadActor, `auto-lead: ${decision.reason}`);
            board.rework(task.boardTaskId, leadActor, decision.note);
            reworked += 1;
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            decision = { decision: "escalate", reason: `could not return the task: ${reason}` };
          }
        }

        // The record describes what actually happened, not what was attempted.
        const current = results.get(task.boardTaskId);
        if (current) {
          results.set(task.boardTaskId, {
            ...current,
            lead: { decision: decision.decision, reason: decision.reason },
          });
        }
        options.onProgress?.(
          `lead: ${task.boardTaskId} ${decision.decision} (${decision.reason})`,
        );

        if (decision.decision !== "rework") {
          // Escalation is final for this run: the same task must not be put in
          // front of the model again in the next round.
          adjudicated.add(task.boardTaskId);
          try {
            board.addMessage(task.boardTaskId, leadActor, `auto-lead: escalated — ${decision.reason}`);
          } catch {
            // The board moved under us; the run summary still reports it.
          }
        }
      }

      if (reworked === 0) {
        // Only a merge can unblock a dependent task. Without one, looping would
        // just retry the same failing work (a detached repo, a lost claim).
        if (mergedThisRound === 0) break;
        const next = selectReadyTasks(board, options.teamId, options.taskIds);
        if (next.length === 0) break;
      }
    }

    const boardNow = board.list({ teamId: options.teamId, limit: 1_000 });
    const waiting = boardNow.filter(
      (task) =>
        (task.status === "backlog" || task.status === "claimed") &&
        !results.has(task.boardTaskId),
    ).length;

    // A task the lead returned is in the backlog, not waiting for a review.
    // This happens only when the run stops between rounds (cost cap, abort).
    const list = [...results.values()].map((task) => {
      const now = boardNow.find((row) => row.boardTaskId === task.boardTaskId);
      if (now && (now.status === "backlog" || now.status === "claimed") && task.status === "review") {
        return {
          ...task,
          status: "skipped" as const,
          boardStatus: now.status,
          reason: "returned for rework; the run stopped before the next round",
        };
      }
      return task;
    });

    return {
      runId: options.runId,
      tasks: list,
      merged: list.filter((task) => task.status === "merged").length,
      review: list.filter((task) => task.status === "review").length,
      blocked: list.filter((task) => task.status === "blocked").length,
      errors: list.filter((task) => task.status === "error").length,
      skipped: list.filter((task) => task.status === "skipped").length,
      waiting,
      rounds,
      cost: costNow(),
      leadCost,
      costCapped,
    };
  } finally {
    try {
      if (!options.keepWorktrees && shortRunId !== undefined) {
        sweepWorktrees(projectDir, shortRunId);
      }
      if (leadDir !== undefined) fs.rmSync(leadDir, { recursive: true, force: true });
    } finally {
      lock.release();
    }
  }
}

/** Names this run created: task, baseline and post-gate scratch trees. */
function ownWorktree(name: string, short: string): boolean {
  return (
    name.endsWith(`-${short}`) ||
    name === `baseline-${short}` ||
    name.startsWith(`scratch-${short}-`) ||
    name === `scratch-${short}`
  );
}

/**
 * Removes the worktrees of this run only. Trees of another run (a pipeline, an
 * earlier crashed run, or one kept with --team-keep-worktrees) are left alone:
 * deleting them could destroy someone's uncommitted work, and nobody asked for
 * a garbage collector here.
 */
function sweepWorktrees(projectDir: string, short: string): void {
  const dir = path.join(projectDir, ".deus", "worktrees");
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    if (!ownWorktree(entry, short)) continue;
    try {
      removeWorkdir(projectDir, path.join(dir, entry));
    } catch {
      // Best effort: a busy directory is not worth failing the run.
    }
  }
}
