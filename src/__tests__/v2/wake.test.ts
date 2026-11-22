import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import Database from "better-sqlite3";

import { openBoard, type Board, type CreateTaskInput } from "../../v2/board.ts";
import type { OpenCodeClient } from "../../v2/client.ts";
import { openWake, openWakeReadonly, registerLeadSession, runWave, type WakeQueue } from "../../v2/wake.ts";

const tempDirs: string[] = [];
const boards: Board[] = [];
const queues: WakeQueue[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deus-wake-"));
  tempDirs.push(dir);
  return dir;
}

function newBoard(dir = tempDir()): { board: Board; dir: string } {
  const board = openBoard(dir);
  boards.push(board);
  return { board, dir };
}

function newWake(dir: string): WakeQueue {
  const queue = openWake(dir);
  queues.push(queue);
  return queue;
}

function mainTeamId(board: Board): string {
  const team = board.getTeamByName("main");
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

/** Drives a task to review and returns its id. */
function submitTask(board: Board, dir: string, executionRef?: string): string {
  const task = newTask(board);
  const claim = board.claim(task.boardTaskId, "main");
  assert.ok(claim);
  board.start(task.boardTaskId, claim.claimToken, executionRef ?? `run-test/${task.boardTaskId}`);
  board.submit(task.boardTaskId, claim.claimToken, { status: "passed" }, { summary: "ok" });
  return task.boardTaskId;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface FakeOptions {
  failPrompt?: boolean;
  cost?: number;
  /** Cost per `session.get` call; the last value repeats. */
  costSeq?: number[];
}

function fakeClient(options: FakeOptions = {}) {
  const calls = { prompt: [] as string[], get: 0 };
  let cost = options.cost ?? 0.1;

  const client = {
    session: {
      get: async () => {
        calls.get++;
        const value = options.costSeq
          ? options.costSeq[Math.min(calls.get - 1, options.costSeq.length - 1)]
          : cost;
        return {
          cost: value,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        };
      },
      prompt: async (input: { text: string }) => {
        if (options.failPrompt) throw new Error("prompt rejected");
        calls.prompt.push(input.text);
        return {
          id: `u-${calls.prompt.length}`,
          sessionID: "ses-1",
          type: "user",
          delivery: "queue",
          payload: { text: input.text },
          time: { created: Date.now() },
        };
      },
    },
    message: {
      list: async () => ({ data: [] }),
    },
  } as unknown as OpenCodeClient;

  return {
    client,
    calls,
    setCost: (value: number) => {
      cost = value;
    },
  };
}

after(() => {
  for (const queue of queues) {
    try {
      queue.close();
    } catch {
      // already closed
    }
  }
  for (const board of boards) {
    try {
      board.close();
    } catch {
      // already closed
    }
  }
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

void describe("wake outbox", () => {
  void it("is idempotent by dedup key", () => {
    const { dir } = newBoard();
    const queue = newWake(dir);

    const first = queue.enqueue({
      dedupKey: "task/review-ready:bt-1:1",
      teamId: "team-1",
      eventType: "task/review-ready",
      recipient: { sessionID: "ses-1" },
    });
    const second = queue.enqueue({
      dedupKey: "task/review-ready:bt-1:1",
      teamId: "team-1",
      eventType: "task/review-ready",
      recipient: { sessionID: "ses-1" },
    });

    assert.equal(first.wakeEventId, second.wakeEventId);
    assert.equal(queue.stats().pending, 1);
  });

  void it("is written by submit in the same transaction as the status change", () => {
    const { board, dir } = newBoard();
    registerLeadSession(dir, "ses-lead");
    const taskId = submitTask(board, dir);

    const queue = newWake(dir);
    const pending = queue.list({ status: "pending" });

    assert.equal(pending.length, 1);
    assert.equal(pending[0].eventType, "task/review-ready");
    assert.equal(pending[0].boardTaskId, taskId);
  });

  void it("rolls back both the status and the event when the outbox write fails", () => {
    const { board, dir } = newBoard();
    const task = newTask(board);
    const claim = board.claim(task.boardTaskId, "main");
    assert.ok(claim);
    board.start(task.boardTaskId, claim.claimToken, `run-test/${task.boardTaskId}`);

    const raw = new Database(path.join(dir, ".deus", "board.db"));
    raw.exec(
      `CREATE TRIGGER fail_wake BEFORE INSERT ON wake_events
       BEGIN SELECT RAISE(ABORT, 'wake boom'); END;`,
    );

    try {
      assert.throws(
        () =>
          board.submit(task.boardTaskId, claim.claimToken, { status: "passed" }, { summary: "x" }),
        /wake boom/,
      );
    } finally {
      raw.exec("DROP TRIGGER fail_wake");
      raw.close();
    }

    assert.equal(board.getTask(task.boardTaskId)?.status, "running");
    assert.equal(newWake(dir).stats().pending, 0);
  });

  void it("enqueues a block event for the lead", () => {
    const { board, dir } = newBoard();
    registerLeadSession(dir, "ses-lead");
    const task = newTask(board);
    const claim = board.claim(task.boardTaskId, "main");
    assert.ok(claim);
    board.block(task.boardTaskId, "main", "needs a decision", claim.claimToken);

    const events = newWake(dir).list({ limit: 20 });
    assert.equal(events.length, 1);
    assert.equal(events[0].eventType, "task/blocked");
    assert.equal(events[0].recipient.sessionID, "ses-lead");
  });

  void it("claims exclusively across two connections", () => {
    const { dir } = newBoard();
    const a = newWake(dir);
    const b = newWake(dir);
    a.enqueue({
      dedupKey: "one",
      teamId: "t",
      eventType: "task/review-ready",
      recipient: { sessionID: "ses-1" },
    });

    const first = a.claim();
    const second = b.claim();

    assert.ok(first);
    assert.equal(second, null);
  });

  void it("lets another process take over an expired lease", async () => {
    const { dir } = newBoard();
    const a = newWake(dir);
    const b = newWake(dir);
    a.enqueue({
      dedupKey: "one",
      teamId: "t",
      eventType: "task/review-ready",
      recipient: { sessionID: "ses-1" },
    });

    const first = a.claim({ leaseMs: 1_000 });
    assert.ok(first);
    await sleep(1_100);

    const second = b.claim();
    assert.ok(second);
    assert.notEqual(second.claimToken, first.claimToken);
  });

  void it("rejects a foreign claim token", () => {
    const { dir } = newBoard();
    const queue = newWake(dir);
    queue.enqueue({
      dedupKey: "one",
      teamId: "t",
      eventType: "task/review-ready",
      recipient: { sessionID: "ses-1" },
    });
    const claim = queue.claim();
    assert.ok(claim);

    assert.throws(() => queue.complete([claim.events[0].wakeEventId], "wake:deadbeef"));
  });

  void it("gives up after repeated failures and keeps the reason", () => {
    const { dir } = newBoard();
    const queue = newWake(dir);
    queue.enqueue({
      dedupKey: "one",
      teamId: "t",
      eventType: "task/review-ready",
      recipient: { sessionID: "ses-1" },
    });

    // Backoff is real time; move the retry time forward instead of waiting.
    const raw = new Database(path.join(dir, ".deus", "board.db"));
    try {
      for (let attempt = 1; attempt <= 5; attempt++) {
        raw.prepare(`UPDATE wake_events SET available_at = ? WHERE status = 'pending'`).run(
          new Date(Date.now() - 1_000).toISOString(),
        );

        const claim = queue.claim();
        assert.ok(claim, `attempt ${attempt} should be claimable`);
        queue.fail(
          claim.events.map((event) => event.wakeEventId),
          claim.claimToken,
          "prompt rejected",
        );
      }
    } finally {
      raw.close();
    }

    const [event] = queue.list({ limit: 5 });
    assert.equal(event.status, "failed");
    assert.equal(event.attempts, 5);
    assert.equal(event.outcome, "retries_exhausted");
    assert.equal(event.lastError, "prompt rejected");
  });

  void it("expires an overdue event instead of delivering it late", () => {
    const { dir } = newBoard();
    const queue = newWake(dir);
    queue.enqueue({
      dedupKey: "old",
      teamId: "t",
      eventType: "task/review-ready",
      recipient: { sessionID: "ses-1" },
      deadlineSeconds: -1,
    });

    assert.equal(queue.claim(), null);
    assert.equal(queue.stats().expired, 1);
  });

  void it("opens read-only only when the board exists", () => {
    const empty = tempDir();
    assert.equal(openWakeReadonly(empty), undefined);

    const { dir } = newBoard();
    const readonly = openWakeReadonly(dir);
    assert.ok(readonly);
    queues.push(readonly);
    assert.equal(readonly.stats().pending, 0);
  });

  void it("adds batch_id when upgrading an intermediate outbox", () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, ".deus"), { recursive: true });
    const raw = new Database(path.join(dir, ".deus", "board.db"));
    raw.pragma("user_version = 2");
    // Shape of an unreleased build: wake_events exists, batch_id does not.
    raw.exec(`
      CREATE TABLE wake_events (
        wake_event_id TEXT PRIMARY KEY,
        dedup_key TEXT NOT NULL UNIQUE,
        team_id TEXT NOT NULL,
        board_task_id TEXT,
        event_type TEXT NOT NULL,
        recipient_json TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at TEXT NOT NULL,
        lease_until TEXT,
        claim_token TEXT,
        deadline_at TEXT NOT NULL,
        cost_baseline REAL,
        cost REAL,
        last_error TEXT,
        outcome TEXT,
        created_at TEXT NOT NULL,
        delivered_at TEXT
      );
    `);
    raw.close();

    const queue = newWake(dir);
    const db = new Database(path.join(dir, ".deus", "board.db"), { readonly: true });
    const columns = (db.prepare(`PRAGMA table_info(wake_events)`).all() as Array<{ name: string }>).map(
      (column) => column.name,
    );
    const version = db.pragma("user_version", { simple: true }) as number;
    db.close();

    assert.ok(columns.includes("batch_id"));
    assert.equal(version, 3);
    assert.equal(queue.stats().pending, 0);
  });

  void it("reports no outbox for a database created before wake existed", () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, ".deus"), { recursive: true });
    const raw = new Database(path.join(dir, ".deus", "board.db"));
    raw.pragma("user_version = 2");
    raw.exec(`CREATE TABLE teams (team_id TEXT PRIMARY KEY)`);
    raw.close();

    assert.equal(openWakeReadonly(dir), undefined);
  });

  void it("cancels a pending wake when the task is accepted", () => {
    const { board, dir } = newBoard();
    registerLeadSession(dir, "ses-lead");
    const taskId = submitTask(board, dir);

    const queue = newWake(dir);
    assert.equal(queue.stats().pending, 1);

    board.accept(taskId, "main");
    assert.equal(queue.stats().pending, 0);
    assert.equal(queue.stats().cancelled, 1);
  });

  void it("cancels a pending wake when the task is cancelled", () => {
    const { board, dir } = newBoard();
    registerLeadSession(dir, "ses-lead");
    const taskId = submitTask(board, dir);

    const queue = newWake(dir);
    board.cancel(taskId, "main");
    assert.equal(queue.stats().cancelled, 1);
  });

  void it("does not cancel a wake that is being delivered right now", () => {
    const { board, dir } = newBoard();
    registerLeadSession(dir, "ses-lead");
    const taskId = submitTask(board, dir);
    const queue = newWake(dir);

    const claim = queue.claim();
    assert.ok(claim);

    board.accept(taskId, "main");
    assert.equal(queue.stats().cancelled, 0);

    // The wave still owns the event and can finish its delivery.
    queue.complete(claim.events.map((event) => event.wakeEventId), claim.claimToken, 0.1);
    assert.equal(queue.stats().delivered, 1);
  });

  void it("prunes terminal wake events", async () => {
    const { board, dir } = newBoard();
    registerLeadSession(dir, "ses-lead");
    const taskId = submitTask(board, dir);
    board.accept(taskId, "main");
    await sleep(5);

    const pruned = board.prune({ taskDays: 90, eventDays: 0 });

    assert.ok(pruned.wakes >= 1);
    assert.equal(newWake(dir).stats().cancelled, 0);
  });
});

