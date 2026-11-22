import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadAgents } from "./agents.ts";
import { applyRun } from "./apply.ts";
import { BoardError, openBoard, type Board } from "./board.ts";
import { createOpenCodeClient } from "./client.ts";
import { loadConfig, resolveChecks, type DeusConfig } from "./config.ts";
import { SessionExecutor } from "./executor.ts";
import { loadPolicy } from "./permissions.ts";
import {
  loadRunState,
  makeRunId,
  persistRunState,
  runDirFor,
  runPipeline,
  type PipelineProgress,
} from "./pipeline.ts";
import { generatePlan, planToSteps, validatePlan } from "./planner.ts";
import { getPipeline } from "./pipelines.ts";
import {
  isWakeDisabled,
  leadSessionFile,
  openWake,
  openWakeReadonly,
  registerLeadSession,
  runWave,
} from "./wake.ts";
import { loadRegistry, agentModel } from "./registry.ts";
import type { ApplyResult, PipelineStepDef, PlanStep, RunState } from "./types.ts";
import { prepareWorkdir, removeWorkdir } from "./worktree.ts";

const DEFAULT_MODEL = "opencode-go/hy4-flash-free#high";
const DEFAULT_TIMEOUT_SECONDS = 15 * 60;

interface CliOptions {
  pipeline: string;
  pipelineExplicit: boolean;
  cwd: string;
  resume?: string;
  model: string;
  modelExplicit: boolean;
  timeoutSeconds: number;
  timeoutExplicit: boolean;
  maxCost?: number;
  maxCostExplicit: boolean;
  worktree: boolean;
  worktreeExplicit: boolean;
  merge: boolean;
  mergeExplicit: boolean;
  gate: boolean;
  baseline: boolean;
  baselineExplicit: boolean;
  policy?: string;
  cleanup: boolean;
  json: boolean;
  smoke: boolean;
  board: boolean;
  wake: boolean;
  wakeStatus: boolean;
  wakeRegister?: string;
  wakeMaxCost?: number;
  wakeMaxSteps?: number;
  wakeMaxWallMs?: number;
  wakeCoalesceMs?: number;
  direct: boolean;
  agent?: string;
  planOnly: boolean;
  fromPlan?: string;
  task: string;
}

