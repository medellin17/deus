import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { teamRunFlags } from "../../v2/cli.ts";
import { teamExitCode, type TeamRunResult } from "../../v2/team.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deus-cli-team-"));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function cli(args: string[]): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/v2/cli.ts", ...args], {
    cwd: repoRoot,
    encoding: "utf-8",
  });
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function git(cwd: string, ...args: string[]): string {
  return spawnSync("git", args, { cwd, encoding: "utf-8" }).stdout.trim();
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

function summary(overrides: Partial<TeamRunResult>): TeamRunResult {
  return {
    runId: "run-test",
    tasks: [],
    merged: 0,
    review: 0,
    blocked: 0,
    errors: 0,
    skipped: 0,
    waiting: 0,
    rounds: 0,
    leadCost: 0,
    costCapped: false,
    cost: 0,
    ...overrides,
  };
}

void describe("teamExitCode", () => {
  void it("returns 0 when everything merged or there was nothing to do", () => {
    assert.equal(teamExitCode(summary({ merged: 2 })), 0);
    assert.equal(teamExitCode(summary({ skipped: 3 })), 0);
  });

  void it("treats an interrupted run as work left, not as success", () => {
    const interrupted = summary({
      skipped: 1,
      tasks: [
        {
          boardTaskId: "bt-1",
          title: "left over",
          status: "skipped",
          reason: "interrupted",
        },
      ],
    });
    assert.equal(teamExitCode(interrupted), 2);
  });

  void it("returns 2 when work is left for a human", () => {
    assert.equal(teamExitCode(summary({ merged: 1, review: 1 })), 2);
    assert.equal(teamExitCode(summary({ blocked: 1 })), 2);
  });

  void it("returns 1 when the runner itself failed", () => {
    assert.equal(teamExitCode(summary({ errors: 1, review: 1 })), 1);
  });
});

void describe("teamRunFlags", () => {
  const base = {
    teamAutoLead: true,
    teamMaxRounds: 4,
    maxCostExplicit: false,
    maxCost: undefined,
    teamParallel: 2,
    teamMaxAttempts: 5,
    teamKeepWorktrees: true,
    teamTasks: "bt-1, bt-2",
    agent: "fixer",
    boardActor: "lead",
  };

  void it("passes the auto-lead flags to the runner instead of dropping them", () => {
    assert.deepEqual(teamRunFlags(base, { maxCost: 1.5 }), {
      autoLead: true,
      maxRounds: 4,
      maxCost: 1.5,
      maxParallel: 2,
      maxAttempts: 5,
      keepWorktrees: true,
      taskIds: ["bt-1", "bt-2"],
      agent: "fixer",
      actor: "lead",
    });
  });

  void it("lets an explicit --max-cost win over deus.json", () => {
    const flags = teamRunFlags({ ...base, maxCostExplicit: true, maxCost: 0.25 }, { maxCost: 9 });
    assert.equal(flags.maxCost, 0.25);
  });

  void it("leaves the task list undefined when the flag is absent", () => {
    assert.equal(teamRunFlags({ ...base, teamTasks: undefined }, {}).taskIds, undefined);
  });
});

void describe("team-run CLI guards", () => {
  void it("requires a team name", () => {
    const result = cli(["--team-run", "--cwd", tempDir()]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /error: invalid_input: --team-run requires --team-name/);
  });

  void it("refuses flags that would silently change the meaning of the run", () => {
    const dir = tempDir();
    for (const flag of [["--no-merge"], ["--json"], ["--cleanup"], ["--direct"], ["--no-gate"]]) {
      const result = cli(["--team-run", "--team-name", "coding", ...flag, "--cwd", dir]);
      assert.equal(result.code, 1, `${flag.join(" ")} should be rejected`);
      assert.match(result.stderr, /error: invalid_input: --team-run cannot be combined with/);
    }
  });

  void it("validates the parallel limit", () => {
    const dir = tempDir();
    assert.match(
      cli(["--team-run", "--team-name", "coding", "--team-parallel", "0", "--cwd", dir]).stderr,
      /--team-parallel must be a positive integer/,
    );
    assert.match(
      cli(["--team-run", "--team-name", "coding", "--team-parallel", "9", "--cwd", dir]).stderr,
      /--team-parallel must not exceed 8/,
    );
  });

  void it("validates the attempt limit", () => {
    const dir = tempDir();
    const result = cli([
      "--team-run",
      "--team-name",
      "coding",
      "--team-max-attempts",
      "0",
      "--cwd",
      dir,
    ]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /--team-max-attempts must be a positive integer/);
  });

  void it("rejects an empty task list", () => {
    const dir = tempDir();
    const result = cli(["--team-run", "--team-name", "coding", "--team-tasks", " , ", "--cwd", dir]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /--team-tasks must list at least one board task id/);
  });

  void it("validates the auto-lead flags", () => {
    const dir = tempDir();
    assert.match(
      cli(["--team-auto-lead", "--cwd", dir]).stderr,
      /--team-auto-lead is only valid with --team-run/,
    );
    assert.match(
      cli(["--team-run", "--team-name", "coding", "--team-max-rounds", "0", "--cwd", dir]).stderr,
      /--team-max-rounds must be an integer between 1 and 9/,
    );
    assert.match(
      cli(["--team-run", "--team-name", "coding", "--team-max-rounds", "10", "--cwd", dir]).stderr,
      /--team-max-rounds must be an integer between 1 and 9/,
    );
    assert.match(
      cli(["--team-run", "--team-name", "coding", "--team-max-rounds", "3", "--cwd", dir]).stderr,
      /--team-max-rounds requires --team-auto-lead/,
    );
  });

  void it("accepts --max-cost for a team run instead of rejecting it", () => {
    const dir = makeRepo();
    // No team exists, so the run must fail on the team lookup: reaching that
    // error proves the flag itself was accepted.
    const result = cli(["--team-run", "--team-name", "ghost", "--max-cost", "1", "--cwd", dir]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /error: not_found: team not found: ghost/);
    assert.doesNotMatch(result.stderr, /cannot be combined/);
  });

  void it("reports an unknown team with a code", () => {
    const dir = makeRepo();
    const result = cli(["--team-run", "--team-name", "ghost", "--cwd", dir]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /error: not_found: team not found: ghost/);
  });

  void it("refuses a project without checks", () => {
    const dir = makeRepo();
    assert.equal(cli(["--team-add", "--team-name", "coding", "--team-goal", "g", "--cwd", dir]).code, 0);
    const result = cli(["--team-run", "--team-name", "coding", "--cwd", dir]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /error: no_checks:/);
  });

  void it("refuses a dirty project", () => {
    const dir = makeRepo();
    fs.writeFileSync(
      path.join(dir, "deus.json"),
      `${JSON.stringify({ checks: { readme: "test -f readme.md" } })}\n`,
      "utf-8",
    );
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "config");
    assert.equal(cli(["--team-add", "--team-name", "coding", "--team-goal", "g", "--cwd", dir]).code, 0);
    fs.writeFileSync(path.join(dir, "readme.md"), "dirty\n", "utf-8");

    const result = cli(["--team-run", "--team-name", "coding", "--cwd", dir]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /error: dirty_worktree:/);
  });
});
