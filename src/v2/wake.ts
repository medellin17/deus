import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type Database from "better-sqlite3";

import type { OpenCodeClient } from "./client.ts";
import { estimateCost } from "./pricing.ts";
import type { TokenUsage } from "./types.ts";
import { followUp, type SessionAddress } from "./sessions.ts";
import { openStore, openStoreReadonly } from "./store.ts";

export const DEFAULT_DEADLINE_SECONDS = 3_600;
const DEFAULT_LEASE_MS = 60_000;
const MAX_LEASE_MS = 600_000;
const MAX_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 60_000;
const DEFER_MS = 60_000;

export const DEFAULT_MAX_COST = 1;
export const DEFAULT_MAX_STEPS = 20;
export const DEFAULT_MAX_WALL_MS = 1_800_000;
export const DEFAULT_COALESCE_MS = 30_000;
const MAX_BATCH = 10;

export type WakeStatus = "pending" | "delivered" | "failed" | "expired" | "cancelled";
export type WakeEventType = "task/review-ready" | "task/blocked" | "task/rework";

export interface WakeEvent {
  wakeEventId: string;
  dedupKey: string;
  teamId: string;
  boardTaskId?: string;
  eventType: string;
  recipient: SessionAddress;
  payload: unknown;
  status: WakeStatus;
  attempts: number;
  availableAt: string;
  deadlineAt: string;
  batchId?: string;
  costBaseline?: number;
  cost?: number;
  lastError?: string;
  outcome?: string;
  createdAt: string;
  deliveredAt?: string;
}

export interface EnqueueInput {
  dedupKey: string;
  teamId: string;
  boardTaskId?: string;
  eventType: string;
  recipient: SessionAddress;
  payload?: unknown;
  deadlineSeconds?: number;
}

export interface ClaimOptions {
  leaseMs?: number;
  /** Coalesce events for the same recipient created within this window. */
  coalesceMs?: number;
  /** Upper bound on a single batch. */
  limit?: number;
}

export interface Claim {
  events: WakeEvent[];
  claimToken: string;
}

export interface WakeStats {
  pending: number;
  delivered: number;
  failed: number;
  expired: number;
  cancelled: number;
  /** Lifetime reconciled cost; use `costOf` for a specific wave. */
  knownCost: number;
  nextAt?: string;
}

export interface WakeQueue {
  readonly projectDir: string;
  enqueue(input: EnqueueInput): WakeEvent;
  claim(options?: ClaimOptions): Claim | null;
  complete(
    eventIds: string[],
    claimToken: string,
    costBaseline?: number,
    tokensBaseline?: TokenUsage,
  ): void;
  fail(eventIds: string[], claimToken: string, error: string): void;
  /** Releases the claim and retries later without spending an attempt. */
  defer(eventIds: string[], claimToken: string, reason: string, delayMs?: number): void;
  /** Rewrites the recipient of a not-yet-delivered event (e.g. lead registered late). */
  retarget(eventIds: string[], claimToken: string, recipient: SessionAddress): void;
  /** Points every pending event without a recipient at it, making them deliverable now. */
  retargetUnaddressed(recipient: SessionAddress): number;
  /** Fills `cost` once per batch, from the session cost since the baseline. */
  reconcileCosts(client: OpenCodeClient, limit?: number, eventIds?: string[]): Promise<number>;
  /** Sum of reconciled cost for the given events. */
  costOf(eventIds: string[]): number;
  stats(): WakeStats;
  list(filter?: { status?: WakeStatus; limit?: number }): WakeEvent[];
  close(): void;
}

interface WakeRow {
  wake_event_id: string;
  dedup_key: string;
  team_id: string;
  board_task_id: string | null;
  event_type: string;
  recipient_json: string;
  payload_json: string;
  status: WakeStatus;
  attempts: number;
  available_at: string;
  lease_until: string | null;
  claim_token: string | null;
  deadline_at: string;
  batch_id: string | null;
  cost_baseline: number | null;
  tokens_baseline_json: string | null;
  cost: number | null;
  last_error: string | null;
  outcome: string | null;
  created_at: string;
  delivered_at: string | null;
}

