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
import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import path from "path";
import { createKB, type KnowledgeBase } from "./kb/index.js";

// ─── Types ──────────────────────────────────────────────────────────────────

interface TaskStep {
  task: string;
  agent: string;
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

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_BASE_URL = "http://localhost:4096";
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 минут для оркестрации
const POLL_INTERVAL_MS = 2000;
const DEFAULT_AGENT = "orchestrator-conductor";
const DEFAULT_CWD = process.cwd();

const VALID_AGENTS = [
  "orchestrator-conductor",
  "researcher-explorer",
  "architect-planner",
  "architect-planner-pro",
  "implementer-builder",
  "reviewer-critic",
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
    { task: "Ревью: {task}\n\nРеализация:\n{prev}", agent: "reviewer-critic" },
    { task: "Тесты:\n{prev}", agent: "integrator-qa" },
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
};

// ─── Logging ────────────────────────────────────────────────────────────────

function log(level: "INFO" | "WARN" | "ERROR" | "DEBUG", message: string): void {
  const ts = new Date().toISOString().replace("T", " ").replace(/\.\d{3}Z/, "");
  console.log(`[${ts}][${level}] ${message}`);
}

// ─── Client ─────────────────────────────────────────────────────────────────

let client: OpencodeClient;
let kb: KnowledgeBase | null = null;
let kbProjectPath: string | null = null;
let globalCwd: string = process.cwd();

function getKB(projectPath?: string): KnowledgeBase {
  const projectDir = projectPath || kbProjectPath || globalCwd;
  if (!kb || kbProjectPath !== projectDir) {
    if (kb) kb.close();
    const dbPath = require("path").join(projectDir, ".agents", "orchestrator.db");
    kb = createKB(dbPath);
    kbProjectPath = projectDir;
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
  serverProcess = spawn("opencode", ["serve", "--port", "4096"], {
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

function copyOpenCodeToTarget(targetDir: string): void {
  const sourceDir = path.join(__dirname, "..", ".opencode");
  const destDir = path.join(targetDir, ".opencode");

  if (fs.existsSync(destDir)) {
    log("INFO", `.opencode/ уже существует в ${targetDir}`);
    return;
  }

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
    await (c.session as any).promptAsync({
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
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    try {
      const msgRes = await c.session.messages({ path: { id: sessionId } });
      const messages = (msgRes.data || msgRes) as Array<{
        info: { role: string; finish?: string };
        parts: Array<{ type: string; text?: string }>;
      }>;

      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.info.role === "assistant" && msg.info.finish === "stop") {
          output = extractText(msg.parts);
          if (output) break;
        }
      }
      if (output) break;
    } catch {
      // retry
    }
  }

  const durationMs = Date.now() - start;
  const success = output.length > 0;

  if (success) log("INFO", `✅ [${agent}] Готово за ${fmtDuration(durationMs)} (${output.length} символов)`);
  else log("ERROR", `❌ [${agent}] Пустой ответ / таймаут за ${fmtDuration(durationMs)}`);

  return { stepIndex: -1, agent, task, sessionId, output, durationMs, success, error: success ? undefined : "Пустой ответ или таймаут" };
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
  log("INFO", `  Конductor: ${DEFAULT_AGENT} (mimo-v2.5-pro)`);
  log("INFO", `  Задача: ${task.slice(0, 120)}${task.length > 120 ? "..." : ""}`);

  // Auto-inject context from Knowledge Base
  let contextPrefix = "";
  try {
    const kbInstance = getKB(globalCwd);

    // Auto-index if KB is empty
    if (!kbInstance.hasContext()) {
      log("INFO", `  KB: пуста, индексация проекта...`);
      kbInstance.indexDirectory(globalCwd);
      const s = kbInstance.stats();
      log("INFO", `  KB: проиндексировано ${s.documents} документов, ${s.chunks} чанков`);
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
      const kbInstance = getKB(globalCwd);
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

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    let taskText = s.task.replace(/\{task\}/g, prev || "(нет исходной задачи)");
    taskText = taskText.replace(/\{prev\}/g, prev || "(нет предыдущего контекста)");

    log("INFO", `\n── Шаг ${i + 1}/${steps.length}: ${s.agent} ──`);
    const r = await runSessionWithRetry(taskText, s.agent);
    r.stepIndex = i;
    results.push(r);

    if (!r.success) {
      log("ERROR", `⛔ Пайплайн прерван на шаге ${i + 1} (${s.agent})`);
      return { success: false, steps: results, totalDurationMs: Date.now() - t0 };
    }
    prev = r.output;
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

function printPipeline(p: PipelineResult): void {
  console.log(`\n${p.success ? "✅" : "❌"} ${p.steps.length} шагов, ${fmtDuration(p.totalDurationMs)}`);
  for (const s of p.steps) {
    console.log(`  ${s.success ? "✓" : "✗"} [${s.stepIndex + 1}] ${s.agent} — ${fmtDuration(s.durationMs)}`);
    if (s.error) console.log(`      Ошибка: ${s.error}`);
  }
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
  --cwd <path>    Рабочая директория для opencode serve (по умолчанию: текущая)

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
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  let mode: Mode = "orchestrate";
  let agent = DEFAULT_AGENT;
  let pipeline = "";
  let cwd: string | undefined;
  const tasks: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--help" || a === "-h") { mode = "help"; return { mode, agent, pipeline, tasks, cwd }; }
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
    tasks.push(a);
  }

  if (mode === "pipeline" && tasks.length === 0) { log("ERROR", "Пайплайн требует задачу"); process.exit(1); }
  if (mode === "orchestrate" && tasks.length === 0) { log("ERROR", "Укажите задачу"); process.exit(1); }
  if (mode === "direct" && tasks.length === 0) { log("ERROR", "Укажите задачу"); process.exit(1); }
  if (mode === "index" && tasks.length === 0) { log("ERROR", "Укажите путь для индексации"); process.exit(1); }
  return { mode, agent, pipeline, tasks, cwd };
}

// ─── Entry ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { mode, agent, pipeline, tasks, cwd } = parseArgs(process.argv);

  if (mode === "help") { printHelp(); return; }
  if (cwd) globalCwd = require("path").resolve(cwd);

  // Auto-copy .opencode/ to target project
  if (globalCwd !== process.cwd()) {
    copyOpenCodeToTarget(globalCwd);
  }

  const baseUrl = process.env.OPENCODE_URL || DEFAULT_BASE_URL;
  try {
    await ensureServerRunning(baseUrl, cwd);
  } catch (err: unknown) {
    log("ERROR", `Не удалось запустить сервер: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
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
        process.exit(r.success ? 0 : 1);
        break;
      }
      case "direct": {
        const r = await runDirect(tasks[0], agent);
        printResult(r);
        process.exit(r.success ? 0 : 1);
        break;
      }
      case "pipeline": {
        const filled = PIPELINES[pipeline].map((s) => ({
          ...s,
          task: s.task.replace(/\{task\}/g, tasks[0]),
        }));
        const r = await runPipeline(filled);
        printPipeline(r);
        process.exit(r.success ? 0 : 1);
        break;
      }
      case "parallel": {
        const r = await runParallel(tasks.map((t) => ({ task: t, agent: DEFAULT_AGENT })));
        printPipeline(r);
        process.exit(r.success ? 0 : 1);
        break;
      }
      case "index": {
        const target = require("path").resolve(tasks[0]);
        const kbInstance = getKB(target);
        log("INFO", `Индексация: ${target}`);
        kbInstance.indexDirectory(target);
        const s = kbInstance.stats();
        log("INFO", `Готово: ${s.documents} документов, ${s.chunks} чанков, ${s.embeddings} эмбеддингов`);
        break;
      }
      case "kb-stats": {
      const kbInstance = getKB(globalCwd);
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
    process.exit(1);
  }

  process.on("SIGINT", () => { stopServer(); process.exit(0); });
  process.on("SIGTERM", () => { stopServer(); process.exit(0); });
  process.on("exit", () => { stopServer(); });
}

main();
