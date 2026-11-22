import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
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
import { runCodingTeam, teamExitCode, TeamError } from "./team.ts";
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

export interface CliOptions {
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
  boardTask?: string;
  boardId?: string;
  boardTitle?: string;
  boardGoal?: string;
  boardDoneWhen?: string;
  boardTeam?: string;
  boardActor?: string;
  boardAssignee?: string;
  boardToken?: string;
  boardReason?: string;
  boardNote?: string;
  boardSummary?: string;
  boardGate?: string;
  boardExecutionRef?: string;
  boardPriority?: number;
  boardDependsOn?: string;
  teamAdd?: boolean;
  teamName?: string;
  teamGoal?: string;
  teamLead?: string;
  teamRun: boolean;
  teamParallel?: number;
  teamMaxAttempts?: number;
  teamAutoLead: boolean;
  teamMaxRounds?: number;
  teamTasks?: string;
  teamKeepWorktrees: boolean;
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
  --team-add           Create a team (--team-name, --team-goal, --team-lead)
  --team-run           Run the team's ready tasks in parallel worktrees
  --team-parallel <n>  Agents at once for --team-run (default: 3, max 8)
  --team-tasks <ids>   Comma-separated board task ids for --team-run
  --team-max-attempts <n> Attempts before a task is blocked (default: 3)
  --team-auto-lead     Let a tool-less advisor return failed tasks with a note
  --team-max-rounds <n> Pools per auto-lead run, 1..9 (default: --team-max-attempts)
  --team-keep-worktrees Keep worktrees and branches after a successful merge
  --board-task <act>   Board mutation: add|claim|start|submit|accept|rework|retry|block|cancel
  --board-id <id>      Task id for --board-task
  --board-actor <name> Who performs the mutation (default: main)
  --board-assignee <name> Optional assignee for "add" (default: unassigned)
  --board-title/--board-goal/--board-done-when/--board-team  Fields for "add"
  --board-token <tok>  Claim token for start|submit|block|cancel
  --board-execution-ref <ref>  run-…/step-id for "start"
  --board-summary <text> / --board-gate <passed|failed|skipped>  For "submit"
  --board-reason <text> / --board-note <text>  For "block" / "rework"
  --board-depends-on <ids> / --board-priority <n>  For "add".
  --wake-register <id> Record the team lead's session for wake delivery
  --wake-max-cost <usd>  Soft per-wave ceiling on reconciled cost (default: 1.00)
  --wake-max-steps <n>   Hard wave ceiling on delivered messages (default: 20)
  --wake-max-wall-ms <ms> Hard wave ceiling on wall clock (default: 1800000)
  --wake-coalesce-ms <ms> Coalesce events per recipient (0 disables, default: 30000)
  --model <ref>        provider/model#variant (default: ${DEFAULT_MODEL})
  --timeout <seconds>  Per-step timeout (default: ${DEFAULT_TIMEOUT_SECONDS})
  --max-cost <usd>     Abort after the total cost exceeds this value (a team
                       run stops between rounds and before the next task)
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
    boardActor: "main",
    teamRun: false,
    teamKeepWorktrees: false,
    teamAutoLead: false,
    direct: false,
    planOnly: false,
    task: "",
  };

  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new CliInputError(`missing value for ${arg}`);
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
          throw new CliInputError("--timeout must be a positive number of seconds");
        }
        options.timeoutExplicit = true;
        break;
      case "--max-cost":
        options.maxCost = Number(next());
        if (!Number.isFinite(options.maxCost) || options.maxCost < 0) {
          throw new CliInputError("--max-cost must be a non-negative number");
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
      case "--board-task":
        options.boardTask = next();
        break;
      case "--board-id":
        options.boardId = next();
        break;
      case "--board-title":
        options.boardTitle = next();
        break;
      case "--board-goal":
        options.boardGoal = next();
        break;
      case "--board-done-when":
        options.boardDoneWhen = next();
        break;
      case "--board-team":
        options.boardTeam = next();
        break;
      case "--board-actor":
        options.boardActor = next();
        break;
      case "--board-assignee":
        options.boardAssignee = next();
        break;
      case "--board-token":
        options.boardToken = next();
        break;
      case "--board-reason":
        options.boardReason = next();
        break;
      case "--board-note":
        options.boardNote = next();
        break;
      case "--board-summary":
        options.boardSummary = next();
        break;
      case "--board-gate":
        options.boardGate = next();
        break;
      case "--board-execution-ref":
        options.boardExecutionRef = next();
        break;
      case "--board-priority":
        options.boardPriority = Number(next());
        if (!Number.isInteger(options.boardPriority)) {
          throw new CliInputError("--board-priority must be an integer");
        }
        break;
      case "--board-depends-on":
        options.boardDependsOn = next();
        break;
      case "--team-add":
        options.teamAdd = true;
        break;
      case "--team-run":
        options.teamRun = true;
        break;
      case "--team-parallel":
        options.teamParallel = Number(next());
        if (!Number.isInteger(options.teamParallel) || options.teamParallel < 1) {
          throw new CliInputError("--team-parallel must be a positive integer");
        }
        break;
      case "--team-tasks":
        options.teamTasks = next();
        break;
      case "--team-max-attempts":
        options.teamMaxAttempts = Number(next());
        if (!Number.isInteger(options.teamMaxAttempts) || options.teamMaxAttempts < 1) {
          throw new CliInputError("--team-max-attempts must be a positive integer");
        }
        break;
      case "--team-auto-lead":
        options.teamAutoLead = true;
        break;
      case "--team-max-rounds":
        options.teamMaxRounds = Number(next());
        if (
          !Number.isInteger(options.teamMaxRounds) ||
          options.teamMaxRounds < 1 ||
          options.teamMaxRounds > 9
        ) {
          throw new CliInputError("--team-max-rounds must be an integer between 1 and 9");
        }
        break;
      case "--team-keep-worktrees":
        options.teamKeepWorktrees = true;
        break;
      case "--team-name":
        options.teamName = next();
        break;
      case "--team-goal":
        options.teamGoal = next();
        break;
      case "--team-lead":
        options.teamLead = next();
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
          throw new CliInputError("--wake-max-cost must be a non-negative number");
        }
        break;
      case "--wake-max-steps":
        options.wakeMaxSteps = Number(next());
        if (!Number.isInteger(options.wakeMaxSteps) || options.wakeMaxSteps <= 0) {
          throw new CliInputError("--wake-max-steps must be a positive integer");
        }
        break;
      case "--wake-max-wall-ms":
        options.wakeMaxWallMs = Number(next());
        if (!Number.isFinite(options.wakeMaxWallMs) || options.wakeMaxWallMs <= 0) {
          throw new CliInputError("--wake-max-wall-ms must be a positive number");
        }
        break;
      case "--wake-coalesce-ms":
        options.wakeCoalesceMs = Number(next());
        if (!Number.isFinite(options.wakeCoalesceMs) || options.wakeCoalesceMs < 0) {
          throw new CliInputError("--wake-coalesce-ms must be a non-negative number");
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
        if (arg.startsWith("-")) throw new CliInputError(`unknown option: ${arg}`);
        positional.push(arg);
    }
  }

  options.task = positional.join(" ").trim();
  if (options.wake && options.wakeRegister !== undefined) {
    throw new CliInputError("--wake-register cannot be combined with --wake");
  }
  if (options.board && options.boardTask !== undefined) {
    throw new CliInputError("--board cannot be combined with --board-task");
  }
  if (options.teamAdd && options.boardTask !== undefined) {
    throw new CliInputError("--team-add cannot be combined with --board-task");
  }
  if (options.teamAdd && options.board) {
    throw new CliInputError("--team-add cannot be combined with --board");
  }
  if (options.boardTask !== undefined && options.task.length > 0) {
    throw new CliInputError("--board-task does not take a positional task");
  }
  if (options.smoke && options.boardTask !== undefined) {
    throw new CliInputError("--smoke cannot be combined with --board-task");
  }
  if (options.teamRun) {
    const together: Array<[boolean, string]> = [
      [options.teamAdd === true, "--team-add"],
      [options.board, "--board"],
      [options.boardTask !== undefined, "--board-task"],
      [options.wake, "--wake"],
      [options.wakeStatus, "--wake-status"],
      [options.wakeRegister !== undefined, "--wake-register"],
      [options.smoke, "--smoke"],
      [options.planOnly, "--plan-only"],
      [options.fromPlan !== undefined, "--from-plan"],
      [options.resume !== undefined, "--resume"],
      [options.task.length > 0, "a positional task"],
      [!options.gate, "--no-gate"],
      [options.mergeExplicit, "--merge/--no-merge"],
      [options.worktreeExplicit, "--worktree/--no-worktree"],
      [options.baselineExplicit, "--baseline/--no-baseline"],
      [options.pipelineExplicit, "--pipeline"],
      [options.direct, "--direct"],
      [options.cleanup, "--cleanup"],
      [options.json, "--json"],
      [options.policy !== undefined, "--policy"],
    ];
    for (const [present, flag] of together) {
      if (present) {
        throw new CliInputError(`--team-run cannot be combined with ${flag}`);
      }
    }
    if (options.teamName === undefined) {
      throw new CliInputError("--team-run requires --team-name");
    }
    if (options.teamParallel !== undefined && options.teamParallel > 8) {
      throw new CliInputError("--team-parallel must not exceed 8");
    }
    if (options.teamMaxRounds !== undefined && !options.teamAutoLead) {
      throw new CliInputError("--team-max-rounds requires --team-auto-lead");
    }
  }
  if (!options.teamRun) {
    const strays: Array<[boolean, string]> = [
      [options.teamTasks !== undefined, "--team-tasks"],
      [options.teamMaxAttempts !== undefined, "--team-max-attempts"],
      [options.teamAutoLead, "--team-auto-lead"],
      [options.teamMaxRounds !== undefined, "--team-max-rounds"],
      [options.teamParallel !== undefined, "--team-parallel"],
      [options.teamKeepWorktrees, "--team-keep-worktrees"],
    ];
    for (const [present, flag] of strays) {
      if (present) throw new CliInputError(`${flag} is only valid with --team-run`);
    }
  }
  if (!options.teamRun && options.teamAdd !== true) {
    const strays: Array<[boolean, string]> = [
      [options.teamName !== undefined, "--team-name"],
      [options.teamGoal !== undefined, "--team-goal"],
      [options.teamLead !== undefined, "--team-lead"],
    ];
    for (const [present, flag] of strays) {
      if (present) throw new CliInputError(`${flag} is only valid with --team-add or --team-run`);
    }
  }
  if (options.teamRun && options.teamTasks !== undefined) {
    const ids = options.teamTasks
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    if (ids.length === 0) {
      throw new CliInputError("--team-tasks must list at least one board task id");
    }
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


class CliInputError extends Error {
  readonly code = "invalid_input";
}

function actorName(value: string | undefined): string {
  const actor = (value ?? "main").trim();
  if (actor.length === 0) {
    throw new CliInputError("--board-actor must not be empty");
  }
  return actor;
}

function requireOption(value: string | undefined, flag: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new CliInputError(`${flag} is required`);
  }
  return value;
}