export interface WaveOptions {
  /**
   * Soft limit: stops a wave when the reconciled cost of the events it already
   * delivered reaches this value. Never counts spend from earlier waves.
   */
  maxCost?: number;
  /** Hard limit on delivered messages (a coalesced batch is one message). */
  maxSteps?: number;
  /** Hard wall-clock limit for one wave. */
  maxWallMs?: number;
  reconcileLimit?: number;
  coalesceMs?: number;
  signal?: AbortSignal;
  /** Report what would be delivered without sending anything. */
  dryRun?: boolean;
}

export interface WaveResult {
  /** Events marked delivered. */
  delivered: number;
  /** Messages actually accepted by the service. */
  messages: number;
  failed: number;
  expired: number;
  skipped: number;
  /** Reconciled cost of the events this wave delivered. */
  cost: number;
  outcome: "done" | "budget_exhausted" | "disabled" | "aborted";
  pendingLeft: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeId(prefix: string): string {
  return `${prefix}-${crypto.randomBytes(6).toString("hex")}`;
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function toAddress(value: string): SessionAddress {
  const parsed = parseJson<Partial<SessionAddress>>(value, {});
  return {
    sessionID: typeof parsed.sessionID === "string" ? parsed.sessionID : "",
    runId: typeof parsed.runId === "string" ? parsed.runId : undefined,
    stepId: typeof parsed.stepId === "string" ? parsed.stepId : undefined,
    agent: typeof parsed.agent === "string" ? parsed.agent : undefined,
  };
}

function toEvent(row: WakeRow): WakeEvent {
  return {
    wakeEventId: row.wake_event_id,
    dedupKey: row.dedup_key,
    teamId: row.team_id,
    boardTaskId: row.board_task_id ?? undefined,
    eventType: row.event_type,
    recipient: toAddress(row.recipient_json),
    payload: parseJson<unknown>(row.payload_json, {}),
    status: row.status,
    attempts: row.attempts,
    availableAt: row.available_at,
    deadlineAt: row.deadline_at,
    batchId: row.batch_id ?? undefined,
    costBaseline: row.cost_baseline ?? undefined,
    cost: row.cost ?? undefined,
    lastError: row.last_error ?? undefined,
    outcome: row.outcome ?? undefined,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at ?? undefined,
  };
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
  const clamp = (value: number): number => Math.max(0, value);
  return {
    input: clamp(after.input - base.input),
    output: clamp(after.output - base.output),
    reasoning: clamp(after.reasoning - base.reasoning),
    cache: {
      read: clamp(after.cache.read - base.cache.read),
      write: clamp(after.cache.write - base.cache.write),
    },
  };
}

function modelRef(model: { providerID: string; id: string; variant?: string } | undefined): string | undefined {
  if (!model) return undefined;
  return `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`;
}

interface BaselineSnapshot {
  cost: number;
  tokens?: TokenUsage;
}

function backoffMs(attempts: number): number {
  return BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1);
}

export function leadSessionFile(projectDir: string): string {
  return path.join(projectDir, ".deus", "team-lead-session.json");
}

export function readLeadSession(projectDir: string): SessionAddress | undefined {
  const file = leadSessionFile(projectDir);
  if (!fs.existsSync(file)) return undefined;

  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as {
      sessionID?: unknown;
      agent?: unknown;
    };
    if (typeof parsed.sessionID !== "string" || parsed.sessionID.length === 0) return undefined;
    return {
      sessionID: parsed.sessionID,
      agent: typeof parsed.agent === "string" ? parsed.agent : undefined,
    };
  } catch {
    return undefined;
  }
}

/** Records where the team lead answers. Used when a task has no session of its own. */
export function registerLeadSession(
  projectDir: string,
  sessionID: string,
  agent = "main",
): void {
  if (sessionID.trim().length === 0) {
    throw new Error("lead session id must not be empty");
  }
  const dir = path.join(projectDir, ".deus");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    leadSessionFile(projectDir),
    `${JSON.stringify({ agent, sessionID }, null, 2)}\n`,
    "utf-8",
  );
}

