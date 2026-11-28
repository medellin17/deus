import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { applyBaseline, runGate } from "./gate.ts";
import {
  attemptMerge,
  branchExists,
  branchHead,
  commitWorktree,
  conflictedFiles,
  headIs,
  ignoredChangedPaths,
  listFiles,
  recoverUnfinishedMerge,
  resetKeeping,
  revParse,
  shortHead,
} from "./gitflow.ts";
import type {
  ApplyResult,
  CheckCommand,
  Executor,
  GateResult,
  PermissionRule,
  RunState,
  StepExecution,
} from "./types.ts";

const RESOLVER_DENIES: PermissionRule[] = [
  { action: "shell", resource: "*", effect: "deny" },
  { action: "subagent", resource: "*", effect: "deny" },
  { action: "webfetch", resource: "*", effect: "deny" },
  { action: "websearch", resource: "*", effect: "deny" },
  { action: "external_directory", resource: "*", effect: "deny" },
  { action: "edit", resource: "**/.env", effect: "deny" },
  { action: "edit", resource: "**/.env.*", effect: "deny" },
  { action: "edit", resource: "**/*.pem", effect: "deny" },
  { action: "edit", resource: "**/id_rsa", effect: "deny" },
  { action: "edit", resource: "**/id_ed25519", effect: "deny" },
  { action: "edit", resource: "**/node_modules/**", effect: "deny" },
  { action: "edit", resource: ".git/**", effect: "deny" },
  { action: "edit", resource: ".deus/**", effect: "deny" },
];

