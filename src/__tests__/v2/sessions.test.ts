import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import type { Board } from "../../v2/board.ts";
import type { OpenCodeClient } from "../../v2/client.ts";
import {
  DEFAULT_FOLLOWUP_TIMEOUT_MS,
  followUp,
  messageTask,
  recordStepSession,
  resolveTaskSession,
} from "../../v2/sessions.ts";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deus-sessions-"));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** A persisted user message: the text lives on the message, not under `payload`. */
function user(id: string, text: string, created = 1) {
  return { id, type: "user", text, time: { created } };
}

function assistant(
  id: string,
  text: string,
  finish = "stop",
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    type: "assistant",
    finish,
    content: [{ type: "text", text }],
    time: { created: 2, completed: 3 },
    ...extra,
  };
}

function tokens(input: number) {
  return { input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
}

interface FakeOptions {
  promptError?: string;
  /** `null` means the service returned no inbox message at all. */
  inbox?: { id?: string; delivery?: "steer" | "queue"; time?: { created: number } } | null;
  before?: unknown[];
  after?: unknown[];
  /** Tokens per `session.get` call; the last value repeats. */
  tokenSeq?: number[];
  /** Cost per `session.get` call; the last value repeats. */
  costSeq?: number[];
  listError?: string;
  /** Fails only after `prompt`, so the snapshot and the send still succeed. */
  listErrorAfterPrompt?: string;
  sessionGoneAfterPrompt?: boolean;
  /** 1-based index of the `session.get` call that should fail. */
  getFailOnCall?: number;
}

function fakeClient(options: FakeOptions = {}) {
  const inbox =
    options.inbox === undefined
      ? { id: "u2", delivery: "queue" as const, time: { created: 2 } }
      : options.inbox;
  const before = options.before ?? [user("u1", "one"), assistant("a1", "one")];
  const after = options.after ?? [
    user("u1", "one"),
    assistant("a1", "one"),
    user("u2", "say two", 2),
    assistant("a2", "two"),
  ];
  const tokenSeq = options.tokenSeq ?? [10, 60, 110];
  const costSeq = options.costSeq ?? [0.1, 0.15, 0.25];

  const calls = { prompt: [] as string[], list: 0, get: 0 };
  let sent = false;

  const client = {
    session: {
      prompt: async (input: { text: string }) => {
        if (options.promptError) throw new Error(options.promptError);
        sent = true;
        calls.prompt.push(input.text);
        return inbox ?? undefined;
      },
      get: async () => {
        calls.get++;
        if (options.getFailOnCall === calls.get) throw new Error("session get failed");
        if (options.sessionGoneAfterPrompt && sent) throw new Error("session not found");
        const index = Math.min(calls.get - 1, tokenSeq.length - 1);
        const costIndex = Math.min(calls.get - 1, costSeq.length - 1);
        return { cost: costSeq[costIndex], tokens: tokens(tokenSeq[index]) };
      },
    },
    message: {
      list: async () => {
        calls.list++;
        if (options.listError) throw new Error(options.listError);
        if (options.listErrorAfterPrompt && sent) throw new Error(options.listErrorAfterPrompt);
        return { data: sent ? after : before };
      },
    },
  } as unknown as OpenCodeClient;

  return { client, calls };
}

void describe("followUp", () => {
  void it("waits for the answer after our message boundary", async () => {
    const { client, calls } = fakeClient();

    const result = await followUp(client, { sessionID: "ses-1", text: "say two" });

    assert.equal(result.status, "completed");
    assert.equal(result.text, "two");
    assert.equal(result.delivered, true);
    assert.equal(result.delivery, "queue");
    assert.deepEqual(calls.prompt, ["say two"]);
  });

  void it("counts only this turn's cost, not the previous turn's tail", async () => {
    const { client } = fakeClient({
      tokenSeq: [10, 100, 130],
      costSeq: [0.1, 0.2, 0.3],
    });

    const result = await followUp(client, { sessionID: "ses-1", text: "say two" });

    assert.equal(result.status, "completed");
    // Delta is measured from the boundary (0.2 / 100), not from before the send.
    assert.ok(Math.abs((result.cost ?? 0) - 0.1) < 1e-9, `cost was ${result.cost}`);
    assert.equal(result.tokens?.input, 30);
  });

  void it("keeps the answer when the metadata read fails at the end", async () => {
    const { client } = fakeClient({ getFailOnCall: 3 });

    const result = await followUp(client, { sessionID: "ses-1", text: "say two" });

    assert.equal(result.status, "completed");
    assert.equal(result.text, "two");
    assert.equal(result.cost, undefined);
    assert.equal(result.tokens, undefined);
  });

  void it("estimates the cost from tokens when the provider reports zero", async () => {
    const { client } = fakeClient({
      tokenSeq: [0, 0, 1_000_000],
      costSeq: [0, 0, 0],
    });

    const result = await followUp(client, {
      sessionID: "ses-1",
      text: "say two",
      model: "opencode-go/deepseek-v4.1-flash#high",
    });

    assert.equal(result.status, "completed");
    assert.equal(result.tokens?.input, 1_000_000);
    assert.ok(Math.abs((result.cost ?? 0) - 0.15) < 1e-9, `cost was ${result.cost}`);
  });

  void it("falls back to the pre-send baseline when the boundary read fails", async () => {
    const { client } = fakeClient({
      getFailOnCall: 2,
      tokenSeq: [10, 60, 130],
      costSeq: [0.1, 0.15, 0.3],
    });

    const result = await followUp(client, { sessionID: "ses-1", text: "say two" });

    // Documented degradation: the delta is measured from before the send.
    assert.equal(result.status, "completed");
    assert.equal(result.tokens?.input, 120);
  });

  void it("does not return the running turn's output as the follow-up answer", async () => {
    const { client } = fakeClient({
      after: [
        user("u1", "one"),
        assistant("a1", "one"),
        // The current turn keeps producing output after the snapshot.
        assistant("a-running", "1\n2\n3\n4\n5"),
        user("u2", "say stopped", 2),
        assistant("a2", "stopped"),
      ],
    });

    const result = await followUp(client, { sessionID: "ses-1", text: "say stopped" });

    assert.equal(result.status, "completed");
    assert.equal(result.text, "stopped");
  });

  void it("times out instead of returning a fresh running-turn answer when our message never appears", async () => {
    const { client } = fakeClient({
      inbox: { id: "u-absent", delivery: "queue", time: { created: 2 } },
      after: [
        user("u1", "one"),
        assistant("a1", "one"),
        // A "last assistant message" implementation would return this text.
        assistant("a-running", "1\n2\n3\n4\n5"),
      ],
    });

    const result = await followUp(client, {
      sessionID: "ses-1",
      text: "never admitted",
      timeoutMs: 40,
      firstOutputMs: 10_000,
    });

    assert.equal(result.status, "failed");
    assert.equal(result.delivered, true);
    assert.equal(result.text, undefined);
    assert.match(result.error ?? "", /timed out/);
    assert.match(result.error ?? "", /may still be queued/);
  });

  void it("finds the boundary by text when the inbox id is not echoed", async () => {
    const { client } = fakeClient({
      inbox: { delivery: "queue", time: { created: 2 } },
      after: [
        user("u1", "one"),
        assistant("a1", "one"),
        user("u-new", "say two", 2),
        assistant("a2", "two"),
      ],
    });

    const result = await followUp(client, { sessionID: "ses-1", text: "say two" });

    assert.equal(result.status, "completed");
    assert.equal(result.text, "two");
  });

  void it("refuses to guess a boundary when two new messages carry the same text", async () => {
    const { client } = fakeClient({
      inbox: { delivery: "queue", time: { created: 2 } },
      after: [
        user("u1", "one"),
        assistant("a1", "one"),
        user("u-main", "same words", 2),
        assistant("a-main", "first"),
        user("u-worker", "same words", 3),
        assistant("a-worker", "second"),
      ],
    });

    const result = await followUp(client, {
      sessionID: "ses-1",
      text: "same words",
      timeoutMs: 40,
      firstOutputMs: 10_000,
    });

    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /timed out/);
  });

  void it("returns queued without waiting when wait is false", async () => {
    const { client, calls } = fakeClient();

    const result = await followUp(client, {
      sessionID: "ses-1",
      text: "later",
      wait: false,
    });

    assert.equal(result.status, "queued");
    assert.equal(result.delivered, true);
    assert.equal(result.delivery, "queue");
    assert.deepEqual(calls.prompt, ["later"]);
    assert.equal(calls.list, 1);
  });

  void it("reports a silent provider after the first-output window", async () => {
    const { client } = fakeClient({
      after: [user("u1", "one"), assistant("a1", "one"), user("u2", "silent", 2)],
      // Tokens already grew with the previous turn, so only the boundary baseline
      // makes "no growth" true here.
      tokenSeq: [10, 110, 110],
    });

    const result = await followUp(client, {
      sessionID: "ses-1",
      text: "silent",
      timeoutMs: 2_000,
      firstOutputMs: 20,
    });

    assert.equal(result.status, "failed");
    assert.equal(result.delivered, true);
    assert.match(result.error ?? "", /no model output/);
  });

  void it("does not fail a turn that produced output without a stop yet", async () => {
    const { client } = fakeClient({
      after: [
        user("u1", "one"),
        assistant("a1", "one"),
        user("u2", "working", 2),
        assistant("a2", "checking the logs", "tool-calls"),
      ],
      tokenSeq: [10, 60, 110],
    });

    const result = await followUp(client, {
      sessionID: "ses-1",
      text: "working",
      timeoutMs: 700,
      firstOutputMs: 20,
    });

    // No stop within the budget, but output existed: the reason must be the
    // timeout, not "no model output".
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /timed out/);
    assert.doesNotMatch(result.error ?? "", /no model output/);
  });

  void it("prefers a later stop over an earlier errored message", async () => {
    const { client } = fakeClient({
      after: [
        user("u1", "one"),
        assistant("a1", "one"),
        user("u2", "recover", 2),
        assistant("a-err", "", "error", { error: { message: "transient failure" } }),
        assistant("a2", "recovered"),
      ],
    });

    const result = await followUp(client, { sessionID: "ses-1", text: "recover" });

    assert.equal(result.status, "completed");
    assert.equal(result.text, "recovered");
  });

  void it("reports an error that comes after the stop", async () => {
    const { client } = fakeClient({
      after: [
        user("u1", "one"),
        assistant("a1", "one"),
        user("u2", "boom", 2),
        assistant("a2", "partial"),
        assistant("a-err", "", "error", { error: { message: "provider exploded" } }),
      ],
    });

    const result = await followUp(client, { sessionID: "ses-1", text: "boom" });

    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /provider exploded/);
  });

  void it("reports a truncated answer instead of waiting for a stop", async () => {
    const { client } = fakeClient({
      after: [
        user("u1", "one"),
        assistant("a1", "one"),
        user("u2", "long", 2),
        assistant("a2", "cut off mid", "length"),
      ],
    });

    const result = await followUp(client, {
      sessionID: "ses-1",
      text: "long",
      timeoutMs: 2_000,
      firstOutputMs: 50,
    });

    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /truncated/);
    // The partial text is still useful and must not be thrown away.
    assert.equal(result.text, "cut off mid");
  });

  void it("keeps the text of an earlier assistant part when the final stop is empty", async () => {
    const { client } = fakeClient({
      after: [
        user("u1", "one"),
        assistant("a1", "one"),
        user("u2", "answer", 2),
        assistant("a-tool", "here is the answer", "tool-calls"),
        assistant("a2", ""),
      ],
    });

    const result = await followUp(client, { sessionID: "ses-1", text: "answer" });

    assert.equal(result.status, "completed");
    assert.equal(result.text, "here is the answer");
  });

  void it("fails when the turn produced no text at all", async () => {
    const { client } = fakeClient({
      after: [
        user("u1", "one"),
        assistant("a1", "one"),
        user("u2", "empty", 2),
        assistant("a2", ""),
      ],
    });

    const result = await followUp(client, { sessionID: "ses-1", text: "empty" });

    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /empty assistant response/);
  });

  void it("rejects empty text before sending", async () => {
    const { client, calls } = fakeClient();

    const result = await followUp(client, { sessionID: "ses-1", text: "   " });

    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /empty/);
    assert.deepEqual(calls.prompt, []);
  });

  void it("falls back to the default timeout for non-finite values", async () => {
    const { client } = fakeClient();

    const result = await followUp(client, {
      sessionID: "ses-1",
      text: "say two",
      timeoutMs: Number.NaN,
      firstOutputMs: Number.POSITIVE_INFINITY,
    });

    assert.equal(result.status, "completed");
    assert.equal(result.text, "two");
  });

  void it("fails clearly when the session is gone", async () => {
    const client = {
      message: {
        list: async () => {
          throw new Error("session not found");
        },
      },
      session: {
        get: async () => {
          throw new Error("session not found");
        },
      },
    } as unknown as OpenCodeClient;

    const result = await followUp(client, { sessionID: "ses-gone", text: "hi" });

    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /session not found/);
  });

  void it("gives up with 'session not found' when the listing keeps failing and the session is gone", async () => {
    const { client, calls } = fakeClient({
      listErrorAfterPrompt: "list is broken",
      sessionGoneAfterPrompt: true,
    });

    const result = await followUp(client, {
      sessionID: "ses-1",
      text: "hi",
      timeoutMs: 5_000,
    });

    assert.deepEqual(calls.prompt, ["hi"]);
    assert.ok(calls.list >= 6, `expected a burst of list calls, got ${calls.list}`);
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /session not found/);
    assert.doesNotMatch(result.error ?? "", /timed out/);
  });

  void it("recovers from a burst of list errors while the session is alive", async () => {
    const { client, calls } = fakeClient({ listErrorAfterPrompt: "list is broken" });

    const result = await followUp(client, {
      sessionID: "ses-1",
      text: "hi",
      timeoutMs: 1_600,
      firstOutputMs: 10_000,
    });

    // The counter resets after the successful probe, so the loop keeps polling
    // until the overall timeout instead of dying on the first burst.
    assert.ok(calls.list > 6, `expected continued polling, got ${calls.list}`);
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /timed out/);
    assert.doesNotMatch(result.error ?? "", /session not found/);
  });

  void it("does not take the next turn's stop as our answer", async () => {
    const { client } = fakeClient({
      after: [
        user("u1", "one"),
        assistant("a1", "one"),
        user("u2", "say stopped", 2),
        // Our turn is still running when another agent starts a new turn.
        assistant("a-ours-tool", "still working", "tool-calls"),
        user("u-other", "another turn", 3),
        assistant("a-other", "not ours"),
      ],
    });

    const result = await followUp(client, {
      sessionID: "ses-1",
      text: "say stopped",
      timeoutMs: 40,
      firstOutputMs: 10_000,
    });

    assert.equal(result.status, "failed");
    assert.equal(result.text, undefined);
    assert.match(result.error ?? "", /timed out/);
  });

  void it("treats a synthetic message as the start of another turn", async () => {
    const { client } = fakeClient({
      after: [
        user("u1", "one"),
        assistant("a1", "one"),
        user("u2", "say stopped", 2),
        assistant("a-ours-tool", "still working", "tool-calls"),
        { id: "s1", type: "synthetic", text: "subagent finished" },
        assistant("a-other", "not ours"),
      ],
    });

    const result = await followUp(client, {
      sessionID: "ses-1",
      text: "say stopped",
      timeoutMs: 40,
      firstOutputMs: 10_000,
    });

    assert.equal(result.status, "failed");
    assert.equal(result.text, undefined);
  });

  void it("does not truncate our turn at an informational message", async () => {
    const { client } = fakeClient({
      after: [
        user("u1", "one"),
        assistant("a1", "one"),
        user("u2", "finish it", 2),
        assistant("a-tool", "working", "tool-calls"),
        { id: "m1", type: "model-selected" },
        assistant("a2", "done"),
      ],
    });

    const result = await followUp(client, { sessionID: "ses-1", text: "finish it" });

    assert.equal(result.status, "completed");
    assert.equal(result.text, "done");
  });

  void it("keeps polling while tokens grow without a finished message", async () => {
    const { client } = fakeClient({
      after: [user("u1", "one"), assistant("a1", "one"), user("u2", "working", 2)],
      tokenSeq: [10, 60, 110],
    });

    const result = await followUp(client, {
      sessionID: "ses-1",
      text: "working",
      timeoutMs: 700,
      firstOutputMs: 20,
    });

    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /timed out/);
    assert.doesNotMatch(result.error ?? "", /no model output/);
  });

  void it("honours an already aborted signal before sending", async () => {
    const { client, calls } = fakeClient();
    const controller = new AbortController();
    controller.abort();

    const result = await followUp(client, {
      sessionID: "ses-1",
      text: "hi",
      signal: controller.signal,
    });

    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /aborted/);
    assert.deepEqual(calls.prompt, []);
  });

  void it("stops waiting when the signal aborts after sending", async () => {
    const { client } = fakeClient({
      after: [user("u1", "one"), assistant("a1", "one")],
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    const result = await followUp(client, {
      sessionID: "ses-1",
      text: "hi",
      timeoutMs: 5_000,
      firstOutputMs: 10_000,
      signal: controller.signal,
    });

    assert.equal(result.status, "failed");
    assert.equal(result.delivered, true);
    assert.match(result.error ?? "", /aborted while waiting/);
  });

  void it("has a sane default timeout", () => {
    assert.equal(DEFAULT_FOLLOWUP_TIMEOUT_MS, 120_000);
  });
});

