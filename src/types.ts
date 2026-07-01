/** Machine-readable report from a sub-orchestrator */
export interface SubOrchestratorReport {
  domain: string;
  depth: number;
  status: "complete" | "partial" | "failed" | "escalated";
  stages: StageResult[];
  escalations: Escalation[];
  total_files_created: number;
  total_files_modified: number;
  confidence: "high" | "medium" | "low";
}

export interface StageResult {
  step: number;
  agent: "implementer-builder" | "reviewer-critic" | "integrator-qa" | "debug";
  goal: string;
  status: "complete" | "failed" | "skipped";
  files_created: string[];
  files_modified: string[];
  test_results?: {
    passed: number;
    failed: number;
    skipped: number;
  };
  review_verdict?: "VERIFIED" | "ISSUES_FOUND";
  issues?: string[];
  duration_approx: string;
  retry_count: number;
}

export interface Escalation {
  step: number;
  reason: string;
  suggestion: string;
}

/** Configuration for sub-orchestrator recursion */
export interface SubOrchestratorConfig {
  maxDepth: number;  // default 2
  timeoutMs: number; // default 300_000 (5 min)
}
