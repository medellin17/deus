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

describe("session failure reporting", () => {
  void it("prefers the server error message over 'session failed'", async () => {
    const client = {
      session: {
        create: async () => ({ id: "ses-1" }),
        prompt: async () => undefined,
        get: async () => ({ id: "ses-1", outcome: "failed", cost: 0 }),
        interrupt: async () => ({ interrupted: false }),
        remove: async () => undefined,
      },
      message: {
        list: async () => ({
          data: [
            {
              id: "m1",
              type: "idle",
              outcome: "failed",
              time: { created: 1, updated: 1 },
              error: { type: "unknown", message: 'Agent not found: "Explore"' },
            },
          ],
        }),
      },
    } as unknown as OpenCodeClient;

    const executor = new SessionExecutor(client, {
      model: "test/model",
      keepSessions: true,
    });

    const result = await executor.run({
      step: { id: "s1", agent: "explore", task: "x" },
      prompt: "x",
      runId: "run-1",
      index: 0,
      workDir: "/tmp",
      timeoutMs: 1000,
    });

    assert.equal(result.status, "failed");
    assert.equal(result.error, 'Agent not found: "Explore"');
  });
});

describe("first output watchdog", () => {
  function silentClient(calls: { interrupt: number }): OpenCodeClient {
    let interrupted = false;
    return {
      session: {
        create: async () => ({ id: "ses-1" }),
        prompt: async () => undefined,
        get: async () => ({
          id: "ses-1",
          outcome: interrupted ? "interrupted" : undefined,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          cost: 0,
        }),
        interrupt: async () => {
          calls.interrupt++;
          interrupted = true;
          return { interrupted: true };
        },
        remove: async () => undefined,
      },
      permission: {
        list: async () => [],
      },
      message: {
        list: async () => ({ data: [] }),
      },
    } as unknown as OpenCodeClient;
  }

  void it("fails the step when the provider stays silent past firstOutputMs", async () => {
    const calls = { interrupt: 0 };
    const executor = new SessionExecutor(silentClient(calls), {
      model: "test/model",
      keepSessions: true,
      firstOutputMs: 100,
    });

    const result = await executor.run({
      step: { id: "s1", agent: "build", task: "do it" },
      prompt: "do it",
      runId: "run-1",
      index: 0,
      workDir: "/tmp",
      timeoutMs: 60_000,
    });

    assert.equal(result.status, "failed");
    assert.match(
      result.error ?? "",
      /no model output after \d+s: the provider did not start responding/,
    );
    assert.equal(calls.interrupt, 1);
  });

  void it("does not trigger the watchdog once tokens appear", async () => {
    const calls = { interrupt: 0 };
    const client = {
      session: {
        create: async () => ({ id: "ses-1" }),
        prompt: async () => undefined,
        get: async () => ({
          id: "ses-1",
          outcome: undefined,
          tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
          cost: 0,
        }),
        interrupt: async () => {
          calls.interrupt++;
          return { interrupted: true };
        },
        remove: async () => undefined,
      },
      permission: {
        list: async () => [],
      },
      message: {
        list: async () => ({ data: [] }),
      },
    } as unknown as OpenCodeClient;

    const executor = new SessionExecutor(client, {
      model: "test/model",
      keepSessions: true,
      firstOutputMs: 100,
    });

    const result = await executor.run({
      step: { id: "s1", agent: "build", task: "do it" },
      prompt: "do it",
      runId: "run-1",
      index: 0,
      workDir: "/tmp",
      timeoutMs: 500,
    });

    assert.equal(result.status, "failed");
    assert.equal(result.error, "step timed out after 1s");
    assert.doesNotMatch(result.error ?? "", /no model output/);
    assert.equal(calls.interrupt, 1);
  });
});

describe("per-agent model", () => {
  void it("creates the session with the agent model and prices it with that model", async () => {
    const created: Array<{ providerID: string; id: string; variant?: string }> = [];
    const logs: string[] = [];
    const client = {
      session: {
        create: async (input: {
          model: { providerID: string; id: string; variant?: string };
        }) => {
          created.push(input.model);
          return { id: "ses-1" };
        },
        prompt: async () => undefined,
        get: async () => ({
          id: "ses-1",
          outcome: "stop",
          tokens: {
            input: 1_000_000,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          cost: 0,
        }),
        interrupt: async () => ({ interrupted: false }),
        remove: async () => undefined,
      },
      permission: {
        list: async () => [],
      },
      message: {
        list: async () => ({
          data: [
            {
              type: "assistant",
              finish: "stop",
              content: [{ type: "text", text: "done" }],
            },
          ],
        }),
      },
    } as unknown as OpenCodeClient;

    const executor = new SessionExecutor(client, {
      model: "tokenharbor/deepseek-v4.1-flash:free",
      modelFor: (agent) =>
        agent === "builder" ? "opencode-go/deepseek-v4.1-flash#high" : undefined,
      keepSessions: true,
      onLog: (message) => logs.push(message),
    });

    const result = await executor.run({
      step: { id: "s1", agent: "builder", task: "do it" },
      prompt: "do it",
      runId: "run-1",
      index: 0,
      workDir: "/tmp",
      timeoutMs: 1000,
    });

    assert.equal(result.status, "succeeded");
    assert.deepEqual(created, [
      { providerID: "opencode-go", id: "deepseek-v4.1-flash", variant: "high" },
    ]);
    // The free run model would price at 0; the agent model prices this at 0.15.
    assert.equal(result.cost, 0.15);
    assert.equal(result.costEstimated, true);
    assert.ok(
      logs.some((line) => line.includes("agent model opencode-go/deepseek-v4.1-flash#high")),
      "the override should be logged so artifacts are not misleading",
    );
  });
});
