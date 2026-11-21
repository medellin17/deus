import path from "path"
import fs from "fs"

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

interface StoredData {
  metrics: Record<string, number>
  sessions: SessionInfo[]
}

const METRIC_KEYS = ["totalCreated", "totalCompleted", "totalFailed", "activeSessions", "avgDurationMs"]

function getDbPath(): string {
  const deusDir = path.join(process.cwd(), ".deus", "kb")
  fs.mkdirSync(deusDir, { recursive: true })
  return path.join(deusDir, "metrics.json")
}

function readData(): StoredData {
  try {
    const raw = fs.readFileSync(getDbPath(), "utf-8")
    const parsed = JSON.parse(raw) as StoredData
    return {
      metrics: typeof parsed.metrics === "object" && parsed.metrics !== null ? parsed.metrics : {},
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
    }
  } catch {
    return { metrics: {}, sessions: [] }
  }
}

function writeData(data: StoredData): void {
  fs.writeFileSync(getDbPath(), JSON.stringify(data, null, 2))
}

function withData<T>(fn: (data: StoredData) => T): T {
  const data = readData()
  const result = fn(data)
  writeData(data)
  return result
}

export async function incrementMetric(key: string, delta: number = 1): Promise<void> {
  withData((data) => {
    data.metrics[key] = (data.metrics[key] ?? 0) + delta
  })
}

export async function setMetric(key: string, value: number): Promise<void> {
  withData((data) => {
    data.metrics[key] = value
  })
}

export async function getMetric(key: string): Promise<number> {
  const data = readData()
  return data.metrics[key] ?? 0
}

export async function updateAvgDuration(newDuration: number): Promise<void> {
  const completed = await getMetric("totalCompleted")
  if (completed <= 1) {
    await setMetric("avgDurationMs", newDuration)
  } else {
    const current = await getMetric("avgDurationMs")
    const avg = current + (newDuration - current) / completed
    await setMetric("avgDurationMs", Math.round(avg))
  }
}

export async function upsertSession(session: SessionInfo): Promise<void> {
  withData((data) => {
    const idx = data.sessions.findIndex((s) => s.id === session.id)
    if (idx >= 0) {
      data.sessions[idx] = session
    } else {
      data.sessions.push(session)
    }
  })
}

export async function getSession(id: string): Promise<SessionInfo | null> {
  const data = readData()
  return data.sessions.find((s) => s.id === id) ?? null
}

export async function deleteSession(id: string): Promise<void> {
  withData((data) => {
    data.sessions = data.sessions.filter((s) => s.id !== id)
  })
}

export async function getMetrics(): Promise<Metrics> {
  const data = readData()
  const get = (key: string) => data.metrics[key] ?? 0
  return {
    totalCreated: get("totalCreated"),
    totalCompleted: get("totalCompleted"),
    totalFailed: get("totalFailed"),
    activeSessions: get("activeSessions"),
    avgDurationMs: get("avgDurationMs"),
  }
}

export async function getAllSessions(): Promise<SessionInfo[]> {
  const data = readData()
  return data.sessions.slice().sort((a, b) => b.startedAt - a.startedAt)
}

export async function closeMetrics(): Promise<void> {
  // No-op for JSON backend
}
