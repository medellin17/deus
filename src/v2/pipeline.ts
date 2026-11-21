import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { applyBaseline, runGate } from "./gate.ts";
import { generatePlan, planToSteps, type PlannerInput } from "./planner.ts";
import type {
  CheckCommand,
  Executor,
  GateResult,
  PipelineStepDef,
  PlanStep,
  RunState,
  StepExecution,
} from "./types.ts";

export interface RunPipelineOptions {
  steps: PipelineStepDef[];
  /** Plan for a from-plan run; persisted so the run can be resumed. */
  plan?: PlanStep[];
  pipeline: string;
  task: string;
  runId: string;
  projectDir: string;
  workDir: string;
  worktree: boolean;
  baseCommit?: string;
  baseBranch?: string;
  model: string;
  timeoutMs: number;
  maxCost?: number;
  /** Total attempts for a gated step, including the first one. */
  maxAttempts?: number;
  checks?: CheckCommand[];
  checkTimeoutMs?: number;
  /** Compare gated checks with the untouched worktree; defaults to true. */
  baseline?: boolean;
  planner?: PlannerInput;
  executor: Executor;
  resume?: RunState;
  signal?: AbortSignal;
  onProgress?: (event: PipelineProgress) => void;
}

export type PipelineProgress =
  | { type: "baseline-start" }
  | { type: "baseline-end"; gate: GateResult }
  | { type: "planner-start"; attempt: number }
  | { type: "planner-end"; result: StepExecution; plan?: PlanStep[] }
  | { type: "step-start"; index: number; step: PipelineStepDef }
  | { type: "step-skip"; index: number; step: PipelineStepDef }
  | { type: "step-retry"; index: number; step: PipelineStepDef; attempt: number; maxAttempts: number }
  | { type: "gate-start"; index: number; step: PipelineStepDef; attempt: number }
  | { type: "gate-end"; index: number; step: PipelineStepDef; gate: GateResult }
  | { type: "step-end"; index: number; step: PipelineStepDef; result: StepExecution }
  | { type: "run-end"; state: RunState };

export interface PipelineResult {
  runDir: string;
  state: RunState;
}

const MAX_DIFF_CHARS = 30_000;

export function validateRunId(runId: string): void {
  if (!/^run-[0-9A-Za-z]+$/.test(runId)) {
    throw new Error(`invalid run id: ${runId} (expected run-<label>)`);
  }
}

export function runDirFor(projectDir: string, runId: string): string {
  validateRunId(runId);
  return path.join(projectDir, ".deus", "runs", runId);
}

export function makeRunId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(".", "");
  return `run-${stamp}`;
}

export function loadRunState(projectDir: string, runId: string): RunState {
  const file = path.join(runDirFor(projectDir, runId), "run.json");
  if (!fs.existsSync(file)) {
    throw new Error(`checkpoint not found: ${file}`);
  }
  let state: RunState;
  try {
    state = JSON.parse(fs.readFileSync(file, "utf-8")) as RunState;
  } catch {
    throw new Error(`checkpoint ${file} is not valid JSON`);
  }
  if (state.version !== 1) {
    throw new Error(`unsupported checkpoint version: ${state.version}`);
  }
  return state;
}

function saveRunState(runDir: string, state: RunState): void {
  fs.mkdirSync(runDir, { recursive: true });
  const file = path.join(runDir, "run.json");
  const tmp = `${file}.tmp`;
  state.updatedAt = new Date().toISOString();
  state.cost = totalCost(state);
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
  fs.renameSync(tmp, file);
}

/** Persists a state that was changed outside of runPipeline, e.g. by apply. */
export function persistRunState(runDir: string, state: RunState): void {
  saveRunState(runDir, state);
  writeRunSummary(runDir, state);
}

function compileTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(task|prev|diff)\}/g, (match, key: string) => {
    return values[key] ?? match;
  });
}

function git(workDir: string, args: string[]): string {
  return execFileSync("git", ["-C", workDir, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 10 * 1024 * 1024,
  });
}

