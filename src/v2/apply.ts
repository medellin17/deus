import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { applyBaseline, runGate } from "./gate.ts";
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

function gitOk(cwd: string, args: string[]): string {
  const result = git(cwd, args);
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return (result.stdout ?? "").trim();
}

function listFiles(cwd: string, args: string[]): string[] {
  const result = git(cwd, args);
  if (result.status !== 0) return [];
  return (result.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function conflictedFiles(projectDir: string): string[] {
  return listFiles(projectDir, ["diff", "--name-only", "--diff-filter=U"]);
}

function modifiedFiles(projectDir: string): string[] {
  return listFiles(projectDir, ["diff", "--name-only"]);
}

function hasConflictMarkers(filePath: string): boolean {
  try {
    const text = fs.readFileSync(filePath, "utf-8");
    return /^(?:<<<<<<<|>>>>>>>)(?: |$)/m.test(text);
  } catch {
    return false;
  }
}

/**
 * Git happily overwrites ignored files during a merge. Refuse to merge when
 * the branch touches a path that is ignored in the main project.
 */
function ignoredChangedPaths(
  projectDir: string,
  baseCommit: string,
  branch: string,
): string[] {
  const files = listFiles(projectDir, [
    "diff",
    "--name-only",
    `${baseCommit}..${branch}`,
  ]);

  return files.filter((file) => {
    const tracked = git(projectDir, ["ls-files", "--error-unmatch", "--", file]);
    if (tracked.status === 0) return false;

    return git(projectDir, ["check-ignore", "-q", "--no-index", "--", file]).status === 0;
  });
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
    const current = runGate(resolver.checks, projectDir, {
      timeoutMs: resolver.checkTimeoutMs,
      stopOnFirstFailure: resolver.baseline?.status !== "failed",
    });
    const gate = applyBaseline(resolver.baseline, current);
    resolution.gate = gate;
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
  const branchExists =
    git(projectDir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).status === 0;

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
  let worktreeClean = false;

  const worktreeStatus = git(workDir, ["status", "--porcelain"]);
  if (worktreeStatus.status !== 0) {
    return { status: "skipped", reason: "cannot read worktree status" };
  }
  worktreeClean = !(worktreeStatus.stdout ?? "").trim();

  if (branchExists) {
    commitHash = gitOk(projectDir, ["rev-parse", "--short", branch]);
  }

  if (branchExists) {
    const mergeHead = git(projectDir, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]);
    if (mergeHead.status === 0) {
      const mergeSource = (mergeHead.stdout ?? "").trim();
      const branchCommit = gitOk(projectDir, ["rev-parse", branch]);

      if (mergeSource === branchCommit) {
        const abort = git(projectDir, ["merge", "--abort"]);
        if (abort.status !== 0) {
          return {
            status: "skipped",
            reason: `cannot abort unfinished merge: ${(abort.stderr || abort.stdout).trim()}`,
            branch,
            commit: commitHash,
            mergeCommand,
          };
        }
      } else {
        return {
          status: "skipped",
          reason: "project has an unfinished merge from another source",
          branch,
          commit: commitHash,
          mergeCommand,
        };
      }
    }
  }

  if (branchExists) {
    if (!worktreeClean) {
      const worktreeBranch = git(workDir, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
      if (worktreeBranch.status !== 0 || (worktreeBranch.stdout ?? "").trim() !== branch) {
        return {
          status: "skipped",
          reason: "worktree is not on the run branch",
          branch,
          commit: commitHash,
          mergeCommand,
        };
      }

      // Finish the commit that was interrupted on a previous attempt.
      gitOk(workDir, ["add", "-A"]);
      const commit = git(workDir, ["commit", "-m", message]);
      if (commit.status !== 0) {
        return {
          status: "skipped",
          reason: `commit failed: ${(commit.stderr || commit.stdout).trim()}`,
          branch,
          commit: commitHash,
          mergeCommand,
        };
      }
      commitHash = gitOk(workDir, ["rev-parse", "--short", "HEAD"]);
      worktreeClean = true;
    }
  } else {
    if (worktreeClean) {
      return { status: "no-changes" };
    }

    const switchResult = git(workDir, ["switch", "-c", branch]);
    if (switchResult.status !== 0) {
      return {
        status: "skipped",
        reason: `cannot create branch: ${(switchResult.stderr || switchResult.stdout).trim()}`,
      };
    }

    gitOk(workDir, ["add", "-A"]);

    const commit = git(workDir, ["commit", "-m", message]);
    if (commit.status !== 0) {
      return {
        status: "skipped",
        reason: `commit failed: ${(commit.stderr || commit.stdout).trim()}`,
      };
    }

    commitHash = gitOk(workDir, ["rev-parse", "--short", "HEAD"]);
    worktreeClean = true;
  }

  if (!options.merge) {
    return branchResult("auto-merge is disabled");
  }

  if (!state.baseCommit) {
    return branchResult("base commit is unknown");
  }

  const branchCommits = Number(
    gitOk(projectDir, ["rev-list", "--count", `${state.baseCommit}..${branch}`]),
  );

  if (branchExists && branchCommits === 0) {
    return {
      status: "skipped",
      reason: "branch has no commits",
      branch,
      commit: commitHash,
      mergeCommand,
    };
  }

  if (branchExists) {
    const merged = git(projectDir, ["merge-base", "--is-ancestor", branch, "HEAD"]);
    if (merged.status === 0) {
      return {
        status: "merged",
        branch,
        commit: gitOk(projectDir, ["rev-parse", "--short", "HEAD"]),
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

  const merge = git(projectDir, [
    "merge",
    "--no-ff",
    branch,
    "-m",
    `Merge deus ${state.runId}: ${title}`,
  ]);

  if (merge.status === 0) {
    return {
      status: "merged",
      branch,
      commit: gitOk(projectDir, ["rev-parse", "--short", "HEAD"]),
      mergeCommand,
    };
  }

  const conflicts = conflictedFiles(projectDir);
  if (conflicts.length > 0 && options.resolve) {
    const outcome = await resolveConflicts(options, options.resolve, conflicts);
    if (outcome.ok) {
      return {
        status: "merged",
        branch,
        commit: gitOk(projectDir, ["rev-parse", "--short", "HEAD"]),
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
      };
    }

    return branchResult(outcome.reason ?? "conflict resolution failed", outcome.resolution);
  }

  const abort = git(projectDir, ["merge", "--abort"]);
  if (abort.status !== 0) {
    return {
      status: "skipped",
      reason: `merge failed and abort failed: ${(abort.stderr || abort.stdout).trim()}`,
      branch,
      commit: commitHash,
      mergeCommand,
    };
  }

  const details = (merge.stderr || merge.stdout).trim().split("\n").slice(-3).join(" ");
  return branchResult(`merge failed: ${details}`);
}
