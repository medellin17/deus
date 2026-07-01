/**
 * Agentic Orchestrator v2 — Hybrid multi-agent runner for OpenCode.
 *
 * Two modes:
 *   --orchestrate  LLM conductor dynamically plans & dispatches (default)
 *   --pipeline     Static predefined step sequence
 *
 * Usage:
 *   npx tsx src/orchestrator.ts "задача"                           → orchestrate (default)
 *   npx tsx src/orchestrator.ts --orchestrate "задача"             → orchestrate
 *   npx tsx src/orchestrator.ts --pipeline build "задача"          → static pipeline
 *   npx tsx src/orchestrator.ts --agent researcher-explorer "задача" → direct single agent
 *   npx tsx src/orchestrator.ts --parallel "задача1" "задача2"     → parallel
 *   npx tsx src/orchestrator.ts --demo                             → demo scenarios
 */

import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";
import { spawn, spawnSync, type ChildProcess } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createKB, type KbProvider } from "./kb/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Types ──────────────────────────────────────────────────────────────────

interface TaskStep {
  task: string;
  agent: string;
  /** If set, executes in parallel with other steps having the same parallelGroup number */
  parallelGroup?: number;
}

interface StepResult {
  stepIndex: number;
  agent: string;
  task: string;
  sessionId: string;
  output: string;
  durationMs: number;
  success: boolean;
  error?: string;
}

interface PipelineResult {
  success: boolean;
  steps: StepResult[];
  totalDurationMs: number;
}

interface SaveResultsOptions {
  mode: string;
  task: string;
  pipelineName?: string;
  agent?: string;
  conductorNote?: string;
  outputDir?: string;
}

/** Local type for session API method not exposed in SDK types */
interface SessionWithPrompt {
  promptAsync(params: { path: { id: string }; body: { parts: Array<{ type: string; text?: string }>; agent: string } }): Promise<void>;
}