function runTeamAdd(projectDir: string, options: CliOptions): number {
  let board: Board | undefined;
  try {
    const name = requireOption(options.teamName, "--team-name");
    const goal = requireOption(options.teamGoal, "--team-goal");
    const leadAgent = actorName(options.teamLead ?? options.boardActor);
    board = openBoard(projectDir);
    const team = board.createTeam({ name, goal, leadAgent });
    console.log(`team: ${team.teamId}`);
    return 0;
  } catch (error) {
    return reportBoardError(error);
  } finally {
    board?.close();
  }
}

function reportBoardError(error: unknown): number {
  if (error instanceof BoardError) {
    console.error(`error: ${error.code}: ${error.message}`);
    return 1;
  }
  if (error instanceof CliInputError) {
    console.error(`error: ${error.code}: ${error.message}`);
    return 1;
  }
  throw error;
}

function runBoardTask(projectDir: string, options: CliOptions): number {
  let board: Board | undefined;

  try {
    const action = requireOption(options.boardTask, "--board-task");
    const actor = actorName(options.boardActor);
    board = openBoard(projectDir);

    switch (action) {
      case "add": {
        const teamName = options.boardTeam ?? "main";
        const team = board.getTeamByName(teamName);
        if (!team) throw new BoardError("not_found", `team not found: ${teamName}`);
        const dependsOn = options.boardDependsOn
          ? options.boardDependsOn
              .split(",")
              .map((value) => value.trim())
              .filter((value) => value.length > 0)
          : undefined;
        const task = board.createTask({
          teamId: team.teamId,
          title: requireOption(options.boardTitle, "--board-title"),
          goal: requireOption(options.boardGoal, "--board-goal"),
          doneWhen: options.boardDoneWhen,
          assignee:
            options.boardAssignee === undefined
              ? undefined
              : requireOption(options.boardAssignee, "--board-assignee"),
          priority: options.boardPriority,
          dependsOn,
          actor,
        });
        console.log(`task: ${task.boardTaskId}`);
        return 0;
      }

      case "claim": {
        const id = requireOption(options.boardId, "--board-id");
        const claim = board.claim(id, actor);
        if (!claim) {
          console.log("claim: none (the task is already held)");
          return 0;
        }
        console.log(`claim_token: ${claim.claimToken}`);
        console.log(`lease_until: ${claim.leaseUntil}`);
        return 0;
      }

      case "start": {
        const id = requireOption(options.boardId, "--board-id");
        board.start(
          id,
          requireOption(options.boardToken, "--board-token"),
          requireOption(options.boardExecutionRef, "--board-execution-ref"),
        );
        console.log(`task: ${id} status: running`);
        return 0;
      }

      case "submit": {
        const id = requireOption(options.boardId, "--board-id");
        const gate = requireOption(options.boardGate, "--board-gate");
        if (gate !== "passed" && gate !== "failed" && gate !== "skipped") {
          throw new CliInputError("--board-gate must be passed, failed or skipped");
        }
        board.submit(
          id,
          requireOption(options.boardToken, "--board-token"),
          { status: gate },
          { summary: requireOption(options.boardSummary, "--board-summary") },
        );
        console.log(`task: ${id} status: review`);
        return 0;
      }

      case "accept": {
        const id = requireOption(options.boardId, "--board-id");
        board.accept(id, actor);
        console.log(`task: ${id} status: done`);
        return 0;
      }

      case "rework": {
        const id = requireOption(options.boardId, "--board-id");
        board.rework(id, actor, options.boardNote);
        console.log(`task: ${id} status: backlog`);
        return 0;
      }

      case "retry": {
        const id = requireOption(options.boardId, "--board-id");
        board.retry(id, actor);
        console.log(`task: ${id} status: backlog`);
        return 0;
      }

      case "block": {
        const id = requireOption(options.boardId, "--board-id");
        board.block(
          id,
          actor,
          requireOption(options.boardReason, "--board-reason"),
          options.boardToken,
        );
        console.log(`task: ${id} status: blocked`);
        return 0;
      }

      case "cancel": {
        const id = requireOption(options.boardId, "--board-id");
        board.cancel(id, actor, options.boardToken);
        console.log(`task: ${id} status: cancelled`);
        return 0;
      }

      default:
        throw new CliInputError(
          `unknown --board-task action: ${action} (add|claim|start|submit|accept|rework|retry|block|cancel)`,
        );
    }
  } catch (error) {
    return reportBoardError(error);
  } finally {
    board?.close();
  }
}


