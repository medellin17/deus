import Database from "better-sqlite3"
import path from "path"
import fs from "fs"

interface MetricsRow {
  key: string
  value: number
}

interface SessionRow {
  id: string
  title: string
  directory: string
  agent: string
  status: string
  started_at: number
  completed_at: number | null
  duration_ms: number | null
}

export interface Metrics {
  totalCreated: number
  totalCompleted: number
  totalFailed: number
  activeSessions: number
  avgDurationMs: number
}

export interface SessionInfo {
  id: string
  title: string
  directory: string
  agent: string
  status: string
  startedAt: number
  completedAt: number | null
  durationMs: number | null
}

let db: Database.Database | null = null

function getDbPath(): string {
  const deusDir = path.join(process.cwd(), ".deus", "kb")
  fs.mkdirSync(deusDir, { recursive: true })
  return path.join(deusDir, "metrics.db")
}

function getDb(): Database.Database {
  if (!db) {
    db = new Database(getDbPath())
    db.pragma("journal_mode = WAL")
    db.pragma("synchronous = NORMAL")
    initSchema(db)
  }
  return db
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS metrics (
      key TEXT PRIMARY KEY,
      value INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      directory TEXT NOT NULL DEFAULT '',
      agent TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      duration_ms INTEGER
    );
  `)
  const defaults = ["totalCreated", "totalCompleted", "totalFailed", "activeSessions", "avgDurationMs"]
  const insert = db.prepare("INSERT OR IGNORE INTO metrics (key, value) VALUES (?, 0)")
  for (const key of defaults) {
    insert.run(key)
  }
}

export function incrementMetric(key: string, delta: number = 1): void {
  const d = getDb()
  d.prepare("UPDATE metrics SET value = value + ? WHERE key = ?").run(delta, key)
}

export function setMetric(key: string, value: number): void {
  const d = getDb()
  d.prepare("INSERT OR REPLACE INTO metrics (key, value) VALUES (?, ?)").run(key, value)
}

export function getMetric(key: string): number {
  const d = getDb()
  const row = d.prepare("SELECT value FROM metrics WHERE key = ?").get(key) as MetricsRow | undefined
  return row?.value ?? 0
}

export function updateAvgDuration(newDuration: number): void {
  const d = getDb()
  const completed = getMetric("totalCompleted")
  if (completed <= 1) {
    setMetric("avgDurationMs", newDuration)
  } else {
    const current = getMetric("avgDurationMs")
    const avg = current + (newDuration - current) / completed
    setMetric("avgDurationMs", Math.round(avg))
  }
}

export function upsertSession(session: SessionInfo): void {
  const d = getDb()
  d.prepare(`
    INSERT OR REPLACE INTO sessions (id, title, directory, agent, status, started_at, completed_at, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(session.id, session.title, session.directory, session.agent, session.status, session.startedAt, session.completedAt, session.durationMs)
}

export function getSession(id: string): SessionInfo | null {
  const d = getDb()
  const row = d.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined
  if (!row) return null
  return {
    id: row.id,
    title: row.title,
    directory: row.directory,
    agent: row.agent,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    durationMs: row.duration_ms,
  }
}

export function deleteSession(id: string): void {
  const d = getDb()
  d.prepare("DELETE FROM sessions WHERE id = ?").run(id)
}

export function getMetrics(): Metrics {
  return {
    totalCreated: getMetric("totalCreated"),
    totalCompleted: getMetric("totalCompleted"),
    totalFailed: getMetric("totalFailed"),
    activeSessions: getMetric("activeSessions"),
    avgDurationMs: getMetric("avgDurationMs"),
  }
}

export function getAllSessions(): SessionInfo[] {
  const d = getDb()
  const rows = d.prepare("SELECT * FROM sessions ORDER BY started_at DESC").all() as SessionRow[]
  return rows.map(row => ({
    id: row.id,
    title: row.title,
    directory: row.directory,
    agent: row.agent,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    durationMs: row.duration_ms,
  }))
}

export function closeMetrics(): void {
  if (db) {
    db.close()
    db = null
  }
}