/** Kill-switch: `DEUS_WAKE=0` or `.deus/wake.disabled`. */
export function isWakeDisabled(projectDir: string): boolean {
  const env = process.env.DEUS_WAKE;
  if (env === "0" || env === "false" || env === "off") return true;
  return fs.existsSync(path.join(projectDir, ".deus", "wake.disabled"));
}

export interface TransitionWakeInput {
  teamId: string;
  taskId: string;
  attempt: number;
  eventType: WakeEventType;
  /** Defaults to the team lead; a rework goes to the task's own session. */
  recipient?: SessionAddress;
  title: string;
  status: string;
  payload?: Record<string, unknown>;
  deadlineSeconds?: number;
}

/**
 * Writes an outbox row inside the caller's transaction. Called from the board
 * right after the status change, so a crash cannot leave one without the other.
 *
 * The recipient is the team lead: a review-ready task has to reach the one who
 * decides, not the session that just reported it.
 *
 * Must be idempotent: the same attempt of the same task yields one row.
 */
export function enqueueTransitionWake(
  db: Database.Database,
  projectDir: string,
  input: TransitionWakeInput,
): void {
  const recipient = input.recipient ?? readLeadSession(projectDir);
  const note = recipient ? null : "no recipient session";

  const now = nowIso();
  const deadline = new Date(
    Date.now() + (input.deadlineSeconds ?? DEFAULT_DEADLINE_SECONDS) * 1_000,
  ).toISOString();
  const dedupKey = `${input.eventType}:${input.taskId}:${input.attempt}`;

  db.prepare(
    `INSERT INTO wake_events (
       wake_event_id, dedup_key, team_id, board_task_id, event_type, recipient_json,
       payload_json, status, available_at, deadline_at, last_error, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
     ON CONFLICT(dedup_key) DO NOTHING`,
  ).run(
    makeId("wake"),
    dedupKey,
    input.teamId,
    input.taskId,
    input.eventType,
    JSON.stringify(recipient ?? { sessionID: "" }),
    JSON.stringify({ ...input.payload, title: input.title, status: input.status }),
    now,
    deadline,
    note,
    now,
  );
}

/**
 * Cancels not-yet-delivered events of a task. Called from the board inside the
 * same transaction as a transition that makes the wake pointless (accept,
 * rework, retry, cancel): otherwise the lead is woken about a task that is
 * already done.
 */
export function cancelTaskWakes(
  db: Database.Database,
  taskId: string,
  outcome: string,
): void {
  // A live lease means a wave is delivering right now; cancelling it would make
  // that wave lose the claim and deliver the same message again later.
  const now = nowIso();
  db.prepare(
    `UPDATE wake_events
        SET status = 'cancelled', outcome = ?, claim_token = NULL, lease_until = NULL
      WHERE board_task_id = ? AND status = 'pending'
        AND (lease_until IS NULL OR lease_until < ?)`,
  ).run(outcome, taskId, now);
}

class SqliteWake implements WakeQueue {
  constructor(
    private readonly db: Database.Database,
    readonly projectDir: string,
  ) {}

