# Context Overflow Prevention — план реализации

## Проблема

Сессия `orchestrator-conductor` (deepseek-v4-flash, reasoningEffort: max) при сложных задачах упирается в лимит ~150k токенов. Контекст растёт от сообщений агентов, результатов воркеров, артефактов. После лимита — потеря стейта, задача недовыполнена.

## Решение: две фазы

| Фаза | Что даёт | Когда |
|------|----------|-------|
| **Phase 1: Checkpoints** | Реактивное спасение: если контекст заполнился — чекпоинт + resume | Сейчас |
| **Phase 2: Sub-orchestrators** | Проактивное масштабирование: декомпозиция до выполнения | После Phase 1 |

---

## Phase 1 — Checkpoints (реактивный)

### Механизм

При достижении ~100k символов (или по сигналу `[CHECKPOINT]` от LLM) оркестратор:

1. Ставит чекпоинт (state.json + summary.md)
2. Сохраняет саммари в `.deus/checkpoints/`
3. Завершает текущую сессию кондуктора со статусом `"suspended"`
4. При resume — инжектит саммари в новую сессию как контекст

### 1. CheckpointManager (`src/kb/checkpoint.ts`)

```
.deus/checkpoints/
  checkpoint-{ts}/
    state.json       # мета: задача, режим, sessionId, completedDispatches, pendingDispatches, contextUsed
    summary.md       # структурированное саммари от LLM
```

**Интерфейс:**

```typescript
interface CompletedDispatch {
  agent: string;
  task: string;
  sessionId?: string;
  artifactPath?: string;
  resultSummary?: string;
}

interface PendingDispatch {
  agent: string;
  task: string;
  dependsOn?: string[];
}

interface CheckpointState {
  checkpointId: string;
  task: string;
  mode: "orchestrate" | "pipeline" | "direct";
  sessionId: string;
  parentCheckpointId?: string;   // для цепочки чекпоинтов
  completedDispatches: CompletedDispatch[];
  pendingDispatches: PendingDispatch[];
  artifacts: string[];
  contextUsed: number;           // приблизительно, в символах
  summaryFile: string;
  createdAt: string;             // ISO timestamp
}

class CheckpointManager {
  save(state: CheckpointState, summary: string): string;  // → checkpointId
  load(checkpointId: string): { state: CheckpointState; summary: string };
  list(): CheckpointState[];
  getLatest(projectDir: string): string | null;
  prune(keepLast: number): void;  // удалить старые чекпоинты, оставить N последних
}
```

**Атомарность записи:** `save()` пишет во временный файл, затем rename — защита от коррупции при краше.

### 2. Триггер в `orchestrator.ts` — потоковый мониторинг

Ключевое изменение: текущий код уже использует `prompt_async` + цикл poll `messages()`. Нужно добавить проверку КАЖДОГО сообщения внутри цикла, а не только после `finish === "stop"`.

**A. Сигнал от LLM (основной):**
- Промпт кондуктора содержит инструкцию про `[CHECKPOINT]`
- В цикле poll сообщений: каждое новое assistant-сообщение проверяется на наличие `[CHECKPOINT]`
- При обнаружении: вызывается `CheckpointManager.save()` + сессия прерывается
- Парсинг регистронезависимый: `[CHECKPOINT]`, `[checkpoint]`, `[Checkpoint]`

**B. Принудительный (запасной):**
- Оркестратор мониторит суммарный размер всех сообщений в сессии (в символах)
- Порог: **100 000 символов** (~60-70% от лимита 150k токенов), оставляя запас
- При превышении: отправляет сообщение *"Сделай саммари текущего стейта"*
- Если и саммари не помещается — сохраняет чекпоинт с тем что есть