export function collectDiff(workDir: string): string {
  try {
    git(workDir, ["rev-parse", "--is-inside-work-tree"]);
    const status = git(workDir, ["status", "--porcelain"]).trim();
    const diff = git(workDir, ["diff", "HEAD", "--no-color", "--", "."]);
    const body = [
      status ? `### git status\n${status}` : "",
      diff.trim() ? `### git diff\n${diff}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    if (!body) return "(no changes)";
    return body.length > MAX_DIFF_CHARS
      ? `${body.slice(0, MAX_DIFF_CHARS)}\n\n… diff truncated`
      : body;
  } catch {
    return "(not a git repository)";
  }
}

function hasWorktreeChanges(workDir: string, baseCommit?: string): boolean {
  try {
    if (git(workDir, ["status", "--porcelain"]).trim()) return true;
    if (!baseCommit) return false;
    return git(workDir, ["rev-parse", "HEAD"]).trim() !== baseCommit;
  } catch {
    return true;
  }
}

function worktreeFingerprint(workDir: string): string | undefined {
  try {
    return `${git(workDir, ["rev-parse", "HEAD"]).trim()}\n${git(workDir, ["status", "--porcelain"]).trim()}`;
  } catch {
    return undefined;
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function totalCost(state: RunState): number {
  const steps = state.steps.reduce(
    (sum, step) => sum + (step.cost ?? 0) + (step.priorCost ?? 0),
    0,
  );
  const planner = (state.planner?.cost ?? 0) + (state.planner?.priorCost ?? 0);
  const resolution = state.apply?.resolution?.cost ?? 0;
  return steps + planner + resolution;
}

function stepFileName(index: number, id: string): string {
  return `step-${String(index).padStart(2, "0")}-${id}.md`;
}

function formatGateFeedback(gate: GateResult): string {  return gate.checks
    .filter((check) => check.status !== "passed")
    .map((check) =>
      [
        `### ${check.name}: ${check.command}`,
        `Status: ${check.status}, exit: ${check.exitCode ?? "none"}`,
        "",
        check.output || "(no output)",
      ].join("\n"),
    )
    .join("\n\n");
}

function writeStepArtifact(
  runDir: string,
  index: number,
  step: PipelineStepDef,
  result: StepExecution,
  suffix = "",
): void {
  const name = `${stepFileName(index, step.id).replace(/\.md$/, "")}${suffix}.md`;
  const lines: Array<string | undefined> = [
    `# Step ${String(index).padStart(2, "0")} — ${step.id}`,
    "",
    `- Agent: \`${result.agent}\``,
    `- Session: \`${result.sessionID || "none"}\``,
    result.attempt ? `- Attempt: ${result.attempt}` : undefined,
    `- Status: **${result.status}**`,
    `- Duration: ${formatDuration(result.durationMs)}`,
    `- Cost: ${result.costEstimated ? "~" : ""}$${(result.cost ?? 0).toFixed(4)}`,
    result.tokens
      ? `- Tokens: ${result.tokens.input} in / ${result.tokens.output} out / ${result.tokens.reasoning} reasoning`
      : undefined,
    result.error ? `- Error: ${result.error}` : undefined,
    "",
    "## Output",
    "",
    result.text || "(empty)",
  ];

  if (result.gate) {
    lines.push("", "## Checks", "");
    if (result.gate.baselineStatus) {
      lines.push(`- Baseline: **${result.gate.baselineStatus}**`);
    }
    for (const check of result.gate.checks) {
      lines.push(
        `- **${check.status}** \`${check.name}\`: ${check.command} (${formatDuration(check.durationMs)}, exit ${check.exitCode ?? "none"})`,
      );
    }
    for (const warning of result.gate.warnings ?? []) {
      lines.push(`- Warning: ${warning}`);
    }

    for (const check of result.gate.checks.filter((item) => item.status !== "passed")) {
      lines.push("", `### ${check.name} output`, "", "~~~", check.output || "(no output)", "~~~");
    }
  }

  if (result.permissionDecisions.length > 0) {
    lines.push("", "## Permission decisions", "");
    for (const decision of result.permissionDecisions) {
      lines.push(
        `- **${decision.decision}** \`${decision.action} ${decision.resources.join(" ")}\` — ${decision.reason}`,
      );
    }
  }

  fs.writeFileSync(
    path.join(runDir, name),
    `${lines.filter((line): line is string => line !== undefined).join("\n")}\n`,
    "utf-8",
  );
}

