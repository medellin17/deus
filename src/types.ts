/**
 * Machine-readable report returned by a sub-orchestrator.
 * Matches the JSON format specified in .opencode/agents/sub-orchestrator.md
 */
export interface SubOrchestratorReport {
  subOrchestratorId: string;
  status: "done" | "blocked" | "failed";
  summary: string;
  artifacts: string[];
  decisions: string[];
  blockers: string[];
  recommendations: string[];
  agentsUsed: number;
  contextUsedApprox?: number;
}

/** Configuration for sub-orchestrator recursion */
export interface SubOrchestratorConfig {
  maxDepth: number;
  timeoutMs: number;
}

/** Definition of a domain task for sub-orchestrator dispatch */
export interface DomainTask {
  domain: string;
  subTask: string;
  kbContext?: string;
  dependsOn?: string[];
}