```
runSession():
  1. session = createSession()
  2. session.prompt_async(task)     // fire & forget

  3. loop:
     a. messages = session.messages()
     b. for each NEW assistant message:
        - check for [CHECKPOINT] (case-insensitive)
        - if found → save checkpoint → break loop
        - accumulate totalSize += message.length
        - if totalSize > 100_000 → send "сделай саммари" → wait → save checkpoint → break loop
     c. if finish === "stop" → break loop (normal completion)
     d. sleep(500ms)

  4. Если чекпойнт сохранён:
     - session.abort()
     - return { status: "suspended", checkpointId }
  5. Если нормальное завершение:
     - extractText(messages)
     - return { status: "done", result }
```

### 3. Resume (`--resume`)

```bash
npx tsx src/orchestrator.ts --cwd . --resume
# или
npx tsx src/orchestrator.ts --cwd . --resume checkpoint-2026-06-30-001
```

**Логика:**
1. Если `--resume` без аргумента — `CheckpointManager.getLatest()`
2. Если с аргументом — `CheckpointManager.load(id)`
3. Загружает `state.json` + `summary.md`
4. Валидация: проверяет что файлы не битые, что referenced файлы существуют
5. Создаёт новую сессию с injected контекстом:

```
## Session Continuation (auto-injected)

### Original Task
{state.task}

### Progress
{summary.md}

### Completed Dispatches
{state.completedDispatches.map(d => `- ${d.agent}: ${d.resultSummary}`)}

### Pending Dispatches
{state.pendingDispatches.map(d => `- ${d.agent}: ${d.task}`)}

Continue from where you left off. Do NOT redo completed dispatches.
```

6. При поиске контекста KB — использует `state.task` (оригинальную задачу), а не "Session Continuation"

### 4. Статус сессии

При чекпоинте **НЕ** помечать сессию как `success`. Использовать отдельный статус:
```typescript
type SessionResult = 
  | { status: "done"; result: string }
  | { status: "suspended"; checkpointId: string }
  | { status: "failed"; error: string };
```

### 5. Структурированное саммари

В промпте кондуктора — жёсткий формат, а не free-form:

```
[CHECKPOINT]
## Completed
- [list of completed steps with results]

## Pending
- [list of not-yet-started steps]

## In Progress
- [currently running agents and their tasks]

## Key Artifacts
- [file paths created so far]

## Decisions
- [key decisions made]

## Next Steps
- [exact next actions to take on resume]
```

### 6. Интеграция с KB (опционально, v1.1)

При сохранении чекпоинта — писать в Memory Tree:
```typescript
kb.upsertMemory(
  `checkpoint:${checkpointId}`,
  "checkpoint",              // отдельный уровень, не "project"
  summary.slice(0, 500)
);
```

**Note:** требуется либо миграция схемы (добавить "checkpoint" в CHECK-constraint уровня), либо использовать префикс `checkpoint:` в path с level "project".

### 7. Модификация промпта кондуктора (`.opencode/agents/orchestrator-conductor.md`)

```
## Context Management

This session has limited context (~150k tokens). When you feel context is filling up
(e.g., agent responses exceed ~20k characters total):

1. End your response with `[CHECKPOINT]`
2. Then write a **structured summary** with these exact sections:
   - Completed: what steps are done
   - Pending: what hasn't started yet
   - In Progress: what is currently running
   - Key Artifacts: files created/changed
   - Decisions: important decisions made so far
   - Next Steps: exact actions for resume

The system will save this summary, start a fresh session, and inject it as context.
```

### Файлы Phase 1

| # | Действие | Файл | Что |
|---|----------|------|-----|
| 1 | создать | `src/kb/checkpoint.ts` | CheckpointManager (save/load/list/getLatest/prune) |
| 2 | изменить | `src/orchestrator.ts` | потоковый мониторинг в runSession, парсинг `[CHECKPOINT]`, force-trigger, resume flow, `--resume` |
| 3 | изменить | `.opencode/agents/orchestrator-conductor.md` | инструкция про `[CHECKPOINT]` + строгий формат саммари |
| 4 | обновить | `src/kb/index.ts` | экспорт CheckpointManager, CheckpointState |

### Cleanup

