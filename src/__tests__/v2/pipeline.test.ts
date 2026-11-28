import assert from "node:assert";
import { execFileSync } from "node:child_process";
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
  GateResult,
  PipelineStepDef,
  RunState,
  StepExecution,
} from "../../v2/types.ts";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deus-v2-test-"));
  tempDirs.push(dir);
  return dir;
}

function gitRepo(): string {
  const dir = tempDir();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "deus-test"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "deus@example.com"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "base.txt"), "1\n", "utf-8");
  fs.mkdirSync(path.join(dir, ".deus"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".deus", ".gitignore"), "*\n", "utf-8");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
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

  void it("keeps the cost of a failed attempt across resume", async () => {
    const steps: PipelineStepDef[] = [{ id: "one", agent: "a", task: "First" }];
    const firstOptions = baseOptions(
      steps,
      new FakeExecutor((input) => ({ ...failed(input, "boom"), cost: 0.25 })),
    );

    const first = await runPipeline(firstOptions);
    assert.equal(first.state.status, "failed");
    assert.ok(Math.abs((first.state.cost ?? 0) - 0.25) < 1e-9);

    const second = await runPipeline({
      ...firstOptions,
      executor: new FakeExecutor((input) => ok(input, "done", 0.001)),
      resume: loadRunState(firstOptions.projectDir, firstOptions.runId),
    });

    assert.equal(second.state.status, "succeeded");
    assert.ok(Math.abs((second.state.cost ?? 0) - 0.251) < 1e-9);
  });

  void it("does not double count the carried cost against maxCost", async () => {
    const dir = tempDir();
    const steps: PipelineStepDef[] = [
      { id: "one", agent: "a", task: "First", gate: true },
    ];
    const firstOptions = baseOptions(
      steps,
      new FakeExecutor((input) => ({ ...failed(input, "boom"), cost: 0.5 })),
      { projectDir: dir, workDir: dir },
    );

    const first = await runPipeline(firstOptions);
    assert.equal(first.state.status, "failed");

    const secondExecutor = new FakeExecutor((input, call) => {
      if (call === 2) fs.writeFileSync(path.join(dir, "ok"), "1", "utf-8");
      return ok(input, `done-${call}`, 0.1);
    });

    const second = await runPipeline({
      ...firstOptions,
      executor: secondExecutor,
      checks: [{ name: "check", command: "test -f ok" }],
      maxCost: 0.75,
      resume: loadRunState(dir, "run-test"),
    });

    assert.equal(second.state.status, "succeeded");
    assert.ok(Math.abs((second.state.cost ?? 0) - 0.7) < 1e-9);
  });

  void it("fails a change step that produced no changes", async () => {
    const dir = gitRepo();
    const steps: PipelineStepDef[] = [
      { id: "impl", agent: "a", task: "Do", gate: true, requireChanges: true },
    ];
    const executor = new FakeExecutor((input) => ok(input, "done"));
    const options = baseOptions(steps, executor, { projectDir: dir, workDir: dir });

    const result = await runPipeline(options);

    assert.equal(result.state.status, "failed");
    assert.match(result.state.error ?? "", /no changes/);
  });

  void it("fails the second change step that produced no changes", async () => {
    const dir = gitRepo();
    const steps: PipelineStepDef[] = [
      { id: "a", agent: "x", task: "A", gate: true, requireChanges: true },
      { id: "b", agent: "x", task: "B", gate: true, requireChanges: true },
    ];
    const executor = new FakeExecutor((input) => {
      if (input.step.id === "a") {
        fs.writeFileSync(path.join(dir, "a.txt"), "1", "utf-8");
      }
      return ok(input, `out-${input.step.id}`);
    });
    const options = baseOptions(steps, executor, { projectDir: dir, workDir: dir });

    const result = await runPipeline(options);

    assert.equal(result.state.status, "failed");
    assert.match(result.state.error ?? "", /no changes/);
    assert.equal(result.state.steps[0].status, "succeeded");
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

  void it("does not save an aborted baseline as a red baseline", async () => {
    const steps: PipelineStepDef[] = [{ id: "one", agent: "a", task: "First", gate: true }];
    const executor = new FakeExecutor((input) => ok(input, "out"));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 50);
    try {
      const result = await runPipeline({
        ...baseOptions(steps, executor),
        checks: [{ name: "slow", command: "sleep 5" }],
        signal: controller.signal,
      });
      assert.equal(result.state.status, "interrupted");
      assert.equal(result.state.baseline?.status, "skipped");
      assert.deepEqual(executor.calls, []);
    } finally {
      clearTimeout(timer);
    }
  });

  void it("stops a gated step when aborted during checks", async () => {
    const steps: PipelineStepDef[] = [{ id: "one", agent: "a", task: "First", gate: true }];
    const executor = new FakeExecutor((input) => ok(input, "out"));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 50);
    try {
      const result = await runPipeline({
        ...baseOptions(steps, executor),
        baseline: false,
        checks: [{ name: "slow", command: "sleep 5" }],
        signal: controller.signal,
      });
      assert.equal(result.state.status, "interrupted");
      assert.equal(result.state.steps[0].error, "run interrupted");
      assert.equal(result.state.steps[0].gate?.aborted, true);
      assert.deepEqual(executor.calls, ["one"]);
    } finally {
      clearTimeout(timer);
    }
  });

  void it("retries a gated step and passes on the second attempt", async () => {
    const dir = tempDir();
    const steps: PipelineStepDef[] = [{ id: "impl", agent: "a", task: "Do", gate: true }];
    const executor = new FakeExecutor((input, call) => {
      if (call === 2) fs.writeFileSync(path.join(dir, "ok"), "1", "utf-8");
      return ok(input, `attempt-${call}`);
    });
    const options = baseOptions(steps, executor, {
      projectDir: dir,
      workDir: dir,
      baseline: false,
      checks: [{ name: "check", command: "test -f ok" }],
    });

    const result = await runPipeline(options);

    assert.equal(result.state.status, "succeeded");
    assert.equal(result.state.steps[0].attempt, 2);
    assert.equal(result.state.steps[0].gate?.status, "passed");
    assert.deepEqual(executor.calls, ["impl", "impl"]);
    assert.match(executor.prompts[1], /Проверка не прошла/);
    assert.ok(Math.abs((result.state.cost ?? 0) - 0.002) < 1e-9);
    assert.ok(
      fs.existsSync(path.join(runDirFor(dir, "run-test"), "step-00-impl-attempt-1.md")),
    );
  });

  void it("fails a gated step when checks keep failing", async () => {
    const dir = tempDir();
    const steps: PipelineStepDef[] = [{ id: "impl", agent: "a", task: "Do", gate: true }];
    const executor = new FakeExecutor((input) => ok(input, "done"));
    const options = baseOptions(steps, executor, {
      projectDir: dir,
      workDir: dir,
      baseline: false,
      checks: [{ name: "check", command: "false" }],
    });

    const result = await runPipeline(options);

    assert.equal(result.state.status, "failed");
    assert.match(result.state.error ?? "", /check "check" failed/);
    assert.equal(result.state.steps[0].gate?.status, "failed");
    assert.deepEqual(executor.calls, ["impl", "impl"]);
  });

  void it("reuses the gate output when resuming a failed step", async () => {
    const dir = tempDir();
    const steps: PipelineStepDef[] = [{ id: "impl", agent: "a", task: "Do", gate: true }];
    const checks = [{ name: "check", command: "test -f ok" }];
    const firstOptions = baseOptions(
      steps,
      new FakeExecutor((input) => ok(input, "first")),
      { projectDir: dir, workDir: dir, baseline: false, checks },
    );

    const first = await runPipeline(firstOptions);
    assert.equal(first.state.status, "failed");
    assert.equal(first.state.steps[0].gate?.status, "failed");

    const secondExecutor = new FakeExecutor((input) => {
      fs.writeFileSync(path.join(dir, "ok"), "1", "utf-8");
      return ok(input, "second");
    });
    const second = await runPipeline({
      ...firstOptions,
      executor: secondExecutor,
      resume: loadRunState(dir, "run-test"),
    });

    assert.equal(second.state.status, "succeeded");
    assert.match(secondExecutor.prompts[0], /Проверка не прошла/);
    assert.equal(second.state.steps[0].attempt, 1);
  });

  void it("does not fail a step for pre-existing check failures", async () => {
    const dir = tempDir();
    const steps: PipelineStepDef[] = [{ id: "impl", agent: "a", task: "Do", gate: true }];
    const executor = new FakeExecutor((input) => ok(input, "done"));
    const options = baseOptions(steps, executor, {
      projectDir: dir,
      workDir: dir,
      checks: [{ name: "check", command: "echo '✖ old'; exit 1" }],
    });

    const result = await runPipeline(options);

    assert.equal(result.state.status, "succeeded");
    assert.equal(result.state.baseline?.status, "failed");
    assert.equal(result.state.steps[0].gate?.status, "passed");
    assert.match(
      result.state.steps[0].gate?.warnings?.join(" ") ?? "",
      /same failures/,
    );
    assert.deepEqual(executor.calls, ["impl"]);
  });

  void it("fails on a failure that is not in the baseline", async () => {
    const dir = tempDir();
    const steps: PipelineStepDef[] = [{ id: "impl", agent: "a", task: "Do", gate: true }];
    const executor = new FakeExecutor((input) => {
      fs.writeFileSync(path.join(dir, "new"), "1", "utf-8");
      return ok(input, "done");
    });
    const options = baseOptions(steps, executor, {
      projectDir: dir,
      workDir: dir,
      checks: [
        {
          name: "check",
          command: "if [ -f new ]; then echo '✖ new'; else echo '✖ old'; fi; exit 1",
        },
      ],
    });

    const result = await runPipeline(options);

    assert.equal(result.state.status, "failed");
    assert.match(result.state.error ?? "", /new failures: new/);
    assert.equal(result.state.steps[0].gate?.status, "failed");
    assert.deepEqual(executor.calls, ["impl", "impl"]);
  });

  void it("does not stop at a red baseline check and catches a later regression", async () => {
    const dir = tempDir();
    const steps: PipelineStepDef[] = [{ id: "impl", agent: "a", task: "Do", gate: true }];
    const executor = new FakeExecutor((input) => {
      fs.writeFileSync(path.join(dir, "broken"), "1", "utf-8");
      return ok(input, "done");
    });
    const options = baseOptions(steps, executor, {
      projectDir: dir,
      workDir: dir,
      checks: [
        { name: "test", command: "echo '✖ old'; exit 1" },
        { name: "types", command: "if [ -f broken ]; then echo '✖ new'; exit 1; fi" },
      ],
    });

    const result = await runPipeline(options);

    assert.equal(result.state.status, "failed");
    assert.match(result.state.error ?? "", /types: check was green before the run/);
  });

  void it("passes when a red baseline becomes green", async () => {
    const dir = tempDir();
    const steps: PipelineStepDef[] = [{ id: "impl", agent: "a", task: "Do", gate: true }];
    const executor = new FakeExecutor((input) => {
      fs.writeFileSync(path.join(dir, "fixed"), "1", "utf-8");
      return ok(input, "done");
    });
    const options = baseOptions(steps, executor, {
      projectDir: dir,
      workDir: dir,
      checks: [{ name: "check", command: "test -f fixed" }],
    });

    const result = await runPipeline(options);

    assert.equal(result.state.status, "succeeded");
    assert.equal(result.state.baseline?.status, "failed");
    assert.equal(result.state.steps[0].gate?.status, "passed");
    assert.equal(result.state.steps[0].gate?.baselineStatus, "failed");
  });

  void it("ignores a stored baseline when comparison is disabled", async () => {
    const dir = tempDir();
    const steps: PipelineStepDef[] = [{ id: "impl", agent: "a", task: "Do", gate: true }];
    const now = new Date().toISOString();
    const failedStep: StepExecution = {
      stepId: "impl",
      agent: "a",
      sessionID: "ses-old",
      status: "failed",
      text: "",
      transcript: "",
      error: "previous failure",
      startedAt: now,
      endedAt: now,
      durationMs: 1,
      permissionDecisions: [],
    };
    const baseline: GateResult = {
      status: "failed",
      durationMs: 1,
      checks: [
        {
          name: "check",
          command: "echo '✖ old'; exit 1",
          status: "failed",
          exitCode: 1,
          durationMs: 1,
          output: "✖ old",
        },
      ],
    };
    const resume: RunState = {
      version: 1,
      runId: "run-test",
      projectDir: dir,
      workDir: dir,
      worktree: false,
      pipeline: "test",
      task: "fix the bug",
      model: "m",
      status: "failed",
      baseline,
      steps: [failedStep],
      createdAt: now,
      updatedAt: now,
    };
    const executor = new FakeExecutor((input) => ok(input, "done"));
    const options = baseOptions(steps, executor, {
      projectDir: dir,
      workDir: dir,
      baseline: false,
      resume,
      checks: [{ name: "check", command: "echo '✖ old'; exit 1" }],
    });

    const result = await runPipeline(options);

    assert.equal(result.state.status, "failed");
    assert.equal(result.state.steps[0].gate?.status, "failed");
  });

  void it("does not run checks for steps without a gate", async () => {
    const dir = tempDir();
    const steps: PipelineStepDef[] = [{ id: "impl", agent: "a", task: "Do" }];
    const executor = new FakeExecutor((input) => ok(input, "done"));
    const options = baseOptions(steps, executor, {
      projectDir: dir,
      workDir: dir,
      checks: [{ name: "check", command: "false" }],
    });

    const result = await runPipeline(options);

    assert.equal(result.state.status, "succeeded");
    assert.equal(result.state.steps[0].gate, undefined);
    assert.deepEqual(executor.calls, ["impl"]);
  });

  void it("runs the planner and executes its plan", async () => {
    const dir = tempDir();
    const plan = {
      goal: "do it",
      steps: [
        { id: "work", agent: "build", mode: "change", task: "change code" },
        { id: "check", agent: "build", mode: "analyze", task: "review" },
      ],
    };
    const executor = new FakeExecutor((input) => {
      if (input.step.id === "work") {
        fs.writeFileSync(path.join(dir, "changed.txt"), "1", "utf-8");
      }
      return input.step.id === "planner"
        ? ok(input, `\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``)
        : ok(input, `out-${input.step.id}`);
    });
    const options = baseOptions([], executor, {
      projectDir: dir,
      workDir: dir,
      pipeline: "auto",
      planner: { agents: [{ name: "build" }, { name: "plan" }] },
    });

    const result = await runPipeline(options);

    assert.equal(result.state.status, "succeeded");
    assert.equal(result.state.plan?.length, 2);
    assert.equal(result.state.planner?.status, "succeeded");
    assert.deepEqual(executor.calls, ["planner", "work", "check"]);
    assert.ok(fs.existsSync(path.join(runDirFor(dir, "run-test"), "plan.json")));
    assert.ok(fs.existsSync(path.join(runDirFor(dir, "run-test"), "planner.md")));
  });

  void it("retries the planner when its output is invalid", async () => {
    const dir = tempDir();
    const plan = {
      goal: "do it",
      steps: [{ id: "check", agent: "build", mode: "analyze", task: "review" }],
    };
    const executor = new FakeExecutor((input, call) =>
      input.step.id === "planner" && call === 1
        ? ok(input, "not json")
        : ok(input, JSON.stringify(plan)),
    );
    const options = baseOptions([], executor, {
      projectDir: dir,
      workDir: dir,
      pipeline: "auto",
      planner: { agents: [{ name: "build" }] },
    });

    const result = await runPipeline(options);

    assert.equal(result.state.status, "succeeded");
    assert.deepEqual(executor.calls, ["planner", "planner", "check"]);
    assert.match(executor.prompts[1], /не прошёл проверку/);
  });

  void it("fails when the planner never returns a valid plan", async () => {
    const dir = tempDir();
    const executor = new FakeExecutor((input) => ok(input, "still not json"));
    const options = baseOptions([], executor, {
      projectDir: dir,
      workDir: dir,
      pipeline: "auto",
      planner: { agents: [{ name: "build" }] },
    });

    const result = await runPipeline(options);

    assert.equal(result.state.status, "failed");
    assert.match(result.state.error ?? "", /planner failed after 2 attempt/);
    assert.deepEqual(executor.calls, ["planner", "planner"]);
  });

  void it("resumes a planned run from the stored plan", async () => {
    const dir = tempDir();
    const plan = {
      goal: "do it",
      steps: [
        { id: "one", agent: "build", mode: "change", task: "first" },
        { id: "two", agent: "build", mode: "analyze", task: "second" },
      ],
    };
    const firstExecutor = new FakeExecutor((input) =>
      input.step.id === "planner"
        ? ok(input, JSON.stringify(plan))
        : failed(input, "boom"),
    );
    const firstOptions = baseOptions([], firstExecutor, {
      projectDir: dir,
      workDir: dir,
      pipeline: "auto",
      planner: { agents: [{ name: "build" }] },
    });

    const first = await runPipeline(firstOptions);
    assert.equal(first.state.status, "failed");
    assert.equal(first.state.plan?.length, 2);

    const secondExecutor = new FakeExecutor((input) => {
      if (input.step.id === "one") {
        fs.writeFileSync(path.join(dir, "changed.txt"), "1", "utf-8");
      }
      return ok(input, `out-${input.step.id}`);
    });
    const second = await runPipeline({
      ...firstOptions,
      steps: [],
      planner: undefined,
      executor: secondExecutor,
      resume: loadRunState(dir, "run-test"),
    });

    assert.equal(second.state.status, "succeeded");
    assert.deepEqual(secondExecutor.calls, ["one", "two"]);
  });
});

void describe("run state loading", () => {
  void it("rejects invalid run ids before touching the filesystem", () => {
    const dir = tempDir();

    for (const runId of ["../../etc", "..", "run-x/../..", "smoke"]) {
      assert.throws(() => runDirFor(dir, runId), /invalid run id/);
      assert.throws(() => loadRunState(dir, runId), /invalid run id/);
    }
  });

  void it("still resolves and loads a valid run id", () => {
    const dir = tempDir();
    const runDir = runDirFor(dir, "run-test");
    assert.equal(runDir, path.join(dir, ".deus", "runs", "run-test"));

    const now = new Date().toISOString();
    const state: RunState = {
      version: 1,
      runId: "run-test",
      projectDir: dir,
      workDir: dir,
      worktree: false,
      pipeline: "test",
      task: "fix the bug",
      model: "m",
      status: "succeeded",
      steps: [],
      createdAt: now,
      updatedAt: now,
    };
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify(state), "utf-8");

    const loaded = loadRunState(dir, "run-test");
    assert.equal(loaded.runId, "run-test");
    assert.equal(loaded.status, "succeeded");
  });

  void it("reports a broken run.json as a clear error, not a SyntaxError", () => {
    const dir = tempDir();
    const runDir = runDirFor(dir, "run-test");
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "run.json"), "{ not json", "utf-8");

    assert.throws(
      () => loadRunState(dir, "run-test"),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /is not valid JSON/);
        assert.ok(!(err instanceof SyntaxError), `unexpected error: ${err.name}`);
        return true;
      },
    );
  });
});
