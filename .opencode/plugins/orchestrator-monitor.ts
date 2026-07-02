import type { Plugin } from "@opencode-ai/plugin"
import type { Event, Session } from "@opencode-ai/sdk"
import {
  incrementMetric,
  setMetric,
  updateAvgDuration,
  upsertSession,
  getSession,
  deleteSession,
} from "../../src/metrics.ts"

const SERVICE = "orchestrator-monitor"

export const OrchestratorMonitor: Plugin = async (ctx) => {
  const client = ctx.client

  return {
    event: async ({ event }: { event: Event }): Promise<void> => {
      switch (event.type) {
        case "session.created": {
          const { info } = event.properties
          incrementMetric("totalCreated", 1)
          incrementMetric("activeSessions", 1)
          upsertSession({
            id: info.id,
            title: info.title,
            directory: info.directory,
            agent: "",
            status: "active",
            startedAt: info.time.created,
            completedAt: null,
            durationMs: null,
          })
          void client.app.log({
            body: {
              service: SERVICE,
              level: "info",
              message: `Session created: ${info.id} | title: ${info.title} | dir: ${info.directory}`,
            },
          })
          break
        }

        case "session.updated": {
          const { info } = event.properties
          const existing = getSession(info.id)
          if (existing) {
            upsertSession({
              ...existing,
              title: info.title,
              directory: info.directory,
            })
          }
          void client.app.log({
            body: {
              service: SERVICE,
              level: "debug",
              message: `Session updated: ${info.id}`,
            },
          })
          break
        }

        case "session.status": {
          const { sessionID, status } = event.properties
          if (status.type === "idle") {
            const existing = getSession(sessionID)
            if (existing && existing.status === "active") {
              const now = Date.now()
              const durationMs = now - existing.startedAt
              incrementMetric("totalCompleted", 1)
              incrementMetric("activeSessions", -1)
              updateAvgDuration(durationMs)
              upsertSession({
                ...existing,
                status: "completed",
                completedAt: now,
                durationMs,
              })
              void client.app.log({
                body: {
                  service: SERVICE,
                  level: "info",
                  message: `Session completed: ${sessionID} | duration: ${durationMs}ms`,
                },
              })
            }
          } else if (status.type === "busy") {
            void client.app.log({
              body: {
                service: SERVICE,
                level: "debug",
                message: `Session busy: ${sessionID}`,
              },
            })
          } else if (status.type === "retry") {
            void client.app.log({
              body: {
                service: SERVICE,
                level: "warn",
                message: `Session retry: ${sessionID} | attempt: ${status.attempt} | ${status.message}`,
              },
            })
          }
          break
        }

        case "session.error": {
          const { sessionID } = event.properties
          incrementMetric("totalFailed", 1)
          if (sessionID) {
            incrementMetric("activeSessions", -1)
            const existing = getSession(sessionID)
            if (existing) {
              upsertSession({
                ...existing,
                status: "failed",
                completedAt: Date.now(),
              })
            }
          }
          void client.app.log({
            body: {
              service: SERVICE,
              level: "error",
              message: `Session error${sessionID ? `: ${sessionID}` : ""}`,
            },
          })
          break
        }

        case "session.deleted": {
          const { info } = event.properties
          const existing = getSession(info.id)
          if (existing) {
            if (existing.status === "active") {
              incrementMetric("activeSessions", -1)
            }
            deleteSession(info.id)
          }
          void client.app.log({
            body: {
              service: SERVICE,
              level: "info",
              message: `Session deleted: ${info.id}`,
            },
          })
          break
        }

        case "session.idle": {
          void client.app.log({
            body: {
              service: SERVICE,
              level: "debug",
              message: `Session idle: ${event.properties.sessionID}`,
            },
          })
          break
        }

        case "session.compacted": {
          void client.app.log({
            body: {
              service: SERVICE,
              level: "debug",
              message: `Session compacted: ${event.properties.sessionID}`,
            },
          })
          break
        }

        case "session.diff": {
          void client.app.log({
            body: {
              service: SERVICE,
              level: "debug",
              message: `Session diff: ${event.properties.sessionID} | files: ${event.properties.diff.length}`,
            },
          })
          break
        }

        default:
          break
      }
    },

    "tool.execute.before": async (input, _output): Promise<void> => {
      void client.app.log({
        body: {
          service: SERVICE,
          level: "debug",
          message: `Tool call starting: ${input.tool} | session: ${input.sessionID}`,
        },
      })
    },

    "tool.execute.after": async (input, _output): Promise<void> => {
      void client.app.log({
        body: {
          service: SERVICE,
          level: "debug",
          message: `Tool call finished: ${input.tool} | session: ${input.sessionID}`,
        },
      })
    },
  }
}
