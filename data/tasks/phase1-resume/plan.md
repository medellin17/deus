# Phase 1 — Auto-Resume + Structured Summary Format

## 1. Goal

Изменить `main()` так, чтобы после force-checkpoint (контекст > 140k токенов)
оркестратор **не завершался** через `shutdownAndExit(1)`, а **автоматически** создавал новую
сессию, инжектировал чекпоинт-контекст и продолжал выполнение с того же места.
Цикл прозрачен для пользователя — без ручного `--resume`. Параллельно:
определить структурный формат саммари (программный, а не LLM-generated),
внедрить отслеживание `completedDispatches`/`pendingDispatches` на уровне
оркестратора, чистить старые чекпоинты после успешного auto-resume.

## 2. Context

### Текущая архитектура (по факту чтения кода)

| Файл | Роль |
|------|------|
| `src/orchestrator.ts` (1279 строк) | main(), runOrchestrate(), runSession(), runSessionWithRetry(), runPipeline(), runDirect(), runParallel() |
| `src/kb/checkpoint.ts` (114 строк) | CheckpointManager — save/load/list/getLatest/prune |
| `src/kb/index.ts` (25 строк) | Экспорт CheckpointManager и типов |
| `.opencode/agents/orchestrator-conductor.md` (144 строки) | Промпт кондуктора — уже содержит `## Context Management` с `[CHECKPOINT]` |

**Поток выполнения (orchestrate mode):**
```
main() → switch("orchestrate") → runOrchestrate(task)
  → runSessionWithRetry(fullTask, "orchestrator-conductor")
    → runSession(task, agent)
      → session.create() → promptAsync() → poll loop
        → [if tokens > 140000 && !output] → save checkpoint → return { suspended: true, checkpointId }
      ← StepResult
    ← [retry if !success — БАГ: не проверяет suspended]
  ← StepResult
→ printResult(r)
→ shutdownAndExit(r.success ? 0 : 1)  // ⬅ всегда exit — даже при suspended
```

### Что сломано (5 проблем)

1. **`main()` всегда делает `exit`** — после suspended → `shutdownAndExit(1)`, вместо auto-resume.
2. **`runSessionWithRetry` не проверяет `suspended`** — при `first.suspended === true` всё равно делает retry с той же задачей. Вторая попытка создаёт дублирующую сессию.
3. **`completedDispatches`/`pendingDispatches` всегда `[]`** — в `runSession()` (строка 627–628) передаются жёстко пустые массивы.
4. **Саммари = `msgText || "[force checkpoint]"`** — неструктурированное, бесполезное для resume.
5. **Старая сессия не закрывается** — после чекпоинта сессия висит на сервере, тратит ресурсы.

### Что изменится

- `main()` получает цикл `while (true)` с max-retry-лимитом (5 итераций).
- `runSessionWithRetry()` проверяет `suspended` и сразу возвращает.
- `runOrchestrate()` / `runPipeline()` / `runDirect()` отслеживают completed/pending dispatches.
- `CheckpointManager.save()` получает структурированный state (не пустые массивы).
- При auto-resume: старая сессия abort-ится, чекпоинты prune-ятся.
- Промпт кондуктора обновляется — добавляется секция `### Resume Behavior`.

## 3. Architecture Changes

### 3.1. `main()` — цикл auto-resume