/** Local type for KbProvider method not in base interface */
interface KbProviderWithEmbeddings extends KbProvider {
  generateEmbeddings(): Promise<number>;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_BASE_URL = "http://localhost:4096";
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 минут для оркестрации
const POLL_INTERVAL_MS = 2000;
const DEFAULT_AGENT = "orchestrator-conductor";
const DEFAULT_CWD = process.cwd();

// ─── Path Validation ─────────────────────────────────────────────────────────

function isValidTargetPath(targetPath: string): boolean {
  try {
    const resolved = path.resolve(targetPath);
    const cwd = process.cwd();
    return resolved === cwd || resolved.startsWith(cwd + path.sep);
  } catch {
    return false;
  }
}

// ─── Valid Agents ────────────────────────────────────────────────────────────

const VALID_AGENTS = [
  "orchestrator-conductor",
  "researcher-explorer",
  "architect-planner",
  "architect-planner-pro",
  "implementer-builder",
  "reviewer-critic",
  "reviewer-critic-pro",
  "integrator-qa",
  "debug",
  "doc-maintainer",
  "content-writer",
  "data-analyst",
  "ux-designer",
  "code-reviewer",
  "test-engineer",
  "security-auditor",
  "skills-indexer",
] as const;

// ─── Pipeline Presets (static fallback) ─────────────────────────────────────

const PIPELINES: Record<string, TaskStep[]> = {
  build: [
    { task: "Исследуй кодовую базу и найди релевантные файлы для задачи: {task}", agent: "researcher-explorer" },
    { task: "Создай план реализации для задачи: {task}\n\nКонтекст исследования:\n{prev}", agent: "architect-planner" },
    { task: "Реализуй код согласно плану:\n{prev}\n\nЗадача: {task}", agent: "implementer-builder" },
    { task: "Проведи ревью реализации:\n{prev}\n\nЗадача: {task}", agent: "reviewer-critic" },
    { task: "Запусти тесты и проверь работоспособность:\n{prev}", agent: "integrator-qa" },
  ],
  "build-pro": [
    { task: "Исследуй кодовую базу: {task}", agent: "researcher-explorer" },
    { task: "Создай детальный план (high-stakes): {task}\n\nКонтекст:\n{prev}", agent: "architect-planner-pro" },
    { task: "Реализуй: {task}\n\nПлан:\n{prev}", agent: "implementer-builder" },
    { task: "Ревью (high-stakes): {task}\n\nРеализация:\n{prev}", agent: "reviewer-critic-pro" },
    { task: "Тесты:\n{prev}", agent: "integrator-qa" },
  ],
  "full-cycle": [
    { task: "Исследуй кодовую базу: {task}", agent: "researcher-explorer" },
    { task: "Создай детальный план (high-stakes): {task}\n\nКонтекст:\n{prev}", agent: "architect-planner-pro" },
    { task: "Ревью плана: {task}\n\nПлан:\n{prev}", agent: "reviewer-critic-pro" },
    { task: "Реализуй: {task}\n\nПлан:\n{prev}", agent: "implementer-builder" },
    { task: "Ревью реализации: {task}\n\nРеализация:\n{prev}", agent: "reviewer-critic-pro" },
    { task: "Тесты: {task}\n\nРеализация:\n{prev}", agent: "integrator-qa" },
    { task: "Обнови документацию: {task}\n\nКонтекст:\n{prev}", agent: "doc-maintainer" },
  ],
  audit: [
    { task: "Аудит безопасности: {task}", agent: "security-auditor" },
    { task: "Ревью кода: {task}", agent: "code-reviewer" },
    { task: "Аудит производительности: {task}", agent: "reviewer-critic" },
  ],
  debug: [
    { task: "Исследуй проблему: {task}", agent: "researcher-explorer" },
    { task: "Найди корневую причину: {task}\n\nКонтекст:\n{prev}", agent: "debug" },
    { task: "Исправь баг: {task}\n\nАнализ:\n{prev}", agent: "implementer-builder" },
    { task: "Проверь исправление: {task}", agent: "integrator-qa" },
  ],
  docs: [
    { task: "Исследуй что нужно задокументировать: {task}", agent: "researcher-explorer" },
    { task: "Напиши документацию: {task}\n\nКонтекст:\n{prev}", agent: "content-writer" },
    { task: "Проверь документацию: {task}", agent: "reviewer-critic" },
  ],

  // ── Parallel audit: 3 reviewers in parallel ──
  "parallel-audit": [
    { task: "Проведи аудит безопасности проекта: {task}", agent: "security-auditor", parallelGroup: 1 },
    { task: "Выполни структурированное ревью кода: {task}", agent: "code-reviewer", parallelGroup: 1 },
    { task: "Выполни критический анализ проекта: {task}", agent: "reviewer-critic", parallelGroup: 1 },
  ],

  // ── Parallel research: 3 researchers from different angles ──
  "parallel-research": [
    { task: "Исследуй архитектуру и структуру проекта: {task}", agent: "researcher-explorer", parallelGroup: 1 },
    { task: "Исследуй зависимости и конфигурации: {task}", agent: "researcher-explorer", parallelGroup: 1 },
    { task: "Исследуй тесты и качество кода: {task}", agent: "researcher-explorer", parallelGroup: 1 },
  ],

  // ── Parallel review: 3 reviewers on same context ──
  "parallel-review": [
    { task: "Аудит безопасности: {task}\n\nКонтекст:\n{prev}", agent: "security-auditor", parallelGroup: 1 },
    { task: "Ревью кода и архитектуры: {task}\n\nКонтекст:\n{prev}", agent: "code-reviewer", parallelGroup: 1 },
    { task: "Анализ производительности: {task}\n\nКонтекст:\n{prev}", agent: "reviewer-critic", parallelGroup: 1 },
  ],

  // ── Content: research → write → review (sequential) ──
  content: [
    { task: "Исследуй тему и собери материалы: {task}", agent: "researcher-explorer" },
    { task: "Напиши контент:\n{prev}", agent: "content-writer" },
    { task: "Проверь контент:\n{prev}", agent: "reviewer-critic" },
  ],

  // ── Data: research → analyze → review (sequential) ──
  data: [
    { task: "Исследуй данные и источники: {task}", agent: "researcher-explorer" },
    { task: "Проанализируй данные:\n{prev}", agent: "data-analyst" },
    { task: "Проверь анализ:\n{prev}", agent: "reviewer-critic" },
  ],

  // ── Design: research → ux → review → prototype (sequential) ──
  design: [
    { task: "Исследуй требования: {task}", agent: "researcher-explorer" },
    { task: "Спроектируй UX/UI:\n{prev}", agent: "ux-designer" },
    { task: "Проверь дизайн:\n{prev}", agent: "reviewer-critic" },
    { task: "Реализуй прототип:\n{prev}", agent: "implementer-builder" },
  ],

  // ── Plan: research → architect (sequential) ──
  plan: [
    { task: "Исследуй кодовую базу: {task}", agent: "researcher-explorer" },
    { task: "Создай план реализации:\n{prev}", agent: "architect-planner" },
  ],

  // ── Research: single researcher step (sequential) ──
  research: [
    { task: "Проведи исследование: {task}", agent: "researcher-explorer" },
  ],
};

// ─── Logging ────────────────────────────────────────────────────────────────

function log(level: "INFO" | "WARN" | "ERROR" | "DEBUG", message: string): void {
  const ts = new Date().toISOString().replace("T", " ").replace(/\.\d{3}Z/, "");
  console.log(`[${ts}][${level}] ${message}`);
}

// ─── Client ─────────────────────────────────────────────────────────────────

let client: OpencodeClient;
let kb: KbProvider | null = null;
let kbProjectPath: string | null = null;
let kbCachedRag: boolean | null = null;
let globalUseRag: boolean = true;
let globalCwd: string = process.cwd();

function getKB(projectPath?: string, useRag?: boolean): KbProvider {
  const projectDir = projectPath || kbProjectPath || globalCwd;
  const rag = useRag ?? globalUseRag;
  if (!kb || kbProjectPath !== projectDir || kbCachedRag !== rag) {
    if (kb) kb.close();
    const dbPath = path.join(projectDir, ".deus", "kb", "orchestrator.db");
    kb = createKB(dbPath, rag);
    kbProjectPath = projectDir;
    kbCachedRag = rag;
  }
  return kb;
}

function getClient(): OpencodeClient {
  if (!client) {
    const baseUrl = process.env.OPENCODE_URL || DEFAULT_BASE_URL;
    client = createOpencodeClient({ baseUrl });
  }
  return client;
}

// ─── Server Management ─────────────────────────────────────────────────────

let serverProcess: ChildProcess | null = null;
let serverWasAlreadyRunning = false;

async function checkServerRunning(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/global/health`);
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureServerRunning(baseUrl: string, cwd?: string): Promise<void> {
  if (await checkServerRunning(baseUrl)) {
    log("INFO", "Сервер уже запущен, подключение...");
    serverWasAlreadyRunning = true;
    return;
  }

  const serverCwd = cwd || DEFAULT_CWD;
  log("INFO", `Запуск opencode serve в ${serverCwd}...`);
  serverProcess = spawn("npx", ["opencode", "serve", "--port", "4096"], {
    stdio: "pipe",
    detached: false,
    cwd: serverCwd,
  });

  serverProcess.stdout?.on("data", (data: Buffer) => {
    const lines = data.toString().trim().split("\n");
    for (const line of lines) {
      log("DEBUG", `[server] ${line}`);
    }
  });

  serverProcess.stderr?.on("data", (data: Buffer) => {
    const lines = data.toString().trim().split("\n");
    for (const line of lines) {
      log("DEBUG", `[server] ${line}`);
    }
  });

  serverProcess.on("error", (err: Error) => {
    log("ERROR", `Ошибка запуска сервера: ${err.message}`);
  });

  serverProcess.on("exit", (code: number | null) => {
    if (!serverWasAlreadyRunning) {
      log("INFO", `Сервер завершён (code ${code})`);
    }
    serverProcess = null;
  });

  log("INFO", "Ожидание готовности сервера...");
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await checkServerRunning(baseUrl)) {
      log("INFO", "Сервер готов");
      return;
    }
  }
  throw new Error("Сервер не запустился за 30 секунд");
}

function stopServer(): void {
  if (serverProcess && !serverWasAlreadyRunning) {
    log("INFO", "Остановка сервера...");
    serverProcess.kill("SIGTERM");
    serverProcess = null;
  }
}

function ensureDeusDir(targetDir: string): void {
  const deusDir = path.join(targetDir, ".deus");
  const kbDir = path.join(deusDir, "kb");
  const runsDir = path.join(deusDir, "runs");
  fs.mkdirSync(kbDir, { recursive: true });
  fs.mkdirSync(runsDir, { recursive: true });
  const gitignorePath = path.join(deusDir, ".gitignore");
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, "# Deus runtime data\n*\n", "utf-8");
  }
}

function copyOpenCodeToTarget(targetDir: string): void {
  const sourceDir = path.join(__dirname, "..", ".opencode");
  const destDir = path.join(targetDir, ".opencode");

  log("INFO", `Копирование .opencode/ в ${targetDir}...`);
  fs.mkdirSync(destDir, { recursive: true });

  const copyDir = (src: string, dst: string) => {
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const srcPath = path.join(src, entry.name);
      const dstPath = path.join(dst, entry.name);
      if (entry.isDirectory()) {
        fs.mkdirSync(dstPath, { recursive: true });
        copyDir(srcPath, dstPath);
      } else {
        fs.copyFileSync(srcPath, dstPath);
      }
    }
  };

  copyDir(sourceDir, destDir);
  log("INFO", `.opencode/ скопирован (${fs.readdirSync(destDir).length} элементов)`);
}

function ensurePackageJson(targetDir: string): void {
  const pkgPath = path.join(targetDir, "package.json");
  if (fs.existsSync(pkgPath)) return;
  log("INFO", "Создание package.json для Smart Context и KB...");
  const pkg = {
    private: true,
    type: "module",
    description: "Auto-generated by Deus Orchestrator",
    dependencies: {},
    devDependencies: {},
  };
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");
  log("INFO", `package.json создан: ${pkgPath}`);
}

function installSmartContext(targetDir: string): void {
  ensurePackageJson(targetDir);
  const pkgPath = path.join(targetDir, "package.json");

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (allDeps["smart-context-retrieving"]) {
      log("INFO", "Smart Context уже установлен");
      return;
    }
  } catch {
    log("WARN", "Не удалось прочитать package.json");
    return;
  }

  const smartContextDir = path.resolve(__dirname, "..", "..", "smart-context-retrieving");
  if (!fs.existsSync(smartContextDir)) {
    log("WARN", `Локальный Smart Context не найден: ${smartContextDir}`);
    return;
  }

  log("INFO", `Установка Smart Context из ${smartContextDir}...`);

  try {
    let result = spawnSync("npm", ["install", "--ignore-scripts", smartContextDir], {
      cwd: targetDir,
      stdio: "pipe",
      timeout: 60000,
      shell: false,
    });

    if (result.error?.code === "ENOENT") {
      log("WARN", "npm не найден, пробуем через npx...");
      result = spawnSync("npx", ["-y", "npm", "install", "--ignore-scripts", smartContextDir], {
        cwd: targetDir,
        stdio: "pipe",
        timeout: 60000,
        shell: false,
      });
    }

    if (result.error) throw result.error;
    if (result.status !== 0) {
      console.warn(`[warn] npm install smart-context-retrieving exit code: ${result.status}`);
    }
    log("INFO", "Smart Context установлен");
  } catch (err) {
    log("WARN", `Не удалось установить Smart Context: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const ORCHESTRATOR_AGENTS_SECTION = `## Deus Orchestrator

Этот проект подключён к [Deus](https://github.com/medellin17/deus) — multi-agent оркестратору для OpenCode.

### Доступные агенты (17)

| Агент | Роль |
|-------|------|
| orchestrator-conductor | Главный дирижёр, декомпозирует, dispatch-ит, синтезирует |
| architect-planner | Базовый архитектор |
| architect-planner-pro | Продвинутый архитектор (deepseek-v4-pro) |
| implementer-builder | Пишет код |
| reviewer-critic | Код-ревью (стандартные задачи) |
| reviewer-critic-pro | Продвинутое ревью (deepseek-v4-pro, high-stakes) |
| integrator-qa | Тестирование |
| researcher-explorer | Анализ кодовой базы |
| debug | Диагностика багов |
| security-auditor | Аудит безопасности |
| code-reviewer | Структурированный ревью |
| content-writer | Тексты, документация |
| doc-maintainer | Ведение документации |
| test-engineer | Написание тестов |
| data-analyst | Анализ данных |
| ux-designer | UX/UI |
| skills-indexer | Индексация skills |

### Команды

\`\`\`bash
# Оркестрация (LLM-конductor сам выбирает пайплайн)
npx tsx /path/to/deus/src/orchestrator.ts --cwd . "задача"

# Статический пайплайн
npx tsx /path/to/deus/src/orchestrator.ts --cwd . --pipeline build "задача"

# Один агент
npx tsx /path/to/deus/src/orchestrator.ts --cwd . --agent implementer-builder "задача"

# Индексация проекта в KB
npx tsx /path/to/deus/src/orchestrator.ts --index .

# Статистика KB
npx tsx /path/to/deus/src/orchestrator.ts --kb-stats --cwd .
\`\`\`

### Пайплайны

| Название | Шаги |
|----------|------|
| build | researcher → architect → implementer → reviewer → qa |
| build-pro | researcher → architect-pro → implementer → reviewer-pro → qa |
| full-cycle | researcher → architect-pro → reviewer-pro → implementer → reviewer-pro → qa → doc |
| audit | security → code-reviewer → reviewer |
| debug | researcher → debug → implementer → qa |
| docs | researcher → content-writer → reviewer |

### Knowledge Base

- FTS5 — keyword поиск (BM25)
- Memory Tree — иерархические саммари
- Per-project — БД в .deus/kb/orchestrator.db

### Custom Tools

- search_code — умный поиск кода (BM25 + Symbol Graph + Graph Walk)
  - Требует: npm install smart-context-retrieving + npx code-assistant index .
  - Автоматически устанавливается при использовании --cwd
`;

function writeProjectAgentsMd(targetDir: string): void {
  const agentsPath = path.join(targetDir, "AGENTS.md");
  const marker = "## Deus Orchestrator";

  if (fs.existsSync(agentsPath)) {
    const content = fs.readFileSync(agentsPath, "utf-8");
    if (content.includes(marker)) {
      log("INFO", "AGENTS.md уже содержит секцию Deus Orchestrator");
      return;
    }
    log("INFO", "Добавление секции Deus Orchestrator в AGENTS.md...");
    fs.appendFileSync(agentsPath, "\n\n" + ORCHESTRATOR_AGENTS_SECTION, "utf-8");
    log("INFO", "AGENTS.md обновлён");
  } else {
    log("INFO", "Создание AGENTS.md...");
    fs.writeFileSync(agentsPath, ORCHESTRATOR_AGENTS_SECTION, "utf-8");
    log("INFO", "AGENTS.md создан");
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function extractText(parts: Array<{ type: string; text?: string }>): string {
  return parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function validateAgent(a: string): boolean {
  return (VALID_AGENTS as readonly string[]).includes(a);
}

// ─── Core: runSession (async + polling) ─────────────────────────────────────

async function runSession(
  task: string,
  agent: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<StepResult> {
  const c = getClient();
  const start = Date.now();

  log("INFO", `→ [${agent}] Создание сессии...`);

  let sessionId: string;
  try {
    const res = await c.session.create({
      body: { title: `[orchestrator] ${agent}: ${task.slice(0, 80)}` },
    });
    const id = res.data?.id;
    if (!id) {
      throw new Error("Сервер не вернул ID сессии");
    }
    sessionId = id;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log("ERROR", `Сервер недоступен: ${msg}`);
    return { stepIndex: -1, agent, task, sessionId: "", output: "", durationMs: Date.now() - start, success: false, error: msg };
  }

  log("INFO", `→ [${agent}] Сессия ${sessionId}, отправка promptAsync (таймаут ${fmtDuration(timeoutMs)})...`);

  // Async prompt — не блокируется
  try {
    await (c.session as unknown as SessionWithPrompt).promptAsync({
      path: { id: sessionId },
      body: { parts: [{ type: "text", text: task }], agent },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log("ERROR", `[${agent}] Ошибка promptAsync: ${msg}`);
    return { stepIndex: -1, agent, task, sessionId, output: "", durationMs: Date.now() - start, success: false, error: msg };
  }

  // Poll messages until finish=stop or timeout
  log("INFO", `[${agent}] Ожидание ответа...`);
  let output = "";
  let errorStr: string | undefined;
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    try {
      const msgRes = await c.session.messages({ path: { id: sessionId } });
      const messages = (msgRes.data || msgRes) as Array<{
        info: { role: string; finish?: string; error?: { name: string; data?: { message?: string } } };
        parts: Array<{ type: string; text?: string }>;
      }>;

      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.info.role !== "assistant") continue;

        if (msg.info.error) {
          errorStr = msg.info.error.data?.message || msg.info.error.name || "Unknown error";
          break;
        }

        if (msg.info.finish === "stop" || msg.info.finish === "tool-calls") {
          output = extractText(msg.parts);
          if (output) break;
        }
      }
      if (output || errorStr) break;
    } catch {
      // retry
    }
  }

  const durationMs = Date.now() - start;
  const success = output.length > 0;

  if (success) log("INFO", `✅ [${agent}] Готово за ${fmtDuration(durationMs)} (${output.length} символов)`);
  else if (errorStr) log("ERROR", `❌ [${agent}] Ошибка: ${errorStr} за ${fmtDuration(durationMs)}`);
  else log("ERROR", `❌ [${agent}] Пустой ответ / таймаут за ${fmtDuration(durationMs)}`);

  return { stepIndex: -1, agent, task, sessionId, output, durationMs, success, error: success ? undefined : (errorStr || "Пустой ответ или таймаут") };
}

async function runSessionWithRetry(task: string, agent: string, timeoutMs?: number): Promise<StepResult> {
  const first = await runSession(task, agent, timeoutMs);
  if (first.success) return first;
  log("WARN", `Повторная попытка для [${agent}]...`);
  return runSession(task, agent, timeoutMs);
}

// ─── Core: runOrchestrate ───────────────────────────────────────────────────

async function runOrchestrate(task: string): Promise<StepResult> {
  log("INFO", `▶ Оркестрация: LLM-конductor выбирает пайплайн и управляет агентами`);
  const cfgPath = path.join(globalCwd, ".opencode", "opencode.json");
  let conductorModel = "unknown";
  try { const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8")); conductorModel = cfg.agent?.[DEFAULT_AGENT]?.model || cfg.model || "unknown"; } catch {}
  log("INFO", `  Конductor: ${DEFAULT_AGENT} (${conductorModel})`);
  log("INFO", `  Задача: ${task.slice(0, 120)}${task.length > 120 ? "..." : ""}`);

  // Auto-inject context from Knowledge Base
  let contextPrefix = "";
  try {
    const kbInstance = getKB(globalCwd, globalUseRag);

    // Auto-index if KB is empty
    if (!kbInstance.hasContext()) {
      log("INFO", `  KB: пуста, индексация проекта...`);
      kbInstance.indexDirectory(globalCwd);
      const s = kbInstance.stats();
      log("INFO", `  KB: проиндексировано ${s.documents} документов, ${s.chunks} чанков`);

      // Generate embeddings if Gemini API key is available
      if (process.env.GEMINI_API_KEY && "generateEmbeddings" in kbInstance) {
        const count = await (kbInstance as KbProviderWithEmbeddings).generateEmbeddings();
        log("INFO", `  KB: сгенерировано ${count} эмбеддингов`);
      }
    }

    if (kbInstance.hasContext()) {
      const context = kbInstance.getContext(task);
      if (context) {
        contextPrefix = `\n\n## Knowledge Base Context (auto-injected)\n${context}\n\n---\n\n`;
        log("INFO", `  KB: контекст инжектирован (${context.length} символов)`);
      }
    }
  } catch {
    log("WARN", `  KB: не удалось получить контекст`);
  }

  log("INFO", "");
  const fullTask = contextPrefix ? `${contextPrefix}## Задача\n\n${task}` : task;
  const r = await runSessionWithRetry(fullTask, DEFAULT_AGENT);
  r.stepIndex = 0;

  log("INFO", "");
  if (r.success) {
    log("INFO", `✅ Оркестрация завершена за ${fmtDuration(r.durationMs)}`);
    log("INFO", `  Сессия: ${r.sessionId}`);
    log("INFO", `  Размер ответа: ${r.output.length} символов`);

    // Save summary to KB memory tree
    try {
      const kbInstance = getKB(globalCwd, globalUseRag);
      const summary = r.output.slice(0, 500);
      kbInstance.upsertMemory(`task:${task.slice(0, 80)}`, "file", summary);
    } catch {
      // ignore
    }
  } else {
    log("ERROR", `❌ Оркестрация не удалась: ${r.error}`);
  }

  return r;
}

// ─── Core: runPipeline ──────────────────────────────────────────────────────

async function runPipeline(steps: TaskStep[]): Promise<PipelineResult> {
  const t0 = Date.now();
  const results: StepResult[] = [];
  let prev = "";

  log("INFO", `▶ Пайплайн: ${steps.length} шагов`);

  let i = 0;
  while (i < steps.length) {
    const s = steps[i];

    // ── Sequential step ──
    if (s.parallelGroup === undefined) {
      let taskText = s.task.replace(/\{task\}/g, prev || "(нет исходной задачи)");
      taskText = taskText.replace(/\{prev\}/g, prev || "(нет предыдущего контекста)");

      log("INFO", `\n── Шаг ${i + 1}/${steps.length}: ${s.agent} ──`);
      const r = await runSessionWithRetry(taskText, s.agent);
      r.stepIndex = results.length;
      results.push(r);

      if (!r.success) {
        log("ERROR", `⛔ Пайплайн прерван на шаге ${i + 1} (${s.agent})`);
        return { success: false, steps: results, totalDurationMs: Date.now() - t0 };
      }
      prev = r.output;
      i++;
      continue;
    }

    // ── Parallel group: collect consecutive steps with same parallelGroup ──
    const group = s.parallelGroup;
    const batch: TaskStep[] = [];
    while (i < steps.length && steps[i].parallelGroup === group) {
      batch.push(steps[i]);
      i++;
    }

    if (batch.length === 0) continue;

    log("INFO", `\n── Параллельная группа ${group}: ${batch.length} шагов ──`);
    for (const b of batch) {
      log("INFO", `  · ${b.agent}`);
    }

    const promises = batch.map((b, idx) => {
      let taskText = b.task.replace(/\{task\}/g, prev || "(нет исходной задачи)");
      taskText = taskText.replace(/\{prev\}/g, prev || "(нет предыдущего контекста)");
      return runSessionWithRetry(taskText, b.agent).then((r) => {
        r.stepIndex = results.length + idx;
        return r;
      });
    });

    const batchResults = await Promise.all(promises);
    for (const r of batchResults) {
      results.push(r);
    }

    const allOk = batchResults.every((r) => r.success);
    if (!allOk) {
      log("ERROR", `⛔ Пайплайн прерван на параллельной группе ${group}`);
      return { success: false, steps: results, totalDurationMs: Date.now() - t0 };
    }

    // Merge parallel outputs as new prev
    prev = batchResults
      .map((r) => `## Результат: ${r.agent}\n\n${r.output}`)
      .join("\n\n---\n\n");
  }

  log("INFO", `\n✅ Пайплайн завершён за ${fmtDuration(Date.now() - t0)}`);
  return { success: true, steps: results, totalDurationMs: Date.now() - t0 };
}

// ─── Core: runParallel ──────────────────────────────────────────────────────

async function runParallel(tasks: TaskStep[]): Promise<PipelineResult> {
  const t0 = Date.now();
  log("INFO", `▶ Параллельный запуск: ${tasks.length} задач`);

  const promises = tasks.map((t, i) =>
    runSessionWithRetry(t.task, t.agent).then((r) => { r.stepIndex = i; return r; }),
  );

  const results = await Promise.all(promises);
  const allOk = results.every((r) => r.success);

  if (allOk) log("INFO", `✅ Все ${tasks.length} задач выполнены за ${fmtDuration(Date.now() - t0)}`);
  else log("ERROR", `❌ ${results.filter((r) => !r.success).length}/${tasks.length} задач упали`);

  return { success: allOk, steps: results, totalDurationMs: Date.now() - t0 };
}

// ─── Core: runDirect ────────────────────────────────────────────────────────

async function runDirect(task: string, agent: string = DEFAULT_AGENT): Promise<StepResult> {
  log("INFO", `▶ Прямой запуск: ${agent}`);
  const r = await runSessionWithRetry(task, agent);
  r.stepIndex = 0;
  return r;
}

// ─── Demo ───────────────────────────────────────────────────────────────────

async function runDemo(): Promise<void> {
  console.log("\n══ Agentic Orchestrator v2 — Демо-сценарии ══\n");

  log("INFO", "── Сценарий 1: Оркестрация (LLM conductor) ──");
  const o = await runOrchestrate("Опиши структуру текущего проекта и предложи 2 улучшения");
  printStep(o, 1);

  console.log("");
  log("INFO", "── Сценарий 2: Прямой запуск (researcher-explorer) ──");
  const d = await runDirect("Найди все TypeScript файлы в проекте", "researcher-explorer");
  printStep(d, 2);

  console.log("");
  log("INFO", "── Сценарий 3: Пайплайн build ──");
  const p = await runPipeline(
    PIPELINES.build.map((s) => ({
      ...s,
      task: s.task.replace(/\{task\}/g, "Добавь функцию валидации email"),
    })),
  );
  printPipeline(p);

  console.log("\n══ Все демонстрационные сценарии завершены. ══");
}

// ─── Output Formatters ──────────────────────────────────────────────────────

function printStep(r: StepResult, num: number): void {
  console.log(`\n${r.success ? "✅" : "❌"} Сценарий ${num}: ${r.agent} (${fmtDuration(r.durationMs)})`);
  console.log(`   Задача: ${r.task.slice(0, 100)}${r.task.length > 100 ? "..." : ""}`);
  if (r.error) console.log(`   Ошибка: ${r.error}`);
  if (r.output) {
    const preview = r.output.slice(0, 500);
    console.log(`   Ответ (${r.output.length} символов):\n   ${preview}${r.output.length > 500 ? "\n   ..." : ""}`);
  }
}

function saveResults(p: PipelineResult, opts: SaveResultsOptions): void {
  const ts = Date.now();
  const dateStr = new Date(ts).toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dirName = opts.outputDir ? `run-${opts.outputDir}` : `run-${dateStr}`;
  const runDir = path.join(globalCwd, ".deus", "runs", dirName);
  fs.mkdirSync(runDir, { recursive: true });

  const summary: string[] = [];
  summary.push(`# Orchestrator Report`);
  summary.push(``);
  summary.push(`- **Режим:** ${opts.mode}`);
  if (opts.pipelineName) summary.push(`- **Пайплайн:** \`${opts.pipelineName}\``);
  if (opts.agent) summary.push(`- **Агент:** \`${opts.agent}\``);
  summary.push(`- **Задача:** ${opts.task}`);
  summary.push(`- **Дата:** ${new Date(ts).toISOString()}`);
  summary.push(`- **Статус:** ${p.success ? "✅ Успешно" : "❌ Ошибка"}`);
  summary.push(`- **Всего:** ${fmtDuration(p.totalDurationMs)}`);
  summary.push(``);
  summary.push(`| # | Агент | Статус | Длит. | Файл |`);
  summary.push(`|---|-------|--------|-------|------|`);

  for (const s of p.steps) {
    const safeName = s.agent.replace(/[^a-z0-9-]/gi, "_");
    const fname = `${safeName}.md`;
    const fpath = path.join(runDir, fname);
    const lines: string[] = [
      `# ${s.agent}`,
      ``,
      `- **Задача:** ${s.task}`,
      `- **Статус:** ${s.success ? "✅" : "❌"}`,
      `- **Длительность:** ${fmtDuration(s.durationMs)}`,
    ];
    if (s.error) lines.push(`- **Ошибка:** ${s.error}`);
    lines.push(``, `---`, ``, s.output || "_пусто_");
    try { fs.writeFileSync(fpath, lines.join("\n"), "utf-8"); } catch { /* ignore */ }
    summary.push(`| ${s.stepIndex + 1} | ${s.agent} | ${s.success ? "✅" : "❌"} | ${fmtDuration(s.durationMs)} | \`${fname}\` |`);
  }

  if (opts.conductorNote) {
    summary.push(``);
    summary.push(`## Conductor Summary`);
    summary.push(``);
    summary.push(opts.conductorNote);
  }

  summary.push(``);
  summary.push(`---`);
  summary.push(`*Сохранено в \`${runDir}\`*`);

  const indexPath = path.join(runDir, "index.md");
  try {
    fs.writeFileSync(indexPath, summary.join("\n"), "utf-8");
    console.log(`\n📁 Результаты: ${runDir}`);
  } catch (e: unknown) {
    console.log(`\n⚠️ Не удалось сохранить результаты (код: ${(e as { code?: string }).code || "unknown"})`);
  }
}

function printPipeline(p: PipelineResult): void {
  console.log(`\n${p.success ? "✅" : "❌"} ${p.steps.length} шагов, ${fmtDuration(p.totalDurationMs)}`);
  for (const s of p.steps) {
    console.log(`\n${"═".repeat(60)}`);
    console.log(`  ${s.success ? "✓" : "✗"} [${s.stepIndex + 1}] ${s.agent} — ${fmtDuration(s.durationMs)}`);
    if (s.error) console.log(`      Ошибка: ${s.error}`);
    if (s.output) {
      console.log(`\n  Ответ:\n${s.output}`);
    }
  }
  console.log(`\n${"═".repeat(60)}`);
}

function printResult(r: StepResult): void {
  console.log(`\n${r.success ? "✅" : "❌"} ${r.agent} (${fmtDuration(r.durationMs)})`);
  if (r.error) console.log(`Ошибка: ${r.error}`);
  if (r.output) {
    console.log(`\nОтвет (${r.output.length} символов):\n${"─".repeat(60)}\n${r.output}\n${"─".repeat(60)}`);
  }
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function printHelp(): void {
  console.log(`
Agentic Orchestrator v2 — Multi-agent pipeline runner for OpenCode

Использование:
  npx tsx src/orchestrator.ts "задача"                              → orchestrate (по умолчанию)
  npx tsx src/orchestrator.ts --orchestrate "задача"                → LLM conductor
  npx tsx src/orchestrator.ts --pipeline <имя> "задача"             → static pipeline
  npx tsx src/orchestrator.ts --agent <агент> "задача"              → direct single agent
  npx tsx src/orchestrator.ts --parallel "задача1" "задача2" ...    → parallel
  npx tsx src/orchestrator.ts --index <путь>                        → индексация в KB
  npx tsx src/orchestrator.ts --kb-stats                            → статистика KB
  npx tsx src/orchestrator.ts --demo                                → demo
  npx tsx src/orchestrator.ts --help                                → help

Режимы:
  --orchestrate   LLM-конductor динамически выбирает пайплайн, dispatch-ит агентов
  --pipeline      Фиксированный пайплайн из preset'ов
  --agent         Один конкретный агент
  --parallel      Несколько задач параллельно
  --index         Индексация проекта в Knowledge Base
  --kb-stats      Статистика Knowledge Base

Опции:
  --cwd <path>        Рабочая директория для opencode serve (по умолчанию: текущая)
  --rag               Включить RAG (контекст из Knowledge Base) — по умолчанию
  --no-rag            Отключить RAG (без контекста из KB)
  --output-dir, -o    Имя подпапки в .deus/runs/ для сохранения результатов

Доступные агенты:
  ${VALID_AGENTS.join("\n  ")}

Доступные пайплайны:
  ${Object.keys(PIPELINES).join(", ")}

Переменные окружения:
  OPENCODE_URL  URL сервера (по умолчанию: ${DEFAULT_BASE_URL})
  GEMINI_API_KEY  Ключ для Gemini embeddings (для RAG поиска)
`);
}

type Mode = "orchestrate" | "direct" | "pipeline" | "parallel" | "index" | "kb-stats" | "demo" | "help";

interface CliArgs {
  mode: Mode;
  agent: string;
  pipeline: string;
  tasks: string[];
  cwd?: string;
  useRag: boolean;
  outputDir?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  let mode: Mode = "orchestrate";
  let agent = DEFAULT_AGENT;
  let pipeline = "";
  let cwd: string | undefined;
  let useRag = true;
  let outputDir: string | undefined;
  const tasks: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--help" || a === "-h") { mode = "help"; return { mode, agent, pipeline, tasks, cwd, useRag, outputDir: undefined }; }
    if (a === "--demo") { mode = "demo"; continue; }
    if (a === "--orchestrate") { mode = "orchestrate"; continue; }
    if (a === "--cwd") { cwd = args[++i]; continue; }
    if (a === "--index") { mode = "index"; continue; }
    if (a === "--kb-stats") { mode = "kb-stats"; continue; }
    if (a === "--agent" || a === "-a") {
      agent = args[++i] || "";
      if (!validateAgent(agent)) {
        log("ERROR", `Неизвестный агент: ${agent}. Доступные: ${VALID_AGENTS.join(", ")}`);
        process.exit(1);
      }
      mode = "direct";
      continue;
    }
    if (a === "--pipeline" || a === "-p") {
      pipeline = args[++i] || "";
      if (!PIPELINES[pipeline]) {
        log("ERROR", `Неизвестный пайплайн: ${pipeline}. Доступные: ${Object.keys(PIPELINES).join(", ")}`);
        process.exit(1);
      }
      mode = "pipeline";
      continue;
    }
    if (a === "--parallel") { mode = "parallel"; continue; }
    if (a === "--rag") { useRag = true; continue; }
    if (a === "--no-rag") { useRag = false; continue; }
    if (a === "--output-dir" || a === "-o") {
      outputDir = args[++i] || "";
      continue;
    }
    tasks.push(a);
  }

  if (mode === "pipeline" && tasks.length === 0) { log("ERROR", "Пайплайн требует задачу"); process.exit(1); }
  if (mode === "orchestrate" && tasks.length === 0) { log("ERROR", "Укажите задачу"); process.exit(1); }
  if (mode === "direct" && tasks.length === 0) { log("ERROR", "Укажите задачу"); process.exit(1); }
  if (mode === "index" && tasks.length === 0) { log("ERROR", "Укажите путь для индексации"); process.exit(1); }
  return { mode, agent, pipeline, tasks, cwd, useRag, outputDir };
}

// ─── Graceful Shutdown ──────────────────────────────────────────────────────

function shutdownAndExit(code: number, reason?: string): never {
  if (reason) log("INFO", `Shutdown: ${reason}`);
  stopServer();
  return process.exit(code);
}

// ─── Entry ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { mode, agent, pipeline, tasks, cwd, useRag, outputDir } = parseArgs(process.argv);
  globalUseRag = useRag;

  // Validate --cwd path (prevent path traversal)
  if (cwd && !isValidTargetPath(cwd)) {
    console.error("Error: --cwd path must be within the current working directory");
    process.exit(1);
  }

  // Register signal handlers early — before any process.exit() can be called
  process.on("SIGINT", () => shutdownAndExit(0, "SIGINT received"));
  process.on("SIGTERM", () => shutdownAndExit(0, "SIGTERM received"));

  if (mode === "help") { printHelp(); return; }
  if (cwd) globalCwd = path.resolve(cwd);

  ensureDeusDir(globalCwd);

  // Auto-copy .opencode/ to target project
  if (globalCwd !== process.cwd()) {
    copyOpenCodeToTarget(globalCwd);
    installSmartContext(globalCwd);
    writeProjectAgentsMd(globalCwd);
  }

  const baseUrl = process.env.OPENCODE_URL || DEFAULT_BASE_URL;
  // Modes that don't need opencode server (help already returns early above)
  if (mode !== "kb-stats" && mode !== "index") {
    try {
      await ensureServerRunning(baseUrl, cwd);
    } catch (err: unknown) {
      log("ERROR", `Не удалось запустить сервер: ${err instanceof Error ? err.message : String(err)}`);
      shutdownAndExit(1);
    }
  }

  log("INFO", `══ Agentic Orchestrator v2 | Сервер: ${baseUrl} ══\n`);

  try {
    switch (mode) {
      case "demo":
        await runDemo();
        break;
      case "orchestrate": {
        const r = await runOrchestrate(tasks[0]);
        printResult(r);
        const pipelineResult: PipelineResult = {
          success: r.success,
          steps: [r],
          totalDurationMs: r.durationMs,
        };
        saveResults(pipelineResult, { mode: "orchestrate", task: tasks[0], outputDir });
        return shutdownAndExit(r.success ? 0 : 1);
      }
      case "direct": {
        const r = await runDirect(tasks[0], agent);
        printResult(r);
        const pipelineResult: PipelineResult = {
          success: r.success,
          steps: [r],
          totalDurationMs: r.durationMs,
        };
        saveResults(pipelineResult, { mode: "direct", task: tasks[0], agent, outputDir });
        return shutdownAndExit(r.success ? 0 : 1);
      }
      case "pipeline": {
        const filled = PIPELINES[pipeline].map((s) => ({
          ...s,
          task: s.task.replace(/\{task\}/g, tasks[0]),
        }));
        const r = await runPipeline(filled);
        printPipeline(r);
        saveResults(r, { mode: "pipeline", task: tasks[0], pipelineName: pipeline, outputDir });
        return shutdownAndExit(r.success ? 0 : 1);
      }
      case "parallel": {
        const r = await runParallel(tasks.map((t) => ({ task: t, agent: DEFAULT_AGENT })));
        printPipeline(r);
        saveResults(r, { mode: "parallel", task: tasks.join(" | "), outputDir });
        return shutdownAndExit(r.success ? 0 : 1);
      }
      case "index": {
        const indexPath = tasks[0] || process.cwd();
        if (!isValidTargetPath(indexPath)) {
          console.error("Error: --index path must be within the current working directory");
          process.exit(1);
        }
        const target = path.resolve(indexPath);
        if (!globalUseRag) {
          log("WARN", "RAG отключён (--no-rag), индексация не выполняется");
          break;
        }
        const kbInstance = getKB(target, globalUseRag);
        log("INFO", `Индексация: ${target}`);
        kbInstance.indexDirectory(target);
        const s = kbInstance.stats();
        log("INFO", `Готово: ${s.documents} документов, ${s.chunks} чанков, ${s.embeddings} эмбеддингов`);

        // Асинхронная генерация эмбеддингов
        if (process.env.GEMINI_API_KEY && "generateEmbeddings" in kbInstance) {
        const count = await (kbInstance as KbProviderWithEmbeddings).generateEmbeddings();
          log("INFO", `Эмбеддинги: ${count} векторов сгенерировано`);
        }
        break;
      }
      case "kb-stats": {
        if (!globalUseRag) {
          log("WARN", "RAG отключён (--no-rag), статистика пуста");
        }
        const kbInstance = getKB(globalCwd, globalUseRag);
        const s = kbInstance.stats();
        console.log(`\nKnowledge Base Stats:`);
        console.log(`  Документов: ${s.documents}`);
        console.log(`  Чанков: ${s.chunks}`);
        console.log(`  Эмбеддингов: ${s.embeddings}`);
        break;
      }
    }
  } catch (err: unknown) {
    log("ERROR", `Критическая ошибка: ${err instanceof Error ? err.message : String(err)}`);
    shutdownAndExit(1);
  }
}

main();