void describe("resolveTaskSession", () => {
  function projectWithRun(state: unknown): string {
    const dir = tempDir();
    const runDir = path.join(dir, ".deus", "runs", "run-abc123");
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify(state), "utf-8");
    return dir;
  }

  void it("finds the session of the last matching step", () => {
    const dir = projectWithRun({
      version: 1,
      steps: [
        { stepId: "plan", sessionID: "ses-plan", agent: "plan" },
        { stepId: "fix", sessionID: "ses-fix-old", agent: "build" },
        { stepId: "fix", sessionID: "ses-fix-new", agent: "build" },
      ],
    });

    assert.deepEqual(resolveTaskSession(dir, "run-abc123/fix"), {
      sessionID: "ses-fix-new",
      runId: "run-abc123",
      stepId: "fix",
      agent: "build",
    });
  });

  void it("rejects an unknown state version", () => {
    const dir = projectWithRun({
      version: 2,
      steps: [{ stepId: "fix", sessionID: "ses-fix" }],
    });

    assert.equal(resolveTaskSession(dir, "run-abc123/fix"), undefined);
  });

  void it("returns undefined for a missing run, step or a traversal attempt", () => {
    const dir = projectWithRun({
      version: 1,
      steps: [{ stepId: "fix", sessionID: "ses-fix" }],
    });

    assert.equal(resolveTaskSession(dir, "run-missing/fix"), undefined);
    assert.equal(resolveTaskSession(dir, "run-abc123/nope"), undefined);
    assert.equal(resolveTaskSession(dir, "../etc/passwd"), undefined);
    assert.equal(resolveTaskSession(dir, "run-abc123"), undefined);
  });
});