`prune(keepLast: N)` удаляет старые чекпоинты, оставляя N последних. Вызывается:
- Автоматически после успешного resume
- По запросу: `--cleanup-checkpoints`
- При достижении порога: > 20 чекпоинтов

---

## Phase 2 — Sub-orchestrators (проактивный)

### Идея

Когда главный conductor видит, что задача слишком большая (N доменов / N агентов), он не пытается всё сделать в одной сессии, а:

1. **Планирует декомпозицию** — architect-planner строит план с доменами
2. **Спавнит Sub-Orchestrator'ов** — по одному на домен (или несколько на один домен)
3. **Каждый Sub-Orchestrator** — отдельная сессия со своим контекстом
4. **Sub-Orchestrator отчитывается** — структурированный отчёт Main'у
5. **Main синтезирует** — собирает всё в финальный результат

```
Main Conductor (план → декомпозиция → dispatch → синтез)
├── Sub-Orchestrator: Auth
│   ├── implementer-builder
│   ├── reviewer-critic
│   └── test-engineer
├── Sub-Orchestrator: Frontend (×2 parallel)
│   ├── implementer-builder
│   └── content-writer
└── Sub-Orchestrator: Database
    ├── architect-planner
    └── implementer-builder
```

### Сравнение Phase 1 vs Phase 2

| | Phase 1: Checkpoints | Phase 2: Sub-orchestrators |
|---|---|---|
| **Когда срабатывает** | Реактивно (контекст заполнился) | Проактивно (до выполнения) |
| **Параллельность** | Нет | ✅ Есть |
| **Сложность** | Средняя | Выше |
| **Расход контекста Main'а** | Каждый resume — всё саммари | Только отчёты от sub-орков |
| **Масштабирование** | Линейное | ✅ Древовидное |
| **Sub-Orchestrator сам может переполниться** | Н/П | Использует Phase 1 |

### 1. Новый тип агента: `sub-orchestrator`

Это conductor, но для подзадачи. Отличается от Main:

- **Промпт**: "Ты sub-orchestrator. Получил подзадачу от главного оркестратора. Исполни её, используя агентов. Верни структурированный отчёт."
- **Контекст**: только подзадача + релевантная часть KB, а не весь проект
- **Отчёт**: единый формат для Main
- **Может использовать чекпоинты** (Phase 1) если переполнится
- **Permissions**: те же `task()` доступы к агентам, что и у Main
- **Нужен в `VALID_AGENTS`** и `.opencode/opencode.json` с моделью

**Передача контекста KB:** main conductor включает релевантный KB-контекст в prompt sub-orchestrator'а. Отдельный KB-поиск sub-orchestrator'ом — под вопросом (нужен доступ к БД проекта).

### 2. Протокол отчёта

```typescript
interface SubOrchestratorReport {
  subOrchestratorId: string;     // кто отчитался
  status: "done" | "blocked" | "failed";
  summary: string;
  artifacts: string[];           // созданные/изменённые файлы
  decisions: string[];           // ключевые решения
  blockers: string[];            // что помешало
  recommendations: string[];     // что делать дальше
  checkpointId?: string;         // если был чекпоинт
  agentsUsed: number;            // сколько агентов задействовано
  startedAt: number;
  completedAt: number;
  contextUsedApprox?: number;    // оценка использованного контекста
}
```

Отчёт передаётся через файл `.deus/runs/sub-orch-{id}/report.json` + возвращается как JSON в ответе sub-orchestrator'а.

### 3. Логика Main Conductor'а

```
1. Получает задачу
2. Строит план (через architect-planner)
3. Оценивает: нужен ли sub-orch?
   Критерии (в промпте кондуктора, не хардкод):
   - План покрывает 2+ независимых домена → sub-orch
   - Ожидаемый output > ~80k токенов → sub-orch
   - Иначе → выполнить самому (как сейчас)
4. Для сложных задач:
   a. Группирует ноды плана по доменам
   b. Создаёт sub-оркестраторов (по одному на группу)
   c. Запускает их параллельно (если нет зависимостей между доменами)
   d. Ждёт отчёты (poll report.json или task() return)
   e. Передаёт результат следующей группе (если есть зависимости)
   f. После всех — синтезирует финальный ответ
```

