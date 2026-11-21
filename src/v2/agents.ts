import type { OpenCodeClient } from "./client.ts";
import type { PlanAgent } from "./planner.ts";

type AgentInfo = Awaited<ReturnType<OpenCodeClient["agent"]["list"]>>["data"][number];

function toPlanAgents(agents: AgentInfo[]): PlanAgent[] {
  const seen = new Set<string>();
  const result: PlanAgent[] = [];

  for (const agent of agents) {
    if (agent.hidden) continue;
    if (/^(compaction|title|summary)$/i.test(agent.name)) continue;
    const key = agent.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ name: agent.name, description: agent.description });
  }

  return result;
}

/**
 * The server only knows the agents of a directory after it has loaded that
 * location, which happens when a session is created there. A fresh project or
 * worktree therefore answers an empty scoped list, so fall back to the
 * server-wide default list.
 */
export async function listAgents(
  client: OpenCodeClient,
  directory: string,
): Promise<PlanAgent[]> {
  const scoped = toPlanAgents((await client.agent.list({ location: { directory } })).data);
  if (scoped.length > 0) return scoped;
  return toPlanAgents((await client.agent.list()).data);
}

export async function loadAgents(
  client: OpenCodeClient,
  directory: string,
): Promise<PlanAgent[]> {
  const agents = await listAgents(client, directory);
  if (agents.length === 0) {
    throw new Error(
      `no agents available for ${directory}: the server returned an empty agent list`,
    );
  }
  return agents;
}
