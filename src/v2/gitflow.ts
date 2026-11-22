import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Git plumbing shared by the single-run applier (`apply.ts`) and the coding
 * team (`team.ts`): commit a worktree as a branch, and merge that branch into
 * the project with the safeguards that keep a merge from surprising anyone.
 *
 * Every function here is synchronous: git is a local subprocess and the callers
 * are already sequential around the shared project worktree.
 */

function git(cwd: string, args: string[]) {
  return spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function listFiles(cwd: string, args: string[]): string[] {
  const result = git(cwd, args);
  if (result.status !== 0) return [];
  return (result.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Short HEAD hash, or undefined when git cannot read it (non-fatal). */
export function shortHead(cwd: string): string | undefined {
  const head = git(cwd, ["rev-parse", "--short", "HEAD"]);
  return head.status === 0 ? head.stdout.trim() : undefined;
}

export function conflictedFiles(projectDir: string): string[] {
  return listFiles(projectDir, ["diff", "--name-only", "--diff-filter=U"]);
}

/** Secret-like paths that must never be committed from a run worktree. */
function isSecretPath(file: string): boolean {
  const segments = file.split("/");
  const base = segments[segments.length - 1] ?? file;
  const parents = segments.slice(0, -1);

  if (base === ".ssh" || base === ".aws" || base === ".gnupg") return true;
  if (parents.some((p) => p === ".ssh" || p === ".aws" || p === ".gnupg")) return true;
  if (base === ".envrc" || base === "id_rsa" || base === "id_ed25519") return true;
  if (/\.(?:pem|key|p12|pfx)$/i.test(base)) return true;
  if (base !== ".env.example" && /\.env(?:\.|$)/i.test(base)) return true;
  return false;
}

function stagedSecretPaths(workDir: string): string[] {
  return listFiles(workDir, ["diff", "--cached", "--name-only"]).filter(isSecretPath);
}

/**
 * Git happily overwrites ignored files during a merge. Refuse to merge when
 * the branch touches a path that is ignored in the main project.
 */
export function ignoredChangedPaths(
  projectDir: string,
  baseCommit: string,
  branch: string,
): string[] {
  const files = listFiles(projectDir, ["diff", "--name-only", `${baseCommit}..${branch}`]);

  return files.filter((file) => {
    const tracked = git(projectDir, ["ls-files", "--error-unmatch", "--", file]);
    if (tracked.status === 0) return false;

    return git(projectDir, ["check-ignore", "-q", "--no-index", "--", file]).status === 0;
  });
}

export function branchExists(projectDir: string, branch: string): boolean {
  return (
    git(projectDir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).status === 0
  );
}

export function branchHead(projectDir: string, branch: string): string | undefined {
  const head = git(projectDir, ["rev-parse", "--short", branch]);
  return head.status === 0 ? head.stdout.trim() : undefined;
}

/**
 * Removes administrative worktree entries whose directory is gone. Without it
 * `git worktree add` refuses a path that was removed by hand or by a crash.
 */
export function pruneWorktrees(projectDir: string): void {
  git(projectDir, ["worktree", "prune"]);
}

export interface CommitWorktreeOptions {
  projectDir: string;
  workDir: string;
  branch: string;
  message: string;
}

export interface CommitWorktreeResult {
  /** `existing` means the branch already holds the work: there is nothing to commit. */
  status: "committed" | "existing" | "no-changes" | "skipped";
  commit?: string;
  reason?: string;
}

/**
 * Commits the worktree as `branch`. Idempotent: a worktree that already sits on
 * the branch continues an interrupted commit instead of failing.
 */
export function commitWorktree(options: CommitWorktreeOptions): CommitWorktreeResult {
  const { projectDir, workDir, branch, message } = options;
  if (!fs.existsSync(workDir)) {
    return { status: "skipped", reason: "worktree is missing" };
  }
  if (git(workDir, ["rev-parse", "--is-inside-work-tree"]).status !== 0) {
    return { status: "skipped", reason: "worktree is not a git repository" };
  }

  const status = git(workDir, ["status", "--porcelain"]);
  if (status.status !== 0) {
    return { status: "skipped", reason: "cannot read worktree status" };
  }
  const clean = !(status.stdout ?? "").trim();
  const known = branchExists(projectDir, branch);

  if (known && clean) {
    // `existing` means "the branch already holds this work". A worktree on a
    // different HEAD (the agent committed on its own, a stale branch exists)
    // must not be reported as done, or the merge would ship the old branch.
    const worktreeHead = revParse(workDir, "HEAD");
    const branchTip = revParse(projectDir, `refs/heads/${branch}`);
    if (worktreeHead === undefined || branchTip === undefined || worktreeHead !== branchTip) {
      return { status: "skipped", reason: "worktree HEAD is not on the branch" };
    }
    return { status: "existing", commit: branchHead(projectDir, branch) };
  }

  if (known) {
    const current = git(workDir, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (current.status !== 0 || (current.stdout ?? "").trim() !== branch) {
      return { status: "skipped", reason: "worktree is not on the run branch" };
    }
  } else {
    if (clean) return { status: "no-changes" };

    const switched = git(workDir, ["switch", "-c", branch]);
    if (switched.status !== 0) {
      return {
        status: "skipped",
        reason: `cannot create branch: ${(switched.stderr || switched.stdout).trim()}`,
      };
    }
  }

  const staged = git(workDir, ["add", "-A"]);
  if (staged.status !== 0) {
    return {
      status: "skipped",
      reason: `git add failed: ${(staged.stderr || staged.stdout).trim()}`,
    };
  }

  const secrets = stagedSecretPaths(workDir);
  if (secrets.length > 0) {
    return {
      status: "skipped",
      reason: `refusing to commit secret-like files: ${secrets.slice(0, 5).join(", ")}`,
    };
  }

  const commit = git(workDir, ["commit", "-m", message]);
  if (commit.status !== 0) {
    return {
      status: "skipped",
      reason: `commit failed: ${(commit.stderr || commit.stdout).trim()}`,
    };
  }

  return { status: "committed", commit: shortHead(workDir) };
}

export interface RecoverMergeResult {
  ok: boolean;
  reason?: string;
}

/**
 * Clears an unfinished merge left by a previous attempt of this same branch.
 * A merge from another source is left alone: silently aborting it would throw
 * away someone else's conflict resolution.
 */
export function recoverUnfinishedMerge(
  projectDir: string,
  branch: string,
): RecoverMergeResult {
  const mergeHead = git(projectDir, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]);
  if (mergeHead.status !== 0) return { ok: true };

  const source = (mergeHead.stdout ?? "").trim();
  const branchRef = git(projectDir, ["rev-parse", branch]);
  if (branchRef.status !== 0) {
    return {
      ok: false,
      reason: `cannot resolve run branch: ${(branchRef.stderr || branchRef.stdout).trim()}`,
    };
  }

  if (source !== branchRef.stdout.trim()) {
    return { ok: false, reason: "project has an unfinished merge from another source" };
  }

  const abort = git(projectDir, ["merge", "--abort"]);
  if (abort.status !== 0) {
    return {
      ok: false,
      reason: `cannot abort unfinished merge: ${(abort.stderr || abort.stdout).trim()}`,
    };
  }

  return { ok: true };
}

export interface AttemptMergeOptions {
  projectDir: string;
  branch: string;
  runId: string;
  title: string;
  /** Leave the merge in progress for the caller to resolve. */
  abortOnConflict?: boolean;
}

export interface AttemptMergeResult {
  status: "merged" | "conflict" | "failed";
  commit?: string;
  reason?: string;
}

/**
 * Runs `git merge --no-ff` and classifies the outcome. Pre-flight guarantees
 * (clean tree, right branch, ignored paths) belong to the caller.
 */
export function attemptMerge(options: AttemptMergeOptions): AttemptMergeResult {
  const { projectDir, branch, runId, title } = options;

  const merge = git(projectDir, [
    "merge",
    "--no-ff",
    branch,
    "-m",
    `Merge deus ${runId}: ${title}`,
  ]);

  if (merge.status === 0) {
    return { status: "merged", commit: shortHead(projectDir) };
  }

  const conflicts = conflictedFiles(projectDir);
  const details = (merge.stderr || merge.stdout).trim().split("\n").slice(-3).join(" ");

  if (options.abortOnConflict !== false) {
    const abort = git(projectDir, ["merge", "--abort"]);
    if (abort.status !== 0) {
      return {
        status: "failed",
        reason: `merge failed and abort failed: ${(abort.stderr || abort.stdout).trim()}`,
      };
    }
  }

  if (conflicts.length > 0) {
    return { status: "conflict", reason: `merge conflict: ${conflicts.slice(0, 5).join(", ")}` };
  }

  return { status: "failed", reason: `merge failed: ${details}` };
}

export interface MergeBranchOptions {
  projectDir: string;
  branch: string;
  /** The commit the branch was built on: needed to count and to spot ignored paths. */
  baseCommit: string;
  /** Branch the project must be on. */
  baseBranch: string;
  runId: string;
  title: string;
}

export interface MergeBranchResult {
  /** `already-merged` is a success: the work is in, nothing to do. */
  status: "merged" | "already-merged" | "conflict" | "skipped";
  commit?: string;
  reason?: string;
}

/**
 * Full merge sequence for a branch that no one else is resolving: recover an
 * interrupted merge, cheap guards, then `merge --no-ff` with abort on conflict.
 */
export function mergeBranch(options: MergeBranchOptions): MergeBranchResult {
  const { projectDir, branch, baseCommit, baseBranch, runId, title } = options;

  if (!branchExists(projectDir, branch)) {
    return { status: "skipped", reason: "branch does not exist" };
  }

  const recovered = recoverUnfinishedMerge(projectDir, branch);
  if (!recovered.ok) return { status: "skipped", reason: recovered.reason };

  const counted = git(projectDir, ["rev-list", "--count", `${baseCommit}..${branch}`]);
  if (counted.status !== 0) {
    return {
      status: "skipped",
      reason: `git rev-list failed: ${(counted.stderr || counted.stdout).trim()}`,
    };
  }
  if (Number((counted.stdout ?? "").trim()) === 0) {
    return { status: "skipped", reason: "branch has no commits" };
  }

  const current = git(projectDir, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (current.status !== 0) {
    return { status: "skipped", reason: "project is in detached HEAD" };
  }
  const currentName = (current.stdout ?? "").trim();
  if (currentName !== baseBranch) {
    return {
      status: "skipped",
      reason: `project switched from ${baseBranch} to ${currentName}; refusing to merge`,
    };
  }

  if (git(projectDir, ["merge-base", "--is-ancestor", baseCommit, "HEAD"]).status !== 0) {
    return { status: "skipped", reason: "project history does not contain the base commit" };
  }

  if (git(projectDir, ["merge-base", "--is-ancestor", branch, "HEAD"]).status === 0) {
    return { status: "already-merged", commit: shortHead(projectDir) };
  }

  const dirty = git(projectDir, ["status", "--porcelain"]);
  if (dirty.status !== 0) {
    return { status: "skipped", reason: "cannot read project status" };
  }
  if ((dirty.stdout ?? "").trim()) {
    return { status: "skipped", reason: "project has uncommitted changes" };
  }

  const ignored = ignoredChangedPaths(projectDir, baseCommit, branch);
  if (ignored.length > 0) {
    return {
      status: "skipped",
      reason: `merge would overwrite ignored files: ${ignored.slice(0, 5).join(", ")}`,
    };
  }

  const merged = attemptMerge({ projectDir, branch, runId, title, abortOnConflict: true });
  if (merged.status === "merged") {
    return { status: "merged", commit: merged.commit };
  }
  if (merged.status === "conflict") {
    return { status: "conflict", reason: merged.reason };
  }
  return { status: "skipped", reason: merged.reason };
}

/** Absolute path of a worktree directory for a run id. */
export function worktreePath(projectDir: string, worktreeId: string): string {
  return path.join(projectDir, ".deus", "worktrees", worktreeId);
}

/** `git status --porcelain`, or undefined when git cannot read the tree. */
export function worktreeStatus(cwd: string): string | undefined {
  const result = git(cwd, ["status", "--porcelain"]);
  return result.status === 0 ? (result.stdout ?? "").trim() : undefined;
}

export function revParse(cwd: string, ref: string): string | undefined {
  const result = git(cwd, ["rev-parse", "--verify", "--quiet", ref]);
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/** Creates a branch at the current HEAD of `workDir`. */
export function createBranch(workDir: string, branch: string): boolean {
  return git(workDir, ["switch", "-c", branch]).status === 0;
}

/** Undoes the merge commit that was just created, under the merge lock. */
export function resetHard(cwd: string, ref: string): boolean {
  return git(cwd, ["reset", "--hard", ref]).status === 0;
}

/** Deletes a fully merged branch. Refuses when git considers it unmerged. */
export function deleteBranch(cwd: string, branch: string): boolean {
  return git(cwd, ["branch", "-d", branch]).status === 0;
}
