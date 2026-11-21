import assert from "node:assert";
import { describe, it } from "node:test";

import {
  generatePlan,
  parsePlanJson,
  planToSteps,
  validatePlan,
  type PlanAgent,
} from "../../v2/planner.ts";
import type { Executor, ExecutorInput, StepExecution } from "../../v2/types.ts";

const AGENTS: PlanAgent[] = [
  { name: "plan", description: "read-only researcher" },
  { name: "build", description: "implementation agent" },
  { name: "Reviewer", description: "review agent" },
];

function validPlan() {
  return {
    goal: "add multiply",
    steps: [
      { id: "implement", agent: "build", mode: "change", task: "add multiply to math.js" },
      { id: "review", agent: "reviewer", mode: "analyze", task: "review the diff" },
    ],
  };
}

function execution(input: ExecutorInput, text: string): StepExecution {
  return {
    stepId: input.step.id,
    agent: input.step.agent,
    sessionID: "ses-test",
    status: "succeeded",
    text,
    transcript: text,
    cost: 0.001,
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    durationMs: 1,
    permissionDecisions: [],
  };
}

class FakeExecutor implements Executor {
  calls = 0;
  readonly prompts: string[] = [];

  constructor(private readonly replies: string[]) {}

  async run(input: ExecutorInput): Promise<StepExecution> {
    const reply = this.replies[this.calls] ?? "{}";
    this.calls++;
    this.prompts.push(input.prompt);
    return execution(input, reply);
  }
}

void describe("parsePlanJson", () => {
  void it("reads a fenced JSON block", () => {
    const parsed = parsePlanJson(`Вот план:\n\`\`\`json\n{"goal":"g","steps":[]}\n\`\`\``);
    assert.deepEqual(parsed, { goal: "g", steps: [] });
  });

  void it("reads JSON surrounded by prose", () => {
    const parsed = parsePlanJson('План: {"goal":"g","steps":[]} конец');
    assert.deepEqual(parsed, { goal: "g", steps: [] });
  });

  void it("rejects a response without JSON", () => {
    assert.throws(() => parsePlanJson("no json here"), /does not contain JSON/);
  });
});

void describe("validatePlan", () => {
  void it("normalizes agent names and keeps the plan", () => {
    const plan = validatePlan(validPlan(), AGENTS);
    assert.equal(plan.goal, "add multiply");
    assert.equal(plan.steps[0].agent, "build");
    assert.equal(plan.steps[1].agent, "Reviewer");
  });

  void it("rejects an unknown agent", () => {
    const plan = validPlan();
    plan.steps[0].agent = "hacker";
    assert.throws(() => validatePlan(plan, AGENTS), /not available/);
  });

  void it("rejects duplicate step ids", () => {
    const plan = validPlan();
    plan.steps[1].id = "implement";
    assert.throws(() => validatePlan(plan, AGENTS), /duplicated/);
  });

  void it("requires a final analyze step after changes", () => {
    const plan = validPlan();
    plan.steps[1].mode = "change";
    assert.throws(() => validatePlan(plan, AGENTS), /last step must be analyze/);
  });

  void it("allows an analyze-only plan", () => {
    const plan = {
      goal: "audit",
      steps: [{ id: "survey", agent: "plan", mode: "analyze", task: "look around" }],
    };
    assert.equal(validatePlan(plan, AGENTS).steps.length, 1);
  });
});

void describe("planToSteps", () => {
  void it("gates change steps and locks analyze steps", () => {
    const plan = validatePlan(validPlan(), AGENTS);
    const steps = planToSteps(plan.steps);

    assert.equal(steps[0].gate, true);
    assert.equal(steps[0].requireChanges, true);
    assert.equal(steps[0].permissions, undefined);
    assert.equal(steps[1].gate, false);
    assert.equal(steps[1].requireChanges, false);
    assert.ok(steps[1].permissions?.some((rule) => rule.action === "edit"));
  });
});

void describe("generatePlan", () => {
  const base = {
    task: "add multiply",
    agents: AGENTS,
    workDir: "/tmp",
    runId: "run-test",
    timeoutMs: 1000,
  };

  void it("returns a validated plan", async () => {
    const executor = new FakeExecutor([JSON.stringify(validPlan())]);
    const outcome = await generatePlan(executor, base);

    assert.ok(outcome.plan);
    assert.equal(outcome.plan?.steps.length, 2);
    assert.equal(outcome.execution.status, "succeeded");
  });

  void it("retries with the validation error attached", async () => {
    const executor = new FakeExecutor(["not json", JSON.stringify(validPlan())]);
    const outcome = await generatePlan(executor, base);

    assert.ok(outcome.plan);
    assert.equal(executor.calls, 2);
    assert.match(executor.prompts[1], /не прошёл проверку/);
    assert.equal(outcome.execution.priorCost, 0.001);
  });

  void it("fails after the attempt limit", async () => {
    const executor = new FakeExecutor(["not json", "still not json"]);
    const outcome = await generatePlan(executor, { ...base });

    assert.equal(outcome.plan, undefined);
    assert.match(outcome.error ?? "", /planner failed after 2 attempt/);
    assert.equal(outcome.execution.status, "failed");
  });
});