export interface TeamRunFlags {
  autoLead: boolean;
  maxRounds?: number;
  maxCost?: number;
  maxParallel?: number;
  maxAttempts?: number;
  keepWorktrees: boolean;
  taskIds?: string[];
  agent: string;
  actor?: string;
}

/**
 * Maps CLI flags (and the `maxCost` default from deus.json) to runner options.
 * Exported so a test can prove the flags are wired instead of accepted and
 * dropped.
 */
type TeamFlagInput = Pick<
  CliOptions,
  | "teamAutoLead"
  | "teamMaxRounds"
  | "maxCostExplicit"
  | "maxCost"
  | "teamParallel"
  | "teamMaxAttempts"
  | "teamKeepWorktrees"
  | "teamTasks"
  | "agent"
  | "boardActor"
>;

export function teamRunFlags(options: TeamFlagInput, config: DeusConfig): TeamRunFlags {
  return {
    autoLead: options.teamAutoLead,
    maxRounds: options.teamMaxRounds,
    maxCost: options.maxCostExplicit ? options.maxCost : config.maxCost,
    maxParallel: options.teamParallel,
    maxAttempts: options.teamMaxAttempts,
    keepWorktrees: options.teamKeepWorktrees,
    taskIds: options.teamTasks
      ?.split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
    agent: options.agent ?? "build",
    actor: options.boardActor,
  };
}