function printHelp(): void {
  console.log(`Deus V2 runner

Usage:
  node --import tsx src/v2/cli.ts [options] "task"
  node --import tsx src/v2/cli.ts --smoke
  node --import tsx src/v2/cli.ts --board --cwd <project>
  node --import tsx src/v2/cli.ts --wake --cwd <project>
  node --import tsx src/v2/cli.ts --wake-status --cwd <project>
  node --import tsx src/v2/cli.ts --plan-only "task"
  node --import tsx src/v2/cli.ts --from-plan plan.json "task"
  node --import tsx src/v2/cli.ts --resume <runId> --cwd <project>

Options:
  --pipeline <name>    Pipeline: build, fix, audit, auto (default: build)
  --direct             Run one agent on the task (no pipeline)
  --agent <id>         Agent for --direct (default: build)
  --cwd <path>         Project directory (default: current directory)
  --resume <runId>     Resume a checkpointed run
  --plan-only          Ask the planner for a plan and exit
  --from-plan <file>   Run a plan produced by --plan-only
  --board              Print the task board and exit (read-only)
  --wake               Deliver one wave of pending wake events and exit
  --wake-status        Print the wake outbox and exit (read-only)
  --wake-register <id> Record the team lead's session for wake delivery
  --wake-max-cost <usd>  Soft per-wave ceiling on reconciled cost (default: 1.00)
  --wake-max-steps <n>   Hard wave ceiling on delivered messages (default: 20)
  --wake-max-wall-ms <ms> Hard wave ceiling on wall clock (default: 1800000)
  --wake-coalesce-ms <ms> Coalesce events per recipient (0 disables, default: 30000)
  --model <ref>        provider/model#variant (default: ${DEFAULT_MODEL})
  --timeout <seconds>  Per-step timeout (default: ${DEFAULT_TIMEOUT_SECONDS})
  --max-cost <usd>     Abort after the total cost exceeds this value
  --policy <file>      JSON permission policy
  --no-worktree        Run in the project directory instead of a git worktree
  --worktree           Force a git worktree even if deus.json disables it
  --no-gate            Do not run project checks
  --no-baseline        Do not compare checks with the untouched worktree
  --baseline           Force baseline comparison even if deus.json disables it
  --merge              Merge a successful run (default)
  --no-merge           Keep the deus/run-* branch without merging
  --cleanup            Remove the worktree after a successful run
  --json               Print the final run state as JSON
  --smoke              Check service, model and session flow without a project
  --help               Show this help
`);
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    pipeline: "build",
    pipelineExplicit: false,
    cwd: process.cwd(),
    model: DEFAULT_MODEL,
    modelExplicit: false,
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    timeoutExplicit: false,
    maxCostExplicit: false,
    worktree: true,
    worktreeExplicit: false,
    merge: true,
    mergeExplicit: false,
    gate: true,
    baseline: true,
    baselineExplicit: false,
    cleanup: false,
    json: false,
    smoke: false,
    board: false,
    wake: false,
    wakeStatus: false,
    direct: false,
    planOnly: false,
    task: "",
  };

  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`missing value for ${arg}`);
      return value;
    };

    switch (arg) {
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      case "--pipeline":
        options.pipeline = next();
        options.pipelineExplicit = true;
        break;
      case "--cwd":
        options.cwd = path.resolve(next());
        break;
      case "--resume":
        options.resume = next();
        break;
      case "--model":
        options.model = next();
        options.modelExplicit = true;
        break;
      case "--timeout":
        options.timeoutSeconds = Number(next());
        if (!Number.isFinite(options.timeoutSeconds) || options.timeoutSeconds <= 0) {
          throw new Error("--timeout must be a positive number of seconds");
        }
        options.timeoutExplicit = true;
        break;
      case "--max-cost":
        options.maxCost = Number(next());
        if (!Number.isFinite(options.maxCost) || options.maxCost < 0) {
          throw new Error("--max-cost must be a non-negative number");
        }
        options.maxCostExplicit = true;
        break;
      case "--policy":
        options.policy = path.resolve(next());
        break;
      case "--no-worktree":
        options.worktree = false;
        options.worktreeExplicit = true;
        break;
      case "--worktree":
        options.worktree = true;
        options.worktreeExplicit = true;
        break;
      case "--no-gate":
        options.gate = false;
        break;
      case "--no-baseline":
        options.baseline = false;
        options.baselineExplicit = true;
        break;
      case "--baseline":
        options.baseline = true;
        options.baselineExplicit = true;
        break;
      case "--merge":
        options.merge = true;
        options.mergeExplicit = true;
        break;
      case "--no-merge":
        options.merge = false;
        options.mergeExplicit = true;
        break;
      case "--cleanup":
        options.cleanup = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--smoke":
        options.smoke = true;
        break;
      case "--board":
        options.board = true;
        break;
      case "--wake":
        options.wake = true;
        break;
      case "--wake-status":
        options.wakeStatus = true;
        break;
      case "--wake-register":
        options.wakeRegister = next();
        break;
      case "--wake-max-cost":
        options.wakeMaxCost = Number(next());
        if (!Number.isFinite(options.wakeMaxCost) || options.wakeMaxCost < 0) {
          throw new Error("--wake-max-cost must be a non-negative number");
        }
        break;
      case "--wake-max-steps":
        options.wakeMaxSteps = Number(next());
        if (!Number.isInteger(options.wakeMaxSteps) || options.wakeMaxSteps <= 0) {
          throw new Error("--wake-max-steps must be a positive integer");
        }
        break;
      case "--wake-max-wall-ms":
        options.wakeMaxWallMs = Number(next());
        if (!Number.isFinite(options.wakeMaxWallMs) || options.wakeMaxWallMs <= 0) {
          throw new Error("--wake-max-wall-ms must be a positive number");
        }
        break;
      case "--wake-coalesce-ms":
        options.wakeCoalesceMs = Number(next());
        if (!Number.isFinite(options.wakeCoalesceMs) || options.wakeCoalesceMs < 0) {
          throw new Error("--wake-coalesce-ms must be a non-negative number");
        }
        break;
      case "--direct":
        options.direct = true;
        break;
      case "--agent":
        options.agent = next();
        break;
      case "--plan-only":
        options.planOnly = true;
        break;
      case "--from-plan":
        options.fromPlan = path.resolve(next());
        break;
      case "--":
        positional.push(...argv.slice(i + 1));
        i = argv.length;
        break;
      default:
        if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);
        positional.push(arg);
    }
  }

  options.task = positional.join(" ").trim();
  if (options.wake && options.wakeRegister !== undefined) {
    throw new Error("--wake-register cannot be combined with --wake");
  }
  return options;
}

