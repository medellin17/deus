import { execFileSync } from "node:child_process";

import fs from "node:fs";
import path from "node:path";

import { pruneWorktrees } from "./gitflow.ts";

export interface PreparedWorkdir {
  workDir: string;
  worktree: boolean;
  repoRoot?: string;
  /** HEAD the worktree was created from. */
  baseCommit?: string;
  /** Branch the main worktree was on when the run started. */
  baseBranch?: string;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function isIgnored(cwd: string, relativePath: string): boolean {
  try {
    git(cwd, ["check-ignore", "-q", "--no-index", relativePath]);
    return true;
  } catch {
    return false;
  }
}

/**
 * A fresh worktree has no node_modules, so npm scripts fail there even though
 * they pass in the project. Link the project's dependencies when git ignores
 * them, which is the usual case. A non-ignored node_modules is left alone:
 * otherwise apply would commit the link.
 *
 * The entries are linked into a real directory instead of replacing
 * node_modules with a single symlink: git matches the `node_modules/` ignore
 * pattern only against a directory, so a symlink would be treated as a file,
 * staged by `git add -A`, and then block the auto-merge ("would overwrite
 * ignored files").
 */
function linkNodeModules(
  projectDir: string,
  workDir: string,
  onLog?: (message: string) => void,
): void {
  const source = path.join(projectDir, "node_modules");
  const target = path.join(workDir, "node_modules");

  if (!fs.existsSync(source) || fs.existsSync(target)) return;

  if (!isIgnored(workDir, "node_modules/")) {
    onLog?.(
      "node_modules exists but is not gitignored; not linking it into the worktree, checks may fail",
    );
    return;
  }

  try {
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      fs.symlinkSync(
        path.join(source, entry.name),
        path.join(target, entry.name),
        entry.isDirectory() ? "dir" : "file",
      );
    }
    onLog?.("linked node_modules into the worktree");
  } catch (error) {
    fs.rmSync(target, { recursive: true, force: true });
    onLog?.(
      `cannot link node_modules: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function prepareWorkdir(
  projectDir: string,
  runId: string,
  useWorktree: boolean,
  onLog?: (message: string) => void,
): PreparedWorkdir {
  if (!useWorktree) {
    return { workDir: projectDir, worktree: false };
  }

  // Ids come from the board and end up in a path. They are always plain names;
  // anything with a separator or `..` is an attempt to leave the directory.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId) || runId.includes("..")) {
    throw new Error(`invalid worktree id: ${runId}`);
  }

  try {
    git(projectDir, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    onLog?.("not a git repository: running in the project directory");
    return { workDir: projectDir, worktree: false };
  }

  const repoRoot = git(projectDir, ["rev-parse", "--show-toplevel"]);

  if (path.resolve(projectDir) !== path.resolve(repoRoot)) {
    throw new Error(
      `--cwd must be the git repository root (${repoRoot}), got ${projectDir}`,
    );
  }

  const workDir = path.join(projectDir, ".deus", "worktrees", runId);

  if (fs.existsSync(workDir)) {
    throw new Error(`worktree already exists: ${workDir}`);
  }

  fs.mkdirSync(path.dirname(workDir), { recursive: true });
  const baseCommit = git(repoRoot, ["rev-parse", "HEAD"]);
  let baseBranch: string | undefined;
  try {
    baseBranch = git(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  } catch {
    baseBranch = undefined;
  }

  try {
    // A directory removed by hand (or by a crash) leaves an administrative entry
    // that makes `worktree add` fail on an otherwise free path.
    try {
      pruneWorktrees(repoRoot);
    } catch {
      // best-effort; `add` below reports the real problem
    }
    git(repoRoot, ["worktree", "add", "--detach", workDir, "HEAD"]);
  } catch (error) {
    throw new Error(
      `failed to create git worktree from HEAD: ${
        error instanceof Error ? error.message : String(error)
      }. Commit your work first or pass --no-worktree.`,
    );
  }

  onLog?.(`worktree: ${workDir} (base ${baseCommit.slice(0, 7)})`);
  linkNodeModules(projectDir, workDir, onLog);
  return { workDir, worktree: true, repoRoot, baseCommit, baseBranch };
}

export function removeWorkdir(projectDir: string, workDir: string): void {
  // `prepareWorkdir` falls back to the project itself when git is unreadable.
  // Removing that path would delete the repository.
  if (path.resolve(workDir) === path.resolve(projectDir)) return;

  // The fallback below removes a directory recursively, so it may only ever
  // touch our own worktree root.
  const root = path.resolve(projectDir, ".deus", "worktrees");
  const target = path.resolve(workDir);
  if (!target.startsWith(`${root}${path.sep}`)) return;

  try {
    const repoRoot = git(projectDir, ["rev-parse", "--show-toplevel"]);
    git(repoRoot, ["worktree", "remove", "--force", workDir]);
  } catch {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}