function writePlannerArtifact(runDir: string, result: StepExecution): void {
  fs.writeFileSync(
    path.join(runDir, "planner.md"),
    `${[
      "# Planner",
      "",
      `- Agent: \`${result.agent}\``,
      `- Session: \`${result.sessionID || "none"}\``,
      result.attempt ? `- Attempt: ${result.attempt}` : "",
      `- Status: **${result.status}**`,
      `- Duration: ${formatDuration(result.durationMs)}`,
      `- Cost: ${result.costEstimated ? "~" : ""}$${(result.cost ?? 0).toFixed(4)}`,
      result.error ? `- Error: ${result.error}` : "",
      "",
      "## Output",
      "",
      result.text || "(empty)",
    ]
      .filter((line) => line !== "")
      .join("\n")}\n`,
    "utf-8",
  );
}

export function writeRunSummary(runDir: string, state: RunState): void {
  const lines: Array<string | undefined> = [
    `# Deus V2 run ${state.runId}`,
    "",
    `- Pipeline: \`${state.pipeline}\``,
    `- Status: **${state.status}**`,
    `- Model: \`${state.model}\``,
    `- Project: \`${state.projectDir}\``,
    `- Work dir: \`${state.workDir}\``,
    `- Worktree: ${state.worktree ? "yes" : "no"}`,
    state.baseCommit ? `- Base commit: \`${state.baseCommit.slice(0, 7)}\`` : undefined,
    state.baseline ? `- Baseline: **${state.baseline.status}**` : undefined,
    `- Cost: $${totalCost(state).toFixed(4)}`,
    state.planner
      ? `- Planner: \`${state.planner.agent}\` (${formatDuration(state.planner.durationMs)}, $${((state.planner.cost ?? 0) + (state.planner.priorCost ?? 0)).toFixed(4)})`
      : undefined,
    state.apply ? `- Apply: **${state.apply.status}**${state.apply.branch ? ` (${state.apply.branch})` : ""}` : undefined,
    state.apply?.resolution
      ? `- Conflict resolution: **${state.apply.resolution.status}** (${formatDuration(state.apply.resolution.durationMs)}, $${(state.apply.resolution.cost ?? 0).toFixed(4)})`
      : undefined,
    state.error ? `- Error: ${state.error}` : undefined,
    "",
    "## Task",
    "",
    state.task,
  ];

  if (state.plan && state.plan.length > 0) {
    lines.push("", "## Plan", "");
    for (const step of state.plan) {
      lines.push(`- \`${step.id}\` — ${step.agent} (${step.mode}): ${step.task.split("\n")[0]}`);
    }
  }

  lines.push(
    "",
    "## Steps",
    "",
    "| # | Step | Agent | Checks | Status | Duration |",
    "|---|---|---|---|---|---|",
    ...state.steps.map(
      (step, index) =>
        `| ${index} | [${step.stepId}](${stepFileName(index, step.stepId)}) | ${step.agent} | ${step.gate?.status ?? "—"} | ${step.status} | ${formatDuration(step.durationMs)} |`,
    ),
  );

  fs.writeFileSync(
    path.join(runDir, "run.md"),
    `${lines.filter((line): line is string => line !== undefined).join("\n")}\n`,
    "utf-8",
  );
}

function validateResume(state: RunState, steps: PipelineStepDef[]): void {
  for (let i = 0; i < state.steps.length; i++) {
    if (state.steps[i].status !== "succeeded") continue;
    if (steps[i]?.id !== state.steps[i].stepId) {
      throw new Error(
        `cannot resume: pipeline step ${i} changed from "${state.steps[i].stepId}" to "${steps[i]?.id ?? "missing"}"`,
      );
    }
  }
}

/**
 * Executes a deterministic step sequence. Each successful step is persisted
 * before the next one starts, so a killed run can resume without repeating
 * side effects. Steps marked with `gate` are verified by real project checks
 * and retried with the failure output attached.
 */