function git(cwd: string, args: string[]) {
  return spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function modifiedFiles(projectDir: string): string[] {
  return listFiles(projectDir, ["diff", "--name-only", "HEAD"]);
}

function hasConflictMarkers(filePath: string): boolean {
  try {
    const text = fs.readFileSync(filePath, "utf-8");
    return /^(?:<<<<<<<|>>>>>>>)(?: |$)/m.test(text);
  } catch {
    return false;
  }
}

export interface ConflictResolverOptions {
  executor: Executor;
  timeoutMs: number;
  checks: CheckCommand[];
  baseline?: GateResult;
  checkTimeoutMs?: number;
  maxCost?: number;
  signal?: AbortSignal;
}

export interface ApplyOptions {
  projectDir: string;
  workDir: string;
  state: RunState;
  merge: boolean;
  /** Resolve merge conflicts with an agent instead of leaving the branch. */
  resolve?: ConflictResolverOptions;
  signal?: AbortSignal;
}

function shortTask(task: string): string {
  const line = task.split("\n")[0].trim();
  if (!line) return "run";
  return line.length > 72 ? `${line.slice(0, 69)}...` : line;
}

function resolutionPrompt(task: string, files: string[]): string {
  return `В проекте идёт git merge и остались конфликты. Разреши их.

## Задача прогона

${task}

## Конфликтующие файлы

${files.map((file) => `- ${file}`).join("\n")}

## Правила

- Сохрани оба намерения: изменения из ветки прогона и изменения, которые уже есть в проекте.
- Убери маркеры конфликта полностью.
- Не меняй файлы вне списка выше.
- Не запускай команды и не делай git commit: коммит сделает раннер.
- В конце перечисли разрешённые файлы и что решил в каждом.`;
}

interface ResolutionOutcome {
  ok: boolean;
  resolution: StepExecution;
  reason?: string;
}

async function resolveConflicts(
  options: ApplyOptions,
  resolver: ConflictResolverOptions,
  conflicts: string[],
): Promise<ResolutionOutcome> {
  const { projectDir, state } = options;
  const prompt = resolutionPrompt(state.task, conflicts);
  const permissions: PermissionRule[] = [
    { action: "edit", resource: "*", effect: "deny" },
    ...conflicts.map((file) => ({
      action: "edit",
      resource: file,
      effect: "allow" as const,
    })),
    ...RESOLVER_DENIES,
  ];

  const resolution = await resolver.executor.run({
    step: {
      id: "resolve-conflicts",
      agent: "build",
      task: prompt,
      permissions,
    },
    prompt,
    runId: state.runId,
    index: 0,
    workDir: projectDir,
    timeoutMs: resolver.timeoutMs,
    signal: resolver.signal,
  });

  if (resolution.status !== "succeeded") {
    return {
      ok: false,
      resolution,
      reason: resolution.error ?? "conflict resolver failed",
    };
  }
  if (resolver.signal?.aborted) {
    return { ok: false, resolution, reason: "run interrupted after conflict resolution" };
  }

  if (
    resolver.maxCost !== undefined &&
    (state.cost ?? 0) + (resolution.cost ?? 0) > resolver.maxCost
  ) {
    return {
      ok: false,
      resolution,
      reason: `cost limit exceeded during conflict resolution: $${((state.cost ?? 0) + (resolution.cost ?? 0)).toFixed(4)} > $${resolver.maxCost.toFixed(4)}`,
    };
  }

  const outside = modifiedFiles(projectDir).filter((file) => !conflicts.includes(file));
  if (outside.length > 0) {
    return {
      ok: false,
      resolution,
      reason: `resolver changed unrelated files: ${outside.join(", ")}`,
    };
  }

  const untracked = listFiles(projectDir, ["ls-files", "--others", "--exclude-standard"]);
  if (untracked.length > 0) {
    return {
      ok: false,
      resolution,
      reason: `resolver created untracked files: ${untracked.join(", ")}`,
    };
  }

  const marked = conflicts.filter((file) => hasConflictMarkers(path.join(projectDir, file)));
  if (marked.length > 0) {
    return {
      ok: false,
      resolution,
      reason: `conflict markers remain in ${marked.join(", ")}`,
    };
  }

  // Checks run before staging, so the committed tree is exactly the tree that
  // passed. If a check rewrites files, they are staged afterwards.
  if (resolver.checks.length > 0) {
    const current = await runGate(resolver.checks, projectDir, {
      timeoutMs: resolver.checkTimeoutMs,
      stopOnFirstFailure: resolver.baseline?.status !== "failed",
      signal: resolver.signal,
    });
    const gate = applyBaseline(resolver.baseline, current);
    resolution.gate = gate;
    if (resolver.signal?.aborted || gate.aborted) {
      return { ok: false, resolution, reason: "run interrupted after conflict checks" };
    }
    if (gate.status === "failed") {
      return {
        ok: false,
        resolution,
        reason: `checks failed after conflict resolution: ${gate.error}`,
      };
    }
  }

  const afterChecksOutside = modifiedFiles(projectDir).filter(
    (file) => !conflicts.includes(file),
  );
  if (afterChecksOutside.length > 0) {
    return {
      ok: false,
      resolution,
      reason: `checks changed unrelated files: ${afterChecksOutside.join(", ")}`,
    };
  }

  const afterChecksUntracked = listFiles(projectDir, [
    "ls-files",
    "--others",
    "--exclude-standard",
  ]);
  if (afterChecksUntracked.length > 0) {
    return {
      ok: false,
      resolution,
      reason: `checks created untracked files: ${afterChecksUntracked.join(", ")}`,
    };
  }

  if (resolver.signal?.aborted) {
    return { ok: false, resolution, reason: "run interrupted before staging conflicts" };
  }

  const staged = git(projectDir, ["add", "--", ...conflicts]);
  if (staged.status !== 0) {
    return {
      ok: false,
      resolution,
      reason: `git add failed: ${(staged.stderr || staged.stdout).trim()}`,
    };
  }

  const remaining = conflictedFiles(projectDir);
  if (remaining.length > 0) {
    return {
      ok: false,
      resolution,
      reason: `unresolved conflicts: ${remaining.join(", ")}`,
    };
  }

  const commit = git(projectDir, ["commit", "--no-edit"]);
  if (commit.status !== 0) {
    return {
      ok: false,
      resolution,
      reason: `merge commit failed: ${(commit.stderr || commit.stdout).trim()}`,
    };
  }

  return { ok: true, resolution };
}

/**
 * Commits the worktree as a branch and merges it with `--no-ff`.
 *
 * The function is idempotent: an existing branch is reused, an unfinished
 * merge from that branch is aborted and retried, and an already merged branch
 * is reported as merged. Any doubt leaves the project alone and returns the
 * branch plus a ready-to-run merge command.
 */
export async function applyRun(options: ApplyOptions): Promise<ApplyResult> {
  const { projectDir, workDir, state } = options;

  if (!state.worktree) {
    return { status: "skipped", reason: "run did not use a worktree" };
  }

  if (!fs.existsSync(workDir)) {
    return { status: "skipped", reason: "worktree is missing" };
  }

  if (git(workDir, ["rev-parse", "--is-inside-work-tree"]).status !== 0) {
    return { status: "skipped", reason: "worktree is not a git repository" };
  }

  const branch = `deus/${state.runId}`;
  const mergeCommand = `git -C "${projectDir}" merge --no-ff ${branch}`;
  const title = shortTask(state.task);
  const message = [
    `deus: ${title}`,
    "",
    `Run: ${state.runId}`,
    `Pipeline: ${state.pipeline}`,
    `Model: ${state.model}`,
  ].join("\n");

  const branchResult = (reason: string, resolution?: StepExecution): ApplyResult => ({
    status: "branch",
    branch,
    commit: commitHash,
    reason,
    mergeCommand,
    resolution,
  });

  let commitHash: string | undefined;

  const known = branchExists(projectDir, branch);
  if (known) {
    commitHash = branchHead(projectDir, branch);
    // Must run before any early return: an unfinished merge from a previous
    // attempt of this branch has to be cleared even if the run cannot continue.
    const recovered = recoverUnfinishedMerge(projectDir, branch);
    if (!recovered.ok) {
      return {
        status: "skipped",
        reason: recovered.reason ?? "unfinished merge",
        branch,
        commit: commitHash,
        mergeCommand,
      };
    }
  }

  if (options.signal?.aborted) {
    return {
      status: "skipped",
      reason: "run interrupted before commit",
      branch,
      commit: commitHash,
      mergeCommand,
      aborted: true,
    };
  }

  const committed = commitWorktree({ projectDir, workDir, branch, message });
  if (committed.status === "skipped") {
    return {
      status: "skipped",
      reason: committed.reason ?? "commit failed",
      branch,
      commit: committed.commit ?? commitHash,
      mergeCommand,
    };
  }
  if (committed.status === "no-changes") {
    return { status: "no-changes" };
  }
  commitHash = committed.commit ?? commitHash;

  if (!options.merge) {
    return branchResult("auto-merge is disabled");
  }

  if (!state.baseCommit) {
    return branchResult("base commit is unknown");
  }

  const counted = git(projectDir, ["rev-list", "--count", `${state.baseCommit}..${branch}`]);
  if (counted.status !== 0) {
    return {
      status: "skipped",
      reason: `git rev-list failed: ${(counted.stderr || counted.stdout).trim()}`,
      branch,
      commit: commitHash,
      mergeCommand,
    };
  }
  const branchCommits = Number((counted.stdout ?? "").trim());

  if (known && branchCommits === 0) {
    return {
      status: "skipped",
      reason: "branch has no commits",
      branch,
      commit: commitHash,
      mergeCommand,
    };
  }

  if (known) {
    const merged = git(projectDir, ["merge-base", "--is-ancestor", branch, "HEAD"]);
    if (merged.status === 0) {
      return {
        status: "merged",
        branch,
        commit: shortHead(projectDir),
        reason: "already merged",
        mergeCommand,
      };
    }
  }

  if (!state.baseBranch) {
    return branchResult("base branch is unknown");
  }

  const currentBranch = git(projectDir, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (currentBranch.status !== 0) {
    return branchResult("project is in detached HEAD");
  }
  const currentBranchName = (currentBranch.stdout ?? "").trim();
  if (currentBranchName !== state.baseBranch) {
    return branchResult(
      `project switched from ${state.baseBranch} to ${currentBranchName}; refusing to merge`,
    );
  }

  const ancestor = git(projectDir, ["merge-base", "--is-ancestor", state.baseCommit, "HEAD"]);
  if (ancestor.status !== 0) {
    return branchResult("project history does not contain the run base commit");
  }

  const dirty = git(projectDir, ["status", "--porcelain"]);
  if (dirty.status !== 0) {
    return branchResult("cannot read project status");
  }
  if ((dirty.stdout ?? "").trim()) {
    return branchResult("project has uncommitted changes");
  }

  const ignored = ignoredChangedPaths(projectDir, state.baseCommit, branch);
  if (ignored.length > 0) {
    return branchResult(
      `merge would overwrite ignored files: ${ignored.slice(0, 5).join(", ")}`,
    );
  }

  if (options.signal?.aborted) {
    return {
      status: "skipped",
      reason: "run interrupted before merge",
      branch,
      commit: commitHash,
      mergeCommand,
      aborted: true,
    };
  }

  const headBeforeMerge = revParse(projectDir, "HEAD");
  const merge = attemptMerge({
    projectDir,
    branch,
    runId: state.runId,
    title,
    abortOnConflict: false,
  });

  if (merge.status === "merged") {
    if (options.signal?.aborted) {
      const mergedHead = merge.commit ?? shortHead(projectDir);
      const rolledBack =
        merge.commit !== undefined &&
        headBeforeMerge !== undefined &&
        headIs(projectDir, merge.commit) &&
        resetKeeping(projectDir, headBeforeMerge);
      return {
        status: "skipped",
        reason: rolledBack
          ? "run interrupted after merge; merge rolled back"
          : "run interrupted after merge; rollback was not safe or failed",
        branch,
        commit: rolledBack ? headBeforeMerge : mergedHead,
        mergeCommand,
        aborted: true,
      };
    }
    return {
      status: "merged",
      branch,
      commit: merge.commit ?? shortHead(projectDir),
      mergeCommand,
    };
  }

  const conflicts = conflictedFiles(projectDir);
  if (conflicts.length > 0 && options.resolve) {
    const outcome = await resolveConflicts(options, {
      ...options.resolve,
      signal: options.resolve.signal ?? options.signal,
    }, conflicts);
    if (outcome.ok) {
      if (options.signal?.aborted) {
        const mergedHead = shortHead(projectDir);
        const rolledBack =
          headBeforeMerge !== undefined &&
          mergedHead !== undefined &&
          headIs(projectDir, mergedHead) &&
          resetKeeping(projectDir, headBeforeMerge);
        return {
          status: "skipped",
          reason: rolledBack
            ? "run interrupted after conflict merge; merge rolled back"
            : "run interrupted after conflict merge; rollback was not safe or failed",
          branch,
          commit: rolledBack ? headBeforeMerge : mergedHead,
          mergeCommand,
          resolution: outcome.resolution,
          aborted: true,
        };
      }
      return {
        status: "merged",
        branch,
        commit: shortHead(projectDir),
        mergeCommand,
        resolution: outcome.resolution,
      };
    }

    const abort = git(projectDir, ["merge", "--abort"]);
    if (abort.status !== 0) {
      return {
        status: "skipped",
        reason: `conflict resolution failed and merge abort failed: ${(abort.stderr || abort.stdout).trim()}`,
        branch,
        commit: commitHash,
        mergeCommand,
        resolution: outcome.resolution,
        aborted: options.signal?.aborted,
      };
    }

    const result = branchResult(outcome.reason ?? "conflict resolution failed", outcome.resolution);
    if (options.signal?.aborted) result.aborted = true;
    return result;
  }

  const abort = git(projectDir, ["merge", "--abort"]);
  if (abort.status !== 0) {
    return {
      status: "skipped",
      reason: `merge failed and abort failed: ${(abort.stderr || abort.stdout).trim()}`,
      branch,
      commit: commitHash,
      mergeCommand,
      aborted: options.signal?.aborted,
    };
  }

  const result = branchResult(merge.reason ?? "merge failed");
  if (options.signal?.aborted) result.aborted = true;
  return result;
}
