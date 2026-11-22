import fs from "node:fs";

import type { OpenCodeClient } from "./client.ts";
import type { Board } from "./board.ts";
import { estimateCost } from "./pricing.ts";
import { runDirFor } from "./pipeline.ts";
import type { TokenUsage } from "./types.ts";

export const DEFAULT_FOLLOWUP_TIMEOUT_MS = 120_000;
export const DEFAULT_FIRST_OUTPUT_MS = 60_000;
const POLL_MS = 250;
const MAX_CONSECUTIVE_LIST_ERRORS = 5;

export interface SessionAddress {
  sessionID: string;
  /** Metadata, not the identifier. */
  runId?: string;
  stepId?: string;
  agent?: string;
}

export interface FollowUpInput {
  sessionID: string;
  text: string;
  /** Default 120 s. Non-finite or non-positive values fall back to the default. */
  timeoutMs?: number;
  /** Default 60 s after our message is admitted. */
  firstOutputMs?: number;
  /** false — only enqueue, do not wait for the answer. */
  wait?: boolean;
  /** Needed to price a turn when the provider reports no cost. */
  model?: string;
  signal?: AbortSignal;
}

export interface FollowUpResult {
  status: "completed" | "queued" | "failed";
  /**
   * The answer. On `completed` it is the full text; on `failed` it is set only
   * when the turn produced partial output (e.g. a truncated answer).
   */
  text?: string;
  /** Cost and tokens of this turn only: the delta since our message boundary. */
  cost?: number;
  tokens?: TokenUsage;
  /** Set only when the turn itself failed; a board problem goes to `boardError`. */
  error?: string;
  sessionID: string;
  /** True once the service accepted the message, even if the answer timed out. */
  delivered?: boolean;
  /** What the service actually did: steer or queue. */
  delivery?: "steer" | "queue";
  /** Set when a board event was requested. */
  boardLogged?: boolean;
  /** Set when the board event was requested but could not be written. */
  boardError?: string;
}

interface MessageLike {
  id: string;
  type: string;
  /** Persisted user messages carry the text here. */
  text?: string;
  finish?: string;
  content?: Array<{ type?: string; text?: string }>;
  /** Inbox messages carry the text under `payload`; kept for robustness. */
  payload?: { text?: string };
  error?: { message?: string } | string;
  time?: { created?: number; completed?: number };
}

interface Baseline {
  cost: number;
  tokens?: TokenUsage;
}

