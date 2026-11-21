import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createOpenCodeClient } from "./client.ts";
import { SessionExecutor } from "./executor.ts";
import { loadPolicy } from "./permissions.ts";
import {
  loadRunState,
  makeRunId,
  runDirFor,
  runPipeline,
  type PipelineProgress,
} from "./pipeline.ts";
import { getPipeline } from "./pipelines.ts";
import type { PipelineStepDef, RunState } from "./types.ts";
import { prepareWorkdir, removeWorkdir } from "./worktree.ts";

const DEFAULT_MODEL = "opencode-go/deepseek-v4.1-flash#max";
const DEFAULT_TIMEOUT_SECONDS = 15 * 60;

interface CliOptions {
  pipeline: string;
  cwd: string;
  resume?: string;
  model: string;
  modelExplicit: boolean;
  timeoutSeconds: number;
  maxCost?: number;
  worktree: boolean;
  policy?: string;
  cleanup: boolean;
  json: boolean;
  smoke: boolean;
  direct: boolean;
  agent?: string;
  task: string;
}

function printHelp(): void {
  console.log(`Deus V2 runner

Usage:
  node --import tsx src/v2/cli.ts [options] "task"
  node --import tsx src/v2/cli.ts --smoke
  node --import tsx src/v2/cli.ts --resume <runId> --cwd <project>

Options:
  --pipeline <name>    Pipeline to run: build, fix, audit (default: build)
  --direct             Run one agent on the task (no pipeline)
  --agent <id>         Agent for --direct (default: build)
  --cwd <path>         Project directory (default: current directory)
  --resume <runId>     Resume a checkpointed run
  --model <ref>        provider/model#variant (default: ${DEFAULT_MODEL})
  --timeout <seconds>  Per-step timeout (default: ${DEFAULT_TIMEOUT_SECONDS})
  --max-cost <usd>     Abort after the total cost exceeds this value
  --policy <file>      JSON permission policy
  --no-worktree        Run in the project directory instead of a git worktree
  --cleanup            Remove the worktree after a successful run
  --json               Print the final run state as JSON
  --smoke              Check service, model and session flow without a project
  --help               Show this help
`);
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    pipeline: "build",
    cwd: process.cwd(),
    model: DEFAULT_MODEL,
    modelExplicit: false,
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    worktree: true,
    cleanup: false,
    json: false,
    smoke: false,
    direct: false,
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
        break;
      case "--max-cost":
        options.maxCost = Number(next());
        if (!Number.isFinite(options.maxCost) || options.maxCost < 0) {
          throw new Error("--max-cost must be a non-negative number");
        }
        break;
      case "--policy":
        options.policy = path.resolve(next());
        break;
      case "--no-worktree":
        options.worktree = false;
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
      case "--direct":
        options.direct = true;
        break;
      case "--agent":
        options.agent = next();
        break;
      default:
        if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);
        positional.push(arg);
    }
  }

  options.task = positional.join(" ").trim();
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
  if (event.type === "step-start") {
    log(`[${event.index + 1}] ${event.step.id} (${event.step.agent}) ...`);
  } else if (event.type === "step-skip") {
    log(`[${event.index + 1}] ${event.step.id} — already completed`);
  } else if (event.type === "step-end") {
    const { result } = event;
    const status = result.status === "succeeded" ? "ok" : `failed: ${result.error}`;
    log(
      `[${event.index + 1}] ${event.step.id} — ${status} (${formatDuration(result.durationMs)}, ${formatCost(result.cost, result.costEstimated)})`,
    );
  } else {
    log(`run ${event.state.status}: ${event.state.runId}`);
  }
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
  log(`artifacts: ${result.runDir}`);
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

  if (!options.task && !options.resume) {
    printHelp();
    throw new Error("task is required (or use --resume)");
  }

  const projectDir = path.resolve(options.cwd);
  ensureDeusDir(projectDir);
  const policyPath = options.policy ?? path.join(projectDir, ".deus", "policy.json");

  let runId: string;
  let state: RunState | undefined;
  let workDir: string;
  let worktree: boolean;
  let pipelineName: string;
  let task: string;

  if (options.resume) {
    state = loadRunState(projectDir, options.resume);
    runId = state.runId;
    workDir = state.workDir;
    worktree = state.worktree;
    pipelineName = state.pipeline;
    task = state.task;
    log(`resuming ${runId} from ${state.steps.length} recorded step(s)`);
  } else {
    runId = makeRunId();
    task = options.task;
    pipelineName = options.direct ? "direct" : options.pipeline;

    if (options.worktree) warnAboutDirtyTree(projectDir);
    const prepared = prepareWorkdir(projectDir, runId, options.worktree, log);
    workDir = prepared.workDir;
    worktree = prepared.worktree;
    ensureDeusDir(workDir);
  }

  const steps: PipelineStepDef[] =
    pipelineName === "direct"
      ? [
          {
            id: "direct",
            agent: options.agent ?? state?.steps[0]?.agent ?? "build",
            task: "{task}",
          },
        ]
      : getPipeline(pipelineName);
  const selectedModel =
    options.resume && !options.modelExplicit && state ? state.model : options.model;
  const client = await createOpenCodeClient();
  const executor = new SessionExecutor(client, {
    model: selectedModel,
    policy: loadPolicy(policyPath),
    keepSessions: true,
    onLog: log,
  });

  const result = await runPipeline({
    steps,
    pipeline: pipelineName,
    task,
    runId,
    projectDir,
    workDir,
    worktree,
    model: selectedModel,
    timeoutMs: options.timeoutSeconds * 1000,
    maxCost: options.maxCost,
    executor,
    resume: state,
    signal: controller.signal,
    onProgress: printProgress,
  });

  printHumanResult(result);

  if (options.cleanup && result.state.status === "succeeded" && worktree) {
    removeWorkdir(projectDir, workDir);
    log(`worktree removed: ${workDir}`);
  }

  if (options.json) {
    console.log(JSON.stringify(result.state, null, 2));
  }

  process.exitCode = result.state.status === "succeeded" ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
