import fs from "node:fs";
import path from "node:path";

import * as yaml from "js-yaml";

/** Directory (relative to the run workdir) that holds the agent definitions. */
export const AGENTS_DIR = path.join(".opencode", "agents");

const DEFAULT_ROLE = "worker";
const MAX_REPORTS_DEPTH = 2;
const MODEL_REF = /^[^/\s#]+\/[^\s#]+(?:#[^\s#]+)?$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export interface AgentBudget {
  /** Hard ceiling in USD for the agent's work. */
  maxCost?: number;
  /** Hard ceiling on the number of steps the agent may take. */
  maxSteps?: number;
}

export type AgentWorkspace =
  | { kind: "inherit" }
  | { kind: "read-only" }
  | { kind: "path"; path: string };

export interface AgentRecord {
  /** Agent id, i.e. the file name without `.md`. */
  id: string;
  file: string;
  description?: string;
  role: string;
  reportsTo?: string;
  workspace: AgentWorkspace;
  budget?: AgentBudget;
  /** Native OpenCode tool allow-list, passed through unchanged. */
  tools?: Record<string, boolean>;
  /** Native OpenCode model override, e.g. `provider/model#variant`. */
  model?: string;
}

export interface AgentRegistry {
  readonly dir: string;
  get(id: string): AgentRecord | undefined;
  list(): AgentRecord[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(file: string, message: string): never {
  throw new Error(`${path.basename(file)}: ${message}`);
}

/**
 * Reads the YAML frontmatter block. Returns `undefined` when the file has no
 * frontmatter at all, and `{}` when the block is empty. A block that opens with
 * `---` and never closes is an error: silently dropping the agent would hide a
 * typo.
 */
function readFrontmatter(file: string): unknown | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch (error) {
    fail(file, `cannot read agent file: ${error instanceof Error ? error.message : String(error)}`);
  }

  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  // Delimiters must start at column 0: an indented `---` is content inside a
  // block scalar (e.g. a markdown rule in `description: |`), not the closing one.
  if (!/^---\s*$/.test(lines[0])) return undefined;

  let end = -1;
  for (let index = 1; index < lines.length; index++) {
    if (/^---\s*$/.test(lines[index])) {
      end = index;
      break;
    }
  }
  if (end === -1) fail(file, "unterminated YAML frontmatter");

  const body = lines.slice(1, end).join("\n");
  const meaningful = body
    .split("\n")
    .some((line) => line.trim().length > 0 && !line.trim().startsWith("#"));
  // An empty or comment-only block is a valid empty document; js-yaml 5 throws
  // on those, so short-circuit before parsing.
  if (!meaningful) return {};

  try {
    return yaml.load(body) ?? {};
  } catch (error) {
    fail(file, `invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function optionalString(file: string, key: string, value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(file, `"${key}" must be a non-empty string`);
  }
  return value.trim();
}

function parseWorkspace(file: string, value: unknown): AgentWorkspace {
  const workspace = optionalString(file, "workspace", value);
  if (workspace === undefined) return { kind: "inherit" };
  if (workspace === "read-only") return { kind: "read-only" };
  if (CONTROL_CHARS.test(workspace)) {
    fail(file, `"workspace" must not contain control characters`);
  }

  // Unify separators before any absolute-path check: a Windows drive or UNC
  // path is absolute even on POSIX, where `path.isAbsolute` would miss it.
  const unified = workspace.replace(/\\/g, "/");
  const looksAbsolute =
    path.posix.isAbsolute(unified) ||
    path.win32.isAbsolute(workspace) ||
    /^[A-Za-z]:/.test(unified);
  if (looksAbsolute) {
    fail(file, `"workspace" must be relative to the project, got an absolute path`);
  }

  const normalized = path.posix.normalize(unified);
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized) ||
    /^[A-Za-z]:/.test(normalized)
  ) {
    fail(file, `"workspace" must stay inside the project: ${workspace}`);
  }
  // `.` is the project root, i.e. the same as an inherited workspace.
  if (normalized === ".") return { kind: "inherit" };

  return { kind: "path", path: normalized };
}

function parseBudget(file: string, value: unknown): AgentBudget | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) fail(file, `"budget" must be an object`);

  const maxCost = value.maxCost;
  if (
    maxCost !== undefined &&
    (typeof maxCost !== "number" || !Number.isFinite(maxCost) || maxCost < 0)
  ) {
    fail(file, `"budget.maxCost" must be a non-negative number`);
  }

  const maxSteps = value.maxSteps;
  if (
    maxSteps !== undefined &&
    (typeof maxSteps !== "number" || !Number.isInteger(maxSteps) || maxSteps <= 0)
  ) {
    fail(file, `"budget.maxSteps" must be a positive integer`);
  }

  if (maxCost === undefined && maxSteps === undefined) return undefined;
  return {
    maxCost: maxCost as number | undefined,
    maxSteps: maxSteps as number | undefined,
  };
}

function parseTools(file: string, value: unknown): Record<string, boolean> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) fail(file, `"tools" must be an object of tool → boolean`);

  const tools: Record<string, boolean> = {};
  for (const [name, enabled] of Object.entries(value)) {
    if (typeof enabled !== "boolean") {
      fail(file, `"tools.${name}" must be true or false`);
    }
    tools[name] = enabled;
  }
  return tools;
}

function parseModel(file: string, value: unknown): string | undefined {
  const model = optionalString(file, "model", value);
  if (model === undefined) return undefined;
  if (!MODEL_REF.test(model)) {
    fail(file, `"model" must look like provider/model or provider/model#variant`);
  }
  return model;
}

function parseRecord(id: string, file: string, raw: unknown): AgentRecord {
  if (!isRecord(raw)) fail(file, "frontmatter must be a YAML object");

  return {
    id,
    file,
    description: optionalString(file, "description", raw.description),
    role: optionalString(file, "role", raw.role) ?? DEFAULT_ROLE,
    reportsTo: optionalString(file, "reports_to", raw.reports_to),
    workspace: parseWorkspace(file, raw.workspace),
    budget: parseBudget(file, raw.budget),
    tools: parseTools(file, raw.tools),
    model: parseModel(file, raw.model),
  };
}

function validateReportsTo(records: Map<string, AgentRecord>): void {
  for (const record of records.values()) {
    if (record.reportsTo === undefined) continue;
    if (record.reportsTo === record.id) {
      fail(record.file, `"reports_to" cannot point at the agent itself`);
    }
    if (!records.has(record.reportsTo)) {
      fail(record.file, `"reports_to" refers to an unknown agent: ${record.reportsTo}`);
    }

    const seen = new Set<string>([record.id]);
    let current: string | undefined = record.reportsTo;
    let depth = 0;
    while (current !== undefined) {
      if (seen.has(current)) fail(record.file, `"reports_to" forms a cycle`);
      seen.add(current);
      depth++;
      if (depth > MAX_REPORTS_DEPTH) {
        fail(record.file, `"reports_to" is deeper than ${MAX_REPORTS_DEPTH} levels`);
      }
      current = records.get(current)?.reportsTo;
    }
  }
}

/**
 * Reads `.opencode/agents/*.md` from the run workdir. A missing directory yields
 * an empty registry: agent definitions are optional for projects that only use
 * the built-in OpenCode agents.
 *
 * The parser is strict about our own fields (`role`, `reports_to`, `workspace`,
 * `budget`) and about the shapes of the native ones (`tools`, `model`), so a
 * typo fails before any session starts instead of silently doing nothing.
 */
export function loadRegistry(workDir: string): AgentRegistry {
  const dir = path.join(workDir, AGENTS_DIR);
  const records = new Map<string, AgentRecord>();

  let names: string[] = [];
  try {
    if (fs.statSync(dir).isDirectory()) {
      names = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.name.endsWith(".md"))
        .map((entry) => entry.name)
        .sort();
    }
  } catch {
    // Missing or unreadable directory: no agent definitions.
    names = [];
  }

  for (const name of names) {
    const file = path.join(dir, name);
    try {
      // Follow symlinks: a linked agent file is still an agent file.
      if (!fs.statSync(file).isFile()) continue;
    } catch {
      continue;
    }

    const raw = readFrontmatter(file);
    if (raw === undefined) continue;
    const id = name.slice(0, -".md".length);
    records.set(id, parseRecord(id, file, raw));
  }

  validateReportsTo(records);

  return {
    dir,
    get: (id) => records.get(id),
    list: () => [...records.values()],
  };
}

/** Per-agent model with the run-level model as the fallback. */
export function agentModel(
  registry: AgentRegistry,
  agentId: string,
  fallback: string,
): string {
  return registry.get(agentId)?.model ?? fallback;
}

/**
 * Clamps an agent budget to the run ceiling: a role can spend less than the run
 * allows, never more. Undefined fields stay undefined.
 */
export function clampBudget(
  budget: AgentBudget | undefined,
  runMaxCost: number | undefined,
): AgentBudget | undefined {
  if (budget === undefined) return undefined;
  if (runMaxCost === undefined || budget.maxCost === undefined) return budget;

  return { ...budget, maxCost: Math.min(budget.maxCost, runMaxCost) };
}