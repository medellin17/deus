# Context Overflow Prevention — план реализации

## Проблема

Сессия `orchestrator-conductor` (deepseek-v4-pro, reasoningEffort: max) при сложных задачах упирается в лимит ~150k токенов. Контекст растёт от сообщений агентов, результатов воркеров, артефактов. После лимита — потеря стейта, задача недовыполнена.

## Решение: Checkpoint → Summary → Resume

При достижении ~130-150k токенов (или по явному сигналу от LLM) оркестратор:

1. Ставит чекпоинт (стейт + саммари)
2. Запрашивает у LLM сжатие контекста в саммари
3. Сохраняет саммари в `.deus/checkpoints/` + KB Memory Tree
4. Завершает текущую сессию кондуктора
5. При resume — инжектит саммари в новую сессию как контекст

## Компоненты

### 1. CheckpointManager (`src/kb/checkpoint.ts`)

Сохранение/загрузка/возобновление чекпоинтов.

```
.deus/checkpoints/
  checkpoint-{ts}/
    state.json       # мета: задача, режим, sessionId, completedSteps, contextUsed
    summary.md       # саммари контекста от LLM
    artifacts/       # ключевые артефакты (код, планы)
```

**Интерфейс:**

```typescript
interface CheckpointState {
  checkpointId: string;
  task: string;
  mode: "orchestrate" | "pipeline" | "direct";
  sessionId: string;
  completedSteps: number;
  artifacts: string[];
  contextUsed: number;
  summaryFile: string;
}

class CheckpointManager {
  save(state: CheckpointState, summary: string): string;  // → checkpointId
  load(checkpointId: string): { state: CheckpointState; summary: string };
  list(): CheckpointState[];
  getLatest(projectDir: string): string | null;
}
```

### 2. Механизм триггера в `orchestrator.ts`

Два режима срабатывания:

**A. Сигнал от LLM (основной):**
- Промпт кондуктора содержит: *"Если контекст переполняется — ответь `[CHECKPOINT]` и напиши саммари стейта"*
- Оркестратор парсит ответ, при наличии `[CHECKPOINT]` — вызывает `CheckpointManager.save()`

**B. Принудительный (запасной):**
- Оркестратор мониторит суммарный размер сообщений в сессии (приблизительно через длину output)
- При превышении порога (~130k токенов) сам отправляет запрос: *"Сделай саммари текущего стейта"*
- Сохраняет чекпоинт, завершает сессию

Поток:

```
runOrchestrate()
  │
  ├─ runSession(conductor, task)
  │    │
  │    ├─ LLM отвечает (возможно с [CHECKPOINT])
  │    │
  │    ├─ если [CHECKPOINT] в ответе:
  │    │    ├─ парсим саммари из ответа
  │    │    ├─ CheckpointManager.save(...)
  │    │    ├─ сохраняем в KB Memory Tree
  │    │    └─ завершаем сессию ( success = true )
  │    │
  │    └─ если нет — обычный flow
  │
  └─ при resume: инжект саммари → новая сессия
```

### 3. Resume (`--resume`)

```bash
npx tsx src/orchestrator.ts --cwd . --resume
# или
npx tsx src/orchestrator.ts --cwd . --resume .deus/checkpoints/checkpoint-2026-06-30-001/
```

**Логика:**
1. Загружает `state.json` + `summary.md`
2. Создаёт новую сессию с injected контекстом:

```
## Session Continuation (auto-injected)

### Task
{original task}

### Progress
{summary.md}

Continue from where you left off.
```

### 4. Модификация промпта кондуктора (`.opencode/agents/orchestrator-conductor.md`)

Добавить инструкцию:

```
## Context Management

This session has limited context (~150k tokens). When you feel context is filling up:

1. End your response with `[CHECKPOINT]`
2. Then write a **summary** of:
   - What has been done so far
   - Key decisions and artifacts produced
   - Current state and what remains
   - Next steps to continue

The system will save this summary, start a fresh session, and inject the summary as context.
```

### 5. Интеграция с KB Memory Tree

При сохранении чекпоинта — писать в Memory Tree:
```typescript
kb.upsertMemory(
  `checkpoint:${checkpointId}`,
  "project",
  summary.slice(0, 500)
);
```

## Файлы для изменения/создания

| # | Действие | Файл | Что |
|---|----------|------|-----|
| 1 | создать | `src/kb/checkpoint.ts` | CheckpointManager |
| 2 | изменить | `src/orchestrator.ts` | мониторинг размера, парсинг `[CHECKPOINT]`, resume flow, флаг `--resume` |
| 3 | изменить | `.opencode/agents/orchestrator-conductor.md` | инструкция про `[CHECKPOINT]` |
| 4 | обновить | `src/kb/index.ts` | экспорт CheckpointManager |

## Структура чекпоинта

### state.json
```json
{
  "checkpointId": "ckpt-2026-06-30-001",
  "task": "Сделай рефакторинг модуля auth",
  "mode": "orchestrate",
  "sessionId": "sess_abc123",
  "completedSteps": [
    { "agent": "researcher-explorer", "status": "done" },
    { "agent": "architect-planner-pro", "status": "done" }
  ],
  "artifacts": ["src/auth/new-flow.ts", "docs/auth-v2.md"],
  "contextUsed": 145000,
  "summaryFile": "summary.md",
  "createdAt": "2026-06-30T12:00:00.000Z"
}
```

### summary.md
```markdown
# Checkpoint Summary

## Task
Сделай рефакторинг модуля auth

## Done
- Исследована кодовая база: найдены файлы src/auth/*.ts (6 файлов)
- Спроектирована архитектура: новый flow через middleware, убраны дублирования
- Создан план: 4 этапа

## Artifacts
- src/auth/new-flow.ts — базовый скелет
- docs/auth-v2.md — архитектурная документация

## Current State
Готовы этапы 1-2 из 4. Осталось:
- Этап 3: миграция существующих роутов
- Этап 4: тесты

## Next Steps
Продолжить с этапа 3. Контекст: архитектура уже спроектирована, каркас написан.
```

## Resume flow

```
Пользователь: npx tsx src/orchestrator.ts --cwd . --resume

Оркестратор:
  1. Ищет последний чекпоинт в .deus/checkpoints/
  2. Загружает state.json + summary.md
  3. Создаёт новую сессию кондуктора
  4. Инжектит:

     ## Session Continuation
     Task: {task}
     Progress:
     {summary.md}
     Continue from where you left off.

  5. Ждёт ответа (как обычный runOrchestrate)
```

## Приоритет реализации

1. CheckpointManager (save/load/list)
2. Интеграция в `runOrchestrate` — парсинг `[CHECKPOINT]`
3. Resume flow (CLI флаг + инжект)
4. Обновление промпта кондуктора
5. Принудительный триггер по размеру контекста