### 4. Рекурсия

Sub-Orchestrator может spawn-ить своих sub-оркестраторов:
```
Main
└── Sub-Orch: Auth
    └── Sub-Orch: Auth-Middleware
    └── Sub-Orch: Auth-OAuth
```

Глубина рекурсии: default 2, переопределяется `--max-depth N` или в конфиге.

### Файлы Phase 2

| # | Действие | Файл | Что |
|---|----------|------|-----|
| 1 | создать | `.opencode/agents/sub-orchestrator.md` | промпт суб-оркестратора |
| 2 | создать | `src/types.ts` | `SubOrchestratorReport`, конфиг рекурсии |
| 3 | изменить | `src/orchestrator.ts` | `spawnSubOrchestrator()`, агрегация отчётов |
| 4 | изменить | `.opencode/agents/orchestrator-conductor.md` | инструкция про декомпозицию |
| 5 | изменить | `.opencode/opencode.json` | регистрация sub-orchestrator агента |

---

## Порядок реализации

### Phase 1

| # | Что | Почему |
|---|-----|--------|
| 1 | **Потоковый `[CHECKPOINT]` detection** в `runSession` | Без этого весь Phase 1 не работает. SDK позволяет: `session.messages()` возвращает сообщения даже до `finish=stop` (отдельный HTTP-запрос) |
| 2 | **CheckpointManager базовый** (save/load/list) | Ядро |
| 3 | **CheckpointState** с dispatched/pending agents | Критично для resume mid-dispatch |
| 4 | **Resume flow** (`--resume`, авто-поиск последнего) | Основной use case |
| 5 | **Обновление промпта кондуктора** | Замыкает цикл |
| 6 | **Force-trigger** по размеру (100k символов) | Запасной механизм |
| 7 | **Цепочка чекпоинтов** (parentCheckpointId) | Для повторных переполнений |
| 8 | **Cleanup** старых чекпоинтов (prune) | Гигиена |

### Phase 2

| # | Что | Почему |
|---|-----|--------|
| 1 | Создание `sub-orchestrator` агента + opencode.json | Базовый тип |
| 2 | Протокол отчёта (`SubOrchestratorReport`) + валидация | Контракт |
| 3 | `spawnSubOrchestrator()` в orchestrator.ts | Механизм |
| 4 | Логика декомпозиции в runOrchestrate | Умное принятие решения |
| 5 | Параллельный dispatch sub-оркестраторов | Производительность |
| 6 | Рекурсия (ограничение глубины) | Масштабирование |

---

## Проверка SDK

Перед реализацией Phase 1 (шаг 1) — проверить:

```typescript
// Может ли session.messages() вернуть сообщения ДО завершения сессии?
const client = createOpencodeClient({ baseUrl: "http://localhost:4096" });
const session = await client.session.create({ body: { title: "test-poll" } });

// Отправить асинхронно
await client.session.prompt({
  path: { id: session.id },
  body: { parts: [{ type: "text", text: "Напиши 10 параграфов" }] }
});

// НЕМЕДЛЕННО (до завершения) запросить сообщения
const messages = await client.session.messages({ path: { id: session.id } });
console.log("Messages count:", messages.data.length);
```

Если `messages.data` пуст до `finish=stop` — LLM-сигнал не работает, полагаемся только на force-trigger.

---

## Связь с SCALING-PLAN.md

- **Phase 1 (Checkpoints)** — временное решение для context overflow до реализации полноценного масштабирования
- **Phase 2 (Sub-orchestrators)** — соответствует секции 4 SCALING-PLAN.md (Agent-as-Worker + Иерархические подоркестраторы), но сфокусирована на контекстном бюджете, а не только на параллелизме
- После Phase 2 — переход к полноценной DAG-архитектуре из SCALING-PLAN.md
