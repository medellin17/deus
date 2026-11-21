import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { Executor, PipelineStepDef, RunState, StepExecution } from "./types.ts";

export interface RunPipelineOptions {
  steps: PipelineStepDef[];
  pipeline: string;
  task: string;
  runId: string;
  projectDir: string;
  workDir: string;
  worktree: boolean;
  model: string;
  timeoutMs: number;
  maxCost?: number;
  executor: Executor;
  resume?: RunState;
  signal?: AbortSignal;
  onProgress?: (event: PipelineProgress) => void;
}

export type PipelineProgress =
  | { type: "step-start"; index: number; step: PipelineStepDef }
  | { type: "step-skip"; index: number; step: PipelineStepDef }
  | { type: "step-end"; index: number; step: PipelineStepDef; result: StepExecution }
  | { type: "run-end"; state: RunState };

export interface PipelineResult {
  runDir: string;
  state: RunState;
}

const MAX_DIFF_CHARS = 30_000;

export function runDirFor(projectDir: string, runId: string): string {
  return path.join(projectDir, ".deus", "runs", runId);
}

export function makeRunId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
  return `run-${stamp}`;
}

export function loadRunState(projectDir: string, runId: string): RunState {
  const file = path.join(runDirFor(projectDir, runId), "run.json");
  if (!fs.existsSync(file)) {
    throw new Error(`checkpoint not found: ${file}`);
  }
  const state = JSON.parse(fs.readFileSync(file, "utf-8")) as RunState;
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

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function totalCost(state: RunState): number {
  return state.steps.reduce((sum, step) => sum + (step.cost ?? 0), 0);
}

function stepFileName(index: number, id: string): string {
  return `step-${String(index).padStart(2, "0")}-${id}.md`;
}

function writeStepArtifact(
  runDir: string,
  index: number,
  step: PipelineStepDef,
  result: StepExecution,
): void {
  const name = stepFileName(index, step.id);
  const lines: Array<string | undefined> = [
    `# Step ${String(index).padStart(2, "0")} — ${step.id}`,
    "",
    `- Agent: \`${result.agent}\``,
    `- Session: \`${result.sessionID || "none"}\``,
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

function writeSummary(runDir: string, state: RunState): void {
  const lines: Array<string | undefined> = [
    `# Deus V2 run ${state.runId}`,
    "",
    `- Pipeline: \`${state.pipeline}\``,
    `- Status: **${state.status}**`,
    `- Model: \`${state.model}\``,
    `- Project: \`${state.projectDir}\``,
    `- Work dir: \`${state.workDir}\``,
    `- Worktree: ${state.worktree ? "yes" : "no"}`,
    `- Cost: $${totalCost(state).toFixed(4)}`,
    state.error ? `- Error: ${state.error}` : undefined,
    "",
    "## Task",
    "",
    state.task,
    "",
    "## Steps",
    "",
    "| # | Step | Agent | Status | Duration |",
    "|---|---|---|---|---|",
    ...state.steps.map(
      (step, index) =>
        `| ${index} | [${step.stepId}](${stepFileName(index, step.stepId)}) | ${step.agent} | ${step.status} | ${formatDuration(step.durationMs)} |`,
    ),
  ];

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
 * side effects.
 */
export async function runPipeline(options: RunPipelineOptions): Promise<PipelineResult> {
  const runDir = runDirFor(options.projectDir, options.runId);
  fs.mkdirSync(runDir, { recursive: true });

  const now = new Date().toISOString();
  const state: RunState = options.resume
    ? { ...options.resume, status: "running", error: undefined }
    : {
        version: 1,
        runId: options.runId,
        projectDir: options.projectDir,
        workDir: options.workDir,
        worktree: options.worktree,
        pipeline: options.pipeline,
        task: options.task,
        model: options.model,
        status: "running",
        createdAt: now,
        updatedAt: now,
        steps: [],
      };

  if (options.resume) validateResume(state, options.steps);

  if (!fs.existsSync(state.workDir)) {
    throw new Error(`work dir does not exist: ${state.workDir}`);
  }

  let previous = "";
  for (const step of state.steps) {
    if (step.status === "succeeded") previous = step.text;
  }

  saveRunState(runDir, state);

  for (let index = 0; index < options.steps.length; index++) {
    const step = options.steps[index];
    const existing = state.steps[index];

    if (options.signal?.aborted) {
      state.status = "interrupted";
      state.error = "run interrupted";
      saveRunState(runDir, state);
      writeSummary(runDir, state);
      options.onProgress?.({ type: "run-end", state });
      return { runDir, state };
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

    const result = await options.executor.run({
      step,
      prompt,
      runId: options.runId,
      index,
      workDir: state.workDir,
      timeoutMs: step.timeoutMs ?? options.timeoutMs,
      signal: options.signal,
    });

    state.steps[index] = result;
    options.onProgress?.({ type: "step-end", index, step, result });
    writeStepArtifact(runDir, index, step, result);
    saveRunState(runDir, state);

    if (result.status !== "succeeded") {
      const interrupted = options.signal?.aborted === true;
      state.status = interrupted ? "interrupted" : "failed";
      state.error = interrupted ? "run interrupted" : (result.error ?? "step failed");
      saveRunState(runDir, state);
      writeSummary(runDir, state);
      options.onProgress?.({ type: "run-end", state });
      return { runDir, state };
    }

    previous = result.text;

    if (options.maxCost !== undefined && totalCost(state) > options.maxCost) {
      state.status = "failed";
      state.error = `cost limit exceeded: $${totalCost(state).toFixed(4)} > $${options.maxCost.toFixed(4)}`;
      saveRunState(runDir, state);
      writeSummary(runDir, state);
      options.onProgress?.({ type: "run-end", state });
      return { runDir, state };
    }
  }

  state.status = "succeeded";
  saveRunState(runDir, state);
  writeSummary(runDir, state);
  options.onProgress?.({ type: "run-end", state });
  return { runDir, state };
}