void describe("runWave", () => {
  void it("delivers a queued message and marks the event delivered", async () => {
    const { dir } = newBoard();
    const queue = newWake(dir);
    queue.enqueue({
      dedupKey: "one",
      teamId: "t",
      boardTaskId: "bt-1",
      eventType: "task/review-ready",
      recipient: { sessionID: "ses-1" },
      payload: { title: "write the report" },
    });

    const { client, calls } = fakeClient();
    const result = await runWave(client, queue, { maxSteps: 1 });

    assert.equal(result.outcome, "done");
    assert.equal(result.delivered, 1);
    assert.equal(result.pendingLeft, 0);
    assert.equal(calls.prompt.length, 1);
    assert.match(calls.prompt[0], /\[deus\]/);
    assert.match(calls.prompt[0], /write the report/);
    assert.equal(queue.stats().delivered, 1);
  });

  void it("stops at maxSteps and leaves the rest pending", async () => {
    const { dir } = newBoard();
    const queue = newWake(dir);
    for (const key of ["a", "b", "c"]) {
      queue.enqueue({
        dedupKey: key,
        teamId: "t",
        eventType: "task/review-ready",
        recipient: { sessionID: "ses-1" },
      });
    }

    const { client } = fakeClient();
    const result = await runWave(client, queue, { maxSteps: 1, coalesceMs: 0 });

    assert.equal(result.delivered, 1);
    assert.equal(result.outcome, "budget_exhausted");
    assert.equal(result.pendingLeft, 2);
  });

  void it("stops immediately when the kill-switch is on", async () => {
    const { dir } = newBoard();
    const queue = newWake(dir);
    queue.enqueue({
      dedupKey: "one",
      teamId: "t",
      eventType: "task/review-ready",
      recipient: { sessionID: "ses-1" },
    });
    fs.writeFileSync(path.join(dir, ".deus", "wake.disabled"), "", "utf-8");

    const { client, calls } = fakeClient();
    const result = await runWave(client, queue);

    assert.equal(result.outcome, "disabled");
    assert.equal(result.delivered, 0);
    assert.deepEqual(calls.prompt, []);
    assert.equal(queue.stats().pending, 1);
  });

  void it("coalesces a storm into one message without losing events", async () => {
    const { dir } = newBoard();
    const queue = newWake(dir);
    for (let index = 0; index < 12; index++) {
      queue.enqueue({
        dedupKey: `storm-${index}`,
        teamId: "t",
        eventType: "task/review-ready",
        recipient: { sessionID: "ses-1" },
        payload: { title: `task ${index}` },
      });
    }

    const { client, calls } = fakeClient();
    const result = await runWave(client, queue, { maxSteps: 1, coalesceMs: 60_000 });

    assert.equal(calls.prompt.length, 1);
    assert.equal(result.messages, 1);
    assert.equal(result.delivered, 10);
    assert.equal(result.pendingLeft, 2);
    assert.match(calls.prompt[0], /10 tasks need you/);
    assert.equal(queue.stats().delivered, 10);
  });

  void it("does not coalesce events outside the window", async () => {
    const { dir } = newBoard();
    const queue = newWake(dir);
    const first = queue.enqueue({
      dedupKey: "first",
      teamId: "t",
      eventType: "task/review-ready",
      recipient: { sessionID: "ses-1" },
    });
    queue.enqueue({
      dedupKey: "second",
      teamId: "t",
      eventType: "task/review-ready",
      recipient: { sessionID: "ses-1" },
    });

    // Pretend the first event is much older than the coalescing window.
    const db = new Database(path.join(dir, ".deus", "board.db"));
    db.prepare(`UPDATE wake_events SET created_at = ? WHERE wake_event_id = ?`).run(
      new Date(Date.parse(first.createdAt) - 5 * 60_000).toISOString(),
      first.wakeEventId,
    );
    db.close();

    const { client, calls } = fakeClient();
    await runWave(client, queue, { maxSteps: 2, coalesceMs: 30_000 });

    assert.equal(calls.prompt.length, 2);
  });

  void it("counts a coalesced batch's cost once", async () => {
    const { dir } = newBoard();
    const queue = newWake(dir);
    for (const key of ["a", "b", "c"]) {
      queue.enqueue({
        dedupKey: key,
        teamId: "t",
        eventType: "task/review-ready",
        recipient: { sessionID: "ses-1" },
      });
    }

    const { client, setCost } = fakeClient({ cost: 0.1 });
    const wave = await runWave(client, queue, { maxSteps: 1, coalesceMs: 60_000 });
    assert.equal(wave.messages, 1);
    assert.equal(wave.delivered, 3);

    setCost(0.25);
    await queue.reconcileCosts(client);
    // A second pass must not charge the same batch again through its other rows.
    await queue.reconcileCosts(client);
    // One message spent 0.15, not 0.45 for three events of that batch.
    assert.ok(Math.abs(queue.stats().knownCost - 0.15) < 1e-9);
  });

  void it("scopes the soft cost ceiling to the wave, not to lifetime spend", async () => {
    const { dir } = newBoard();
    const queue = newWake(dir);
    queue.enqueue({
      dedupKey: "old",
      teamId: "t",
      eventType: "task/review-ready",
      recipient: { sessionID: "ses-1" },
    });

    const { client, setCost } = fakeClient({ cost: 0.1 });
    await runWave(client, queue, { maxSteps: 1, coalesceMs: 0 });
    setCost(5); // lifetime spend is now far above any cap
    await queue.reconcileCosts(client);

    // Two fresh events: the wave must deliver both despite the lifetime spend.
    for (const key of ["new-1", "new-2"]) {
      queue.enqueue({
        dedupKey: key,
        teamId: "t",
        eventType: "task/review-ready",
        recipient: { sessionID: "ses-1" },
      });
    }
    setCost(5.05);

    const wave = await runWave(client, queue, { maxSteps: 2, coalesceMs: 0, maxCost: 0.5 });
    assert.equal(wave.delivered, 2);
    assert.equal(wave.outcome, "done");
  });

  void it("stops a wave when its own reconciled cost passes the ceiling", async () => {
    const { dir } = newBoard();
    const queue = newWake(dir);
    for (const key of ["a", "b"]) {
      queue.enqueue({
        dedupKey: key,
        teamId: "t",
        eventType: "task/review-ready",
        recipient: { sessionID: "ses-1" },
      });
    }

    // Snapshot and baseline see 0; after the first delivery the session shows 5.
    const { client, calls } = fakeClient({ costSeq: [0, 0, 5, 5] });
    const wave = await runWave(client, queue, {
      maxSteps: 2,
      coalesceMs: 0,
      maxCost: 0.5,
    });

    assert.equal(calls.prompt.length, 1);
    assert.equal(wave.delivered, 1);
    assert.equal(wave.outcome, "budget_exhausted");
    assert.equal(wave.pendingLeft, 1);
  });

  void it("treats maxCost 0 as 'deliver nothing'", async () => {
    const { dir } = newBoard();
    const queue = newWake(dir);
    queue.enqueue({
      dedupKey: "one",
      teamId: "t",
      eventType: "task/review-ready",
      recipient: { sessionID: "ses-1" },
    });

    const { client, calls } = fakeClient();
    const result = await runWave(client, queue, { maxCost: 0 });

    assert.equal(result.outcome, "budget_exhausted");
    assert.equal(result.delivered, 0);
    assert.deepEqual(calls.prompt, []);
  });

  void it("defers an event without a recipient instead of spending an attempt", async () => {
    const { dir } = newBoard();
    const queue = newWake(dir);
    queue.enqueue({
      dedupKey: "one",
      teamId: "t",
      eventType: "task/review-ready",
      recipient: { sessionID: "" },
    });

    const { client, calls } = fakeClient();
    const result = await runWave(client, queue);

    assert.equal(result.failed, 0);
    assert.equal(result.skipped, 1);
    assert.deepEqual(calls.prompt, []);
    const [event] = queue.list({ limit: 1 });
    assert.equal(event.status, "pending");
    assert.equal(event.attempts, 0);
    assert.match(event.lastError ?? "", /no recipient session/);
  });

  void it("retargets a deferred event as soon as the lead registers", async () => {
    const { dir } = newBoard();
    const queue = newWake(dir);
    queue.enqueue({
      dedupKey: "one",
      teamId: "t",
      eventType: "task/review-ready",
      recipient: { sessionID: "" },
    });

    // No lead yet: the event is deferred, not failed.
    const first = await runWave(fakeClient().client, queue, { maxSteps: 1 });
    assert.equal(first.delivered, 0);
    assert.equal(first.skipped, 1);
    assert.equal(queue.list({ limit: 1 })[0].attempts, 0);

    registerLeadSession(dir, "ses-late-lead");
    const { client, calls } = fakeClient();
    const second = await runWave(client, queue, { maxSteps: 1 });

    // Immediately, not after the defer delay.
    assert.equal(second.delivered, 1);
    assert.equal(calls.prompt.length, 1);
    assert.equal(queue.list({ limit: 1 })[0].recipient.sessionID, "ses-late-lead");
  });

  void it("does not count a rejected prompt as delivered", async () => {
    const { dir } = newBoard();
    const queue = newWake(dir);
    queue.enqueue({
      dedupKey: "one",
      teamId: "t",
      eventType: "task/review-ready",
      recipient: { sessionID: "ses-1" },
    });

    const { client } = fakeClient({ failPrompt: true });
    const result = await runWave(client, queue, { maxSteps: 1 });

    assert.equal(result.delivered, 0);
    assert.equal(result.failed, 1);
    assert.equal(queue.stats().delivered, 0);
  });

  void it("reconciles the cost of a queued turn on the next pass", async () => {
    const { dir } = newBoard();
    const queue = newWake(dir);
    queue.enqueue({
      dedupKey: "one",
      teamId: "t",
      eventType: "task/review-ready",
      recipient: { sessionID: "ses-1" },
    });

    const { client, setCost } = fakeClient({ cost: 0.1 });
    await runWave(client, queue, { maxSteps: 1, coalesceMs: 0 });
    assert.equal(queue.stats().knownCost, 0);

    setCost(0.25);
    const reconciled = await queue.reconcileCosts(client);

    assert.equal(reconciled, 1);
    assert.ok(Math.abs(queue.stats().knownCost - 0.15) < 1e-9);
  });

  void it("reports a dry run without sending anything", async () => {
    const { dir } = newBoard();
    const queue = newWake(dir);
    queue.enqueue({
      dedupKey: "one",
      teamId: "t",
      eventType: "task/review-ready",
      recipient: { sessionID: "ses-1" },
    });

    const { client, calls } = fakeClient();
    const result = await runWave(client, queue, { dryRun: true });

    assert.equal(result.skipped, 1);
    assert.equal(result.pendingLeft, 1);
    assert.deepEqual(calls.prompt, []);
  });
});
