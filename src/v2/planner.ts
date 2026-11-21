import { READ_ONLY_RULES } from "./pipelines.ts";
import type { Executor, PipelineStepDef, PlanStep, StepExecution } from "./types.ts";

export const PLANNER_STEP_ID = "planner";
export const PLANNER_AGENT = "plan";

const MAX_STEPS = 8;
const MAX_TASK_CHARS = 4000;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

export interface PlanAgent {
  name: string;
  description?: string;
}

export interface Plan {
  goal: string;
  steps: PlanStep[];
}

export interface PlannerOptions {
  task: string;
  agents: PlanAgent[];
  agent?: string;
  workDir: string;
  runId: string;
  timeoutMs: number;
  maxAttempts?: number;
  signal?: AbortSignal;
  onAttempt?: (attempt: number) => void;
}

export interface PlannerInput {
  agents: PlanAgent[];
  agent?: string;
  maxAttempts?: number;
}

export interface PlannerOutcome {
  plan?: Plan;
  execution: StepExecution;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function buildPlannerPrompt(task: string, agents: PlanAgent[]): string {
  const agentList = agents
    .map((agent) => `- ${agent.name}${agent.description ? ` — ${agent.description}` : ""}`)
    .join("\n");

  return `Ты — планировщик автономного прогона. Изучи проект в текущей рабочей директории и составь план.

## Задача

${task}

## Формат ответа

Верни ТОЛЬКО JSON, без markdown и пояснений:

{"goal":"...","steps":[{"id":"kebab-case","agent":"...","mode":"analyze|change","task":"..."}]}

## Правила

- От 1 до ${MAX_STEPS} шагов.
- "agent" — только из списка ниже.
- "analyze" — только чтение. "change" — правки файлов и команды.
- Если есть хотя бы один "change", последний шаг обязан быть "analyze": это ревью.
- "task" — конкретная инструкция агенту, без плейсхолдеров вроде {task}.
- Не добавляй шаги, которых нет в задаче.

## Доступные агенты

${agentList}`;
}

export function parsePlanJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced
    ? fenced[1]
    : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);

  if (!candidate.trim()) {
    throw new Error("planner response does not contain JSON");
  }

  try {
    return JSON.parse(candidate);
  } catch (error) {
    throw new Error(
      `planner returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Validates a raw plan. The planner cannot invent agents or grant itself
 * permissions: steps may only use agents from the live list, and the mode
 * decides whether the step is read-only.
 */
export function validatePlan(value: unknown, agents: PlanAgent[]): Plan {
  if (!isRecord(value)) {
    throw new Error("plan must be a JSON object");
  }

  if (typeof value.goal !== "string" || value.goal.trim().length === 0) {
    throw new Error("plan.goal must be a non-empty string");
  }

  if (!Array.isArray(value.steps) || value.steps.length === 0) {
    throw new Error("plan.steps must be a non-empty array");
  }

  if (value.steps.length > MAX_STEPS) {
    throw new Error(`plan.steps must contain at most ${MAX_STEPS} steps`);
  }

  const byName = new Map(agents.map((agent) => [agent.name.toLowerCase(), agent.name]));
  const seen = new Set<string>();
  const steps: PlanStep[] = [];

  for (let index = 0; index < value.steps.length; index++) {
    const raw = value.steps[index];
    const where = `plan.steps[${index}]`;

    if (!isRecord(raw)) {
      throw new Error(`${where} must be an object`);
    }

    const id = raw.id;
    if (typeof id !== "string" || !ID_PATTERN.test(id)) {
      throw new Error(`${where}.id must be lowercase letters, digits and dashes (max 40 chars)`);
    }

    if (seen.has(id)) {
      throw new Error(`${where}.id is duplicated: ${id}`);
    }
    seen.add(id);

    if (typeof raw.agent !== "string") {
      throw new Error(`${where}.agent must be a string`);
    }
    const agent = byName.get(raw.agent.toLowerCase());
    if (!agent) {
      throw new Error(
        `${where}.agent "${raw.agent}" is not available. Available: ${agents.map((item) => item.name).join(", ")}`,
      );
    }

    if (raw.mode !== "analyze" && raw.mode !== "change") {
      throw new Error(`${where}.mode must be "analyze" or "change"`);
    }

    if (typeof raw.task !== "string" || raw.task.trim().length === 0) {
      throw new Error(`${where}.task must be a non-empty string`);
    }

    if (raw.task.length > MAX_TASK_CHARS) {
      throw new Error(`${where}.task must be at most ${MAX_TASK_CHARS} characters`);
    }

    steps.push({ id, agent, mode: raw.mode, task: raw.task.trim() });
  }

  if (steps.some((step) => step.mode === "change") && steps[steps.length - 1].mode !== "analyze") {
    throw new Error("the last step must be analyze when the plan changes code");
  }

  return { goal: value.goal.trim(), steps };
}

export function planToSteps(steps: PlanStep[]): PipelineStepDef[] {
  return steps.map((step) => ({
    id: step.id,
    agent: step.agent,
    task: step.task,
    permissions: step.mode === "analyze" ? READ_ONLY_RULES : undefined,
    gate: step.mode === "change",
    requireChanges: step.mode === "change",
  }));
}

/**
 * Asks the planner agent for a plan and validates it. Invalid output is
 * retried with the validation error, so a sloppy answer does not fail the run
 * on the first try.
 */
export async function generatePlan(
  executor: Executor,
  options: PlannerOptions,
): Promise<PlannerOutcome> {
  const prompt = buildPlannerPrompt(options.task, options.agents);
  const step: PipelineStepDef = {
    id: PLANNER_STEP_ID,
    agent: options.agent ?? PLANNER_AGENT,
    permissions: READ_ONLY_RULES,
    task: prompt,
  };

  const maxAttempts = Math.max(1, options.maxAttempts ?? 2);
  let priorCost = 0;
  let feedback = "";
  let last: StepExecution | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    options.onAttempt?.(attempt);

    const execution = await executor.run({
      step,
      prompt: feedback
        ? `${prompt}\n\n## Предыдущая попытка\n\nОтвет не прошёл проверку: ${feedback}\nВерни только исправленный JSON.`
        : prompt,
      runId: options.runId,
      index: 0,
      workDir: options.workDir,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });

    execution.attempt = attempt;
    execution.priorCost = priorCost;
    last = execution;

    if (execution.status !== "succeeded") {
      return { execution, error: execution.error ?? "planner step failed" };
    }

    try {
      const plan = validatePlan(parsePlanJson(execution.text), options.agents);
      return { plan, execution };
    } catch (error) {
      feedback = error instanceof Error ? error.message : String(error);
      priorCost += execution.cost ?? 0;
    }
  }

  const error = `planner failed after ${maxAttempts} attempt(s): ${feedback}`;
  if (last) {
    last.status = "failed";
    last.error = error;
  }

  return { execution: last as StepExecution, error };
}
