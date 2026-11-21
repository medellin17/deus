import fs from "node:fs";
import path from "node:path";

import type { CheckCommand } from "./types.ts";

export const CONFIG_FILE = "deus.json";

export interface DeusConfig {
  model?: string;
  timeoutSeconds?: number;
  maxCost?: number;
  pipeline?: string;
  worktree?: boolean;
  merge?: boolean;
  /** Compare checks with the untouched worktree; defaults to true. */
  baseline?: boolean;
  /** Path to a permission policy, relative to the project root. */
  policy?: string;
  /** Named checks; a value may be a single command or a chain of commands. */
  checks?: CheckCommand[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(file: string, key: string, value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${file}: "${key}" must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(file: string, key: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(file, key, value);
}

function optionalNumber(file: string, key: string, value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${file}: "${key}" must be a non-negative number`);
  }
  return value;
}

function optionalPositiveNumber(
  file: string,
  key: string,
  value: unknown,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${file}: "${key}" must be a positive number`);
  }
  return value;
}

function optionalBoolean(file: string, key: string, value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`${file}: "${key}" must be true or false`);
  }
  return value;
}

function parseChecks(file: string, value: unknown): CheckCommand[] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(`${file}: "checks" must be an object of name → command`);
  }

  const checks: CheckCommand[] = [];
  for (const [name, raw] of Object.entries(value)) {
    const commands = Array.isArray(raw) ? raw : [raw];
    if (commands.length === 0) {
      throw new Error(`${file}: check "${name}" must contain at least one command`);
    }
    for (const command of commands) {
      if (typeof command !== "string" || command.trim().length === 0) {
        throw new Error(`${file}: check "${name}" must be a non-empty string`);
      }
    }
    checks.push({ name, command: commands.map((command) => command.trim()).join(" && ") });
  }

  return checks;
}

/**
 * Reads `deus.json` from the project root. A missing file is not an error:
 * the runner falls back to built-in defaults and auto-detected checks.
 */
export function loadConfig(projectDir: string): DeusConfig {
  const file = path.join(projectDir, CONFIG_FILE);
  if (!fs.existsSync(file)) return {};

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (error) {
    throw new Error(
      `${CONFIG_FILE}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!isRecord(raw)) {
    throw new Error(`${CONFIG_FILE}: expected a JSON object`);
  }

  return {
    model: optionalString(CONFIG_FILE, "model", raw.model),
    timeoutSeconds: optionalPositiveNumber(CONFIG_FILE, "timeoutSeconds", raw.timeoutSeconds),
    maxCost: optionalNumber(CONFIG_FILE, "maxCost", raw.maxCost),
    pipeline: optionalString(CONFIG_FILE, "pipeline", raw.pipeline),
    worktree: optionalBoolean(CONFIG_FILE, "worktree", raw.worktree),
    merge: optionalBoolean(CONFIG_FILE, "merge", raw.merge),
    baseline: optionalBoolean(CONFIG_FILE, "baseline", raw.baseline),
    policy: optionalString(CONFIG_FILE, "policy", raw.policy),
    checks: parseChecks(CONFIG_FILE, raw.checks),
  };
}

function readPackageScripts(projectDir: string): Record<string, unknown> | undefined {
  const file = path.join(projectDir, "package.json");
  if (!fs.existsSync(file)) return undefined;

  try {
    const pkg = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
    if (!isRecord(pkg) || !isRecord(pkg.scripts)) return undefined;
    return pkg.scripts;
  } catch {
    return undefined;
  }
}

const NPM_NO_TEST = /no test specified/i;

/**
 * Minimal auto-detection: only the test script. Lint and build are opt-in via
 * `deus.json`, because a pre-existing lint failure would otherwise block every
 * run in the project.
 */
export function detectChecks(projectDir: string): CheckCommand[] {
  const scripts = readPackageScripts(projectDir);
  if (!scripts) return [];

  const test = scripts.test;
  if (typeof test === "string" && test.trim() && !NPM_NO_TEST.test(test)) {
    return [{ name: "test", command: "npm test" }];
  }

  return [];
}

export function resolveChecks(
  config: DeusConfig,
  projectDir: string,
): CheckCommand[] {
  return config.checks ?? detectChecks(projectDir);
}