  private write<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }

  enqueue(input: EnqueueInput): WakeEvent {
    const now = nowIso();
    const deadline = new Date(
      Date.now() + (input.deadlineSeconds ?? DEFAULT_DEADLINE_SECONDS) * 1_000,
    ).toISOString();

    return this.write(() => {
      this.db
        .prepare(
          `INSERT INTO wake_events (
             wake_event_id, dedup_key, team_id, board_task_id, event_type, recipient_json,
             payload_json, status, available_at, deadline_at, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
           ON CONFLICT(dedup_key) DO NOTHING`,
        )
        .run(
          makeId("wake"),
          input.dedupKey,
          input.teamId,
          input.boardTaskId ?? null,
          input.eventType,
          JSON.stringify(input.recipient),
          JSON.stringify(input.payload ?? {}),
          now,
          deadline,
          now,
        );

      return toEvent(this.mustRowByDedup(input.dedupKey));
    });
  }

  claim(options: ClaimOptions = {}): Claim | null {
    const lease = Math.min(Math.max(options.leaseMs ?? DEFAULT_LEASE_MS, 1_000), MAX_LEASE_MS);
    const coalesceMs = Math.max(0, options.coalesceMs ?? 0);
    const limit = Math.max(1, Math.min(options.limit ?? MAX_BATCH, MAX_BATCH));

    return this.write(() => {
      const now = nowIso();
      // A task may be closed (accepted or cancelled) between enqueue and the
      // wave, for example by the lead while the event sat in backoff. Waking
      // someone about it would ask for a decision that is already made.
      this.db
        .prepare(
          `UPDATE wake_events
              SET status = 'cancelled', outcome = 'task closed',
                  claim_token = NULL, lease_until = NULL
            WHERE status = 'pending' AND board_task_id IS NOT NULL
              AND (lease_until IS NULL OR lease_until < ?)
              AND board_task_id IN (
                SELECT board_task_id FROM board_tasks
                 WHERE status IN ('done', 'cancelled')
              )`,
        )
        .run(now);

      // Overdue events are closed instead of delivered late. An event that is
      // being delivered right now has a live lease and is left alone.
      this.db
        .prepare(
          `UPDATE wake_events
              SET status = 'expired', outcome = 'deadline', claim_token = NULL,
                  lease_until = NULL, last_error = 'deadline passed'
            WHERE status = 'pending' AND deadline_at <= ?
              AND (lease_until IS NULL OR lease_until < ?)`,
        )
        .run(now, now);

      const first = this.db
        .prepare(
          `SELECT * FROM wake_events
            WHERE status = 'pending' AND available_at <= ?
              AND (lease_until IS NULL OR lease_until < ?)
            ORDER BY created_at ASC, wake_event_id ASC
            LIMIT 1`,
        )
        .get(now, now) as WakeRow | undefined;
      if (!first) return null;

      const claimToken = `wake:${crypto.randomBytes(4).toString("hex")}`;
      const leaseUntil = new Date(Date.now() + lease).toISOString();
      const claimed = this.db
        .prepare(
          `UPDATE wake_events
              SET claim_token = ?, lease_until = ?
            WHERE wake_event_id = ? AND status = 'pending'
              AND (lease_until IS NULL OR lease_until < ?)`,
        )
        .run(claimToken, leaseUntil, first.wake_event_id, now);
      if (claimed.changes !== 1) return null;

      const events = [toEvent(this.mustRow(first.wake_event_id))];

      if (coalesceMs > 0 && limit > 1) {
        // Both bounds matter: without the upper one an hour-old event joins a
        // fresh batch and the "30 s window" is a lie.
        const since = new Date(Date.parse(first.created_at) - coalesceMs).toISOString();
        const until = new Date(Date.parse(first.created_at) + coalesceMs).toISOString();
        const firstSession = toAddress(first.recipient_json).sessionID;
        const candidates = this.db
          .prepare(
            `SELECT * FROM wake_events
              WHERE status = 'pending' AND available_at <= ?
                AND (lease_until IS NULL OR lease_until < ?)
                AND wake_event_id != ? AND created_at >= ? AND created_at <= ?
              ORDER BY created_at ASC, wake_event_id ASC
              LIMIT ?`,
          )
          .all(now, now, first.wake_event_id, since, until, limit - 1) as WakeRow[];

        for (const candidate of candidates) {
          if (toAddress(candidate.recipient_json).sessionID !== firstSession) continue;
          const row = this.db
            .prepare(
              `UPDATE wake_events
                  SET claim_token = ?, lease_until = ?
                WHERE wake_event_id = ? AND status = 'pending'
                  AND (lease_until IS NULL OR lease_until < ?)`,
            )
            .run(claimToken, leaseUntil, candidate.wake_event_id, now);
          if (row.changes === 1) events.push(toEvent(this.mustRow(candidate.wake_event_id)));
        }
      }

      return { events, claimToken };
    });
  }

  complete(
    eventIds: string[],
    claimToken: string,
    costBaseline?: number,
    tokensBaseline?: TokenUsage,
  ): void {
    this.write(() => {
      const now = nowIso();
      // One batch id per message: the cost of a coalesced message is counted
      // once, not once per event.
      const batchId = makeId("wbatch");
      for (const eventId of eventIds) {
        const updated = this.db
          .prepare(
            `UPDATE wake_events
                SET status = 'delivered', delivered_at = ?, claim_token = NULL,
                    lease_until = NULL, batch_id = ?, cost_baseline = ?,
                    tokens_baseline_json = ?, last_error = NULL
              WHERE wake_event_id = ? AND claim_token = ?`,
          )
          .run(
            now,
            batchId,
            costBaseline ?? null,
            tokensBaseline ? JSON.stringify(tokensBaseline) : null,
            eventId,
            claimToken,
          );
        if (updated.changes !== 1) {
          throw new Error(`wake: claim token does not own ${eventId}`);
        }

        const row = this.mustRow(eventId);
        if (row.board_task_id) {
          const eventIdNew = makeId("evt");
          this.db
            .prepare(
              `INSERT INTO board_events
                 (event_id, team_id, board_task_id, event_type, actor, payload_json, created_at)
               VALUES (?, ?, ?, 'task/wake-delivered', 'wake', '{}', ?)`,
            )
            .run(eventIdNew, row.team_id, row.board_task_id, now);
          this.db
            .prepare(`UPDATE board_tasks SET last_event_id = ? WHERE board_task_id = ?`)
            .run(eventIdNew, row.board_task_id);
        }
      }
    });
  }

  fail(eventIds: string[], claimToken: string, error: string): void {
    this.write(() => {
      for (const eventId of eventIds) {
        const row = this.db
          .prepare(
            `SELECT * FROM wake_events WHERE wake_event_id = ? AND claim_token = ?`,
          )
          .get(eventId, claimToken) as WakeRow | undefined;
        if (!row) throw new Error(`wake: claim token does not own ${eventId}`);

        const attempts = row.attempts + 1;
        const exhausted = attempts >= MAX_ATTEMPTS;
        const availableAt = exhausted
          ? row.available_at
          : new Date(Date.now() + backoffMs(attempts)).toISOString();

        this.db
          .prepare(
            `UPDATE wake_events
                SET attempts = ?, status = ?, available_at = ?, claim_token = NULL,
                    lease_until = NULL, last_error = ?, outcome = ?
              WHERE wake_event_id = ?`,
          )
          .run(
            attempts,
            exhausted ? "failed" : "pending",
            availableAt,
            error,
            exhausted ? "retries_exhausted" : null,
            eventId,
          );
      }
    });
  }

  defer(eventIds: string[], claimToken: string, reason: string, delayMs = DEFER_MS): void {
    this.write(() => {
      const availableAt = new Date(Date.now() + Math.max(1_000, delayMs)).toISOString();
      for (const eventId of eventIds) {
        const updated = this.db
          .prepare(
            `UPDATE wake_events
                SET claim_token = NULL, lease_until = NULL, available_at = ?, last_error = ?
              WHERE wake_event_id = ? AND claim_token = ? AND status = 'pending'`,
          )
          .run(availableAt, reason, eventId, claimToken);
        if (updated.changes !== 1) {
          throw new Error(`wake: claim token does not own ${eventId}`);
        }
      }
    });
  }

  retarget(eventIds: string[], claimToken: string, recipient: SessionAddress): void {
    this.write(() => {
      for (const eventId of eventIds) {
        // Keep the claim: the caller is about to deliver with this token.
        const updated = this.db
          .prepare(
            `UPDATE wake_events
                SET recipient_json = ?, last_error = NULL
              WHERE wake_event_id = ? AND claim_token = ? AND status = 'pending'`,
          )
          .run(JSON.stringify(recipient), eventId, claimToken);
        if (updated.changes !== 1) {
          throw new Error(`wake: claim token does not own ${eventId}`);
        }
      }
    });
  }

  retargetUnaddressed(recipient: SessionAddress): number {
    if (!recipient.sessionID) return 0;
    return this.write(() => {
      const now = nowIso();
      const updated = this.db
        .prepare(
          `UPDATE wake_events
              SET recipient_json = ?, last_error = NULL,
                  available_at = CASE WHEN available_at > ? THEN ? ELSE available_at END
            WHERE status = 'pending'
              AND json_extract(recipient_json, '$.sessionID') = ''`,
        )
        .run(JSON.stringify(recipient), now, now);
      return updated.changes;
    });
  }

  async reconcileCosts(client: OpenCodeClient, limit = 20, eventIds?: string[]): Promise<number> {
    const params: unknown[] = [];
    let scope = "";
    if (eventIds !== undefined) {
      if (eventIds.length === 0) return 0;
      scope = ` AND wake_event_id IN (${eventIds.map(() => "?").join(",")})`;
      params.push(...eventIds);
    }

    const groups = this.db
      .prepare(
        `SELECT COALESCE(w.batch_id, w.wake_event_id) AS grp,
                MIN(w.wake_event_id) AS first_id,
                MIN(w.cost_baseline) AS baseline,
                MIN(w.tokens_baseline_json) AS tokens_baseline,
                MIN(w.recipient_json) AS recipient
           FROM wake_events w
          WHERE w.status = 'delivered' AND w.cost IS NULL AND w.cost_baseline IS NOT NULL${scope}
            AND NOT EXISTS (
              SELECT 1 FROM wake_events x
               WHERE COALESCE(x.batch_id, x.wake_event_id) = COALESCE(w.batch_id, w.wake_event_id)
                 AND x.cost IS NOT NULL
            )
          GROUP BY grp
          LIMIT ?`,
      )
      .all(...params, Math.max(0, Math.trunc(limit))) as Array<{
      grp: string;
      first_id: string;
      baseline: number;
      tokens_baseline: string | null;
      recipient: string;
    }>;

    let reconciled = 0;
    for (const group of groups) {
      const sessionID = toAddress(group.recipient).sessionID;
      if (!sessionID) continue;

      try {
        const info = await client.session.get({ sessionID });
        let delta = Math.max(0, (info.cost ?? 0) - group.baseline);

        if (delta <= 0) {
          // Some providers report cost 0 even for a paid model. Token growth is
          // still real, so price the delta with the session's own model.
          const before = group.tokens_baseline
            ? (JSON.parse(group.tokens_baseline) as TokenUsage)
            : undefined;
          const grown = deltaTokens(info.tokens ? toTokens(info.tokens) : undefined, before);
          const model = modelRef(info.model);
          if (model && tokenTotal(grown) > 0 && grown) {
            delta = estimateCost(model, grown);
          }
        }

        // Nothing spent yet (the message may still be queued): leave the cost
        // unknown so a later pass can see the real spend instead of freezing 0.
        if (delta <= 0) continue;

        const updated = this.db
          .prepare(
            `UPDATE wake_events SET cost = ?
              WHERE wake_event_id = ? AND cost IS NULL`,
          )
          .run(delta, group.first_id);
        if (updated.changes === 1) reconciled++;
      } catch {
        // Session gone or unreadable: leave the cost unknown rather than invent it.
      }
    }

    return reconciled;
  }

  costOf(eventIds: string[]): number {
    if (eventIds.length === 0) return 0;
    const placeholders = eventIds.map(() => "?").join(",");
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(cost), 0) AS total FROM wake_events
          WHERE wake_event_id IN (${placeholders})`,
      )
      .get(...eventIds) as { total: number };
    return row.total;
  }

  stats(): WakeStats {
    const rows = this.db
      .prepare(`SELECT status, COUNT(*) AS total FROM wake_events GROUP BY status`)
      .all() as Array<{ status: WakeStatus; total: number }>;
    const counts = new Map(rows.map((row) => [row.status, row.total]));

    const cost = this.db
      .prepare(`SELECT COALESCE(SUM(cost), 0) AS total FROM wake_events`)
      .get() as { total: number };
    const next = this.db
      .prepare(`SELECT MIN(available_at) AS at FROM wake_events WHERE status = 'pending'`)
      .get() as { at: string | null };

    return {
      pending: counts.get("pending") ?? 0,
      delivered: counts.get("delivered") ?? 0,
      failed: counts.get("failed") ?? 0,
      expired: counts.get("expired") ?? 0,
      cancelled: counts.get("cancelled") ?? 0,
      knownCost: cost.total,
      nextAt: next.at ?? undefined,
    };
  }

  list(filter: { status?: WakeStatus; limit?: number } = {}): WakeEvent[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filter.status !== undefined) {
      conditions.push("status = ?");
      params.push(filter.status);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const requested = filter.limit ?? 100;
    const limit = Number.isFinite(requested) ? Math.max(0, Math.trunc(requested)) : 100;

    const rows = this.db
      .prepare(`SELECT * FROM wake_events ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...params, limit) as WakeRow[];
    return rows.map(toEvent);
  }

  close(): void {
    this.db.close();
  }

  private mustRow(wakeEventId: string): WakeRow {
    const row = this.db
      .prepare(`SELECT * FROM wake_events WHERE wake_event_id = ?`)
      .get(wakeEventId) as WakeRow | undefined;
    if (!row) throw new Error(`wake: event not found: ${wakeEventId}`);
    return row;
  }

  private mustRowByDedup(dedupKey: string): WakeRow {
    const row = this.db
      .prepare(`SELECT * FROM wake_events WHERE dedup_key = ?`)
      .get(dedupKey) as WakeRow | undefined;
    if (!row) throw new Error(`wake: event not found for ${dedupKey}`);
    return row;
  }
}

