/** Local type: OpenCode plugin interface (package @opencode-ai/plugin unavailable) */
type Plugin = (ctx: unknown) => Promise<Record<string, (event: unknown) => Promise<void>>>

/** Possible statuses for a monitored session */
type SessionStatus = "active" | "completed" | "errored" | "failed"

/** Record of a single tracked session */
interface SessionRecord {
  id: string
  agent: string
  task: string
  createdAt: string
  completedAt: string | null
  erroredAt: string | null
  durationMs: number | null
  status: SessionStatus
}

/** Aggregate metrics across all sessions */
interface Metrics {
  totalCreated: number
  totalCompleted: number
  totalErrored: number
  totalFailed: number
  activeSessions: number
  avgDurationMs: number
}

/** Full metrics object exposed internally */
interface MetricsState extends Metrics {
  sessions: Map<string, SessionRecord>
}

/** Raw event payload from session events */
interface SessionEventPayload {
  id?: string
  agent?: string
  task?: string
  status?: string
  [key: string]: unknown
}

/** Raw event payload from tool events */
interface ToolEventPayload {
  sessionId?: string
  name?: string
  [key: string]: unknown
}

/** Log levels */
type LogLevel = "INFO" | "WARN" | "ERROR" | "DEBUG"

const PLUGIN_TAG = "orchestrator-monitor"

/**
 * Format a timestamp as YYYY-MM-DD HH:MM:SS.
 */
function formatTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * Emit a structured log line.
 */
function log(level: LogLevel, message: string): void {
  const ts = formatTimestamp(new Date())
  console.log(`[${PLUGIN_TAG}][${ts}][${level}] ${message}`)
}

/**
 * Recalculate avgDurationMs from the sessions map.
 */
function recalcAvgDuration(sessions: Map<string, SessionRecord>): number {
  const finished = Array.from(sessions.values()).filter(
    (s) => s.durationMs !== null
  )
  if (finished.length === 0) return 0
  const total = finished.reduce((sum, s) => sum + (s.durationMs ?? 0), 0)
  return Math.round(total / finished.length)
}

/** Shared metrics state accessible from the exported helper */
let metricsState: MetricsState = {
  totalCreated: 0,
  totalCompleted: 0,
  totalErrored: 0,
  totalFailed: 0,
  activeSessions: 0,
  avgDurationMs: 0,
  sessions: new Map(),
}

/**
 * Return a JSON string with the current metrics snapshot.
 *
 * @example
 * ```ts
 * const summary = getMetricsSummary()
 * console.log(summary)
 * // {"totalCreated":12,"totalCompleted":10,"totalErrored":1,"totalFailed":1,"activeSessions":0,"avgDurationMs":3420}
 * ```
 */
export function getMetricsSummary(): string {
  const { sessions, ...rest } = metricsState
  return JSON.stringify(rest)
}

/**
 * Return the raw metrics object (read-only snapshot).
 */
export function getMetrics(): Metrics {
  const { sessions, ...rest } = metricsState
  return { ...rest }
}

/**
 * Return all session records as an array.
 */
export function getSessions(): SessionRecord[] {
  return Array.from(metricsState.sessions.values())
}

/**
 * OpenCode plugin that monitors orchestrator sessions and tracks metrics.
 */
