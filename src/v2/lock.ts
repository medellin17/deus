import fs from "node:fs";
import path from "node:path";

/**
 * One run per project, whatever kind it is: a coding team and a pipeline both
 * write the same worktree, the same `.deus/worktrees` and the same git index.
 *
 * The lock is advisory: an agent with a shell can delete it. It protects
 * against two runs started by mistake, not against a malicious one.
 */

export type RunKind = "team" | "pipeline";

export interface RunLockOwner {
  pid?: number;
  runId?: string;
  kind?: string;
}

export interface RunLock {
  runId: string;
  kind: RunKind;
  /** True when a dead run's lock was taken over: a run died in this project. */
  tookOverStale: boolean;
  release(): void;
}

export class RunBusyError extends Error {
  readonly code = "run_busy";

  constructor(
    readonly owner: RunLockOwner,
    message: string,
  ) {
    super(message);
    this.name = "RunBusyError";
  }
}

const LOCK_FILE = "run.lock";
/** Durable note that a run died here, so the next run can act on it. */
const CRASH_FILE = "crashed-run.json";
const LEGACY_LOCK_FILE = "team.lock";
/** A lock nobody can attribute is stolen only after this pause. */
const UNREADABLE_GRACE_MS = 60_000;

function lockPath(projectDir: string): string {
  return path.join(projectDir, ".deus", LOCK_FILE);
}

function readOwner(file: string): RunLockOwner | undefined {
  if (!fs.existsSync(file)) return undefined;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
    if (typeof raw !== "object" || raw === null) return {};
    const record = raw as Record<string, unknown>;
    return {
      pid: typeof record.pid === "number" ? record.pid : undefined,
      runId: typeof record.runId === "string" ? record.runId : undefined,
      kind: typeof record.kind === "string" ? record.kind : undefined,
    };
  } catch {
    return {};
  }
}

function ageMs(file: string): number | undefined {
  try {
    return Date.now() - fs.statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * `ESRCH` means the process is gone. `EPERM` means it exists but belongs to
 * someone else, which is still alive. Anything unexpected is treated as alive:
 * stealing a lock we do not understand is worse than refusing to start.
 */
export function isAlive(
  pid: number,
  kill: (pid: number, signal: 0) => void = (target, signal) => {
    process.kill(target, signal);
  },
): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function describe(owner: RunLockOwner, file: string): string {
  const pid = owner.pid ?? "?";
  const run = owner.runId ?? "?";
  const kind = owner.kind ? ` ${owner.kind}` : "";
  return (
    `another run is active${kind} (pid ${pid}, run ${run}). ` +
    `If that process is gone, delete ${file} and retry.`
  );
}

/**
 * Creates the lock. The payload is written to a private file first and then
 * hard-linked into place, so the lock is never visible while empty: a crash
 * cannot leave a lock that says nothing about its owner.
 */
function tryCreate(file: string, payload: string): boolean {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, payload, { encoding: "utf-8" });
  try {
    fs.linkSync(tmp, file);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return false;
    if (code === "EPERM" || code === "ENOTSUP" || code === "EACCES") {
      throw new Error(
        `cannot create ${file}: ${(error as Error).message} ` +
          "(the project lock uses hard links; is the filesystem local?)",
      );
    }
    throw error;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * Removes a stale lock. `rename` is the compare-and-swap we need: exactly one
 * contender moves the file, everybody else gets ENOENT. The moved file is
 * checked again, because its owner may have changed between our read and the
 * rename; if it turns out to be alive, it is put back.
 */
function steal(file: string): boolean {
  const grave = `${file}.stale.${process.pid}.${Date.now()}`;
  try {
    fs.renameSync(file, grave);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }

  try {
    const owner = readOwner(grave);
    if (owner !== undefined && typeof owner.pid === "number" && isAlive(owner.pid)) {
      // It was alive after all. Put it back unless a newer lock already exists.
      try {
        fs.linkSync(grave, file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      throw new RunBusyError(owner, describe(owner, file));
    }
    return true;
  } finally {
    fs.rmSync(grave, { force: true });
  }
}

/** A lock left by the previous version of the tool must still be respected. */
function legacyOwner(projectDir: string): RunLockOwner | undefined {
  const file = path.join(projectDir, ".deus", LEGACY_LOCK_FILE);
  const owner = readOwner(file);
  if (owner !== undefined && typeof owner.pid === "number" && isAlive(owner.pid)) {
    return owner;
  }
  return undefined;
}

export function acquireProjectLock(
  projectDir: string,
  runId: string,
  kind: RunKind,
): RunLock {
  const dir = path.join(projectDir, ".deus");
  fs.mkdirSync(dir, { recursive: true });
  const file = lockPath(projectDir);
  const payload = `${JSON.stringify({ pid: process.pid, runId, kind })}\n`;
  let tookOverStale = false;

  const legacy = legacyOwner(projectDir);
  if (legacy !== undefined) {
    throw new RunBusyError(legacy, describe(legacy, path.join(dir, LEGACY_LOCK_FILE)));
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    if (tryCreate(file, payload)) {
      return {
        runId,
        kind,
        tookOverStale,
        release: () => release(file, runId),
      };
    }

    const owner = readOwner(file);
    if (owner === undefined) continue; // vanished; try to create again

    if (typeof owner.pid === "number") {
      if (isAlive(owner.pid)) throw new RunBusyError(owner, describe(owner, file));
    } else {
      // No owner at all: either a process is writing right now, or the file is
      // debris. Wait out the grace period instead of stealing blindly.
      const age = ageMs(file);
      if (age !== undefined && age < UNREADABLE_GRACE_MS) {
        throw new RunBusyError(owner, describe(owner, file));
      }
    }

    if (steal(file)) {
      tookOverStale = true;
      // The next run may not be the one that notices: a pipeline can take the
      // lock over, and `tookOverStale` dies with its process. Leave a note.
      markCrash(projectDir, owner);
    }
  }

  const owner = readOwner(file) ?? {};
  throw new RunBusyError(owner, describe(owner, file));
}

function crashPath(projectDir: string): string {
  return path.join(projectDir, ".deus", CRASH_FILE);
}

function markCrash(projectDir: string, owner: RunLockOwner): void {
  try {
    fs.writeFileSync(
      crashPath(projectDir),
      `${JSON.stringify({ ...owner, detectedAt: new Date().toISOString() })}\n`,
      "utf-8",
    );
  } catch {
    // The note is best effort; the lock itself is what prevents two runs.
  }
}

/**
 * The crash note is project-wide: it is written by whoever steals the lock and
 * survives a pipeline run in between. The reader decides when it is safe to
 * clear it.
 */
export function readCrashMarker(projectDir: string): RunLockOwner | undefined {
  return readOwner(crashPath(projectDir));
}

export function clearCrashMarker(projectDir: string): void {
  try {
    fs.rmSync(crashPath(projectDir), { force: true });
  } catch {
    // Leave it for the next attempt if it cannot be removed.
  }
}

function release(file: string, runId: string): void {
  const owner = readOwner(file);
  // Only the owner may release: a lock taken over by a newer run stays intact.
  if (owner === undefined || owner.pid !== process.pid || owner.runId !== runId) return;
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // Nothing to release.
  }
}

/** Path of the lock file, for diagnostics and tests. */
export function projectLockPath(projectDir: string): string {
  return lockPath(projectDir);
}