export function openWake(projectDir: string): WakeQueue {
  return new SqliteWake(openStore(projectDir), projectDir);
}

/**
 * Opens an existing outbox without creating or migrating anything. A board
 * created before wake existed simply has no outbox yet; report that instead of
 * a raw `no such table`.
 */
export function openWakeReadonly(projectDir: string): WakeQueue | undefined {
  const db = openStoreReadonly(projectDir);
  if (!db) return undefined;

  const table = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'wake_events'`)
    .get() as { name: string } | undefined;
  if (!table) {
    db.close();
    return undefined;
  }
  return new SqliteWake(db, projectDir);
}

function payloadField(payload: unknown, key: string): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function renderWake(events: WakeEvent[]): string {
  const lines = [
    `[deus] ${events.length === 1 ? "a task needs you" : `${events.length} tasks need you`}`,
  ];
  for (const event of events) {
    const title = payloadField(event.payload, "title") ?? event.boardTaskId ?? "untitled";
    const status = payloadField(event.payload, "status");
    const summary = payloadField(event.payload, "summary");
    const note = payloadField(event.payload, "note");
    const verification = event.payload as { verification?: { status?: string } } | undefined;
    const gate = verification?.verification?.status;

    const details = [
      status ? `status: ${status}` : undefined,
      gate ? `gate: ${gate}` : undefined,
      summary ? `summary: ${summary}` : undefined,
      note ? `note: ${note}` : undefined,
    ].filter(Boolean);

    lines.push(`- ${event.eventType} ${event.boardTaskId ?? "-"} "${title}"`);
    if (details.length > 0) lines.push(`  ${details.join(", ")}`);
  }
  const types = new Set(events.map((event) => event.eventType));
  const footer =
    types.size === 1 && events[0].eventType === "task/rework"
      ? "Do the requested work, then submit it again."
      : types.size === 1 && events[0].eventType === "task/blocked"
        ? "Decide how to unblock: retry | cancel."
        : "Reply with a decision (accept | rework | retry).";

  lines.push("", footer);
  return lines.join("\n");
}

async function sessionBaseline(
  client: OpenCodeClient,
  sessionID: string,
): Promise<BaselineSnapshot | undefined> {
  try {
    const info = await client.session.get({ sessionID });
    return {
      cost: info.cost ?? 0,
      tokens: info.tokens ? toTokens(info.tokens) : undefined,
    };
  } catch {
    return undefined;
  }
}

/**
 * Delivers one wave of pending events. Messages are only queued (`wait:false`),
 * so the wave never blocks on an agent's turn.
 *
 * Hard limits: delivered messages and wall-clock. `maxCost` is soft and scoped
 * to this wave: only the reconciled cost of the events this wave delivered
 * counts, so lifetime spend can never lock the queue.
 */
export async function runWave(
  client: OpenCodeClient,
  queue: WakeQueue,
  options: WaveOptions = {},
): Promise<WaveResult> {
  const maxCost = options.maxCost ?? DEFAULT_MAX_COST;
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const maxWallMs = options.maxWallMs ?? DEFAULT_MAX_WALL_MS;
  const coalesceMs = options.coalesceMs ?? DEFAULT_COALESCE_MS;
  const started = Date.now();
  const expiredBefore = queue.stats().expired;

  const result: WaveResult = {
    delivered: 0,
    messages: 0,
    failed: 0,
    expired: 0,
    skipped: 0,
    cost: 0,
    outcome: "done",
    pendingLeft: 0,
  };

  if (options.dryRun) {
    result.skipped = queue.list({ status: "pending", limit: maxSteps }).length;
    result.pendingLeft = queue.stats().pending;
    return result;
  }

  if (isWakeDisabled(queue.projectDir)) {
    result.outcome = "disabled";
    result.pendingLeft = queue.stats().pending;
    return result;
  }

  const deliveredIds: string[] = [];
  let waveCost = 0;

  // A lead registered after the events were written must not wait for the
  // defer delay.
  const knownLead = readLeadSession(queue.projectDir);
  if (knownLead) queue.retargetUnaddressed(knownLead);

  let iterations = 0;
  while (true) {
    // Safety net: every branch must either deliver, fail, or advance a retry
    // time. This guards against a future change that makes one of them a no-op.
    if (++iterations > 10_000) {
      result.outcome = "aborted";
      break;
    }
    if (isWakeDisabled(queue.projectDir)) {
      result.outcome = "disabled";
      break;
    }
    if (options.signal?.aborted) {
      result.outcome = "aborted";
      break;
    }

    // Reconcile only the events this wave delivered: their turns may already
    // have answered, and their cost belongs to this wave's soft budget.
    if (deliveredIds.length > 0) {
      await queue.reconcileCosts(client, deliveredIds.length, deliveredIds);
      waveCost = queue.costOf(deliveredIds);
    }

    if (result.messages >= maxSteps || Date.now() - started >= maxWallMs) {
      result.outcome = queue.stats().pending > 0 ? "budget_exhausted" : "done";
      break;
    }
    if (waveCost >= maxCost) {
      result.outcome = queue.stats().pending > 0 ? "budget_exhausted" : "done";
      break;
    }

    const claim = queue.claim({ coalesceMs });
    if (!claim) break;

    const ids = claim.events.map((event) => event.wakeEventId);
    let address = claim.events[0].recipient;

    if (!address.sessionID) {
      const lead = readLeadSession(queue.projectDir);
      if (!lead) {
        // Not a delivery failure: the lead was not registered yet. Keep the
        // event pending and visible instead of burning its attempts.
        try {
          queue.defer(ids, claim.claimToken, "no recipient session; run --wake-register");
        } catch {
          // A concurrent cancel: nothing left to defer.
        }
        result.skipped += ids.length;
        continue;
      }
      try {
        queue.retarget(ids, claim.claimToken, lead);
      } catch {
        // A concurrent cancel or a lease takeover: not ours to deliver anymore.
        result.skipped += ids.length;
        continue;
      }
      address = lead;
    }

    const baseline = await sessionBaseline(client, address.sessionID);
    let delivered = false;
    let error: string | undefined;

    try {
      const response = await followUp(client, {
        sessionID: address.sessionID,
        text: renderWake(claim.events),
        wait: false,
        signal: options.signal,
      });
      delivered = response.delivered === true;
      error = response.error;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }

    // A lost lease (slow delivery) must not kill the wave: the message may have
    // been delivered, and the other wave owns the accounting.
    if (delivered) {
      // The message left the building even if the lease was taken over; count
      // it, but do not claim ownership of events we no longer hold.
      result.messages += 1;
      try {
        queue.complete(ids, claim.claimToken, baseline?.cost, baseline?.tokens);
        result.delivered += ids.length;
        deliveredIds.push(...ids);
      } catch {
        result.skipped += ids.length;
      }
    } else {
      try {
        queue.fail(ids, claim.claimToken, error ?? "message was not accepted");
        result.failed += ids.length;
      } catch {
        result.skipped += ids.length;
      }
    }
  }

  if (deliveredIds.length > 0) {
    await queue.reconcileCosts(client, deliveredIds.length, deliveredIds);
    waveCost = queue.costOf(deliveredIds);
  }

  const stats = queue.stats();
  result.expired = Math.max(0, stats.expired - expiredBefore);
  result.pendingLeft = stats.pending;
  result.cost = waveCost;
  return result;
}