```typescript
// Псевдокод
const MAX_AUTO_RESUME = 5;

for (let iteration = 0; iteration < MAX_AUTO_RESUME; iteration++) {
  const result = await executeCurrentMode(mode, task, accumulatedState);
  
  if (!result.suspended) {
    // Нормальное завершение или ошибка
    handleFinalResult(result);
    break;
  }
  
  // suspended: сохраняем state, готовим resume-задачу
  const cm = new CheckpointManager(globalCwd);
  const latest = cm.getLatest();
  if (!latest) { /* не должно случиться */ break; }
  
  // Строим resume-задачу из checkpoint state
  task = buildResumeTask(latest);
  // Обновляем accumulatedState для следующей итерации
  accumulatedState = { ...latest, iteration };
  
  // Abort старой сессии
  await abortSession(result.sessionId);
  
  log("INFO", `Auto-resume #${iteration + 1}: новая сессия с чекпоинт-контекстом`);
}
```

**Файл:** `src/orchestrator.ts`, функция `main()` (строки 1087–1279)

### 3.2. `runSessionWithRetry()` — защита от retry при suspended

```typescript
async function runSessionWithRetry(task, agent, timeout?): Promise<StepResult> {
  const first = await runSession(task, agent, timeout);
  if (first.success || first.suspended) return first;  // ⬅ было: if (first.success)
  log("WARN", `Повторная попытка для [${agent}]...`);
  return runSession(task, agent, timeout);
}
```

**Файл:** `src/orchestrator.ts`, строки 655–660

### 3.3. `runSession()` — структурированный checkpoint state

Вместо `completedDispatches: []` и `pendingDispatches: []` — принимает аккумулятор состояния.

**Сигнатура меняется:**
```typescript
async function runSession(
  task: string,
  agent: string,
  timeoutMs?: number,
  dispatchState?: DispatchAccumulator,   // ⬅ новый параметр
): Promise<StepResult>
```

**`DispatchAccumulator`:**
```typescript
interface DispatchAccumulator {
  completedDispatches: CompletedDispatch[];
  pendingDispatches: PendingDispatch[];
  mode: "orchestrate" | "pipeline" | "direct";
  pipelineName?: string;
  pipelineStepIndex?: number;  // на каком шаге пайплайна находимся
}
```

**В точке checkpoint (строки 616–640):**
```typescript
cm.save({
  checkpointId,
  task,
  mode: dispatchState?.mode ?? "orchestrate",
  sessionId,
  completedDispatches: dispatchState?.completedDispatches ?? [],
  pendingDispatches: dispatchState?.pendingDispatches ?? [],
  artifacts: [],
  contextUsed: totalTokens,
  summaryFile: "summary.md",
  createdAt: new Date().toISOString(),
}, buildStructuredSummary(dispatchState, totalTokens, msgText));
```

### 3.4. Pipeline-отслеживание в `runPipeline()`

**Файл:** `src/orchestrator.ts`, строки 735–808

В цикле `while (i < steps.length)`:
- Перед запуском шага: `pendingDispatches = steps.slice(i).map(s => ({ agent: s.agent, task: s.task }))`
- После успешного шага: `completedDispatches.push({ agent: s.agent, task: taskText, sessionId: r.sessionId, resultSummary: r.output.slice(0, 200) })`

`DispatchAccumulator` передаётся в `runSession()` → `runSessionWithRetry()`.

### 3.5. `runOrchestrate()` — отслеживание кондуктора

**Файл:** `src/orchestrator.ts`, строки 664–731

Поскольку `runOrchestrate` — это один вызов кондуктора, диспатчи внутри не видны оркестратору:
- `completedDispatches`: `[]` (не знаем, что кондуктор уже сделал)
- `pendingDispatches`: `[{ agent: "orchestrator-conductor", task }]` (вся задача ещё pending)

### 3.6. `runDirect()` — отслеживание одиночного агента

**Файл:** `src/orchestrator.ts`, строки 831–836

- `pendingDispatches`: `[{ agent, task }]`
- `completedDispatches`: после успеха — `[]` (уже записали в результат)

### 3.7. Structured summary format

Функция `buildStructuredSummary()` в `src/orchestrator.ts` (новая):

```typescript
function buildStructuredSummary(
  state: DispatchAccumulator | undefined,
  tokensUsed: number,
  lastMessage: string,
): string {
  const lines: string[] = [];
  lines.push(`# Checkpoint Summary`);
  lines.push(``);
  lines.push(`- **Created**: ${new Date().toISOString()}`);
  lines.push(`- **Mode**: ${state?.mode ?? "unknown"}`);
  lines.push(`- **Tokens used**: ${tokensUsed.toLocaleString()}`);
  lines.push(``);
  lines.push(`## Original Task`);
  lines.push(``);
  lines.push(`(см. state.json)`);
  lines.push(``);
  
  if (state?.completedDispatches.length) {
    lines.push(`## Completed Dispatches`);
    lines.push(``);
    lines.push(`| Agent | Task | Result |`);
    lines.push(`|-------|------|--------|`);
    for (const d of state.completedDispatches) {
      lines.push(`| ${d.agent} | ${d.task.slice(0, 80)} | ${d.resultSummary?.slice(0, 100) ?? "—"} |`);
    }
    lines.push(``);
  }
  
  if (state?.pendingDispatches.length) {
    lines.push(`## Pending Dispatches`);
    lines.push(``);
    lines.push(`| Agent | Task |`);
    lines.push(`|-------|------|`);
    for (const d of state.pendingDispatches) {
      lines.push(`| ${d.agent} | ${d.task.slice(0, 120)} |`);
    }
    lines.push(``);
  }
  
  lines.push(`## Last Message (truncated)`);
  lines.push(``);
  lines.push(`\`\`\``);
  lines.push(lastMessage.slice(0, 2000));
  lines.push(`\`\`\``);
  
  return lines.join("\n");
}
```

### 3.8. Inject checkpoint context в новую сессию

Функция `buildResumeTask()` в `src/orchestrator.ts` (новая, расширяет существующую логику из строк 1135–1151):

```typescript
function buildResumeTask(state: CheckpointState, summary: string): string {
  const parts: string[] = [
    `## Session Continuation (auto-resume #${state.checkpointId})`,
    ``,
    `The previous session was interrupted because the token limit was exceeded.`,
    `Continue from where you left off. Do NOT redo completed work.`,
    ``,
    `### Original Task`,
    state.task,
    ``,
  ];
  
  if (state.completedDispatches.length > 0) {
    parts.push(`### Completed Dispatches (do NOT redo)`);
    for (const d of state.completedDispatches) {
      parts.push(`- [DONE] ${d.agent}: ${d.task.slice(0, 120)}`);
      if (d.resultSummary) parts.push(`  Result: ${d.resultSummary.slice(0, 200)}`);
    }
    parts.push(``);
  }
  
  if (state.pendingDispatches.length > 0) {
    parts.push(`### Pending Dispatches (continue from here)`);
    for (const d of state.pendingDispatches) {
      parts.push(`- [TODO] ${d.agent}: ${d.task.slice(0, 120)}`);
    }
    parts.push(``);
  }
  
  parts.push(`### Previous Session Context`);
  parts.push(summary.slice(0, 3000));  // truncated summary
  parts.push(``);
  parts.push(`Resume execution now. Start with the first pending dispatch.`);
  
  return parts.join("\n");
}
```

### 3.9. Session abort

```typescript
async function abortSession(sessionId: string): Promise<void> {
  try {
    const c = getClient();
    // Попытка 1: прямой метод abort
    if (typeof (c.session as any).abort === "function") {
      await (c.session as any).abort({ path: { id: sessionId } });
      log("INFO", `Сессия ${sessionId} прервана`);
      return;
    }
    // Попытка 2: delete session
    if (typeof (c.session as any).delete === "function") {
      await (c.session as any).delete({ path: { id: sessionId } });
      log("INFO", `Сессия ${sessionId} удалена`);
      return;
    }
    log("WARN", `Не удалось прервать сессию ${sessionId} — SDK не поддерживает abort/delete`);
  } catch (e) {
    log("WARN", `Ошибка при прерывании сессии ${sessionId}: ${e instanceof Error ? e.message : e}`);
  }
}
```

### 3.10. KB-контекст при auto-resume

При первой итерации — KB-контекст инжектится как обычно (через `getKB().getContext(task)`).
При auto-resume (iteration > 0) — KB-контекст **пропускается** во избежание дублирования.
Флаг: `skipKbContext: boolean` в параметрах `runOrchestrate()`.

```typescript
async function runOrchestrate(task: string, skipKbContext = false): Promise<StepResult> {
  let contextPrefix = "";
  if (!skipKbContext) {
    // ... существующая логика KB-инжекта (строки 673–700)
  }
  // ...
}
```

## 4. Implementation Plan

### Stage 1: Fix `runSessionWithRetry` — не retry при suspended

**Сложность:** тривиально  
**Риск:** низкий  
**Файл:** `src/orchestrator.ts`, строки 655–660

**Что сделать:**
1. Вставить проверку `first.suspended` в условие `if (first.success || first.suspended) return first;`
2. Убедиться, что `StepResult.suspended` типизирован (уже есть `suspended?: boolean`)

**Приёмка:**
- При suspended `runSessionWithRetry` возвращает suspended-результат сразу
- При обычной ошибке — retry (поведение не меняется)

---

### Stage 2: Auto-resume loop в `main()`

**Сложность:** высокая  
**Риск:** средний (может сломать все режимы)  
**Файл:** `src/orchestrator.ts`, строки 1087–1279

**Что сделать:**

1. Вынести текущий `switch(mode)` в отдельную функцию `executeMode(mode, task, dispatchState)`:
   ```typescript
   async function executeMode(
     mode: Mode,
     task: string,
     dispatchState?: DispatchAccumulator,
   ): Promise<{ result: StepResult | PipelineResult; mode: Mode }>
   ```

2. В `main()` — обернуть вызов в цикл:
   ```typescript
   const MAX_AUTO_RESUME = 5;
   let currentTask = tasks[0];
   let iteration = 0;
   let finalResult: StepResult | PipelineResult | null = null;
   
   while (iteration < MAX_AUTO_RESUME) {
     const { result } = await executeMode(mode, currentTask, /* dispatchState */);
     
     const stepResult = isStepResult(result) ? result : result.steps[0];
     
     if (!stepResult?.suspended) {
       finalResult = result;
       break;
     }
     
     // Build resume task
     const cm = new CheckpointManager(globalCwd);
     const latest = cm.getLatest();
     if (!latest) { log("ERROR", "Checkpoint lost"); break; }
     
     // Abort old session
     await abortSession(stepResult.sessionId);
     
     // Build resume task from checkpoint
     const loaded = cm.load(latest.checkpointId);
     if (!loaded) { log("ERROR", "Checkpoint corrupted"); break; }
     currentTask = buildResumeTask(loaded.state, loaded.summary);
     skipKbContext = true;
     iteration++;
     
     log("INFO", `⟳ Auto-resume ${iteration}/${MAX_AUTO_RESUME}: ${latest.checkpointId}`);
   }
   ```

3. `runOrchestrate()` получает параметр `skipKbContext: boolean`:
   ```typescript
   async function runOrchestrate(task: string, skipKbContext = false): Promise<StepResult>
   ```
   При `skipKbContext === true` — пропустить `getKB().getContext(task)`.

4. После цикла: `prune(5)` старых чекпоинтов, если был auto-resume.

5. **Для pipeline mode**: аналогично — `runPipeline()` должен возвращать информацию о том, на каком шаге прервался.

**Приёмка:**
- Orchestrate: задача с единственным вызовом кондуктора → если suspended → auto-resume 1 раз → кондуктор завершает работу → exit 0.
- Pipeline: 5 шагов → suspended на шаге 3 → auto-resume → шаги 1-2 пропускаются, 3-5 выполняются.
- Direct: suspended → auto-resume → агент завершает → exit 0.
- 5 итераций подряд без прогресса → exit 1 с сообщением.

---

### Stage 3: Structured summary format — `buildStructuredSummary()`

**Сложность:** низкая  
**Риск:** низкий  
**Файл:** `src/orchestrator.ts`, новая функция

**Что сделать:**
1. Создать функцию `buildStructuredSummary()` по спецификации из §3.7.
2. Вызывать её в `runSession()` вместо передачи `msgText || "[force checkpoint]"`.

**Сигнатура:**
```typescript
function buildStructuredSummary(
  state: DispatchAccumulator | undefined,
  tokensUsed: number,
  lastMessage: string,
): string
```

**Приёмка:**
- `summary.md` содержит секции: Checkpoint Summary, Completed Dispatches (если есть), Pending Dispatches, Last Message.
- Формат — чистый Markdown.

---

### Stage 4: Track completed/pending dispatches

**Сложность:** средняя  
**Риск:** средний (изменяет сигнатуры нескольких функций)  
**Файлы:** `src/orchestrator.ts`

**Что сделать:**

1. Определить `DispatchAccumulator` интерфейс (см. §3.3).

2. В `runPipeline()` (строки 735–808):
   - Создать `DispatchAccumulator` со всеми шагами как `pendingDispatches`.
   - Перед `runSessionWithRetry()` — обновить `pendingDispatches = оставшиеся шаги`.
   - После успешного шага — `completedDispatches.push(...)`.
   - Передавать аккумулятор в `runSessionWithRetry()` → `runSession()`.

3. В `runDirect()` (строки 831–836):
   - `pendingDispatches: [{ agent, task }]`
   - После успеха — очистить.

4. В `runOrchestrate()` (строки 664–731):
   - `completedDispatches: []`
   - `pendingDispatches: [{ agent: "orchestrator-conductor", task }]`

5. В `runSession()` (строки 530–653):
   - Принимает `dispatchState?: DispatchAccumulator`
   - При force-checkpoint: использует `dispatchState` вместо пустых массивов.

6. В `runSessionWithRetry()` (строки 655–660):
   - Пробрасывает `dispatchState` в `runSession()`.

**Приёмка:**
- Pipeline checkpoint: `state.json` содержит корректные `completedDispatches` (шаги 1..N-1) и `pendingDispatches` (шаги N..M).
- Direct checkpoint: `pendingDispatches` содержит один элемент.
- Orchestrate checkpoint: `pendingDispatches` содержит `orchestrator-conductor`.

---

### Stage 5: Session abort and checkpoint prune

**Сложность:** низкая  
**Риск:** низкий  
**Файл:** `src/orchestrator.ts`

**Что сделать:**

1. Создать `abortSession(sessionId: string)` (см. §3.9).

2. Вызывать в auto-resume цикле после получения suspended:
   ```typescript
   await abortSession(stepResult.sessionId);
   ```

3. После успешного auto-resume — `cm.prune(5)`:
   ```typescript
   if (iteration > 0 && finalResult) {
     cm.prune(5);
     log("INFO", "Старые чекпоинты очищены, оставлено 5");
   }
   ```

4. Также prune при ручном `--resume` (уже есть на строке 1163).

**Приёмка:**
- После auto-resume: старые чекпоинты удалены, `.deus/checkpoints/` содержит ≤ 5 директорий.
- При отсутствии `session.abort()` в SDK: graceful degradation с логом WARN.

---

### Stage 6: Conductor prompt update

**Сложность:** низкая  
**Риск:** низкий  
**Файл:** `.opencode/agents/orchestrator-conductor.md`

**Что сделать:**

Промпт уже содержит `## Context Management` (строки 125–143) — менять не нужно.
Добавить после строки 143 секцию:

