export type PermissionEffect = "allow" | "deny" | "ask";

export interface PermissionRule {
  action: string;
  resource: string;
  effect: PermissionEffect;
}

export interface PipelineStepDef {
  /** Stable step id, used in artifacts and checkpoints. */
  id: string;
  /** OpenCode agent id, e.g. "build", "plan", "reviewer". */
  agent: string;
  /** Prompt template. Supports {task}, {prev}, {diff}. */
  task: string;
  /** Optional session-level permission overlay. */
  permissions?: PermissionRule[];
  /** Per-step timeout; falls back to the run-level timeout. */
  timeoutMs?: number;
}

export interface TokenUsage {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
}

export interface PermissionDecision {
  requestID: string;
  action: string;
  resources: string[];
  decision: "allow" | "deny";
  reason: string;
}

export interface StepExecution {
  stepId: string;
  agent: string;
  sessionID: string;
  status: "succeeded" | "failed";
  text: string;
  transcript: string;
  error?: string;
  tokens?: TokenUsage;
  cost?: number;
  costEstimated?: boolean;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  permissionDecisions: PermissionDecision[];
}

export interface RunState {
  version: 1;
  runId: string;
  projectDir: string;
  workDir: string;
  worktree: boolean;
  pipeline: string;
  task: string;
  model: string;
  status: "running" | "succeeded" | "failed" | "interrupted";
  error?: string;
  cost?: number;
  createdAt: string;
  updatedAt: string;
  steps: StepExecution[];
}

export interface ExecutorInput {
  step: PipelineStepDef;
  prompt: string;
  runId: string;
  index: number;
  workDir: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface Executor {
  run(input: ExecutorInput): Promise<StepExecution>;
}