function ensureDeusDir(dir: string): void {
  fs.mkdirSync(path.join(dir, ".deus", "kb"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".deus", "runs"), { recursive: true });
  const gitignore = path.join(dir, ".deus", ".gitignore");
  if (!fs.existsSync(gitignore)) {
    fs.writeFileSync(gitignore, "# Deus runtime data\n*\n", "utf-8");
  }
}

function log(message: string): void {
  console.error(message);
}

function formatCost(cost?: number, estimated?: boolean): string {
  return `${estimated ? "~" : ""}$${(cost ?? 0).toFixed(4)}`;
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function printProgress(event: PipelineProgress): void {
  switch (event.type) {
    case "baseline-start":
      log("[baseline] running checks on the untouched worktree ...");
      break;
    case "baseline-end":
      log(`[baseline] checks ${event.gate.status} (${formatDuration(event.gate.durationMs)})`);
      break;
    case "planner-start":
      log(`[planner] attempt ${event.attempt} ...`);
      break;
    case "planner-end": {
      const { result, plan } = event;
      const status =
        result.status === "succeeded"
          ? `${plan?.length ?? 0} step(s)`
          : `failed: ${result.error}`;
      log(
        `[planner] ${status} (${formatDuration(result.durationMs)}, ${formatCost(result.cost, result.costEstimated)})`,
      );
      break;
    }
    case "step-start":
      log(`[${event.index + 1}] ${event.step.id} (${event.step.agent}) ...`);
      break;
    case "step-skip":
      log(`[${event.index + 1}] ${event.step.id} — already completed`);
      break;
    case "step-retry":
      log(
        `[${event.index + 1}] ${event.step.id} — checks failed, retry ${event.attempt}/${event.maxAttempts}`,
      );
      break;
    case "gate-start":
      log(`[${event.index + 1}] ${event.step.id} — checks (attempt ${event.attempt}) ...`);
      break;
    case "gate-end": {
      const warnings = event.gate.warnings?.length ?? 0;
      log(
        `[${event.index + 1}] ${event.step.id} — checks ${event.gate.status}${warnings > 0 ? `, ${warnings} warning(s)` : ""} (${formatDuration(event.gate.durationMs)})`,
      );
      break;
    }
    case "step-end": {
      const { result } = event;
      const status = result.status === "succeeded" ? "ok" : `failed: ${result.error}`;
      log(
        `[${event.index + 1}] ${event.step.id} — ${status} (${formatDuration(result.durationMs)}, ${formatCost(result.cost, result.costEstimated)})`,
      );
      break;
    }
    case "run-end":
      log(`run ${event.state.status}: ${event.state.runId}`);
      break;
  }
}

function printApply(result: ApplyResult): void {
  if (result.status === "merged") {
    const extra = result.resolution ? ", conflicts resolved" : "";
    log(`apply:    merged ${result.branch} -> ${result.commit}${extra}`);
    return;
  }
  if (result.status === "branch") {
    log(`apply:    branch ${result.branch} (${result.reason ?? "not merged"})`);
    if (result.mergeCommand) log(`merge:    ${result.mergeCommand}`);
    return;
  }
  if (result.status === "no-changes") {
    log("apply:    no changes");
    return;
  }
  log(`apply:    skipped (${result.reason ?? "unknown"})`);
}

function printHumanResult(result: { runDir: string; state: RunState }): void {
  const { state } = result;
  log("");
  log(`run:      ${state.runId}`);
  log(`status:   ${state.status}`);
  log(`pipeline: ${state.pipeline}`);
  log(`model:    ${state.model}`);
  log(`workdir:  ${state.workDir}`);
  log(`cost:     ~$${(state.cost ?? 0).toFixed(4)}`);
  if (state.baseline) log(`baseline: ${state.baseline.status}`);
  log(`artifacts: ${result.runDir}`);
  if (state.apply) printApply(state.apply);
  const warnings = [
    ...(state.baseline?.warnings ?? []),
    ...state.steps.flatMap((step) => step.gate?.warnings ?? []),
  ];
  for (const warning of [...new Set(warnings)]) log(`warning:  ${warning}`);
  if (state.error) log(`error:    ${state.error}`);
}

function warnAboutDirtyTree(projectDir: string): void {
  try {
    const status = execFileSync("git", ["-C", projectDir, "status", "--porcelain"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (status) {
      log(
        "warning: the project has uncommitted changes; the worktree starts from HEAD and does not include them",
      );
    }
  } catch {
    // Not a git repository; prepareWorkdir already handles the fallback.
  }
}

function resolvePolicyPath(
  options: CliOptions,
  config: DeusConfig,
  projectDir: string,
): string {
  if (options.policy) {
    if (!fs.existsSync(options.policy)) {
      throw new Error(`policy file not found: ${options.policy}`);
    }
    return options.policy;
  }

  if (config.policy) {
    const resolved = path.resolve(projectDir, config.policy);
    if (!fs.existsSync(resolved)) {
      throw new Error(`policy file not found: ${resolved}`);
    }
    return resolved;
  }

  return path.join(projectDir, ".deus", "policy.json");
}

function readPlanFile(file: string): unknown {
  if (!fs.existsSync(file)) {
    throw new Error(`plan file not found: ${file}`);
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (error) {
    throw new Error(
      `plan file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function runSmoke(options: CliOptions, signal: AbortSignal): Promise<number> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "deus-v2-smoke-"));
  const client = await createOpenCodeClient();
  const executor = new SessionExecutor(client, {
    model: options.model,
    policy: loadPolicy(options.policy),
    keepSessions: false,
    onLog: log,
  });

  const step: PipelineStepDef = {
    id: "smoke",
    agent: "build",
    task: "Reply with exactly: deus-ok",
  };

  try {
    const result = await executor.run({
      step,
      prompt: "Reply with exactly: deus-ok. Do not use any tools.",
      runId: "smoke",
      index: 0,
      workDir: tempDir,
      timeoutMs: 120_000,
      signal,
    });

    const ok = result.status === "succeeded" && result.text.includes("deus-ok");
    log(`smoke: ${ok ? "ok" : "failed"}`);
    if (!ok) {
      log(`response: ${JSON.stringify(result.text)}`);
      if (result.error) log(`error: ${result.error}`);
    }
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    }
    return ok ? 0 : 1;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function runPlanOnly(
  options: CliOptions,
  projectDir: string,
  config: DeusConfig,
  signal: AbortSignal,
): Promise<number> {
  if (!options.task) throw new Error("--plan-only requires a task");

  warnAboutDirtyTree(projectDir);

  const runId = makeRunId();
  const model = options.modelExplicit
    ? options.model
    : (config.model ?? DEFAULT_MODEL);
  const timeoutSeconds = options.timeoutExplicit
    ? options.timeoutSeconds
    : (config.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS);
  const maxCost = options.maxCostExplicit ? options.maxCost : config.maxCost;

  const client = await createOpenCodeClient();
  const registry = loadRegistry(projectDir);
  const executor = new SessionExecutor(client, {
    model,
    modelFor: options.modelExplicit
      ? undefined
      : (agent: string) => agentModel(registry, agent, model),
    policy: loadPolicy(resolvePolicyPath(options, config, projectDir)),
    keepSessions: false,
    onLog: log,
  });

  const agents = await loadAgents(client, projectDir);
  const outcome = await generatePlan(executor, {
    task: options.task,
    agents,
    workDir: projectDir,
    runId,
    timeoutMs: timeoutSeconds * 1000,
    signal,
    onAttempt: (attempt) => log(`[planner] attempt ${attempt} ...`),
  });

  log(
    `[planner] ${outcome.plan ? `${outcome.plan.steps.length} step(s)` : "failed"} (${formatDuration(outcome.execution.durationMs)}, ${formatCost(outcome.execution.cost, outcome.execution.costEstimated)})`,
  );

  if (!outcome.plan) {
    log(`error: ${outcome.error ?? "planner failed"}`);
    return 1;
  }

  const spent = (outcome.execution.cost ?? 0) + (outcome.execution.priorCost ?? 0);
  if (maxCost !== undefined && spent > maxCost) {
    log(`error: cost limit exceeded: $${spent.toFixed(4)} > $${maxCost.toFixed(4)}`);
    return 1;
  }

  const runDir = runDirFor(projectDir, runId);
  fs.mkdirSync(runDir, { recursive: true });
  const planFile = path.join(runDir, "plan.json");
  fs.writeFileSync(planFile, `${JSON.stringify(outcome.plan, null, 2)}\n`, "utf-8");

  log(`plan:     ${planFile}`);
  console.log(JSON.stringify(outcome.plan, null, 2));
  return 0;
}

function showBoard(projectDir: string): number {
  let board: Board;
  try {
    board = openBoard(projectDir, { readonly: true });
  } catch (error) {
    if (error instanceof BoardError && error.code === "not_found") {
      console.log("board: not created yet");
      return 0;
    }
    throw error;
  }

  try {
    for (const team of board.listTeams()) {
      console.log(`team ${team.name} (${team.teamId}) — ${team.status}`);
      const tasks = board.list({ teamId: team.teamId });
      if (tasks.length === 0) {
        console.log("  (no tasks)");
        continue;
      }
      for (const task of tasks) {
        const assignee = task.assignee ? ` @${task.assignee}` : "";
        console.log(
          `  [${task.status}] ${task.boardTaskId} ${task.title}${assignee} (attempt ${task.attempt})`,
        );
      }
    }

    const events = board.events({ limit: 20, order: "desc" }).reverse();
    if (events.length > 0) {
      console.log("");
      console.log("recent events:");
      for (const event of events) {
        console.log(
          `  ${event.createdAt} ${event.type} ${event.boardTaskId ?? "-"} (${event.actor})`,
        );
      }
    }
    return 0;
  } finally {
    board.close();
  }
}

async function runWake(
  projectDir: string,
  options: CliOptions,
  signal: AbortSignal,
): Promise<number> {
  // Registration is configuration, not delivery: the kill-switch must not
  // silence it.
  if (options.wakeRegister !== undefined) {
    const sessionID = options.wakeRegister;
    const client = await createOpenCodeClient();
    try {
      await client.session.get({ sessionID });
    } catch (error) {
      log(
        `wake: session is not readable: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 1;
    }
    registerLeadSession(projectDir, sessionID, options.agent ?? "main");
    log(`wake: team lead session recorded -> ${leadSessionFile(projectDir)}`);
    return 0;
  }

  const dbFile = path.join(projectDir, ".deus", "board.db");
  if (!fs.existsSync(dbFile)) {
    log("wake: board is not created yet; nothing to deliver");
    return 0;
  }

  if (isWakeDisabled(projectDir)) {
    const queue = openWakeReadonly(projectDir);
    if (!queue) {
      log("wake: disabled by kill-switch; outbox is not created yet");
      return 0;
    }
    const pending = queue.stats().pending;
    queue.close();
    log(`wake: disabled by kill-switch (DEUS_WAKE=0 or .deus/wake.disabled); pending=${pending}`);
    return 0;
  }

  const queue = openWake(projectDir);
  try {
    const client = await createOpenCodeClient();
    const result = await runWave(client, queue, {
      maxCost: options.wakeMaxCost,
      maxSteps: options.wakeMaxSteps,
      maxWallMs: options.wakeMaxWallMs,
      coalesceMs: options.wakeCoalesceMs,
      signal,
    });
    console.log(
      `wake: ${result.outcome} delivered=${result.delivered} messages=${result.messages} ` +
        `failed=${result.failed} expired=${result.expired} skipped=${result.skipped} ` +
        `pending=${result.pendingLeft} wavecost=~$${result.cost.toFixed(4)}`,
    );
    return result.failed > 0 ? 1 : 0;
  } finally {
    queue.close();
  }
}

function showWakeStatus(projectDir: string): number {
  if (!fs.existsSync(path.join(projectDir, ".deus", "board.db"))) {
    console.log("wake: board is not created yet");
    return 0;
  }

  const queue = openWakeReadonly(projectDir);
  if (!queue) {
    console.log("wake: outbox is not created yet; open the board once to migrate");
    return 0;
  }

  try {
    const stats = queue.stats();
    console.log(
      `wake: pending=${stats.pending} delivered=${stats.delivered} failed=${stats.failed} ` +
        `expired=${stats.expired} cancelled=${stats.cancelled} totalcost=~$${stats.knownCost.toFixed(4)}`,
    );
    if (stats.nextAt) console.log(`next_at: ${stats.nextAt}`);
    for (const event of queue.list({ limit: 20 })) {
      const to = event.recipient.sessionID || "no session";
      const error = event.lastError ? ` (${event.lastError})` : "";
      console.log(
        `  [${event.status}] ${event.eventType} ${event.boardTaskId ?? "-"} -> ${to}${error}`,
      );
    }
    return 0;
  } finally {
    queue.close();
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  const controller = new AbortController();
  let signalCount = 0;
  const onSignal = (signal: string): void => {
    signalCount++;
    if (signalCount > 1) process.exit(130);
    log(`${signal}: interrupting...`);
    controller.abort();
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  if (options.smoke) {
    process.exitCode = await runSmoke(options, controller.signal);
    return;
  }

  if (options.board) {
    process.exitCode = showBoard(path.resolve(options.cwd));
    return;
  }

  if (options.wakeStatus) {
    process.exitCode = showWakeStatus(path.resolve(options.cwd));
    return;
  }

  if (options.wake || options.wakeRegister !== undefined) {
    process.exitCode = await runWake(path.resolve(options.cwd), options, controller.signal);
    return;
  }

  if (options.resume && options.fromPlan) {
    throw new Error("--resume cannot be combined with --from-plan");
  }

  if (options.planOnly && options.resume) {
    throw new Error("--plan-only cannot be combined with --resume");
  }

  if (options.planOnly && options.fromPlan) {
    throw new Error("--plan-only cannot be combined with --from-plan");
  }

  const projectDir = path.resolve(options.cwd);
  ensureDeusDir(projectDir);
  const config = loadConfig(projectDir);

  if (options.planOnly) {
    process.exitCode = await runPlanOnly(options, projectDir, config, controller.signal);
    return;
  }

  if (!options.task && !options.resume && !options.fromPlan) {
    printHelp();
    throw new Error("task is required (or use --resume)");
  }

  const state = options.resume ? loadRunState(projectDir, options.resume) : undefined;
  const runId = state?.runId ?? makeRunId();
  let task = state?.task ?? options.task;

  let pipelineName: string;
  if (state) {
    pipelineName = state.pipeline;
  } else if (options.fromPlan) {
    pipelineName = "plan";
  } else if (options.direct) {
    pipelineName = "direct";
  } else if (options.pipelineExplicit) {
    pipelineName = options.pipeline;
  } else {
    pipelineName = config.pipeline ?? "build";
  }

  const model = options.modelExplicit
    ? options.model
    : (state?.model ?? config.model ?? DEFAULT_MODEL);
  const timeoutSeconds = options.timeoutExplicit
    ? options.timeoutSeconds
    : (config.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS);
  const maxCost = options.maxCostExplicit ? options.maxCost : config.maxCost;
  const useWorktree = options.worktreeExplicit
    ? options.worktree
    : (config.worktree ?? true);
  const merge = options.mergeExplicit ? options.merge : (config.merge ?? true);
  const baseline = options.baselineExplicit
    ? options.baseline
    : (config.baseline ?? true);
  const checks = options.gate ? resolveChecks(config, projectDir) : [];

  if (options.gate && checks.length === 0) {
    log(
      "warning: no checks configured; the gate is disabled. Add checks to deus.json to verify runs.",
    );
  }

  let workDir: string;
  let worktreeUsed: boolean;
  let baseCommit: string | undefined;
  let baseBranch: string | undefined;

  if (state) {
    workDir = state.workDir;
    worktreeUsed = state.worktree;
    baseCommit = state.baseCommit;
    baseBranch = state.baseBranch;
    log(`resuming ${runId} from ${state.steps.length} recorded step(s)`);
  } else {
    if (useWorktree) warnAboutDirtyTree(projectDir);
    const prepared = prepareWorkdir(projectDir, runId, useWorktree, log);
    workDir = prepared.workDir;
    worktreeUsed = prepared.worktree;
    baseCommit = prepared.baseCommit;
    baseBranch = prepared.baseBranch;
    ensureDeusDir(workDir);
  }

  let steps: PipelineStepDef[];
  let initialPlan: PlanStep[] | undefined;
  if (state?.plan?.length) {
    steps = planToSteps(state.plan);
  } else if (pipelineName === "direct") {
    steps = [
      {
        id: "direct",
        agent: options.agent ?? state?.steps[0]?.agent ?? "build",
        task: "{task}",
        gate: true,
      },
    ];
  } else if (pipelineName === "auto" || pipelineName === "plan") {
    steps = [];
  } else {
    steps = getPipeline(pipelineName);
  }

  const client = await createOpenCodeClient();
  // An explicit --model is the only thing that disables per-agent models. A
  // resumed run keeps using the agent model: `state.model` is derived, not a
  // choice, so remaining steps must behave like they would on a fresh run.
  const registry = loadRegistry(workDir);
  const modelFor = options.modelExplicit
    ? undefined
    : (agent: string) => agentModel(registry, agent, model);
  const executor = new SessionExecutor(client, {
    model,
    modelFor,
    policy: loadPolicy(resolvePolicyPath(options, config, projectDir)),
    keepSessions: true,
    onLog: log,
  });

  if (options.fromPlan) {
    const agents = await loadAgents(client, workDir);
    const plan = validatePlan(readPlanFile(options.fromPlan), agents);
    steps = planToSteps(plan.steps);
    initialPlan = plan.steps;
    if (!task) task = plan.goal;
  }

  const planner =
    pipelineName === "auto" && !state?.plan
      ? { agents: await loadAgents(client, workDir) }
      : undefined;

  if (!state && steps.length === 0 && !planner) {
    throw new Error(`pipeline "${pipelineName}" has no steps`);
  }

  const result = await runPipeline({
    steps,
    plan: initialPlan,
    pipeline: pipelineName,
    task,
    runId,
    projectDir,
    workDir,
    worktree: worktreeUsed,
    baseCommit,
    baseBranch,
    model,
    timeoutMs: timeoutSeconds * 1000,
    maxCost,
    checks,
    baseline,
    planner,
    executor,
    resume: state,
    signal: controller.signal,
    onProgress: printProgress,
  });

  if (result.state.status === "succeeded" && worktreeUsed) {
    log("");
    log("applying changes...");
    const applied = await applyRun({
      projectDir,
      workDir,
      state: result.state,
      merge,
      resolve: {
        executor,
        timeoutMs: timeoutSeconds * 1000,
        checks,
        baseline: baseline ? result.state.baseline : undefined,
        maxCost,
        signal: controller.signal,
      },
    });
    result.state.apply = applied;
    persistRunState(result.runDir, result.state);

    if (applied.resolution) {
      const file = path.join(result.runDir, "conflict-resolution.md");
      const lines = [
        "# Conflict resolution",
        "",
        `- Session: \`${applied.resolution.sessionID || "none"}\``,
        `- Status: **${applied.resolution.status}**`,
        `- Cost: ${formatCost(applied.resolution.cost, applied.resolution.costEstimated)}`,
        applied.resolution.error ? `- Error: ${applied.resolution.error}` : "",
        "",
        "## Output",
        "",
        applied.resolution.text || "(empty)",
      ];
      fs.writeFileSync(file, `${lines.filter((line) => line !== "").join("\n")}\n`, "utf-8");
    }
  }

  printHumanResult(result);

  const appliedStatus = result.state.apply?.status;
  const safeToCleanup =
    appliedStatus === "merged" ||
    appliedStatus === "no-changes" ||
    (!merge &&
      appliedStatus === "branch" &&
      result.state.apply?.commit !== undefined);

  if (options.cleanup && result.state.status === "succeeded" && worktreeUsed) {
    if (safeToCleanup) {
      removeWorkdir(projectDir, workDir);
      log(`worktree removed: ${workDir}`);
    } else {
      log("cleanup skipped: changes were not committed");
    }
  }

  if (options.json) {
    console.log(JSON.stringify(result.state, null, 2));
  }

  const mergePending =
    merge &&
    worktreeUsed &&
    result.state.status === "succeeded" &&
    result.state.apply !== undefined &&
    result.state.apply.status !== "merged" &&
    result.state.apply.status !== "no-changes";

  process.exitCode = result.state.status === "succeeded" ? (mergePending ? 2 : 0) : 1;
}

main().catch((error: unknown) => {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