```markdown
### Resume Behavior

When you receive a `## Session Continuation` block:
1. Read `### Completed Dispatches` — these are DONE, do NOT redo them.
2. Start from `### Pending Dispatches` — execute them in order.
3. If pending dispatches are empty, re-read `### Previous Session Context` and continue from where you left off.
4. Produce a final synthesis report covering ALL completed work (from this session + previous).
```

---

### Stage 7: Integrate `DispatchAccumulator` carry-over across auto-resume cycles

**Сложность:** средняя  
**Риск:** средний (накопление состояния между итерациями)  
**Файл:** `src/orchestrator.ts`

**Что сделать:**

При auto-resume — completed dispatches из чекпоинта должны аккумулироваться:
```typescript
// После загрузки чекпоинта:
accumulatedCompleted = [...(loaded.state.completedDispatches ?? [])];
// При следующем чекпоинте — completedDispatches включает accumulatedCompleted
```

В `main()`:
```typescript
let carryOverDispatches: CompletedDispatch[] = [];

while (iteration < MAX_AUTO_RESUME) {
  const dispatchState: DispatchAccumulator = {
    completedDispatches: carryOverDispatches,
    pendingDispatches: [...], // определяется режимом
    mode,
    pipelineName: pipeline || undefined,
  };
  
  const { result } = await executeMode(mode, currentTask, dispatchState);
  // ...
  if (suspended) {
    const loaded = cm.load(latest.checkpointId);
    carryOverDispatches = loaded?.state.completedDispatches ?? [];
  }
}
```

**Приёмка:**
- Pipeline из 5 шагов, checkpoint на шаге 2, auto-resume, checkpoint на шаге 4 — второй чекпоинт содержит все 3 completed (1+2+3), а не только последний.

## 5. Interface Definitions

### Новые типы (добавить в `src/orchestrator.ts`, секция `─ Types ─`)

```typescript
import type { CompletedDispatch, PendingDispatch } from "./kb/checkpoint.js";