interface Snapshot extends Baseline {
  ids: Set<string>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeMs(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function formatWindow(ms: number): string {
  return ms < 1_000 ? `${Math.round(ms)}ms` : `${Math.round(ms / 1_000)}s`;
}

function isMessage(value: unknown): value is MessageLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

function isAssistant(message: MessageLike): boolean {
  return message.type === "assistant";
}

function userText(message: MessageLike): string | undefined {
  return message.text ?? message.payload?.text;
}

function assistantText(message: MessageLike): string {
  return (message.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}

function toTokens(tokens: {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
}): TokenUsage {
  return {
    input: tokens.input,
    output: tokens.output,
    reasoning: tokens.reasoning,
    cache: { read: tokens.cache.read, write: tokens.cache.write },
  };
}

function tokenTotal(tokens: TokenUsage | undefined): number {
  if (!tokens) return 0;
  return tokens.input + tokens.output + tokens.reasoning;
}

function deltaTokens(
  after: TokenUsage | undefined,
  before: TokenUsage | undefined,
): TokenUsage | undefined {
  if (!after) return undefined;
  const base = before ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
  const positive = (value: number): number => Math.max(0, value);
  return {
    input: positive(after.input - base.input),
    output: positive(after.output - base.output),
    reasoning: positive(after.reasoning - base.reasoning),
    cache: {
      read: positive(after.cache.read - base.cache.read),
      write: positive(after.cache.write - base.cache.write),
    },
  };
}

async function listMessages(
  client: OpenCodeClient,
  sessionID: string,
): Promise<MessageLike[]> {
  const response = await client.message.list({ sessionID, order: "asc" });
  return (response.data as unknown[]).filter(isMessage);
}

async function snapshot(client: OpenCodeClient, sessionID: string): Promise<Snapshot> {
  const info = await client.session.get({ sessionID });
  const messages = await listMessages(client, sessionID);
  return {
    cost: info.cost ?? 0,
    tokens: info.tokens ? toTokens(info.tokens) : undefined,
    ids: new Set(messages.map((message) => message.id)),
  };
}

/**
 * The address of our own turn in the transcript. `session.prompt` returns the
 * inbox message; the persisted user message reuses its id (confirmed live), so
 * everything before this boundary belongs to an earlier turn.
 *
 * The id is the primary key. The text fallback exists for the case where the
 * service stops echoing the id; it refuses to guess when several new messages
 * carry the same text (two agents may send the same words), because a wrong
 * boundary would attribute another turn's answer to us.
 */
function findBoundary(
  messages: MessageLike[],
  inboxId: string | undefined,
  text: string,
  beforeIds: Set<string>,
  inboxCreated: number | undefined,
): number {
  if (inboxId) {
    const exact = messages.findIndex((message) => message.id === inboxId);
    if (exact >= 0) return exact;
  }

  const candidates = messages
    .map((message, index) => ({ message, index }))
    .filter(
      ({ message }) =>
        message.type === "user" &&
        !beforeIds.has(message.id) &&
        userText(message) === text &&
        (inboxCreated === undefined || (message.time?.created ?? 0) >= inboxCreated),
    );

  if (candidates.length !== 1) return -1;
  return candidates[0].index;
}

/**
 * Message types that start a new block in the transcript. Our turn ends at the
 * first of them after the boundary: a later turn may not be marked `user`
 * (a subagent or a resumed run can write `synthetic`, `system`, `shell` or
 * `compaction`), and its `stop` must not become our answer.
 */
const TURN_BREAK_TYPES = new Set(["user", "synthetic", "system", "shell", "compaction"]);

/**
 * Assistant messages that belong to our turn: after our boundary and before the
 * next block. Informational messages (`idle`, `model-selected`, ...) are not a
 * boundary and are filtered out anyway.
 */
function answerAfter(messages: MessageLike[], boundary: number): MessageLike[] {
  let end = messages.length;
  for (let index = boundary + 1; index < messages.length; index++) {
    if (TURN_BREAK_TYPES.has(messages[index].type)) {
      end = index;
      break;
    }
  }
  return messages.slice(boundary + 1, end).filter(isAssistant);
}

/**
 * A message that ends the turn unsuccessfully. `length` is included: a
 * truncated answer is not a completed one.
 */
function terminalFailure(message: MessageLike): string | undefined {
  const structured = message.error;
  const detail = typeof structured === "string" ? structured : structured?.message;
  if (detail) return detail;
  if (message.finish === "error") return "provider stopped the turn: error";
  if (message.finish === "content-filter") return "provider stopped the turn: content-filter";
  if (message.finish === "length") return "response truncated: finish=length";
  return undefined;
}

/**
 * A turn may add an errored message and then recover with a successful stop.
 * The later message wins, so a recovered turn is not reported as failed.
 */
function lastIndexWhere(
  answers: MessageLike[],
  predicate: (message: MessageLike) => boolean,
): number {
  for (let index = answers.length - 1; index >= 0; index--) {
    if (predicate(answers[index])) return index;
  }
  return -1;
}

async function finish(
  client: OpenCodeClient,
  sessionID: string,
  baseline: Baseline,
  text: string,
  model: string | undefined,
  delivered: boolean,
  delivery: "steer" | "queue" | undefined,
): Promise<FollowUpResult> {
  let cost: number | undefined;
  let tokens: TokenUsage | undefined;

  try {
    const after = await client.session.get({ sessionID });
    tokens = deltaTokens(after.tokens ? toTokens(after.tokens) : undefined, baseline.tokens);
    const reported = Math.max(0, (after.cost ?? 0) - baseline.cost);
    cost =
      reported > 0
        ? reported
        : model && tokens
          ? estimateCost(model, tokens)
          : 0;
  } catch {
    // The answer arrived; a failed metadata read must not discard it.
  }

  return { status: "completed", sessionID, text: text.trim(), cost, tokens, delivered, delivery };
}

/**
 * Sends another turn into an existing session and, by default, waits for the
 * answer to *that* turn.
 *
 * The answer is located after the boundary of our own user message, not by a
 * raw "any new assistant message" diff: a running session keeps producing
 * output for the current turn, and a diff would return it as the follow-up
 * answer. Messages are explicitly queued (`delivery: "queue"`), so a running
 * session finishes its turn first.
 */
export async function followUp(
  client: OpenCodeClient,
  input: FollowUpInput,
): Promise<FollowUpResult> {
  const sessionID = input.sessionID;

  if (input.text.trim().length === 0) {
    return { status: "failed", sessionID, error: "message text is empty" };
  }
  if (input.signal?.aborted) {
    return { status: "failed", sessionID, error: "aborted before sending" };
  }

  const timeoutMs = normalizeMs(input.timeoutMs, DEFAULT_FOLLOWUP_TIMEOUT_MS);
  const firstOutputMs = normalizeMs(input.firstOutputMs, DEFAULT_FIRST_OUTPUT_MS);

  let before: Snapshot;
  try {
    before = await snapshot(client, sessionID);
  } catch (error) {
    return {
      status: "failed",
      sessionID,
      error: `session not found or unreadable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  let inbox:
    | { id?: string; delivery?: "steer" | "queue"; time?: { created?: number } }
    | undefined;
  try {
    inbox = (await client.session.prompt({
      sessionID,
      text: input.text,
      delivery: "queue",
    })) as { id?: string; delivery?: "steer" | "queue"; time?: { created?: number } };
  } catch (error) {
    return {
      status: "failed",
      sessionID,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const delivered = true;
  const delivery = inbox?.delivery;

  if (input.wait === false) {
    return { status: "queued", sessionID, delivered, delivery };
  }

  const started = Date.now();
  let boundary = -1;
  let boundaryAt = 0;
  // Cost/tokens as of the boundary: the previous turn's spending must not be
  // counted as this turn's cost.
  let baseline: Baseline = { cost: before.cost, tokens: before.tokens };
  let consecutiveErrors = 0;

  while (Date.now() - started < timeoutMs) {
    if (input.signal?.aborted) {
      return {
        status: "failed",
        sessionID,
        delivered,
        delivery,
        error: "aborted while waiting; the message was already delivered",
      };
    }

    let messages: MessageLike[];
    try {
      messages = await listMessages(client, sessionID);
      consecutiveErrors = 0;
    } catch (error) {
      consecutiveErrors++;
      if (consecutiveErrors >= MAX_CONSECUTIVE_LIST_ERRORS) {
        try {
          await client.session.get({ sessionID });
          consecutiveErrors = 0;
        } catch {
          return {
            status: "failed",
            sessionID,
            delivered,
            delivery,
            error: `session not found: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }
      await sleep(POLL_MS);
      continue;
    }

    if (boundary === -1) {
      boundary = findBoundary(messages, inbox?.id, input.text, before.ids, inbox?.time?.created);
      if (boundary >= 0) {
        boundaryAt = Date.now();
        try {
          const info = await client.session.get({ sessionID });
          baseline = {
            cost: info.cost ?? before.cost,
            tokens: info.tokens ? toTokens(info.tokens) : before.tokens,
          };
        } catch {
          // Keep the pre-turn baseline; the delta is then slightly wide, but the
          // answer itself is unaffected.
        }
      }
    }

    if (boundary === -1) {
      await sleep(POLL_MS);
      continue;
    }

    const answers = answerAfter(messages, boundary);
    const stoppedAt = lastIndexWhere(answers, (message) => message.finish === "stop");
    const failedAt = lastIndexWhere(answers, (message) => terminalFailure(message) !== undefined);

    if (failedAt > stoppedAt) {
      // A truncated turn still produced useful text; return it next to the error.
      const partial = answers
        .slice(0, failedAt + 1)
        .map(assistantText)
        .filter((part) => part.trim().length > 0)
        .join("\n\n")
        .trim();
      return {
        status: "failed",
        sessionID,
        delivered,
        delivery,
        error: terminalFailure(answers[failedAt]),
        text: partial.length > 0 ? partial : undefined,
      };
    }

    if (stoppedAt >= 0) {
      const stopping = answers[stoppedAt];
      // A final `stop` may be empty when the text arrived in an earlier part of
      // the same turn; join what the turn actually said before failing.
      const text =
        assistantText(stopping).trim() ||
        answers.map(assistantText).filter((part) => part.trim().length > 0).join("\n\n");
      if (text.trim().length === 0) {
        return {
          status: "failed",
          sessionID,
          delivered,
          delivery,
          error: "empty assistant response",
        };
      }
      return finish(client, sessionID, baseline, text, input.model, delivered, delivery);
    }

    if (Date.now() - boundaryAt > firstOutputMs) {
      let grew = false;
      try {
        const info = await client.session.get({ sessionID });
        const current = info.tokens ? toTokens(info.tokens) : undefined;
        grew = tokenTotal(current) > tokenTotal(baseline.tokens);
      } catch {
        grew = false;
      }
      // Either a fresh assistant message or token growth counts as progress.
      if (!grew && answers.length === 0) {
        return {
          status: "failed",
          sessionID,
          delivered,
          delivery,
          error: `no model output after ${formatWindow(firstOutputMs)}; the message is queued or the provider is silent`,
        };
      }
    }

    await sleep(POLL_MS);
  }

  return {
    status: "failed",
    sessionID,
    delivered,
    delivery,
    error: `follow-up timed out after ${formatWindow(timeoutMs)}; the message may still be queued`,
  };
}

/** Parses `.deus/runs/<runId>/run.json` and finds the session of a step. */
export function resolveTaskSession(
  projectDir: string,
  executionRef: string,
): SessionAddress | undefined {
  const slash = executionRef.indexOf("/");
  if (slash <= 0 || slash === executionRef.length - 1) return undefined;

  const runId = executionRef.slice(0, slash);
  const stepId = executionRef.slice(slash + 1);

  let runDir: string;
  try {
    runDir = runDirFor(projectDir, runId);
  } catch {
    return undefined;
  }
  const file = `${runDir}/run.json`;
  if (!fs.existsSync(file)) return undefined;

  let state: unknown;
  try {
    state = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return undefined;
  }

  if (typeof state !== "object" || state === null) return undefined;
  if ((state as { version?: unknown }).version !== 1) return undefined;

  const rawSteps = (state as { steps?: unknown }).steps;
  const steps: Array<Record<string, unknown>> = Array.isArray(rawSteps)
    ? (rawSteps as Array<Record<string, unknown>>)
    : [];

  // The last match wins: a resumed run may have rerun the same step.
  for (let index = steps.length - 1; index >= 0; index--) {
    const step = steps[index];
    if (step?.stepId !== stepId) continue;
    if (typeof step.sessionID !== "string" || step.sessionID.length === 0) continue;
    return {
      sessionID: step.sessionID,
      runId,
      stepId,
      agent: typeof step.agent === "string" ? step.agent : undefined,
    };
  }

  return undefined;
}

export interface MessageTaskInput {
  taskId: string;
  executionRef: string;
  text: string;
  wait?: boolean;
  timeoutMs?: number;
  firstOutputMs?: number;
  model?: string;
  signal?: AbortSignal;
  /** Optional board: a delivered message is recorded as `task/message`. */
  board?: Board;
  /** Required together with `board`; without it the event is skipped loudly. */
  actor?: string;
}

/** Resolves a board task's session and sends it a message. */
export async function messageTask(
  client: OpenCodeClient,
  projectDir: string,
  input: MessageTaskInput,
): Promise<FollowUpResult> {
  if (input.text.trim().length === 0) {
    return { status: "failed", sessionID: "", error: "message text is empty" };
  }

  const address = resolveTaskSession(projectDir, input.executionRef);
  if (!address) {
    return {
      status: "failed",
      sessionID: "",
      error: `no session found for ${input.executionRef}`,
    };
  }

  const result = await followUp(client, {
    sessionID: address.sessionID,
    text: input.text,
    wait: input.wait,
    timeoutMs: input.timeoutMs,
    firstOutputMs: input.firstOutputMs,
    model: input.model,
    signal: input.signal,
  });

  if (input.board && result.delivered) {
    if (!input.actor) {
      result.boardLogged = false;
      result.boardError = "message delivered, but no actor was given: board event skipped";
    } else {
      try {
        input.board.addMessage(input.taskId, input.actor, input.text);
        result.boardLogged = true;
      } catch (error) {
        // The turn already happened; a board write failure must not lose it.
        result.boardLogged = false;
        result.boardError = `message delivered, but the board event failed: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
    }
  }

  return result;
}
