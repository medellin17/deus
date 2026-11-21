import { OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";

export type OpenCodeClient = ReturnType<typeof OpenCode.make>;

export interface ParsedModel {
  providerID: string;
  id: string;
  variant?: string;
}

/**
 * Connect to the shared OpenCode V2 service. The service owns authentication,
 * so the runner never spawns or configures a server itself.
 */
export async function createOpenCodeClient(): Promise<OpenCodeClient> {
  const endpoint = (await Service.discover()) ?? (await Service.ensure());
  return OpenCode.make({
    baseUrl: endpoint.url,
    headers: Service.headers(endpoint),
  });
}

export function parseModelRef(ref: string): ParsedModel {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) {
    throw new Error(`Invalid model reference "${ref}", expected provider/model#variant`);
  }

  const providerID = ref.slice(0, slash);
  const rest = ref.slice(slash + 1);
  const hash = rest.indexOf("#");
  if (hash === -1) return { providerID, id: rest };
  return {
    providerID,
    id: rest.slice(0, hash),
    variant: rest.slice(hash + 1) || undefined,
  };
}