/** Аккумулятор состояния диспатчей — передаётся через всю цепочку вызовов */
interface DispatchAccumulator {
  completedDispatches: CompletedDispatch[];
  pendingDispatches: PendingDispatch[];
  mode: "orchestrate" | "pipeline" | "direct";
  pipelineName?: string;
  pipelineStepIndex?: number;
}
```

### Изменения в `StepResult`

```typescript
// Без изменений — поля suspended?, checkpointId? уже есть.
```

### Изменения в `PipelineResult`

```typescript
// Было:
interface PipelineResult {
  success: boolean;
  steps: StepResult[];
  totalDurationMs: number;
}

// Стало:
interface PipelineResult {
  success: boolean;
  steps: StepResult[];
  totalDurationMs: number;
  suspended?: boolean;            // ⬅ новое: был ли чекпоинт на любом шаге
  suspendedAtStep?: number;       // ⬅ индекс шага, где произошёл чекпоинт
  checkpointId?: string;          // ⬅ ID чекпоинта
}
```

### Новые сигнатуры функций

```typescript
// runSession — добавлен dispatchState
async function runSession(
  task: string,
  agent: string,
  timeoutMs?: number,
  dispatchState?: DispatchAccumulator,
): Promise<StepResult>

// runSessionWithRetry — проброс dispatchState
async function runSessionWithRetry(
  task: string,
  agent: string,
  timeoutMs?: number,
  dispatchState?: DispatchAccumulator,
): Promise<StepResult>

