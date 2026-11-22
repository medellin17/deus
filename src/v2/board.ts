import crypto from "node:crypto";

import type Database from "better-sqlite3";

import { resolveTaskSession } from "./sessions.ts";
import { openStore, openStoreReadonly } from "./store.ts";
import { enqueueTransitionWake, cancelTaskWakes } from "./wake.ts";

const DEFAULT_LEASE_MS = 120_000;
const MAX_LEASE_MS = 600_000;
const DEFAULT_TASK_RETENTION_DAYS = 30;
const DEFAULT_EVENT_RETENTION_DAYS = 90;

export type BoardStatus =
  | "backlog"
  | "claimed"
  | "running"
  | "review"
  | "done"
  | "blocked"
  | "cancelled";

export type TeamStatus = "active" | "done" | "archived";

export type BoardErrorCode =
  | "not_found"
  | "not_owner"
  | "invalid_transition"
  | "dependency_not_done"
  | "verification_required"
  | "team_closed"
  | "team_exists"
  | "execution_taken";

export class BoardError extends Error {
  constructor(
    readonly code: BoardErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BoardError";
  }
}

export interface Verification {
  /**
   * The board does not run checks itself: the caller submits the outcome of
   * `gate.ts`. `accept` only trusts `status`, so the caller is responsible for
   * writing it from a real gate result.
   */
  status: "passed" | "failed" | "skipped";
  /** Free-form evidence, e.g. the gate result. */
  checks?: unknown;
}

export interface Team {
  teamId: string;
  name: string;
  goal: string;
  leadAgent: string;
  status: TeamStatus;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
}

export interface BoardTask {
  boardTaskId: string;
  teamId: string;
  title: string;
  goal: string;
  doneWhen: string;
  assignee?: string;
  workspace?: string;
  status: BoardStatus;
  priority: number;
  dependsOn: string[];
  executionRef?: string;
  resultSummary?: string;
  blockedReason?: string;
  artifacts: string[];
  verification?: Verification;
  createdBy: string;
  attempt: number;
  createdAt: string;
  updatedAt: string;
  claimedAt?: string;
  leaseUntil?: string;
  finishedAt?: string;
  lastEventId?: string;
}

export interface BoardEvent {
  id: number;
  eventId: string;
  teamId: string;
  boardTaskId?: string;
  type: string;
  actor: string;
  payload: unknown;
  createdAt: string;
}

export interface Claim {
  taskId: string;
  claimToken: string;
  leaseUntil: string;
  attempt: number;
}

export interface CreateTaskInput {
  teamId: string;
  title: string;
  goal: string;
  doneWhen?: string;
  assignee?: string;
  workspace?: string;
  dependsOn?: string[];
  priority?: number;
  actor: string;
}

export interface SubmitResult {
  summary: string;
  artifacts?: string[];
}

export interface Board {
  getTeam(teamId: string): Team | undefined;
  getTeamByName(name: string): Team | undefined;
  listTeams(): Team[];
  createTeam(input: { name: string; goal: string; leadAgent: string }): Team;
  /** Closes a team; every task must already be terminal. */
  closeTeam(teamId: string, actor: string): Team;

  getTask(taskId: string): BoardTask | undefined;
  createTask(input: CreateTaskInput): BoardTask;

  claim(taskId: string, actor: string, leaseMs?: number): Claim | null;
  release(taskId: string, claimToken: string): void;
  start(taskId: string, claimToken: string, executionRef: string): void;
  submit(
    taskId: string,
    claimToken: string,
    verification: Verification,
    result: SubmitResult,
  ): void;
  accept(taskId: string, actor: string): void;
  /** Returns a task for rework; the note is delivered to the task's session. */
  rework(taskId: string, actor: string, note?: string): void;
  block(taskId: string, actor: string, reason: string, claimToken?: string): void;
  retry(taskId: string, actor: string): void;
  cancel(taskId: string, actor: string, claimToken?: string): void;
  /** Appends a comment event; allowed on terminal tasks, never changes status. */
  addMessage(taskId: string, actor: string, text: string): void;