export async function runPipeline(options: RunPipelineOptions): Promise<PipelineResult> {
  const runDir = runDirFor(options.projectDir, options.runId);
  fs.mkdirSync(runDir, { recursive: true });

  const planToWrite = options.plan ?? options.resume?.plan;
  if (planToWrite?.length) {
    const planFile = path.join(runDir, "plan.json");
    if (!fs.existsSync(planFile)) {
      fs.writeFileSync(
        planFile,
        `${JSON.stringify({ goal: options.task, steps: planToWrite }, null, 2)}\n`,
        "utf-8",
      );
    }
  }

  const now = new Date().toISOString();
  const state: RunState = options.resume
    ? { ...options.resume, status: "running", error: undefined }
    : {
        version: 1,
        runId: options.runId,
        projectDir: options.projectDir,
        workDir: options.workDir,
        worktree: options.worktree,
        baseCommit: options.baseCommit,
        baseBranch: options.baseBranch,
        pipeline: options.pipeline,
        task: options.task,
        model: options.model,
        status: "running",
        plan: options.plan,
        createdAt: now,
        updatedAt: now,
        steps: [],
      };

  if (options.resume) {
    state.model = options.model;
  }

  const finish = (status: RunState["status"], error?: string): PipelineResult => {    state.status = status;
    state.error = error;
    saveRunState(runDir, state);
    writeRunSummary(runDir, state);
    options.onProgress?.({ type: "run-end", state });
    return { runDir, state };
  };

  if (!fs.existsSync(state.workDir)) {
    throw new Error(`work dir does not exist: ${state.workDir}`);
  }

  if (options.planner && !state.plan) {
    const priorPlannerCost =
      options.resume && state.planner
        ? (state.planner.cost ?? 0) + (state.planner.priorCost ?? 0)
        : 0;

    const outcome = await generatePlan(options.executor, {
      task: options.task,
      agents: options.planner.agents,
      agent: options.planner.agent,
      workDir: state.workDir,
      runId: options.runId,
      timeoutMs: options.timeoutMs,
      maxAttempts: options.planner.maxAttempts,
      signal: options.signal,
      onAttempt: (attempt) => options.onProgress?.({ type: "planner-start", attempt }),
    });

    state.planner = outcome.execution;
    state.planner.priorCost = (state.planner.priorCost ?? 0) + priorPlannerCost;
    options.onProgress?.({ type: "planner-end", result: outcome.execution, plan: outcome.plan?.steps });
    writePlannerArtifact(runDir, outcome.execution);

    if (!outcome.plan) {
      const interrupted = options.signal?.aborted === true;
      return finish(
        interrupted ? "interrupted" : "failed",
        interrupted ? "run interrupted" : (outcome.error ?? "planner failed"),
      );
    }

    state.plan = outcome.plan.steps;
    fs.writeFileSync(
      path.join(runDir, "plan.json"),
      `${JSON.stringify(outcome.plan, null, 2)}\n`,
      "utf-8",
    );
    saveRunState(runDir, state);

    if (options.maxCost !== undefined && totalCost(state) > options.maxCost) {
      return finish(
        "failed",
        `cost limit exceeded: $${totalCost(state).toFixed(4)} > $${options.maxCost.toFixed(4)}`,
      );
    }
  }

  const steps = state.plan?.length ? planToSteps(state.plan) : options.steps;
  if (steps.length === 0) {
    throw new Error("no pipeline steps to run");
  }

  const checks = options.checks ?? [];
  const needsBaseline =
    options.baseline !== false &&
    checks.length > 0 &&
    steps.some((step) => step.gate === true);

  if (needsBaseline && !state.baseline) {
    if (options.resume) {
      state.baseline = {
        status: "skipped",
        checks: [],
        durationMs: 0,
        warnings: ["baseline is unavailable for this checkpoint; checks are strict"],
      };
      saveRunState(runDir, state);
    } else {
      options.onProgress?.({ type: "baseline-start" });
      const baseline = runGate(checks, state.workDir, {
        timeoutMs: options.checkTimeoutMs,
        stopOnFirstFailure: false,
      });
      state.baseline = baseline;
      options.onProgress?.({ type: "baseline-end", gate: baseline });
      saveRunState(runDir, state);
    }
  }

  if (options.resume) validateResume(state, steps);

  const effectiveBaseline = options.baseline === false ? undefined : state.baseline;

  let previous = state.planner?.text ?? "";
  for (const step of state.steps) {
    if (step.status === "succeeded") previous = step.text;
  }

  saveRunState(runDir, state);

  const runStep = async (
    index: number,
    step: PipelineStepDef,
    prompt: string,
    initialFeedback: string,
    initialPriorCost: number,
  ): Promise<StepExecution> => {
    const gated = step.gate === true && checks.length > 0;
    const maxAttempts = gated ? Math.max(1, options.maxAttempts ?? 2) : 1;
    let priorCost = initialPriorCost;
    let feedback = initialFeedback;

    const preExisting =
      state.steps[index] !== undefined &&
      hasWorktreeChanges(state.workDir, state.baseCommit);
    const beforeFingerprint = worktreeFingerprint(state.workDir);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const attemptPrompt = feedback
        ? `${prompt}\n\n## Проверка не прошла\n\nПрошлая попытка не прошла проверку. Исправь причину, не удаляй и не отключай тесты. Если тест сам неверен — измени его минимально и объясни почему.\n\n${feedback}`
        : prompt;

      const result = await options.executor.run({
        step,
        prompt: attemptPrompt,
        runId: options.runId,
        index,
        workDir: state.workDir,
        timeoutMs: step.timeoutMs ?? options.timeoutMs,
        signal: options.signal,
      });

      result.attempt = attempt;
      result.priorCost = priorCost;

      if (result.status !== "succeeded") return result;

      const afterFingerprint = worktreeFingerprint(state.workDir);
      if (
        step.requireChanges &&
        !preExisting &&
        beforeFingerprint !== undefined &&
        afterFingerprint !== undefined &&
        afterFingerprint === beforeFingerprint
      ) {
        result.status = "failed";
        result.error = "step produced no changes";
        return result;
      }

      if (!gated) return result;

      options.onProgress?.({ type: "gate-start", index, step, attempt });
      const current = runGate(checks, state.workDir, {
        timeoutMs: options.checkTimeoutMs,
        stopOnFirstFailure: effectiveBaseline?.status !== "failed",
      });
      const gate = applyBaseline(effectiveBaseline, current);
      result.gate = gate;
      options.onProgress?.({ type: "gate-end", index, step, gate });

      if (gate.status !== "failed") return result;

      const spent =
        totalCost(state) - initialPriorCost + priorCost + (result.cost ?? 0);
      if (options.maxCost !== undefined && spent > options.maxCost) {
        result.status = "failed";
        result.error = `cost limit exceeded: $${spent.toFixed(4)} > $${options.maxCost.toFixed(4)}`;
        return result;
      }

      if (attempt === maxAttempts) {
        result.status = "failed";
        result.error = gate.error ?? "checks failed";
        return result;
      }

      writeStepArtifact(runDir, index, step, result, `-attempt-${attempt}`);
      priorCost += result.cost ?? 0;
      feedback = formatGateFeedback(gate);
      options.onProgress?.({ type: "step-retry", index, step, attempt: attempt + 1, maxAttempts });
    }

    throw new Error("unreachable: step loop ended without a result");
  };

  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    const existing = state.steps[index];

    if (options.signal?.aborted) {
      return finish("interrupted", "run interrupted");
    }

    if (existing?.status === "succeeded") {
      previous = existing.text;
      options.onProgress?.({ type: "step-skip", index, step });
      continue;
    }

    options.onProgress?.({ type: "step-start", index, step });

    const prompt = compileTemplate(step.task, {
      task: options.task,
      prev: previous,
      diff: collectDiff(state.workDir),
    });

    const initialFeedback =
      existing?.status === "failed" && existing.gate?.status === "failed"
        ? formatGateFeedback(existing.gate)
        : "";

    const carriedCost = existing
      ? (existing.cost ?? 0) + (existing.priorCost ?? 0)
      : 0;

    const result = await runStep(index, step, prompt, initialFeedback, carriedCost);

    state.steps[index] = result;
    options.onProgress?.({ type: "step-end", index, step, result });
    writeStepArtifact(runDir, index, step, result);
    saveRunState(runDir, state);

    if (result.status !== "succeeded") {
      const interrupted =
        options.signal?.aborted === true || result.error === "run interrupted";
      return finish(
        interrupted ? "interrupted" : "failed",
        interrupted ? "run interrupted" : (result.error ?? "step failed"),
      );
    }

    previous = result.text;

    if (options.maxCost !== undefined && totalCost(state) > options.maxCost) {
      return finish(
        "failed",
        `cost limit exceeded: $${totalCost(state).toFixed(4)} > $${options.maxCost.toFixed(4)}`,
      );
    }
  }

  return finish("succeeded");
}
