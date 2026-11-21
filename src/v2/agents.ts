import type { OpenCodeClient } from "./client.ts";
import type { PlanAgent } from "./planner.ts";

type AgentInfo = Awaited<ReturnType<OpenCodeClient["agent"]["list"]>>["data"][number];

function toPlanAgents(agents: AgentInfo[]): PlanAgent[] {
  const seen = new Set<string>();
  const result: PlanAgent[] = [];

  for (const agent of agents) {
    if (agent.hidden) continue;
    if (/^(compaction|title|summary)$/i.test(agent.id)) continue;
    const key = agent.id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ name: agent.id, description: agent.description });
  }

  return result;
}

/**
 * A directory can answer with an empty scoped agent list: observed for a fresh
 * project root and for an unused temp directory, while a directory the server
 * had answered for before returned the full list. The reason is not
 * established, so fall back to the server-wide default list and let the caller
 * fail when that is empty too.
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