void describe("messageTask", () => {
  function projectWithSession(): string {
    const dir = tempDir();
    const runDir = path.join(dir, ".deus", "runs", "run-abc123");
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, "run.json"),
      JSON.stringify({
        version: 1,
        steps: [{ stepId: "fix", sessionID: "ses-fix", agent: "build" }],
      }),
      "utf-8",
    );
    return dir;
  }

  function spyBoard(throwOnWrite = false): {
    board: Board;
    logged: Array<[string, string, string]>;
  } {
    const logged: Array<[string, string, string]> = [];
    const board = {
      addMessage: (taskId: string, actor: string, text: string) => {
        if (throwOnWrite) throw new Error("board is locked");
        logged.push([taskId, actor, text]);
      },
    } as unknown as Board;
    return { board, logged };
  }

  void it("sends to the resolved session and records the message on the board", async () => {
    const dir = projectWithSession();
    const { client, calls } = fakeClient();
    const { board, logged } = spyBoard();

    const result = await messageTask(client, dir, {
      taskId: "bt-1",
      executionRef: "run-abc123/fix",
      text: "how is it going?",
      board,
      actor: "main",
    });

    assert.equal(result.status, "completed");
    assert.equal(result.sessionID, "ses-fix");
    assert.equal(result.boardLogged, true);
    assert.equal(result.boardError, undefined);
    assert.deepEqual(calls.prompt, ["how is it going?"]);
    assert.deepEqual(logged, [["bt-1", "main", "how is it going?"]]);
  });

  void it("does not log a message the service rejected", async () => {
    const dir = projectWithSession();
    const { client } = fakeClient({ promptError: "boom" });
    const { board, logged } = spyBoard();

    const result = await messageTask(client, dir, {
      taskId: "bt-1",
      executionRef: "run-abc123/fix",
      text: "hi",
      board,
      actor: "main",
    });

    assert.equal(result.status, "failed");
    assert.equal(result.delivered, undefined);
    assert.deepEqual(logged, []);
  });

  void it("logs a delivered message even when the answer times out", async () => {
    const dir = projectWithSession();
    const { client } = fakeClient({
      inbox: { id: "u-absent", delivery: "queue", time: { created: 2 } },
      after: [user("u1", "one"), assistant("a1", "one")],
    });
    const { board, logged } = spyBoard();

    const result = await messageTask(client, dir, {
      taskId: "bt-1",
      executionRef: "run-abc123/fix",
      text: "queued",
      board,
      actor: "main",
      timeoutMs: 40,
      firstOutputMs: 10_000,
    });

    assert.equal(result.status, "failed");
    assert.equal(result.delivered, true);
    assert.equal(result.boardLogged, true);
    assert.deepEqual(logged, [["bt-1", "main", "queued"]]);
  });

  void it("keeps a delivered answer when the board write fails", async () => {
    const dir = projectWithSession();
    const { client } = fakeClient();
    const { board } = spyBoard(true);

    const result = await messageTask(client, dir, {
      taskId: "bt-1",
      executionRef: "run-abc123/fix",
      text: "say two",
      board,
      actor: "main",
    });

    assert.equal(result.status, "completed");
    assert.equal(result.text, "two");
    assert.equal(result.boardLogged, false);
    assert.equal(result.error, undefined);
    assert.match(result.boardError ?? "", /board event failed/);
  });

  void it("reports a skipped board event when the actor is missing", async () => {
    const dir = projectWithSession();
    const { client } = fakeClient();
    const { board, logged } = spyBoard();

    const result = await messageTask(client, dir, {
      taskId: "bt-1",
      executionRef: "run-abc123/fix",
      text: "say two",
      board,
    });

    assert.equal(result.status, "completed");
    assert.equal(result.boardLogged, false);
    assert.match(result.boardError ?? "", /no actor/);
    assert.deepEqual(logged, []);
  });

  void it("does not resolve a session for an unknown execution ref", async () => {
    const dir = tempDir();
    const { client } = fakeClient();

    const result = await messageTask(client, dir, {
      taskId: "bt-1",
      executionRef: "run-missing/fix",
      text: "hi",
      actor: "main",
    });

    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /no session found/);
  });
});