/** Model output must not be able to forge the line-based summary. */
function oneLine(text: string): string {
  return text.replace(/[\r\n\t]+/g, " ").replace(/[\u0000-\u001f\u001b]/g, "").trim();
}

async function runTeam(signal: AbortSignal, options: CliOptions): Promise<number> {
  const projectDir = path.resolve(options.cwd);
  const teamName = options.teamName as string;
  const config = loadConfig(projectDir);
  const checks = resolveChecks(config, projectDir);
  const board = openBoard(projectDir);

  try {
    const team = board.getTeamByName(teamName);
    if (!team) {
      throw new TeamError("not_found", `team not found: ${teamName}`);
    }

    const client = await createOpenCodeClient();
    // Two runs started in the same millisecond would share a directory, a
    // worktree and a branch. Make the id unique before anything uses it.
    let runId = makeRunId();
    while (fs.existsSync(runDirFor(projectDir, runId))) {
      runId = `${makeRunId()}${crypto.randomBytes(2).toString("hex")}`;
    }
    const result = await runCodingTeam(client, board, {
      projectDir,
      teamId: team.teamId,
      runId,
      model: options.model,
      checks,
      timeoutMs: options.timeoutSeconds * 1_000,
      signal,
      onProgress: (line) => log(`team: ${line}`),
      ...teamRunFlags(options, config),
    });

    for (const task of result.tasks) {
      const details = [
        `task: ${task.boardTaskId}`,
        task.status,
        `status: ${task.boardStatus ?? "-"}`,
        task.branch ? `branch: ${task.branch}` : undefined,
        task.commit ? `commit: ${task.commit}` : undefined,
        task.gate ? `gate: ${task.gate.status}` : undefined,
        task.reason ? `reason: ${oneLine(task.reason)}` : undefined,
        task.lead ? `lead: ${task.lead.decision} (${oneLine(task.lead.reason)})` : undefined,
        task.cost !== undefined ? `cost=~$${task.cost.toFixed(4)}` : undefined,
      ].filter(Boolean);
      console.log(details.join(" "));
    }
    console.log(
      `team: merged=${result.merged} review=${result.review} blocked=${result.blocked} ` +
        `errors=${result.errors} skipped=${result.skipped} waiting=${result.waiting} ` +
        `rounds=${result.rounds} cost=~$${result.cost.toFixed(4)} ` +
        `lead=~$${result.leadCost.toFixed(4)}` +
        `${result.costCapped ? " stopped-by-cost" : ""} run=${result.runId}`,
    );

    return teamExitCode(result);
  } catch (error) {
    if (error instanceof TeamError) {
      console.error(`error: ${error.code}: ${error.message}`);
      return 1;
    }
    throw error;
  } finally {
    board.close();
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

  if (options.teamRun) {
    process.exitCode = await runTeam(controller.signal, options);
    return;
  }

  if (options.teamAdd) {
    process.exitCode = runTeamAdd(path.resolve(options.cwd), options);
    return;
  }

  if (options.boardTask !== undefined) {
    process.exitCode = runBoardTask(path.resolve(options.cwd), options);
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

/** True when this module is the program, not an import from a test. */
function isEntryPoint(): boolean {
  const script = process.argv[1];
  if (!script) return false;
  try {
    return fs.realpathSync(script) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().catch((error: unknown) => {
    const code = (error as { code?: unknown }).code;
    const message = error instanceof Error ? error.message : String(error);
    console.error(typeof code === "string" ? `error: ${code}: ${message}` : `error: ${message}`);
    process.exitCode = 1;
  });
}
