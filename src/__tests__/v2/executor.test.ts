import assert from "node:assert";
import { describe, it } from "node:test";

import { SessionExecutor, SESSION_OVERLAY } from "../../v2/executor.ts";
import type { OpenCodeClient } from "../../v2/client.ts";

void describe("session permission overlay", () => {
  void it("forces policy checks for dangerous actions", () => {
    for (const action of ["shell", "websearch", "webfetch", "external_directory"]) {
      assert.ok(
        SESSION_OVERLAY.some(
          (rule) => rule.action === action && rule.resource === "*" && rule.effect === "ask",
        ),
        `missing ask overlay for ${action}`,
      );
    }

    for (const action of ["read", "edit"]) {
      for (const resource of [
        "**/.env",
        "**/.envrc",
        "**/*.key",
        "**/*.p12",
        "**/*.pfx",
        "**/.ssh/**",
        "**/.aws/**",
        "**/.gnupg/**",
      ]) {
        assert.ok(
          SESSION_OVERLAY.some(
            (rule) =>
              rule.action === action && rule.resource === resource && rule.effect === "ask",
          ),
          `missing ask overlay for ${action} ${resource}`,
        );
      }
    }
  });
});

describe("session cleanup on failure", () => {
  function failingClient(calls: { interrupt: number; remove: number }): OpenCodeClient {
    return {
      session: {
        create: async () => ({ id: "ses-1" }),
        prompt: async () => {
          throw new Error("boom");
        },
        get: async () => {
          throw new Error("session gone");
        },
        interrupt: async () => {
          calls.interrupt++;
          return { interrupted: true };
        },
        remove: async () => {
          calls.remove++;
        },
      },
    } as unknown as OpenCodeClient;
  }

  void it("interrupts and removes the session when the step throws", async () => {
    const calls = { interrupt: 0, remove: 0 };
    const executor = new SessionExecutor(failingClient(calls), {
      model: "test/model",
      keepSessions: false,
    });

    const result = await executor.run({
      step: { id: "s1", agent: "build", task: "do it" },
      prompt: "do it",
      runId: "run-1",
      index: 0,
      workDir: "/tmp",
      timeoutMs: 1000,
    });

    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /boom/);
    assert.equal(calls.interrupt, 1);
    assert.equal(calls.remove, 1);
  });

  void it("keeps the session when keepSessions is set", async () => {
    const calls = { interrupt: 0, remove: 0 };
    const executor = new SessionExecutor(failingClient(calls), {
      model: "test/model",
      keepSessions: true,
    });

    const result = await executor.run({
      step: { id: "s1", agent: "build", task: "do it" },
      prompt: "do it",
      runId: "run-1",
      index: 0,
      workDir: "/tmp",
      timeoutMs: 1000,
    });

    assert.equal(result.status, "failed");
    assert.equal(calls.interrupt, 1);
    assert.equal(calls.remove, 0);
  });
});
