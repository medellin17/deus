import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  loadRunState,
  runDirFor,
  runPipeline,
  type RunPipelineOptions,
} from "../../v2/pipeline.ts";
import type {
  Executor,
  ExecutorInput,
  PipelineStepDef,
  StepExecution,
} from "../../v2/types.ts";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deus-v2-test-"));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function ok(input: ExecutorInput, text: string, cost = 0.001): StepExecution {
  return {
    stepId: input.step.id,
    agent: input.step.agent,
    sessionID: `ses-${input.step.id}`,
    status: "succeeded",
    text,
    transcript: text,
    cost,
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    durationMs: 10,
    permissionDecisions: [],
  };
}

function failed(input: ExecutorInput, error: string): StepExecution {
  return {
    ...ok(input, ""),
    status: "failed",
    error,
    cost: 0,
  };
}

class FakeExecutor implements Executor {
  readonly prompts: string[] = [];
  calls: string[] = [];
  private readonly behavior: (
    input: ExecutorInput,
    call: number,
  ) => StepExecution | Promise<StepExecution>;

  constructor(behavior: (input: ExecutorInput, call: number) => StepExecution | Promise<StepExecution>) {
    this.behavior = behavior;
  }

  async run(input: ExecutorInput): Promise<StepExecution> {
    this.calls.push(input.step.id);
    this.prompts.push(input.prompt);
    return this.behavior(input, this.calls.length);
  }
}

function baseOptions(
  steps: PipelineStepDef[],
  executor: Executor,
  overrides: Partial<RunPipelineOptions> = {},
): RunPipelineOptions {
  const dir = tempDir();
  return {
    steps,
    pipeline: "test",
    task: "fix the bug",
    runId: "run-test",
    projectDir: dir,
    workDir: dir,
    worktree: false,
    model: "opencode-go/deepseek-v4.1-flash#max",
    timeoutMs: 1000,
    executor,
    ...overrides,
  };
}

void describe("runPipeline", () => {
  void it("runs steps in order and substitutes task/prev", async () => {
    const steps: PipelineStepDef[] = [
      { id: "one", agent: "a", task: "First: {task}" },
      { id: "two", agent: "b", task: "Second: {task}\nPrev:\n{prev}" },
    ];
    const executor = new FakeExecutor((input) => ok(input, `out-${input.step.id}`));
    const options = baseOptions(steps, executor);

    const result = await runPipeline(options);

    assert.equal(result.state.status, "succeeded");
    assert.deepEqual(executor.calls, ["one", "two"]);
    assert.equal(executor.prompts[0], "First: fix the bug");
    assert.match(executor.prompts[1], /out-one/);

    const runDir = runDirFor(options.projectDir, options.runId);
    assert.ok(fs.existsSync(path.join(runDir, "run.json")));
    assert.ok(fs.existsSync(path.join(runDir, "run.md")));
    assert.ok(fs.existsSync(path.join(runDir, "step-00-one.md")));
    assert.ok(fs.existsSync(path.join(runDir, "step-01-two.md")));

    const persisted = loadRunState(options.projectDir, options.runId);
    assert.equal(persisted.steps.length, 2);
    assert.equal(persisted.steps[1].text, "out-two");
  });

  void it("stops on failure and resumes without repeating succeeded steps", async () => {
    const steps: PipelineStepDef[] = [
      { id: "one", agent: "a", task: "First" },
      { id: "two", agent: "b", task: "Second" },
    ];

    const firstExecutor = new FakeExecutor((input) =>
      input.step.id === "two" ? failed(input, "boom") : ok(input, "out-one"),
    );
    const firstOptions = baseOptions(steps, firstExecutor);
    const first = await runPipeline(firstOptions);

    assert.equal(first.state.status, "failed");
    assert.equal(first.state.error, "boom");
    assert.deepEqual(firstExecutor.calls, ["one", "two"]);

    const resumeState = loadRunState(firstOptions.projectDir, firstOptions.runId);
    const secondExecutor = new FakeExecutor((input) =>
      ok(input, `retry-${input.step.id}`),
    );
    const second = await runPipeline({
      ...firstOptions,
      executor: secondExecutor,
      resume: resumeState,
    });

    assert.equal(second.state.status, "succeeded");
    assert.deepEqual(secondExecutor.calls, ["two"]);
    assert.equal(second.state.steps[0].text, "out-one");
    assert.equal(second.state.steps[1].text, "retry-two");
  });

  void it("stops when the cost limit is exceeded", async () => {
    const steps: PipelineStepDef[] = [
      { id: "one", agent: "a", task: "First" },
      { id: "two", agent: "b", task: "Second" },
    ];
    const executor = new FakeExecutor((input) => ok(input, `out-${input.step.id}`, 0.5));
    const options = baseOptions(steps, executor, { maxCost: 0.1 });

    const result = await runPipeline(options);

    assert.equal(result.state.status, "failed");
    assert.match(result.state.error ?? "", /cost limit exceeded/);
    assert.deepEqual(executor.calls, ["one"]);
  });

  void it("does not start work when the signal is already aborted", async () => {
    const steps: PipelineStepDef[] = [{ id: "one", agent: "a", task: "First" }];
    const executor = new FakeExecutor((input) => ok(input, "out"));
    const controller = new AbortController();
    controller.abort();

    const result = await runPipeline({
      ...baseOptions(steps, executor),
      signal: controller.signal,
    });

    assert.equal(result.state.status, "interrupted");
    assert.equal(result.state.error, "run interrupted");
    assert.deepEqual(executor.calls, []);
  });
});
