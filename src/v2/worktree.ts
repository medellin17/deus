import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface PreparedWorkdir {
  workDir: string;
  worktree: boolean;
  repoRoot?: string;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
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

  try {
    git(projectDir, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    onLog?.("not a git repository: running in the project directory");
    return { workDir: projectDir, worktree: false };
  }

  const repoRoot = git(projectDir, ["rev-parse", "--show-toplevel"]);
  const workDir = path.join(projectDir, ".deus", "worktrees", runId);

  if (fs.existsSync(workDir)) {
    throw new Error(`worktree already exists: ${workDir}`);
  }

  fs.mkdirSync(path.dirname(workDir), { recursive: true });

  try {
    git(repoRoot, ["worktree", "add", "--detach", workDir, "HEAD"]);
  } catch (error) {
    throw new Error(
      `failed to create git worktree from HEAD: ${
        error instanceof Error ? error.message : String(error)
      }. Commit your work first or pass --no-worktree.`,
    );
  }

  onLog?.(`worktree: ${workDir}`);
  return { workDir, worktree: true, repoRoot };
}

export function removeWorkdir(projectDir: string, workDir: string): void {
  try {
    const repoRoot = git(projectDir, ["rev-parse", "--show-toplevel"]);
    git(repoRoot, ["worktree", "remove", "--force", workDir]);
  } catch {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}
