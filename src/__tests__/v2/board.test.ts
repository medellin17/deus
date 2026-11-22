import assert from "node:assert";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import Database from "better-sqlite3";

import { BoardError, openBoard, type Board, type CreateTaskInput } from "../../v2/board.ts";

const tempDirs: string[] = [];
const boards: Board[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deus-board-"));
  tempDirs.push(dir);
  return dir;
}

function newBoard(dir = tempDir()): Board {
  const board = openBoard(dir);
  boards.push(board);
  return board;
}

function mainTeamId(board: Board): string {
  const team = board.listTeams().find((item) => item.name === "main");
  assert.ok(team, "the main team should exist");
  return team.teamId;
}

function newTask(board: Board, overrides: Partial<CreateTaskInput> = {}) {
  return board.createTask({
    teamId: mainTeamId(board),
    title: "a task",
    goal: "do the thing",
    actor: "main",
    ...overrides,
  });
}

function complete(board: Board, taskId: string, actor = "main"): void {
  const claim = board.claim(taskId, actor);
  assert.ok(claim, "expected to claim the task");
  board.start(taskId, claim.claimToken, `run-test/${taskId}`);
  board.submit(taskId, claim.claimToken, { status: "passed" }, { summary: "ok" });
  board.accept(taskId, actor);
}