// runOrchestrate — skipKbContext
async function runOrchestrate(
  task: string,
  skipKbContext?: boolean,
): Promise<StepResult>

// executeMode — новая функция (извлечена из main)
async function executeMode(
  mode: Mode,
  task: string,
  dispatchState?: DispatchAccumulator,
): Promise<{ result: StepResult | PipelineResult; mode: Mode }>

// buildStructuredSummary — новая функция
function buildStructuredSummary(
  state: DispatchAccumulator | undefined,
  tokensUsed: number,
  lastMessage: string,
): string

// buildResumeTask — новая функция (расширяет логику из --resume)
function buildResumeTask(
  state: CheckpointState,
  summary: string,
): string

// abortSession — новая функция
async function abortSession(sessionId: string): Promise<void>
```

## 6. Auto-Resume Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│ main()                                                          │
│                                                                 │
│ parseArgs → ensureServerRunning                                 │
│                                                                 │
│ iteration = 0                                                   │
│ carryOverDispatches = []                                        │
│ skipKbContext = false                                           │
│                                                                 │
│ ┌──────────────────────────────────────────────────────────┐    │
│ │ WHILE iteration < MAX_AUTO_RESUME (5)                    │    │
│ │                                                          │    │
│ │ ┌────────────────────────────────────────────────────┐   │    │
│ │ │ executeMode(mode, task, dispatchState)             │   │    │
│ │ │                                                    │   │    │
│ │ │ switch(mode):                                      │   │    │
│ │ │   orchestrate → runOrchestrate(task, skipKbContext)│   │    │
│ │ │                  → runSessionWithRetry(...)        │   │    │
│ │ │                    → runSession(...)               │   │    │
│ │ │                      → [poll loop]                 │   │    │
│ │ │                      → tokens > 140k?              │   │    │
│ │ │                        → save checkpoint            │   │    │
│ │ │                        ← { suspended: true }       │   │    │
│ │ │   pipeline    → runPipeline(steps)                 │   │    │
│ │ │                  → for each step:                   │   │    │
│ │ │                    → runSessionWithRetry(...)      │   │    │
│ │ │                    → update dispatchState           │   │    │
│ │ │   direct      → runDirect(task, agent)             │   │    │
│ │ │                                                    │   │    │
│ │ └────────────────────────────────────────────────────┘   │    │
│ │                                                          │    │
│ │ result = { result, mode }                                │    │
│ │                                                          │    │
│ │ isSuspended(result)?                                     │    │
│ │   NO  → finalResult = result; break WHILE               │    │
│ │   YES →                                                 │    │
│ │     1. cm.getLatest() → checkpoint                      │    │
│ │     2. abortSession(sessionId)                           │    │
│ │     3. cm.load(checkpointId) → state + summary          │    │
│ │     4. task = buildResumeTask(state, summary)            │    │
│ │     5. carryOverDispatches = state.completedDispatches   │    │
│ │     6. skipKbContext = true                              │    │
│ │     7. iteration++                                       │    │
│ │     8. CONTINUE WHILE                                    │    │
│ │                                                          │    │
│ └──────────────────────────────────────────────────────────┘    │
│                                                                 │
│ if (iteration > 0) cm.prune(5)                                 │
│                                                                 │
│ printResult / saveResults                                      │
│ shutdownAndExit(success ? 0 : 1)                               │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## 7. Risks & Mitigations

### 7.1. Бесконечный цикл
**Риск:** задача не умещается в 140k токенов за 5 попыток, оркестратор бесконечно чекпоинтит.  
**Митигация:** `MAX_AUTO_RESUME = 5`. После 5 итераций — `log("ERROR", "Auto-resume limit exceeded")` + `shutdownAndExit(1)`.

### 7.2. Утечка сессий
**Риск:** При чекпоинте старая сессия остаётся на сервере, потребляет память/CPU.  
**Митигация:** Вызов `abortSession()` при каждом suspended. Если SDK не поддерживает — лог WARN, но не блокирует работу. Ручная очистка через `opencode session list` + `opencode session delete`.

### 7.3. Дублирование KB-контекста
**Риск:** При auto-resume — KB инжектит тот же контекст + checkpoint-контекст — удвоение токенов.  
**Митигация:** `skipKbContext: true` при `iteration > 0`. KB-контекст нужен только при первом запуске.

### 7.4. Loss of accumulated state
**Риск:** При повторном чекпоинте (iteration 2) — `completedDispatches` из предыдущей итерации теряются.  
**Митигация:** `carryOverDispatches` в цикле `main()` — аккумулируется из `loaded.state.completedDispatches` после каждого чекпоинта.

### 7.5. Поломка `--resume` ручного режима
**Риск:** Изменения в `runOrchestrate()` (новый параметр) ломают существующий `--resume`.  
**Митигация:** Параметр `skipKbContext` — опциональный, default `false`. Существующий `--resume` продолжает работать без изменений.

### 7.6. SDK не поддерживает `session.abort()`
**Риск:** `abortSession()` не срабатывает.  
**Митигация:** Graceful degradation — try/catch с логом WARN. Старая сессия завершится по таймауту сервера.

## 8. Out of Scope

- `[CHECKPOINT]` LLM-сигнал (пользователь явно отклонил).
- Phase 2 sub-orchestrators.
- KB-интеграция с memory tree (сохранение чекпоинтов в KB).
- `--cleanup-checkpoints` CLI флаг.
- `parentCheckpointId` цепочка.
- Модификация `runParallel()` (аналогично pipeline, но out of scope для v1).

## 9. Design Uncertainty

### 9.1. `session.abort()` / `session.delete()` в SDK
**Что:** Неизвестно, поддерживает ли `@opencode-ai/sdk` методы abort/delete для сессий.  
**Почему:** Документация SDK не локальна, код SDK — внешняя зависимость.  
**Как разрешить:** Проверить во время Stage 5 через `console.log(Object.keys(c.session))` или чтение `node_modules/@opencode-ai/sdk/dist/...`. Если методов нет — только лог WARN.

### 9.2. `DispatchAccumulator` для `runOrchestrate()`
**Что:** Для orchestrate mode мы не знаем, что именно кондуктор dispatch-ил внутри сессии. `pendingDispatches: [{ agent: "orchestrator-conductor", task }]` — грубое приближение.  
**Почему:** Кондуктор — чёрный ящик (LLM-агент), оркестратор не видит его внутренние `task()` вызовы.  
**Как разрешить:** В Phase 2 (sub-orchestrators) каждый dispatch становится отдельным вызовом оркестратора — тогда completed/pending будут точными. Пока принимаем approximation.  
**Влияние:** При auto-resume кондуктор начинает заново, но видит "ничего не completed" → может повторить уже сделанную работу. Приемлемо для Phase 1.

### 9.3. Проверка token-порога
**Что:** Текущий код считает токены только из `msg.info.tokens` последнего assistant-сообщения (строки 611–613). Не сумма всех сообщений.  
**Почему:** SDK может не возвращать `tokens` для всех сообщений.  
**Как разрешить:** Оставить как есть — приблизительная оценка. Порог 140000 с запасом.

## 10. Confidence

**High** — 85%.

План основан на полном прочтении всех затронутых файлов (1279 строк `orchestrator.ts`, 114 строк `checkpoint.ts`, 144 строки промпта кондуктора, план CONTEXT-OVERFLOW-PLAN.md). Все сигнатуры, номера строк и интерфейсы верифицированы по исходному коду. Основные неопределённости — метод `session.abort()` в SDK и точность `DispatchAccumulator` для orchestrate mode — задокументированы и имеют явные fallback-стратегии. План самодостаточен: implementer-builder может реализовать его без дополнительных уточнений.