void describe("recordStepSession", () => {
  void it("writes a step that resolveTaskSession can find", () => {
    const dir = tempDir();
    recordStepSession(dir, "run-team01", {
      stepId: "bt-1",
      sessionID: "ses-worker",
      agent: "build",
    });

    assert.deepEqual(resolveTaskSession(dir, "run-team01/bt-1"), {
      sessionID: "ses-worker",
      runId: "run-team01",
      stepId: "bt-1",
      agent: "build",
    });
  });

  void it("keeps the newest session for the same step", () => {
    const dir = tempDir();
    recordStepSession(dir, "run-team02", { stepId: "bt-1", sessionID: "ses-first", agent: "build" });
    recordStepSession(dir, "run-team02", { stepId: "bt-1", sessionID: "ses-second", agent: "build" });
    recordStepSession(dir, "run-team02", { stepId: "bt-2", sessionID: "ses-other", agent: "build" });

    assert.equal(resolveTaskSession(dir, "run-team02/bt-1")?.sessionID, "ses-second");
    assert.equal(resolveTaskSession(dir, "run-team02/bt-2")?.sessionID, "ses-other");
  });

  void it("refuses to overwrite a pipeline run state", () => {
    const dir = tempDir();
    const runDir = path.join(dir, ".deus", "runs", "run-pipeline1");
    fs.mkdirSync(runDir, { recursive: true });
    const file = path.join(runDir, "run.json");
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, runId: "run-pipeline1", pipeline: "build", workDir: dir, steps: [] }),
      "utf-8",
    );

    assert.throws(
      () => recordStepSession(dir, "run-pipeline1", { stepId: "bt-1", sessionID: "ses-x", agent: "build" }),
      /belongs to a pipeline run/,
    );
    const kept = JSON.parse(fs.readFileSync(file, "utf-8")) as { pipeline?: string };
    assert.equal(kept.pipeline, "build");
  });

  void it("ignores an empty session id instead of writing a hole", () => {
    const dir = tempDir();
    recordStepSession(dir, "run-team03", { stepId: "bt-1", sessionID: "  ", agent: "build" });

    assert.equal(resolveTaskSession(dir, "run-team03/bt-1"), undefined);
  });
});
