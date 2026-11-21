import assert from "node:assert";
import { describe, it } from "node:test";

import { loadAgents } from "../../v2/agents.ts";
import type { OpenCodeClient } from "../../v2/client.ts";

interface FakeAgent {
  name: string;
  hidden?: boolean;
  description?: string;
}

function fakeClient(scoped: FakeAgent[], fallback: FakeAgent[]) {
  const calls: string[] = [];
  const client = {
    agent: {
      list: async (input?: { location?: { directory?: string } }) => {
        const scopedCall = input?.location !== undefined;
        calls.push(scopedCall ? "scoped" : "default");
        const data = (scopedCall ? scoped : fallback).map((agent) => ({
          name: agent.name,
          hidden: agent.hidden ?? false,
          description: agent.description,
        }));
        return { location: {}, data };
      },
    },
  } as unknown as OpenCodeClient;
  return { client, calls };
}

void describe("loadAgents", () => {
  void it("falls back to the default list when the scoped list is empty", async () => {
    const { client, calls } = fakeClient([], [{ name: "build" }, { name: "plan" }]);
    const agents = await loadAgents(client, "/tmp/fresh-project");

    assert.deepEqual(
      agents.map((agent) => agent.name),
      ["build", "plan"],
    );
    assert.deepEqual(calls, ["scoped", "default"]);
  });

  void it("keeps the scoped list when it is not empty", async () => {
    const { client, calls } = fakeClient([{ name: "local" }], [{ name: "build" }]);
    const agents = await loadAgents(client, "/tmp/known-project");

    assert.deepEqual(
      agents.map((agent) => agent.name),
      ["local"],
    );
    assert.deepEqual(calls, ["scoped"]);
  });

  void it("fails before the planner when both lists are empty", async () => {
    const { client, calls } = fakeClient([], []);
    let plannerCalled = false;

    await assert.rejects(
      async () => {
        const agents = await loadAgents(client, "/tmp/empty");
        plannerCalled = true; // планировщик пошёл бы дальше только с непустым списком
        void agents;
      },
      /no agents available for \/tmp\/empty: the server returned an empty agent list/,
    );

    assert.deepEqual(calls, ["scoped", "default"]);
    assert.equal(plannerCalled, false);
  });
});
