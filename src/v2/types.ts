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
  /** Run project checks after this step and retry on failure. */
  gate?: boolean;
  /** Fail the step when it produced no changes in the worktree. */
  requireChanges?: boolean;
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

export interface CheckCommand {
  /** Stable name shown in artifacts, e.g. "test". */
  name: string;
  /** Shell command executed in the work directory. */
  command: string;
}

export interface CheckResult {
  name: string;
  command: string;
  status: "passed" | "failed" | "timedOut";
  exitCode: number | null;
  durationMs: number;
  output: string;
}

export interface GateResult {
  status: "passed" | "failed" | "skipped";
  checks: CheckResult[];
  durationMs: number;
  error?: string;
  /** Non-fatal notes, e.g. pre-existing failures kept from the baseline. */
  warnings?: string[];
  /** Result of the same checks on the untouched worktree. */
  baselineStatus?: "passed" | "failed" | "skipped";
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
  /** 1-based attempt number when the step runs behind a gate. */
  attempt?: number;
  /** Cost of the failed attempts that preceded this one. */
  priorCost?: number;
  /** Project checks that ran after this step. */
  gate?: GateResult;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  permissionDecisions: PermissionDecision[];
}

export interface PlanStep {
  id: string;
  agent: string;
  /** analyze is read-only, change allows edits and commands. */
  mode: "analyze" | "change";
  task: string;
}

export type ApplyStatus = "merged" | "branch" | "no-changes" | "skipped";

export interface ApplyResult {
  status: ApplyStatus;
  branch?: string;
  commit?: string;
  reason?: string;
  mergeCommand?: string;
  /** Agent session that resolved merge conflicts, if any. */
  resolution?: StepExecution;
}

export interface RunState {
  version: 1;
  runId: string;
  projectDir: string;
  workDir: string;
  worktree: boolean;
  /** HEAD of the project when the worktree was created. */
  baseCommit?: string;
  /** Branch the main worktree was on when the run started. */
  baseBranch?: string;
  pipeline: string;
  task: string;
  model: string;
  status: "running" | "succeeded" | "failed" | "interrupted";
  error?: string;
  cost?: number;
  /** Checks on the untouched worktree, used to ignore pre-existing failures. */
  baseline?: GateResult;
  /** Plan produced by the planner; also used to rebuild steps on resume. */
  plan?: PlanStep[];
  planner?: StepExecution;
  apply?: ApplyResult;
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