function isBoardError(code: string) {
  return (error: unknown) => error instanceof BoardError && error.code === code;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

after(() => {
  for (const board of boards) {
    try {
      board.close();
    } catch {
      // already closed
    }
  }
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

void describe("board", () => {
  void it("creates tasks in backlog under the auto main team", () => {
    const board = newBoard();
    const task = newTask(board, { title: "write the report" });

    assert.equal(task.status, "backlog");
    assert.equal(task.attempt, 1);
    assert.equal(task.title, "write the report");
    assert.equal(board.listTeams().filter((team) => team.name === "main").length, 1);
  });

  void it("claims through CAS: only the first claim wins", () => {
    const board = newBoard();
    const task = newTask(board);

    const first = board.claim(task.boardTaskId, "main");
    const second = board.claim(task.boardTaskId, "other");

    assert.ok(first);
    assert.equal(second, null);
    assert.equal(board.getTask(task.boardTaskId)?.status, "claimed");
  });

  void it("keeps CAS correct across two connections", () => {
    const dir = tempDir();
    const a = newBoard(dir);
    const b = newBoard(dir);
    const task = newTask(a);

    const first = a.claim(task.boardTaskId, "main");
    const second = b.claim(task.boardTaskId, "main");

    assert.ok(first);
    assert.equal(second, null);
  });

  void it("refuses to claim until dependencies are done", () => {
    const board = newBoard();
    const dependency = newTask(board);
    const task = newTask(board, { dependsOn: [dependency.boardTaskId] });

    assert.throws(
      () => board.claim(task.boardTaskId, "main"),
      isBoardError("dependency_not_done"),
    );

    complete(board, dependency.boardTaskId);
    assert.ok(board.claim(task.boardTaskId, "main"));
  });

  void it("forbids running to done and any claim of a running task", () => {
    const board = newBoard();
    const task = newTask(board);
    const claim = board.claim(task.boardTaskId, "main");
    assert.ok(claim);
    board.start(task.boardTaskId, claim.claimToken, `run-test/${task.boardTaskId}`);

    assert.throws(
      () => board.accept(task.boardTaskId, "main"),
      isBoardError("invalid_transition"),
    );
    // A running task is not claimable at all: not a lost race, an invalid state.
    assert.throws(
      () => board.claim(task.boardTaskId, "other"),
      isBoardError("invalid_transition"),
    );
  });

  void it("requires a passing verification to accept", () => {
    const board = newBoard();
    const task = newTask(board);
    const claim = board.claim(task.boardTaskId, "main");
    assert.ok(claim);
    board.start(task.boardTaskId, claim.claimToken, `run-test/${task.boardTaskId}`);
    board.submit(task.boardTaskId, claim.claimToken, { status: "failed" }, { summary: "bad" });

    assert.throws(
      () => board.accept(task.boardTaskId, "main"),
      isBoardError("verification_required"),
    );
  });

  void it("reclaims an expired lease with a fresh token", async () => {
    const board = newBoard();
    const task = newTask(board);

    const first = board.claim(task.boardTaskId, "first", 1_000);
    assert.ok(first);
    await sleep(1_100);

    const second = board.claim(task.boardTaskId, "second");
    assert.ok(second);
    assert.notEqual(second.claimToken, first.claimToken);
    assert.equal(board.getTask(task.boardTaskId)?.attempt, 2);

    assert.throws(
      () => board.start(task.boardTaskId, first.claimToken, "run/x"),
      isBoardError("not_owner"),
    );
  });

  void it("rejects a foreign claim token", () => {
    const board = newBoard();
    const task = newTask(board);
    board.claim(task.boardTaskId, "main");

    assert.throws(
      () => board.start(task.boardTaskId, "other:deadbeef", "run/x"),
      isBoardError("not_owner"),
    );
  });

  void it("keeps terminal tasks immutable", () => {
    const board = newBoard();
    const task = newTask(board);
    complete(board, task.boardTaskId);

    assert.throws(
      () => board.cancel(task.boardTaskId, "main"),
      isBoardError("invalid_transition"),
    );
    assert.throws(
      () => board.block(task.boardTaskId, "main", "why"),
      isBoardError("invalid_transition"),
    );
  });

  void it("writes one event per transition", () => {
    const board = newBoard();
    const task = newTask(board);
    complete(board, task.boardTaskId);

    assert.deepEqual(
      board.events({ taskId: task.boardTaskId }).map((event) => event.type),
      ["task/created", "task/claimed", "task/started", "task/submitted", "task/accepted"],
    );
  });

  void it("changes neither state nor events when a transition is rejected", () => {
    const board = newBoard();
    const task = newTask(board);
    const eventsBefore = board.events({ taskId: task.boardTaskId }).length;

    assert.throws(() => board.block(task.boardTaskId, "main", "   "));

    assert.equal(board.getTask(task.boardTaskId)?.status, "backlog");
    assert.equal(board.events({ taskId: task.boardTaskId }).length, eventsBefore);
  });

  void it("is idempotent across reopen", () => {
    const dir = tempDir();
    const first = openBoard(dir);
    const task = first.createTask({
      teamId: mainTeamId(first),
      title: "survives",
      goal: "g",
      actor: "main",
    });
    first.close();

    const second = openBoard(dir);
    boards.push(second);
    assert.equal(second.getTask(task.boardTaskId)?.title, "survives");
  });

  void it("rejects a duplicate execution reference", () => {
    const board = newBoard();
    const first = newTask(board);
    const second = newTask(board);

    const firstClaim = board.claim(first.boardTaskId, "main");
    const secondClaim = board.claim(second.boardTaskId, "main");
    assert.ok(firstClaim);
    assert.ok(secondClaim);
    board.start(first.boardTaskId, firstClaim.claimToken, "run/same");

    assert.throws(
      () => board.start(second.boardTaskId, secondClaim.claimToken, "run/same"),
      isBoardError("execution_taken"),
    );
  });

  void it("prunes terminal tasks", async () => {
    const board = newBoard();
    const task = newTask(board);
    complete(board, task.boardTaskId);
    await sleep(5); // the cutoff is strict, so the row must be strictly older

    const pruned = board.prune({ taskDays: 0, eventDays: 90 });

    assert.ok(pruned.tasks >= 1);
    assert.equal(board.getTask(task.boardTaskId), undefined);
  });

  void it("keeps a task that a live task still depends on", async () => {
    const board = newBoard();
    const dependency = newTask(board);
    complete(board, dependency.boardTaskId);
    newTask(board, { dependsOn: [dependency.boardTaskId] });
    await sleep(5);

    const pruned = board.prune({ taskDays: 0, eventDays: 90 });

    assert.equal(pruned.tasks, 0);
    assert.ok(board.getTask(dependency.boardTaskId));
  });

  void it("replaces the assignee when a lease is reclaimed", async () => {
    const board = newBoard();
    const task = newTask(board);

    board.claim(task.boardTaskId, "alice", 1_000);
    await sleep(1_100);
    board.claim(task.boardTaskId, "bob");

    assert.equal(board.getTask(task.boardTaskId)?.assignee, "bob");
  });

  void it("requires the owner token to block or cancel a live task", () => {
    const board = newBoard();
    const task = newTask(board);
    const claim = board.claim(task.boardTaskId, "alice");
    assert.ok(claim);

    assert.throws(
      () => board.block(task.boardTaskId, "mallory", "mine now"),
      isBoardError("not_owner"),
    );
    assert.throws(
      () => board.cancel(task.boardTaskId, "mallory"),
      isBoardError("not_owner"),
    );

    board.cancel(task.boardTaskId, "alice", claim.claimToken);
    assert.equal(board.getTask(task.boardTaskId)?.status, "cancelled");
  });

  void it("rejects a duplicate team name", () => {
    const board = newBoard();

    assert.throws(
      () => board.createTeam({ name: "main", goal: "g", leadAgent: "main" }),
      isBoardError("team_exists"),
    );
  });

  void it("rejects creating tasks on a closed team", () => {
    const board = newBoard();
    const task = newTask(board);
    complete(board, task.boardTaskId);

    const team = board.getTeamByName("main");
    assert.ok(team);
    board.closeTeam(team.teamId, "main");

    assert.throws(
      () =>
        board.createTask({
          teamId: team.teamId,
          title: "late",
          goal: "g",
          actor: "main",
        }),
      isBoardError("team_closed"),
    );
  });

  void it("keeps cancelled tasks immutable", () => {
    const board = newBoard();
    const task = newTask(board);
    board.cancel(task.boardTaskId, "main");

    assert.throws(
      () => board.accept(task.boardTaskId, "main"),
      isBoardError("invalid_transition"),
    );
    assert.throws(
      () => board.rework(task.boardTaskId, "main"),
      isBoardError("invalid_transition"),
    );
  });

  void it("records a message event without changing the status", () => {
    const board = newBoard();
    const task = newTask(board);
    complete(board, task.boardTaskId);
    const before = board.events({ taskId: task.boardTaskId }).length;

    board.addMessage(task.boardTaskId, "main", "please review");

    const events = board.events({ taskId: task.boardTaskId });
    assert.equal(board.getTask(task.boardTaskId)?.status, "done");
    assert.equal(events.length, before + 1);
    assert.equal(events[events.length - 1].type, "task/message");
    assert.deepEqual(events[events.length - 1].payload, { text: "please review" });

    assert.throws(
      () => board.addMessage(task.boardTaskId, "main", "   "),
      isBoardError("invalid_transition"),
    );
  });

  void it("rejects a skipped verification on accept", () => {
    const board = newBoard();
    const task = newTask(board);
    const claim = board.claim(task.boardTaskId, "main");
    assert.ok(claim);
    board.start(task.boardTaskId, claim.claimToken, `run-test/${task.boardTaskId}`);
    board.submit(task.boardTaskId, claim.claimToken, { status: "skipped" }, { summary: "x" });

    assert.throws(
      () => board.accept(task.boardTaskId, "main"),
      isBoardError("verification_required"),
    );
  });

  void it("rolls back status and event when a write fails inside the transaction", () => {
    const board = newBoard();
    const first = newTask(board);
    const second = newTask(board);
    const firstClaim = board.claim(first.boardTaskId, "main");
    const secondClaim = board.claim(second.boardTaskId, "main");
    assert.ok(firstClaim);
    assert.ok(secondClaim);
    board.start(first.boardTaskId, firstClaim.claimToken, "run/same");

    const statusBefore = board.getTask(second.boardTaskId)?.status;
    const eventsBefore = board.events({ taskId: second.boardTaskId }).length;

    assert.throws(
      () => board.start(second.boardTaskId, secondClaim.claimToken, "run/same"),
      isBoardError("execution_taken"),
    );

    assert.equal(board.getTask(second.boardTaskId)?.status, statusBefore);
    assert.equal(board.events({ taskId: second.boardTaskId }).length, eventsBefore);
  });

  void it("keeps events append-only across transitions", () => {
    const board = newBoard();
    const task = newTask(board);

    const before = board.events({ taskId: task.boardTaskId });
    board.block(task.boardTaskId, "main", "later");
    const after = board.events({ taskId: task.boardTaskId });

    assert.deepEqual(after.slice(0, before.length), before);
    assert.equal(after.length, before.length + 1);
  });

  void it("allows a comment on a task of a closed team", () => {
    const board = newBoard();
    const task = newTask(board);
    complete(board, task.boardTaskId);
    const team = board.getTeamByName("main");
    assert.ok(team);
    board.closeTeam(team.teamId, "main");

    board.addMessage(task.boardTaskId, "main", "after the team was closed");

    const events = board.events({ taskId: task.boardTaskId });
    assert.equal(events[events.length - 1].type, "task/message");
  });

  void it("supports newest-first event ordering", () => {
    const board = newBoard();
    const task = newTask(board);
    complete(board, task.boardTaskId);

    const ascending = board.events({ taskId: task.boardTaskId });
    const descending = board.events({ taskId: task.boardTaskId, order: "desc" });

    assert.equal(descending[0].type, ascending[ascending.length - 1].type);
  });

  void it("limits list results", () => {
    const board = newBoard();
    newTask(board);
    newTask(board);

    assert.equal(board.list({ limit: 1 }).length, 1);
  });

  void it("does not create a board in readonly mode", () => {
    const dir = tempDir();

    assert.throws(() => openBoard(dir, { readonly: true }), isBoardError("not_found"));
    assert.equal(fs.existsSync(path.join(dir, ".deus", "board.db")), false);
  });

  void it("lets exactly one of two processes win the claim", async () => {
    const dir = tempDir();
    const board = newBoard(dir);
    const task = newTask(board);
    board.close();

    const moduleUrl = new URL("../../v2/board.ts", import.meta.url).href;
    const script = `
      import(${JSON.stringify(moduleUrl)}).then((module) => {
        const board = module.openBoard(process.env.DEUS_DIR);
        const claim = board.claim(process.env.DEUS_TASK, process.env.DEUS_ACTOR);
        console.log(claim ? "WON" : "LOST");
        board.close();
      }).catch((error) => {
        console.error(error);
        process.exit(1);
      });
    `;

    const run = (actor: string): Promise<string> =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", "-e", script], {
          env: {
            ...process.env,
            DEUS_DIR: dir,
            DEUS_TASK: task.boardTaskId,
            DEUS_ACTOR: actor,
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        let err = "";
        child.stdout.on("data", (chunk) => (out += chunk));
        child.stderr.on("data", (chunk) => (err += chunk));
        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 0) resolve(out.trim());
          else reject(new Error(err || `worker exited with ${code}`));
        });
      });

    const results = await Promise.all([run("p1"), run("p2")]);

    assert.equal(results.filter((result) => result === "WON").length, 1);
    assert.equal(results.filter((result) => result === "LOST").length, 1);
  });

  void it("lets the team lead unstick a running task without a token", () => {
    const board = newBoard();
    const task = newTask(board);
    const claim = board.claim(task.boardTaskId, "alice");
    assert.ok(claim);
    board.start(task.boardTaskId, claim.claimToken, `run-test/${task.boardTaskId}`);

    // The executor died and its token is gone; the lead can still recover.
    board.block(task.boardTaskId, "main", "executor died");
    assert.equal(board.getTask(task.boardTaskId)?.status, "blocked");

    board.retry(task.boardTaskId, "main");
    assert.equal(board.getTask(task.boardTaskId)?.status, "backlog");
  });

  void it("reseeds an active main after the previous main is closed", () => {
    const dir = tempDir();
    const first = openBoard(dir);
    const task = first.createTask({
      teamId: mainTeamId(first),
      title: "close me",
      goal: "g",
      actor: "main",
    });
    complete(first, task.boardTaskId);
    const main = first.getTeamByName("main");
    assert.ok(main);
    first.closeTeam(main.teamId, "main");
    first.close();

    const second = openBoard(dir);
    boards.push(second);
    const activeMain = second
      .listTeams()
      .filter((team) => team.name === "main" && team.status === "active");

    assert.equal(activeMain.length, 1);
  });

  void it("rolls back an applied update when the event insert fails", () => {
    const dir = tempDir();
    const board = newBoard(dir);
    const task = newTask(board);
    const db = new Database(path.join(dir, ".deus", "board.db"));
    db.exec(
      `CREATE TRIGGER fail_events BEFORE INSERT ON board_events
       BEGIN SELECT RAISE(ABORT, 'boom'); END;`,
    );

    const eventsBefore = board.events({ taskId: task.boardTaskId }).length;
    try {
      assert.throws(() => board.block(task.boardTaskId, "main", "x"), /boom/);
    } finally {
      db.exec("DROP TRIGGER fail_events");
      db.close();
    }

    assert.equal(board.getTask(task.boardTaskId)?.status, "backlog");
    assert.equal(board.events({ taskId: task.boardTaskId }).length, eventsBefore);
  });

  void it("prunes events of removed tasks", async () => {
    const board = newBoard();
    const task = newTask(board);
    complete(board, task.boardTaskId);
    await sleep(5);

    const pruned = board.prune({ taskDays: 0, eventDays: 0 });

    assert.ok(pruned.tasks >= 1);
    assert.ok(pruned.events >= 1);
    assert.equal(board.events({ taskId: task.boardTaskId }).length, 0);
  });

  void it("clamps a negative list limit to zero", () => {
    const board = newBoard();
    newTask(board);

    assert.equal(board.list({ limit: -5 }).length, 0);
  });

  void it("reads an existing board in readonly mode", () => {
    const dir = tempDir();
    const board = newBoard(dir);
    const task = newTask(board);
    board.close();

    const readonly = openBoard(dir, { readonly: true });
    boards.push(readonly);

    assert.equal(readonly.getTask(task.boardTaskId)?.title, task.title);
  });
});