const OrchestratorMonitor: Plugin = async (_ctx) => {
  log("INFO", "Plugin loaded — monitoring active")

  // ── Helpers ────────────────────────────────────────────────

  function extractSessionId(event: SessionEventPayload): string | null {
    return event.id ?? null
  }

  function ensureSession(id: string): SessionRecord {
    let record = metricsState.sessions.get(id)
    if (!record) {
      record = {
        id,
        agent: "unknown",
        task: "",
        createdAt: formatTimestamp(new Date()),
        completedAt: null,
        erroredAt: null,
        durationMs: null,
        status: "active",
      }
      metricsState.sessions.set(id, record)
    }
    return record
  }

  function completeSession(id: string, status: "completed" | "errored" | "failed"): void {
    const record = metricsState.sessions.get(id)
    if (!record) return

    const now = new Date()
    const createdMs = new Date(record.createdAt).getTime()
    record.completedAt = formatTimestamp(now)
    record.durationMs = createdMs > 0 ? now.getTime() - createdMs : 0
    record.status = status

    if (status === "completed") metricsState.totalCompleted++
    else if (status === "errored") metricsState.totalErrored++
    else metricsState.totalFailed++

    metricsState.activeSessions = Math.max(0, metricsState.activeSessions - 1)
    metricsState.avgDurationMs = recalcAvgDuration(metricsState.sessions)

    log(
      status === "completed" ? "INFO" : "ERROR",
      `Session ${status}: ${id} | duration: ${record.durationMs}ms | active: ${metricsState.activeSessions}`
    )
  }

  function diffCount(prev: Metrics, next: Metrics): string {
    const parts: string[] = []
    if (next.totalCreated !== prev.totalCreated) parts.push(`created: ${next.totalCreated}`)
    if (next.activeSessions !== prev.activeSessions) parts.push(`active: ${next.activeSessions}`)
    if (next.avgDurationMs !== prev.avgDurationMs) parts.push(`avgMs: ${next.avgDurationMs}`)
    return parts.length > 0 ? ` | ${parts.join(" | ")}` : ""
  }

  // ── Event Handlers ─────────────────────────────────────────

  const handlers: Record<string, (event: unknown) => Promise<void>> = {
    "session.created": async (event) => {
      const payload = event as SessionEventPayload
      const id = extractSessionId(payload)
      if (!id) {
        log("WARN", "session.created fired without id — skipped")
        return
      }

      const record = ensureSession(id)
      if (payload.agent) record.agent = payload.agent
      if (payload.task) record.task = payload.task

      metricsState.totalCreated++
      metricsState.activeSessions++

      log(
        "INFO",
        `Session created: ${id} | agent: ${record.agent} | active: ${metricsState.activeSessions}`
      )
    },

    "session.idle": async (event) => {
      const payload = event as SessionEventPayload
      const id = extractSessionId(payload)
      if (!id) return

      const record = metricsState.sessions.get(id)
      if (!record) {
        log("WARN", `session.idle for unknown session: ${id}`)
        return
      }

      record.status = "active"
      log("DEBUG", `Session idle: ${id} | agent: ${record.agent}`)
    },

    "session.error": async (event) => {
      const payload = event as SessionEventPayload
      const id = extractSessionId(payload)
      if (!id) {
        log("ERROR", "session.error fired without id — skipped")
        return
      }

      ensureSession(id)
      completeSession(id, "errored")
    },

    "session.status": async (event) => {
      const payload = event as SessionEventPayload
      const id = extractSessionId(payload)
      if (!id) return

      const record = ensureSession(id)
      const incoming = (payload.status ?? "").toString().toLowerCase()

      if (incoming === "completed") {
        completeSession(id, "completed")
      } else if (incoming === "failed") {
        completeSession(id, "failed")
      } else if (incoming === "errored") {
        completeSession(id, "errored")
      } else {
        record.status = "active"
        log("DEBUG", `Session status update: ${id} → ${incoming || "unknown"}`)
      }
    },

    "session.updated": async (event) => {
      const payload = event as SessionEventPayload
      const id = extractSessionId(payload)
      if (!id) return

      const record = ensureSession(id)
      if (payload.agent) record.agent = payload.agent
      if (payload.task) record.task = payload.task

      log("DEBUG", `Session updated: ${id} | agent: ${record.agent}`)
    },

    "session.deleted": async (event) => {
      const payload = event as SessionEventPayload
      const id = extractSessionId(payload)
      if (!id) return

      const record = metricsState.sessions.get(id)
      if (!record) {
        log("WARN", `session.deleted for unknown session: ${id}`)
        return
      }

      if (record.status === "active") {
        metricsState.activeSessions = Math.max(0, metricsState.activeSessions - 1)
      }

      metricsState.sessions.delete(id)
      log("INFO", `Session deleted: ${id} | remaining tracked: ${metricsState.sessions.size}`)
    },

    "tool.execute.before": async (event) => {
      const payload = event as ToolEventPayload
      const sessionId = payload.sessionId ?? "unknown"
      const toolName = payload.name ?? "unknown"

      log("DEBUG", `Tool call starting: ${toolName} | session: ${sessionId}`)
    },

    "tool.execute.after": async (event) => {
      const payload = event as ToolEventPayload
      const sessionId = payload.sessionId ?? "unknown"
      const toolName = payload.name ?? "unknown"

      log("DEBUG", `Tool call finished: ${toolName} | session: ${sessionId}`)
    },
  }

  return handlers
}

export default OrchestratorMonitor
