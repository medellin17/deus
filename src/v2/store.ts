import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

/**
 * Single owner of the project database at `<project>/.deus/board.db`:
 * directory creation, WAL, busy timeout and idempotent migrations.
 *
 * Both the board and the wake outbox live in this file because a status change
 * and the event it produces must be committed in one transaction.
 */
export const SCHEMA_VERSION = 3;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS teams (
    team_id       TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    goal          TEXT NOT NULL,
    lead_agent    TEXT NOT NULL,
    status        TEXT NOT NULL CHECK(status IN ('active', 'done', 'archived')),
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    closed_at     TEXT,
    last_event_id TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_teams_name
    ON teams(name) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS board_tasks (
    board_task_id   TEXT PRIMARY KEY,
    team_id         TEXT NOT NULL,
    title           TEXT NOT NULL,
    goal            TEXT NOT NULL,
    done_when       TEXT NOT NULL DEFAULT '',
    assignee        TEXT,
    workspace       TEXT,
    status          TEXT NOT NULL CHECK(status IN (
        'backlog', 'claimed', 'running', 'review', 'done', 'blocked', 'cancelled'
    )),
    priority        INTEGER NOT NULL DEFAULT 0,
    depends_on_json TEXT NOT NULL DEFAULT '[]',
    execution_ref   TEXT,
    result_summary  TEXT,
    blocked_reason  TEXT,
    artifacts_json  TEXT NOT NULL DEFAULT '[]',
    verification_json TEXT,
    created_by      TEXT NOT NULL,
    claim_token     TEXT,
    lease_until     TEXT,
    attempt         INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    claimed_at      TEXT,
    finished_at     TEXT,
    last_event_id   TEXT
);
CREATE INDEX IF NOT EXISTS idx_board_tasks_team_status
    ON board_tasks(team_id, status, priority DESC, created_at);
CREATE INDEX IF NOT EXISTS idx_board_tasks_assignee
    ON board_tasks(assignee, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_board_tasks_execution
    ON board_tasks(execution_ref) WHERE execution_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_board_tasks_lease
    ON board_tasks(status, lease_until);

CREATE TABLE IF NOT EXISTS board_events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id      TEXT NOT NULL UNIQUE,
    team_id       TEXT NOT NULL,
    board_task_id TEXT,
    event_type    TEXT NOT NULL,
    actor         TEXT NOT NULL,
    payload_json  TEXT NOT NULL DEFAULT '{}',
    created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_board_events_team ON board_events(team_id, id);
CREATE INDEX IF NOT EXISTS idx_board_events_task ON board_events(board_task_id, id);
CREATE INDEX IF NOT EXISTS idx_board_events_type ON board_events(event_type, id);

CREATE TABLE IF NOT EXISTS wake_events (
    wake_event_id   TEXT PRIMARY KEY,
    dedup_key       TEXT NOT NULL,
    team_id         TEXT NOT NULL,
    board_task_id   TEXT,
    event_type      TEXT NOT NULL,
    recipient_json  TEXT NOT NULL,
    payload_json    TEXT NOT NULL DEFAULT '{}',
    status          TEXT NOT NULL CHECK(status IN (
        'pending', 'delivered', 'failed', 'expired', 'cancelled'
    )),
    attempts        INTEGER NOT NULL DEFAULT 0,
    available_at    TEXT NOT NULL,
    lease_until     TEXT,
    claim_token     TEXT,
    deadline_at     TEXT NOT NULL,
    batch_id        TEXT,
    cost_baseline   REAL,
    cost            REAL,
    last_error      TEXT,
    outcome         TEXT,
    created_at      TEXT NOT NULL,
    delivered_at    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wake_dedup ON wake_events(dedup_key);
CREATE INDEX IF NOT EXISTS idx_wake_pending ON wake_events(status, available_at);
`;

function ensureWakeColumns(db: Database.Database): void {
  const columns = db.prepare(`PRAGMA table_info(wake_events)`).all() as Array<{ name: string }>;
  if (columns.length === 0) return;
  if (!columns.some((column) => column.name === "batch_id")) {
    db.exec(`ALTER TABLE wake_events ADD COLUMN batch_id TEXT`);
  }
}

function migrate(db: Database.Database): void {
  const version = db.pragma("user_version", { simple: true }) as number;
  if (version > SCHEMA_VERSION) {
    throw new Error(
      `board: database schema v${version} is newer than this build (v${SCHEMA_VERSION})`,
    );
  }
  if (version === SCHEMA_VERSION) return;

  db.transaction(() => {
    db.exec(SCHEMA);
    // `CREATE TABLE IF NOT EXISTS` cannot add a column to an existing table, and
    // the version bump would hide that forever. Intermediate builds of the wake
    // outbox predate `batch_id`.
    ensureWakeColumns(db);
    if (version < 2) {
      // v1 made every non-archived name unique, so a closed team kept its name
      // forever and a fresh active `main` could not be seeded. Names are unique
      // among active teams only.
      db.exec(
        `DROP INDEX IF EXISTS idx_teams_name;
         CREATE UNIQUE INDEX IF NOT EXISTS idx_teams_name
           ON teams(name) WHERE status = 'active';`,
      );
    }
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }).immediate();
}

export function storeFile(projectDir: string): string {
  return path.join(projectDir, ".deus", "board.db");
}

/** Synchronous pause: `openStore` is called from sync code paths. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Opens an existing database without creating, migrating or writing anything.
 * Returns `undefined` when the project has no board yet.
 */
export function openStoreReadonly(projectDir: string): Database.Database | undefined {
  const file = storeFile(projectDir);
  if (!fs.existsSync(file)) return undefined;

  const db = new Database(file, { readonly: true, fileMustExist: true });
  db.pragma("busy_timeout = 5000");
  return db;
}

/**
 * Opens (and creates on first use) the project database. WAL and a busy timeout
 * keep several processes from corrupting or deadlocking each other; the schema
 * is applied idempotently through `PRAGMA user_version`.
 */
export function openStore(projectDir: string): Database.Database {
  const dir = path.join(projectDir, ".deus");
  fs.mkdirSync(dir, { recursive: true });

  const gitignore = path.join(dir, ".gitignore");
  if (!fs.existsSync(gitignore)) {
    fs.writeFileSync(gitignore, "*\n", "utf-8");
  }

  const db = new Database(storeFile(projectDir));
  // Set the busy timeout first: converting a fresh database to WAL takes an
  // exclusive lock that SQLite does not retry through the busy handler, so two
  // processes opening a new project at once can fail with SQLITE_BUSY.
  db.pragma("busy_timeout = 5000");

  let journalMode = "";
  for (let attempt = 0; ; attempt++) {
    try {
      journalMode = String(db.pragma("journal_mode = WAL", { simple: true }));
      break;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "SQLITE_BUSY" || attempt >= 20) {
        db.close();
        throw error;
      }
      sleepSync(50);
    }
  }
  if (journalMode.toLowerCase() !== "wal") {
    db.close();
    throw new Error(
      `board: WAL is unavailable (journal_mode=${journalMode}); a long-lived team cannot share this database`,
    );
  }
  db.pragma("foreign_keys = OFF");
  try {
    migrate(db);
  } catch (error) {
    db.close();
    throw error;
  }

  return db;
}