  list(filter?: { teamId?: string; status?: BoardStatus; limit?: number }): BoardTask[];
  events(filter?: {
    teamId?: string;
    taskId?: string;
    limit?: number;
    order?: "asc" | "desc";
  }): BoardEvent[];
  prune(options?: { taskDays?: number; eventDays?: number }): {
    tasks: number;
    events: number;
    wakes: number;
  };
  close(): void;
}

interface TeamRow {
  team_id: string;
  name: string;
  goal: string;
  lead_agent: string;
  status: TeamStatus;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

interface TaskRow {
  board_task_id: string;
  team_id: string;
  title: string;
  goal: string;
  done_when: string;
  assignee: string | null;
  workspace: string | null;
  status: BoardStatus;
  priority: number;
  depends_on_json: string;
  execution_ref: string | null;
  result_summary: string | null;
  blocked_reason: string | null;
  artifacts_json: string;
  verification_json: string | null;
  created_by: string;
  claim_token: string | null;
  lease_until: string | null;
  attempt: number;
  created_at: string;
  updated_at: string;
  claimed_at: string | null;
  finished_at: string | null;
  last_event_id: string | null;
}

interface EventRow {
  id: number;
  event_id: string;
  team_id: string;
  board_task_id: string | null;
  event_type: string;
  actor: string;
  payload_json: string;
  created_at: string;
}

function makeId(prefix: string): string {
  return `${prefix}-${crypto.randomBytes(6).toString("hex")}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function actorOf(token: string): string {
  const colon = token.indexOf(":");
  return colon === -1 ? token : token.slice(0, colon);
}

function toTeam(row: TeamRow): Team {
  return {
    teamId: row.team_id,
    name: row.name,
    goal: row.goal,
    leadAgent: row.lead_agent,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at ?? undefined,
  };
}

function toTask(row: TaskRow): BoardTask {
  return {
    boardTaskId: row.board_task_id,
    teamId: row.team_id,
    title: row.title,
    goal: row.goal,
    doneWhen: row.done_when,
    assignee: row.assignee ?? undefined,
    workspace: row.workspace ?? undefined,
    status: row.status,
    priority: row.priority,
    dependsOn: parseJson<string[]>(row.depends_on_json, []),
    executionRef: row.execution_ref ?? undefined,
    resultSummary: row.result_summary ?? undefined,
    blockedReason: row.blocked_reason ?? undefined,
    artifacts: parseJson<string[]>(row.artifacts_json, []),
    verification: row.verification_json
      ? parseJson<Verification | undefined>(row.verification_json, undefined)
      : undefined,
    createdBy: row.created_by,
    attempt: row.attempt,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    claimedAt: row.claimed_at ?? undefined,
    leaseUntil: row.lease_until ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    lastEventId: row.last_event_id ?? undefined,
  };
}

function toEvent(row: EventRow): BoardEvent {
  return {
    id: row.id,
    eventId: row.event_id,
    teamId: row.team_id,
    boardTaskId: row.board_task_id ?? undefined,
    type: row.event_type,
    actor: row.actor,
    payload: parseJson<unknown>(row.payload_json, {}),
    createdAt: row.created_at,
  };
}

function ensureMainTeam(db: Database.Database): void {
  const existing = db
    .prepare(`SELECT team_id FROM teams WHERE name = 'main' AND status = 'active'`)
    .get() as { team_id: string } | undefined;
  if (existing) return;

  const now = nowIso();
  db.prepare(
    `INSERT OR IGNORE INTO teams (team_id, name, goal, lead_agent, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?)`,
  ).run(makeId("team"), "main", "default project team", "main", now, now);
}

class SqliteBoard implements Board {
  constructor(
    private readonly db: Database.Database,
    private readonly projectDir: string,
  ) {}

  /**
   * Every state change runs as BEGIN IMMEDIATE. A deferred transaction reads a
   * snapshot and only then upgrades to a write lock; with WAL and several
   * processes that upgrade can fail with SQLITE_BUSY_SNAPSHOT, and a busy
   * timeout cannot refresh a stale snapshot. Taking the write lock upfront
   * turns contention into a wait instead of an exception.
   */
  private write<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }

  close(): void {
    this.db.close();
  }

  getTeam(teamId: string): Team | undefined {
    const row = this.db.prepare(`SELECT * FROM teams WHERE team_id = ?`).get(teamId) as
      | TeamRow
      | undefined;
    return row ? toTeam(row) : undefined;
  }

  listTeams(): Team[] {
    const rows = this.db
      .prepare(`SELECT * FROM teams ORDER BY created_at ASC`)
      .all() as TeamRow[];
    return rows.map(toTeam);
  }

  getTeamByName(name: string): Team | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM teams WHERE name = ? AND status != 'archived'
          ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, created_at DESC
          LIMIT 1`,
      )
      .get(name) as TeamRow | undefined;
    return row ? toTeam(row) : undefined;
  }

  closeTeam(teamId: string, actor: string): Team {
    return this.write(() => {
      const team = this.getTeam(teamId);
      if (!team) throw new BoardError("not_found", `team not found: ${teamId}`);
      if (team.status !== "active") {
        throw new BoardError(
          "invalid_transition",
          `team is already ${team.status}: ${teamId}`,
        );
      }

      const open = this.db
        .prepare(
          `SELECT COUNT(*) AS total FROM board_tasks
            WHERE team_id = ? AND status NOT IN ('done', 'cancelled')`,
        )
        .get(teamId) as { total: number };
      if (open.total > 0) {
        throw new BoardError(
          "invalid_transition",
          `team has ${open.total} non-terminal task(s)`,
        );
      }

      const now = nowIso();
      this.db
        .prepare(
          `UPDATE teams SET status = 'done', closed_at = ?, updated_at = ? WHERE team_id = ?`,
        )
        .run(now, now, teamId);
      this.recordEvent(teamId, null, "team/closed", actor, {});
      return this.getTeam(teamId) as Team;
    });
  }

  createTeam(input: { name: string; goal: string; leadAgent: string }): Team {
    if (input.name.trim().length === 0) {
      throw new BoardError("invalid_transition", "team name must not be empty");
    }

    return this.write(() => {
      const teamId = makeId("team");
      const now = nowIso();
      try {
        this.db
          .prepare(
            `INSERT INTO teams (team_id, name, goal, lead_agent, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'active', ?, ?)`,
          )
          .run(teamId, input.name, input.goal, input.leadAgent, now, now);
      } catch (error) {
        if ((error as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") {
          throw new BoardError("team_exists", `team already exists: ${input.name}`);
        }
        throw error;
      }
      this.recordEvent(teamId, null, "team/created", input.leadAgent, {
        name: input.name,
      });
      return this.getTeam(teamId) as Team;
    });
  }

  getTask(taskId: string): BoardTask | undefined {
    const row = this.mustTaskRow(taskId, false);
    return row ? toTask(row) : undefined;
  }

  createTask(input: CreateTaskInput): BoardTask {
    return this.write(() => {
      this.assertTeamActive(input.teamId);
      for (const dependency of input.dependsOn ?? []) {
        const dependent = this.mustTaskRow(dependency, false);
        if (!dependent) {
          throw new BoardError("not_found", `dependency not found: ${dependency}`);
        }
        if (dependent.team_id !== input.teamId) {
          throw new BoardError(
            "invalid_transition",
            `dependency belongs to another team: ${dependency}`,
          );
        }
      }

      const taskId = makeId("bt");
      const now = nowIso();
      this.db
        .prepare(
          `INSERT INTO board_tasks (
             board_task_id, team_id, title, goal, done_when, assignee, workspace,
             status, priority, depends_on_json, created_by, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'backlog', ?, ?, ?, ?, ?)`,
        )
        .run(
          taskId,
          input.teamId,
          input.title,
          input.goal,
          input.doneWhen ?? "",
          input.assignee ?? null,
          input.workspace ?? null,
          input.priority ?? 0,
          JSON.stringify(input.dependsOn ?? []),
          input.actor,
          now,
          now,
        );
      this.recordEvent(input.teamId, taskId, "task/created", input.actor, {
        title: input.title,
      });
      return this.getTask(taskId) as BoardTask;
    });
  }

  claim(taskId: string, actor: string, leaseMs = DEFAULT_LEASE_MS): Claim | null {
    const lease = Math.min(Math.max(leaseMs, 1_000), MAX_LEASE_MS);

    return this.write(() => {
      const row = this.mustTaskRow(taskId);
      this.assertTeamActive(row.team_id);

      const now = nowIso();
      const reclaim =
        row.status === "claimed" &&
        row.lease_until !== null &&
        row.lease_until < now;

      if (row.status !== "backlog" && !reclaim) {
        if (row.status === "claimed") return null; // held by someone else
        throw new BoardError(
          "invalid_transition",
          `cannot claim a task in status ${row.status}`,
        );
      }

      for (const dependency of parseJson<string[]>(row.depends_on_json, [])) {
        const dependent = this.mustTaskRow(dependency, false);
        if (!dependent || dependent.status !== "done") {
          throw new BoardError(
            "dependency_not_done",
            `dependency is not done: ${dependency}`,
          );
        }
      }

      const claimToken = `${actor}:${crypto.randomBytes(4).toString("hex")}`;
      const leaseUntil = new Date(Date.now() + lease).toISOString();
      // On a reclaim the new owner must replace the old one everywhere a human
      // reads it; keeping the previous assignee would mislabel the holder.
      const nextAssignee = reclaim ? actor : (row.assignee ?? actor);
      const nextClaimedAt = reclaim ? now : (row.claimed_at ?? now);
      const updated = this.db
        .prepare(
          `UPDATE board_tasks
              SET status = 'claimed',
                  assignee = ?,
                  claim_token = ?,
                  lease_until = ?,
                  claimed_at = ?,
                  attempt = attempt + ?,
                  updated_at = ?
            WHERE board_task_id = ?
              AND (status = 'backlog'
                   OR (status = 'claimed' AND lease_until IS NOT NULL AND lease_until < ?))`,
        )
        .run(
          nextAssignee,
          claimToken,
          leaseUntil,
          nextClaimedAt,
          reclaim ? 1 : 0,
          now,
          taskId,
          now,
        );

      if (updated.changes !== 1) return null;

      this.recordEvent(
        row.team_id,
        taskId,
        reclaim ? "task/reclaimed" : "task/claimed",
        actor,
        { leaseUntil },
      );
      return {
        taskId,
        claimToken,
        leaseUntil,
        attempt: row.attempt + (reclaim ? 1 : 0),
      };
    });
  }

  release(taskId: string, claimToken: string): void {
    this.write(() => {
      const row = this.ownedRow(taskId, claimToken, ["claimed"]);
      this.assertTeamActive(row.team_id);
      this.setBacklog(row, "task/released", actorOf(claimToken), {});
    });
  }

  start(taskId: string, claimToken: string, executionRef: string): void {
    this.write(() => {
      const row = this.ownedRow(taskId, claimToken, ["claimed"]);
      this.assertTeamActive(row.team_id);
      const now = nowIso();
      try {
        this.db
          .prepare(
            `UPDATE board_tasks
                SET status = 'running', execution_ref = ?, lease_until = NULL, updated_at = ?
              WHERE board_task_id = ?`,
          )
          .run(executionRef, now, taskId);
      } catch (error) {
        if ((error as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") {
          throw new BoardError(
            "execution_taken",
            `execution reference is already attached: ${executionRef}`,
          );
        }
        throw error;
      }
      this.recordEvent(row.team_id, taskId, "task/started", actorOf(claimToken), {
        executionRef,
      });
    });
  }

  submit(
    taskId: string,
    claimToken: string,
    verification: Verification,
    result: SubmitResult,
  ): void {
    this.write(() => {
      const row = this.ownedRow(taskId, claimToken, ["running"]);
      this.assertTeamActive(row.team_id);
      const now = nowIso();
      this.db
        .prepare(
          `UPDATE board_tasks
              SET status = 'review',
                  verification_json = ?,
                  result_summary = ?,
                  artifacts_json = ?,
                  updated_at = ?
            WHERE board_task_id = ?`,
        )
        .run(
          JSON.stringify(verification),
          result.summary,
          JSON.stringify(result.artifacts ?? []),
          now,
          taskId,
        );
      this.recordEvent(row.team_id, taskId, "task/submitted", actorOf(claimToken), {
        verification,
      });
      // Same transaction as the status change: a review result must wake
      // someone even if the process dies right after submit.
      enqueueTransitionWake(this.db, this.projectDir, {
        teamId: row.team_id,
        taskId,
        attempt: row.attempt,
        eventType: "task/review-ready",
        title: row.title,
        status: "review",
        payload: { verification, summary: result.summary },
      });
    });
  }

  accept(taskId: string, actor: string): void {
    this.write(() => {
      const row = this.mustTaskRow(taskId);
      this.assertTeamActive(row.team_id);
      if (row.status !== "review") {
        throw new BoardError(
          "invalid_transition",
          `cannot accept a task in status ${row.status}`,
        );
      }

      const verification = row.verification_json
        ? parseJson<Verification | undefined>(row.verification_json, undefined)
        : undefined;
      if (verification?.status !== "passed") {
        throw new BoardError(
          "verification_required",
          "accept requires verification with status=passed",
        );
      }

      const now = nowIso();
      this.db
        .prepare(
          `UPDATE board_tasks
              SET status = 'done', finished_at = ?, claim_token = NULL,
                  lease_until = NULL, updated_at = ?
            WHERE board_task_id = ?`,
        )
        .run(now, now, taskId);
      this.recordEvent(row.team_id, taskId, "task/accepted", actor, {});
      cancelTaskWakes(this.db, taskId, "accepted");
    });
  }

  rework(taskId: string, actor: string, note?: string): void {
    const cleanNote = note?.trim() ? note.trim() : undefined;
    this.write(() => {
      const row = this.mustTaskRow(taskId);
      this.assertTeamActive(row.team_id);
      if (row.status !== "review") {
        throw new BoardError(
          "invalid_transition",
          `cannot rework a task in status ${row.status}`,
        );
      }

      const now = nowIso();
      this.db
        .prepare(
          `UPDATE board_tasks
              SET status = 'backlog', attempt = attempt + 1,
                  execution_ref = NULL, result_summary = NULL, artifacts_json = '[]',
                  verification_json = NULL, blocked_reason = NULL, finished_at = NULL,
                  claim_token = NULL, lease_until = NULL, updated_at = ?
            WHERE board_task_id = ?`,
        )
        .run(now, taskId);
      this.recordEvent(row.team_id, taskId, "task/reworked", actor, { note: cleanNote });
      cancelTaskWakes(this.db, taskId, "reworked");

      // Wake the executor itself: it is the one who has to act on the note.
      const address = row.execution_ref
        ? resolveTaskSession(this.projectDir, row.execution_ref)
        : undefined;
      if (address) {
        enqueueTransitionWake(this.db, this.projectDir, {
          teamId: row.team_id,
          taskId,
          attempt: row.attempt + 1,
          eventType: "task/rework",
          recipient: address,
          title: row.title,
          status: "rework",
          payload: { note: cleanNote, previousStatus: row.status },
        });
      }
    });
  }

  block(taskId: string, actor: string, reason: string, claimToken?: string): void {
    if (reason.trim().length === 0) {
      throw new BoardError("invalid_transition", "block requires a reason");
    }

    this.write(() => {
      const row = this.mustTaskRow(taskId);
      this.assertTeamActive(row.team_id);
      if (!["backlog", "claimed", "running", "review"].includes(row.status)) {
        throw new BoardError(
          "invalid_transition",
          `cannot block a task in status ${row.status}`,
        );
      }
      this.assertOwnerIfLive(row, actor, claimToken);

      const now = nowIso();
      this.db
        .prepare(
          `UPDATE board_tasks
              SET status = 'blocked', blocked_reason = ?, claim_token = NULL,
                  lease_until = NULL, verification_json = NULL,
                  result_summary = NULL, artifacts_json = '[]',
                  execution_ref = NULL, updated_at = ?
            WHERE board_task_id = ?`,
        )
        .run(reason, now, taskId);
      this.recordEvent(row.team_id, taskId, "task/blocked", actor, { reason });
      enqueueTransitionWake(this.db, this.projectDir, {
        teamId: row.team_id,
        taskId,
        attempt: row.attempt,
        eventType: "task/blocked",
        title: row.title,
        status: "blocked",
        payload: { reason, previousStatus: row.status },
      });
    });
  }

  retry(taskId: string, actor: string): void {
    this.write(() => {
      const row = this.mustTaskRow(taskId);
      this.assertTeamActive(row.team_id);
      if (row.status !== "blocked") {
        throw new BoardError(
          "invalid_transition",
          `cannot retry a task in status ${row.status}`,
        );
      }

      const now = nowIso();
      this.db
        .prepare(
          `UPDATE board_tasks
              SET status = 'backlog', attempt = attempt + 1,
                  blocked_reason = NULL, verification_json = NULL,
                  result_summary = NULL, execution_ref = NULL, updated_at = ?
            WHERE board_task_id = ?`,
        )
        .run(now, taskId);
      this.recordEvent(row.team_id, taskId, "task/retried", actor, {});
      cancelTaskWakes(this.db, taskId, "retried");
    });
  }

  cancel(taskId: string, actor: string, claimToken?: string): void {
    this.write(() => {
      const row = this.mustTaskRow(taskId);
      this.assertTeamActive(row.team_id);
      if (!["backlog", "claimed", "running", "review", "blocked"].includes(row.status)) {
        throw new BoardError(
          "invalid_transition",
          `cannot cancel a task in status ${row.status}`,
        );
      }
      this.assertOwnerIfLive(row, actor, claimToken);

      const now = nowIso();
      this.db
        .prepare(
          `UPDATE board_tasks
              SET status = 'cancelled', finished_at = ?, claim_token = NULL,
                  lease_until = NULL, verification_json = NULL,
                  result_summary = NULL, execution_ref = NULL, updated_at = ?
            WHERE board_task_id = ?`,
        )
        .run(now, now, taskId);
      this.recordEvent(row.team_id, taskId, "task/cancelled", actor, {});
      cancelTaskWakes(this.db, taskId, "cancelled");
    });
  }

  addMessage(taskId: string, actor: string, text: string): void {
    if (text.trim().length === 0) {
      throw new BoardError("invalid_transition", "message must not be empty");
    }

    this.write(() => {
      const row = this.mustTaskRow(taskId);
      this.recordEvent(row.team_id, taskId, "task/message", actor, { text });
    });
  }

  list(
    filter: { teamId?: string; status?: BoardStatus; limit?: number } = {},
  ): BoardTask[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filter.teamId !== undefined) {
      conditions.push("team_id = ?");
      params.push(filter.teamId);
    }
    if (filter.status !== undefined) {
      conditions.push("status = ?");
      params.push(filter.status);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    let limitSql = "";
    if (filter.limit !== undefined && Number.isFinite(filter.limit)) {
      limitSql = " LIMIT ?";
      params.push(Math.max(0, Math.trunc(filter.limit)));
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM board_tasks ${where} ORDER BY priority DESC, created_at ASC${limitSql}`,
      )
      .all(...params) as TaskRow[];
    return rows.map(toTask);
  }

  events(
    filter: {
      teamId?: string;
      taskId?: string;
      limit?: number;
      order?: "asc" | "desc";
    } = {},
  ): BoardEvent[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filter.teamId !== undefined) {
      conditions.push("team_id = ?");
      params.push(filter.teamId);
    }
    if (filter.taskId !== undefined) {
      conditions.push("board_task_id = ?");
      params.push(filter.taskId);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const order = filter.order === "desc" ? "DESC" : "ASC";
    const requested = filter.limit ?? 100;
    const limit = Number.isFinite(requested) ? Math.max(0, Math.trunc(requested)) : 100;
    const rows = this.db
      .prepare(`SELECT * FROM board_events ${where} ORDER BY id ${order} LIMIT ?`)
      .all(...params, limit) as EventRow[];
    return rows.map(toEvent);
  }

  prune(
    options: { taskDays?: number; eventDays?: number } = {},
  ): { tasks: number; events: number; wakes: number } {
    const taskDays = options.taskDays ?? DEFAULT_TASK_RETENTION_DAYS;
    const eventDays = options.eventDays ?? DEFAULT_EVENT_RETENTION_DAYS;
    const taskCutoff = new Date(Date.now() - taskDays * 86_400_000).toISOString();
    const eventCutoff = new Date(Date.now() - eventDays * 86_400_000).toISOString();

    return this.write(() => {
      const tasks = this.db
        .prepare(
          `DELETE FROM board_tasks
            WHERE status IN ('done', 'cancelled') AND updated_at < ?
              AND NOT EXISTS (
                SELECT 1 FROM board_tasks dependent
                 WHERE dependent.status NOT IN ('done', 'cancelled')
                   AND instr(
                         dependent.depends_on_json,
                         '"' || board_tasks.board_task_id || '"'
                       ) > 0
              )`,
        )
        .run(taskCutoff).changes;
      const events = this.db
        .prepare(
          `DELETE FROM board_events
            WHERE created_at < ?
              AND (board_task_id IS NULL
                   OR board_task_id NOT IN (SELECT board_task_id FROM board_tasks))`,
        )
        .run(eventCutoff).changes;
      const wakes = this.db
        .prepare(
          `DELETE FROM wake_events
            WHERE status IN ('delivered', 'failed', 'expired', 'cancelled')
              AND created_at < ?`,
        )
        .run(eventCutoff).changes;
      return { tasks, events, wakes };
    });
  }

  private mustTaskRow(taskId: string): TaskRow;
  private mustTaskRow(taskId: string, required: false): TaskRow | undefined;
  private mustTaskRow(taskId: string, required = true): TaskRow | undefined {
    const row = this.db
      .prepare(`SELECT * FROM board_tasks WHERE board_task_id = ?`)
      .get(taskId) as TaskRow | undefined;
    if (!row && required) {
      throw new BoardError("not_found", `task not found: ${taskId}`);
    }
    return row;
  }

  /**
 * `claimed`/`running` belong to the token holder. A lost token would otherwise
 * make a crashed `running` task unrecoverable (claim never takes `running`),
 * so the team lead may also block/cancel a live task as an explicit recovery
 * path. Any other actor needs the matching claim token.
 */
  private assertOwnerIfLive(
    row: TaskRow,
    actor: string,
    claimToken?: string,
  ): void {
    if (row.status !== "claimed" && row.status !== "running") return;

    const team = this.db
      .prepare(`SELECT lead_agent FROM teams WHERE team_id = ?`)
      .get(row.team_id) as { lead_agent: string } | undefined;
    const isLead = team?.lead_agent === actor;

    // An expired lease has already been lost; only the lead may act before a
    // reclaim, even if the old token is still presented.
    if (
      row.status === "claimed" &&
      row.lease_until !== null &&
      row.lease_until < nowIso()
    ) {
      if (isLead) return;
      throw new BoardError("not_owner", "the claim lease has expired");
    }

    if (row.claim_token !== null && row.claim_token === claimToken) return;
    if (isLead) return;

    throw new BoardError(
      "not_owner",
      "a matching claim token or the team lead is required to mutate a live task",
    );
  }

  private ownedRow(
    taskId: string,
    claimToken: string,
    allowed: BoardStatus[],
  ): TaskRow {
    const row = this.mustTaskRow(taskId);
    if (!allowed.includes(row.status)) {
      throw new BoardError(
        "invalid_transition",
        `unexpected status ${row.status} for this operation`,
      );
    }
    if (
      row.status === "claimed" &&
      row.lease_until !== null &&
      row.lease_until < nowIso()
    ) {
      throw new BoardError("not_owner", "the claim lease has expired");
    }
    if (row.claim_token !== claimToken) {
      throw new BoardError("not_owner", "claim token does not own this task");
    }
    return row;
  }

  private setBacklog(
    row: TaskRow,
    eventType: string,
    actor: string,
    payload: unknown,
  ): void {
    const now = nowIso();
    this.db
      .prepare(
        `UPDATE board_tasks
            SET status = 'backlog', claim_token = NULL, lease_until = NULL, updated_at = ?
          WHERE board_task_id = ?`,
      )
      .run(now, row.board_task_id);
    this.recordEvent(row.team_id, row.board_task_id, eventType, actor, payload);
  }

  private assertTeamActive(teamId: string): void {
    const team = this.db
      .prepare(`SELECT status FROM teams WHERE team_id = ?`)
      .get(teamId) as { status: TeamStatus } | undefined;
    if (!team) throw new BoardError("not_found", `team not found: ${teamId}`);
    if (team.status !== "active") {
      throw new BoardError("team_closed", `team is ${team.status}: ${teamId}`);
    }
  }

  private recordEvent(
    teamId: string,
    boardTaskId: string | null,
    type: string,
    actor: string,
    payload: unknown,
  ): void {
    const eventId = makeId("evt");
    this.db
      .prepare(
        `INSERT INTO board_events
           (event_id, team_id, board_task_id, event_type, actor, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        eventId,
        teamId,
        boardTaskId,
        type,
        actor,
        JSON.stringify(payload ?? {}),
        nowIso(),
      );
    if (boardTaskId) {
      this.db
        .prepare(`UPDATE board_tasks SET last_event_id = ? WHERE board_task_id = ?`)
        .run(eventId, boardTaskId);
    }
  }
}

export interface OpenBoardOptions {
  /** Open an existing board without creating, migrating or seeding anything. */
  readonly?: boolean;
}

/**
 * Opens (and creates on first use) the project board at
 * `<project>/.deus/board.db`. The schema is applied idempotently through
 * `PRAGMA user_version`; WAL and a busy timeout keep several processes from
 * corrupting or deadlocking each other.
 */
export function openBoard(projectDir: string, options: OpenBoardOptions = {}): Board {
  if (options.readonly) {
    const db = openStoreReadonly(projectDir);
    if (!db) {
      throw new BoardError("not_found", `board is not created yet: ${projectDir}/.deus/board.db`);
    }
    return new SqliteBoard(db, projectDir);
  }

  const db = openStore(projectDir);
  try {
    ensureMainTeam(db);
  } catch (error) {
    db.close();
    throw error;
  }

  return new SqliteBoard(db, projectDir);
}
