import assert from "node:assert";
import { spawnSync } from "node:child_process";

import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deus-cli-board-"));
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

function id(out: string, prefix: string): string {
  const match = out.split("\n").find((line) => line.startsWith(`${prefix}: `));
  assert.ok(match, `expected "${prefix}:" in ${JSON.stringify(out)}`);
  return match.slice(prefix.length + 2).trim();
}

void describe("board CLI", () => {
  void it("drives a task through add, claim, start, submit and accept", () => {
    const dir = tempDir();

    const team = cli(["--team-add", "--team-name", "research", "--team-goal", "look", "--cwd", dir]);
    assert.equal(team.code, 0, team.stderr);
    assert.match(team.stdout, /^team: team-/m);

    const added = cli([
      "--board-task",
      "add",
      "--board-title",
      "read executor",
      "--board-goal",
      "find three things",
      "--board-team",
      "research",
      "--board-actor",
      "driver",
      "--cwd",
      dir,
    ]);
    assert.equal(added.code, 0, added.stderr);
    const taskId = id(added.stdout, "task");

    const beforeClaim = cli(["--board", "--cwd", dir]);
    assert.doesNotMatch(beforeClaim.stdout, /@driver/);

    const claimed = cli(["--board-task", "claim", "--board-id", taskId, "--cwd", dir]);
    assert.equal(claimed.code, 0, claimed.stderr);
    const token = id(claimed.stdout, "claim_token");

    const started = cli([
      "--board-task",
      "start",
      "--board-id",
      taskId,
      "--board-token",
      token,
      "--board-execution-ref",
      "run-x/step-1",
      "--cwd",
      dir,
    ]);
    assert.equal(started.code, 0, started.stderr);
    assert.match(started.stdout, /status: running/);

    const submitted = cli([
      "--board-task",
      "submit",
      "--board-id",
      taskId,
      "--board-token",
      token,
      "--board-gate",
      "passed",
      "--board-summary",
      "three findings",
      "--cwd",
      dir,
    ]);
    assert.equal(submitted.code, 0, submitted.stderr);
    assert.match(submitted.stdout, /status: review/);

    const accepted = cli(["--board-task", "accept", "--board-id", taskId, "--cwd", dir]);
    assert.equal(accepted.code, 0, accepted.stderr);
    assert.match(accepted.stdout, /status: done/);

    const board = cli(["--board", "--cwd", dir]);
    assert.equal(board.code, 0, board.stderr);
    assert.match(board.stdout, /\[done\]/);
    // The actor is not silently used as an assignee at creation time; the
    // claimer becomes the assignee, which is the point of claiming.
    assert.match(board.stdout, /@main/);
  });

  void it("reports a forbidden transition as an error code with exit 1", () => {
    const dir = tempDir();
    const added = cli([
      "--board-task",
      "add",
      "--board-title",
      "backlog task",
      "--board-goal",
      "g",
      "--cwd",
      dir,
    ]);
    const taskId = id(added.stdout, "task");

    const accepted = cli(["--board-task", "accept", "--board-id", taskId, "--cwd", dir]);
    assert.equal(accepted.code, 1);
    assert.match(accepted.stderr, /error: invalid_transition/);
  });

  void it("treats a lost claim race as a normal outcome", () => {
    const dir = tempDir();
    const added = cli([
      "--board-task",
      "add",
      "--board-title",
      "contended",
      "--board-goal",
      "g",
      "--cwd",
      dir,
    ]);
    const taskId = id(added.stdout, "task");

    assert.equal(cli(["--board-task", "claim", "--board-id", taskId, "--cwd", dir]).code, 0);
    const second = cli(["--board-task", "claim", "--board-id", taskId, "--cwd", dir]);
    assert.equal(second.code, 0);
    assert.match(second.stdout, /claim: none/);
  });

  void it("rejects an unknown team instead of guessing", () => {
    const dir = tempDir();
    const added = cli([
      "--board-task",
      "add",
      "--board-title",
      "no team",
      "--board-goal",
      "g",
      "--board-team",
      "ghost",
      "--cwd",
      dir,
    ]);
    assert.equal(added.code, 1);
    assert.match(added.stderr, /error: not_found/);
  });

  void it("passes the rework note through to the wake outbox", () => {
    const dir = tempDir();
    const runDir = path.join(dir, ".deus", "runs", "run-cli");
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, "run.json"),
      JSON.stringify({
        version: 1,
        steps: [{ stepId: "fix", sessionID: "ses-cli-worker", agent: "build" }],
      }),
      "utf-8",
    );

    const added = cli([
      "--board-task",
      "add",
      "--board-title",
      "needs rework",
      "--board-goal",
      "g",
      "--cwd",
      dir,
    ]);
    const taskId = id(added.stdout, "task");
    const claimed = cli(["--board-task", "claim", "--board-id", taskId, "--cwd", dir]);
    const token = id(claimed.stdout, "claim_token");
    cli([
      "--board-task",
      "start",
      "--board-id",
      taskId,
      "--board-token",
      token,
      "--board-execution-ref",
      "run-cli/fix",
      "--cwd",
      dir,
    ]);
    cli([
      "--board-task",
      "submit",
      "--board-id",
      taskId,
      "--board-token",
      token,
      "--board-gate",
      "passed",
      "--board-summary",
      "first try",
      "--cwd",
      dir,
    ]);

    const reworked = cli([
      "--board-task",
      "rework",
      "--board-id",
      taskId,
      "--board-note",
      "add line numbers",
      "--cwd",
      dir,
    ]);
    assert.equal(reworked.code, 0, reworked.stderr);

    const db = new Database(path.join(dir, ".deus", "board.db"), { readonly: true });
    const row = db
      .prepare(
        `SELECT event_type, recipient_json, payload_json FROM wake_events
          WHERE event_type = 'task/rework'`,
      )
      .get() as { event_type: string; recipient_json: string; payload_json: string };
    db.close();

    assert.equal(row.event_type, "task/rework");
    assert.equal(JSON.parse(row.recipient_json).sessionID, "ses-cli-worker");
    assert.equal(JSON.parse(row.payload_json).note, "add line numbers");
  });

  void it("requires a token to block a live task as a stranger", () => {
    const dir = tempDir();
    const added = cli([
      "--board-task",
      "add",
      "--board-title",
      "live",
      "--board-goal",
      "g",
      "--cwd",
      dir,
    ]);
    const taskId = id(added.stdout, "task");
    const claimed = cli(["--board-task", "claim", "--board-id", taskId, "--cwd", dir]);
    assert.equal(claimed.code, 0, claimed.stderr);

    const blocked = cli([
      "--board-task",
      "block",
      "--board-id",
      taskId,
      "--board-actor",
      "stranger",
      "--board-reason",
      "mine now",
      "--cwd",
      dir,
    ]);
    assert.equal(blocked.code, 1);
    assert.match(blocked.stderr, /error: not_owner/);
  });

  void it("rejects an empty actor", () => {
    const dir = tempDir();
    const result = cli([
      "--board-task",
      "add",
      "--board-title",
      "x",
      "--board-goal",
      "g",
      "--board-actor",
      "   ",
      "--cwd",
      dir,
    ]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /error: invalid_input: --board-actor must not be empty/);
  });

  void it("rejects an empty assignee", () => {
    const dir = tempDir();
    const result = cli([
      "--board-task",
      "add",
      "--board-title",
      "x",
      "--board-goal",
      "g",
      "--board-assignee",
      "  ",
      "--cwd",
      dir,
    ]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /error: invalid_input: --board-assignee is required/);
  });

  void it("lets the team lead block a live task without a token", () => {
    const dir = tempDir();
    const added = cli([
      "--board-task",
      "add",
      "--board-title",
      "live for lead",
      "--board-goal",
      "g",
      "--cwd",
      dir,
    ]);
    const taskId = id(added.stdout, "task");
    const claimed = cli([
      "--board-task",
      "claim",
      "--board-id",
      taskId,
      "--board-actor",
      "worker",
      "--cwd",
      dir,
    ]);
    assert.equal(claimed.code, 0, claimed.stderr);

    // "main" is the lead of the auto-created team, so it may unstick the task.
    const blocked = cli([
      "--board-task",
      "block",
      "--board-id",
      taskId,
      "--board-actor",
      "main",
      "--board-reason",
      "executor died",
      "--cwd",
      dir,
    ]);
    assert.equal(blocked.code, 0, blocked.stderr);
    assert.match(blocked.stdout, /status: blocked/);
  });

  void it("reports a flag conflict with a code", () => {
    const dir = tempDir();
    const result = cli(["--board", "--board-task", "add", "--cwd", dir]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /error: invalid_input: --board cannot be combined/);
  });

  void it("rejects an unknown board action", () => {
    const dir = tempDir();
    const result = cli(["--board-task", "explode", "--cwd", dir]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /error: invalid_input: unknown --board-task action/);
  });

  void it("requires an explicit gate for submit", () => {
    const dir = tempDir();
    const added = cli([
      "--board-task",
      "add",
      "--board-title",
      "needs a gate",
      "--board-goal",
      "g",
      "--cwd",
      dir,
    ]);
    const taskId = id(added.stdout, "task");
    const claimed = cli(["--board-task", "claim", "--board-id", taskId, "--cwd", dir]);
    const token = id(claimed.stdout, "claim_token");
    cli([
      "--board-task",
      "start",
      "--board-id",
      taskId,
      "--board-token",
      token,
      "--board-execution-ref",
      "run-x/step",
      "--cwd",
      dir,
    ]);

    const result = cli([
      "--board-task",
      "submit",
      "--board-id",
      taskId,
      "--board-token",
      token,
      "--board-summary",
      "no gate",
      "--cwd",
      dir,
    ]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /error: invalid_input: --board-gate is required/);
  });
});
