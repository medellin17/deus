import { spawnSync } from "node:child_process";

import type { CheckCommand, CheckResult, GateResult } from "./types.ts";

const MAX_OUTPUT_CHARS = 12_000;
const DEFAULT_CHECK_TIMEOUT_MS = 5 * 60_000;

export function truncateCheckOutput(text: string, limit = MAX_OUTPUT_CHARS): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  return `… (${trimmed.length - limit} chars omitted)\n${trimmed.slice(-limit)}`;
}

/**
 * Runs one project check in the work directory. Checks are shell commands
 * from the project config, so the runner never guesses how a project builds.
 */
export function runCheck(
  check: CheckCommand,
  cwd: string,
  timeoutMs = DEFAULT_CHECK_TIMEOUT_MS,
): CheckResult {
  const started = Date.now();
  const result = spawnSync(check.command, {
    shell: true,
    cwd,
    encoding: "utf-8",
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const output = truncateCheckOutput(`${result.stdout ?? ""}${result.stderr ?? ""}`);
  const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  const timedOut =
    errorCode === "ETIMEDOUT" || (result.status === null && result.signal !== null);

  const status: CheckResult["status"] = timedOut
    ? "timedOut"
    : result.status === 0 && !result.error
      ? "passed"
      : "failed";

  return {
    name: check.name,
    command: check.command,
    status,
    exitCode: result.status ?? null,
    durationMs: Date.now() - started,
    output,
  };
}

export interface RunGateOptions {
  timeoutMs?: number;
  /** Baseline runs need every check, not only the first failure. */
  stopOnFirstFailure?: boolean;
}

/**
 * Runs checks in order. A failed check means the step did not achieve its
 * goal, regardless of what the agent reported.
 */
export function runGate(
  checks: CheckCommand[],
  cwd: string,
  options: RunGateOptions = {},
): GateResult {
  const started = Date.now();

  if (checks.length === 0) {
    return { status: "skipped", checks: [], durationMs: 0 };
  }

  const results: CheckResult[] = [];

  for (const check of checks) {
    const result = runCheck(check, cwd, options.timeoutMs);
    results.push(result);

    if (result.status !== "passed" && options.stopOnFirstFailure !== false) {
      break;
    }
  }

  const failed = results.filter((result) => result.status !== "passed");

  if (failed.length > 0) {
    const first = failed[0];
    return {
      status: "failed",
      checks: results,
      durationMs: Date.now() - started,
      error: `check "${first.name}" ${first.status === "timedOut" ? "timed out" : "failed"}${
        failed.length > 1 ? ` (+${failed.length - 1} more)` : ""
      }`,
    };
  }

  return { status: "passed", checks: results, durationMs: Date.now() - started };
}

const ANSI = /\x1b\[[0-9;]*m/g;

const FAILURE_PATTERNS = [
  /^not ok\s+\d+\s*[-–]\s*(.+)$/u,
  /^✖\s*(.+)$/u,
  /^✕\s*(.+)$/u,
  /^●\s*(.+)$/u,
  /^--- FAIL:\s*(.+)$/u,
  /^FAILED\s+(.+)$/u,
  /^FAIL(?::|\s)\s*(.+)$/u,
];

const FATAL_LINE_PATTERNS = [
  /error TS\d+:/i,
  /\berror[\[(:]/i,
  /\bnpm (?:error|ERR!)/i,
  /UnhandledPromiseRejection/i,
  /\bcommand not found\b/i,
  /^make: \*\*\*.*Error \d+/i,
  /^sh: (?:line )?\d+:/i,
  /Cannot find module/i,
  /\bENOENT\b/,
  /Segmentation fault/i,
  /panic:/i,
  /\bFATAL\b/i,
  /\b(?:Killed|Aborted|out of memory)\b/i,
];

const ERROR_CLASS_PATTERN = /\b(\w*Error)\b:/;

function normalizeSignature(value: string): string {
  return value
    .replace(/\(\d+(?:\.\d+)?\s*(?:ms|s|m)\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function comparableOutput(output: string): string {
  return output
    .replace(ANSI, "")
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extracts stable names of failing tests from common reporters: node:test,
 * jest, mocha, vitest, pytest and go test. This is a heuristic: it is used
 * only to tell a pre-existing failure from a new one when the baseline is red.
 */
export function failureSignatures(output: string): string[] {
  const signatures = new Set<string>();

  for (const raw of output.replace(ANSI, "").split("\n")) {
    const line = raw.trim();
    for (const pattern of FAILURE_PATTERNS) {
      const match = line.match(pattern);
      if (!match) continue;
      const name = normalizeSignature(match[1]);
      if (name) signatures.add(name);
      break;
    }
  }

  return [...signatures].sort();
}

/**
 * Fatal lines that are not test names: compiler errors, crashes, panics.
 * They are compared separately so a known failing test does not hide a new
 * fatal error in the same output.
 */
export function fatalSignatures(output: string): string[] {
  const signatures = new Set<string>();

  for (const raw of output.replace(ANSI, "").split("\n")) {
    const line = raw.trim();
    if (FAILURE_PATTERNS.some((pattern) => pattern.test(line))) continue;

    if (FATAL_LINE_PATTERNS.some((pattern) => pattern.test(line))) {
      signatures.add(normalizeSignature(line));
      continue;
    }

    const errorClass = line.match(ERROR_CLASS_PATTERN);
    if (errorClass) {
      signatures.add(`class:${errorClass[1]}`);
    }
  }

  return [...signatures].sort();
}

/**
 * Compares the current check run with the baseline taken before the agent
 * touched anything. A red baseline does not block the run by itself: only
 * failures that were not present in the baseline are treated as regressions.
 */
export function applyBaseline(
  baseline: GateResult | undefined,
  current: GateResult,
): GateResult {
  const currentTimeout = current.checks.find((check) => check.status === "timedOut");
  if (currentTimeout) {
    return {
      ...current,
      status: "failed",
      baselineStatus: baseline?.status,
      error: `check "${currentTimeout.name}" timed out; the run cannot be verified`,
    };
  }

  if (!baseline || baseline.status === "skipped") {
    return { ...current, baselineStatus: baseline?.status };
  }

  const baselineTimeout = baseline.checks.find((check) => check.status === "timedOut");
  if (baselineTimeout && current.status !== "passed") {
    return {
      ...current,
      status: "failed",
      baselineStatus: "failed",
      error: `baseline check "${baselineTimeout.name}" timed out; comparison is not reliable`,
      warnings: current.warnings,
    };
  }

  if (baseline.status === "passed") {
    return { ...current, baselineStatus: "passed" };
  }

  if (current.status === "passed") {
    return {
      ...current,
      baselineStatus: "failed",
      warnings: [
        ...(current.warnings ?? []),
        "checks were red before the run and are green now",
      ],
    };
  }

  const problems: string[] = [];
  const warnings: string[] = [...(current.warnings ?? [])];

  for (const check of current.checks) {
    const before = baseline.checks.find((item) => item.name === check.name);

    if (check.status === "passed") {
      if (before && before.status !== "passed") {
        warnings.push(`${check.name}: was red before the run, is green now`);
      }
      continue;
    }

    if (!before || before.status === "passed") {
      problems.push(`${check.name}: check was green before the run`);
      continue;
    }

    const beforeFatal = fatalSignatures(before.output);
    const currentFatal = fatalSignatures(check.output);
    const newFatal = currentFatal.filter((line) => !beforeFatal.includes(line));

    if (newFatal.length > 0) {
      problems.push(`${check.name}: new fatal output: ${newFatal[0]}`);
      continue;
    }

    const beforeSignatures = failureSignatures(before.output);
    const currentSignatures = failureSignatures(check.output);

    if (beforeSignatures.length === 0 || currentSignatures.length === 0) {
      if (comparableOutput(before.output) === comparableOutput(check.output)) {
        warnings.push(
          `${check.name}: was red before the run with identical output; treating as pre-existing`,
        );
      } else {
        problems.push(
          `${check.name}: baseline was red but the failure output changed and cannot be compared`,
        );
      }
      continue;
    }

    const added = currentSignatures.filter((signature) => !beforeSignatures.includes(signature));
    if (added.length > 0) {
      problems.push(`${check.name}: new failures: ${added.slice(0, 5).join("; ")}`);
    } else {
      warnings.push(`${check.name}: same failures as before the run`);
    }
  }

  if (problems.length > 0) {
    return {
      ...current,
      status: "failed",
      baselineStatus: "failed",
      error: problems.join("; "),
      warnings,
    };
  }

  return {
    ...current,
    status: "passed",
    baselineStatus: "failed",
    error: undefined,
    warnings,
  };
}
