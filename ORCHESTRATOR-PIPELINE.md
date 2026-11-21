# Deus Orchestrator v2 — пайплайн, зависимости и правила

> Полное описание того, как работает оркестратор в `agentic-orchestrator-v2-deus`, от запуска CLI до финального отчёта. Основано на исходниках `src/orchestrator.ts`, `src/dag/engine.ts`, `src/kb/*`, `src/state/*`, `.opencode/agents/` и плагина мониторинга.

---

## 1. Общая архитектура

```mermaid
graph TB
    User([Пользователь / CLI / будущие Web, TG])
    CLI["orchestrator.ts<br/>CLI + SDK-клиент"]
    SDK["@opencode-ai/sdk"]
    Server["opencode serve<br/>(localhost:4096)"]
    Agents["18 агентов<br/>17 + sub-orchestrator"]
    Target[("Целевой проект<br/>--cwd")]
    KB[("Knowledge Base<br/>SQLite + FTS5 + Memory Tree<br/>.deus/kb/orchestrator.db")]
    State[("State DB<br/>tasks, task_nodes, session_log, agent_stats<br/>та же orchestrator.db")]
    Metrics[("metrics.db<br/>сессии + агрегаты")]
    Plugin["orchestrator-monitor.ts<br/>plugin lifecycle hooks"]

    User -->|"задача, --pipeline, --agent, ..."| CLI
    CLI -->|"HTTP / JSON"| SDK
    SDK --> Server
    Server --> Agents
    Agents -->|"читают/пишут файлы"| Target
    CLI -->|"indexDirectory / getContext / upsertMemory"| KB
    CLI -->|"CheckpointManager save/load"| State
    Server -->|"session.* events"| Plugin
    Plugin -->|"incrementMetric / upsertSession"| Metrics
```

### Ключевые компоненты

| Компонент | Файл | Ответственность |
|-----------|------|-----------------|
| `orchestrator.ts` | `src/orchestrator.ts` | CLI, разбор аргументов, запуск сервера, диспетчеризация режимов, polling сессий, сохранение отчётов |
| `opencode-client.ts` | `src/opencode-client.ts` | Синглтон `@opencode-ai/sdk`, создание/отправка/чтение сессий |
| `DAGEngine` | `src/dag/engine.ts` | Выполнение DAG графа: валидация, Kahn's algorithm, retries, fallback на context-limit |
| `TaskManager` | `src/state/task-manager.ts` | CRUD задач и нод, логирование сессий, статистика по агентам |
| `StateDatabase` | `src/state/schema.ts` | Схема SQLite для `tasks`, `task_nodes`, `session_log`, `agent_stats` |
| `RagKbProvider` | `src/kb/rag-provider.ts` | Фасад KB: индексация, поиск, контекст, memory tree, smart context |
| `CheckpointManager` | `src/kb/checkpoint.ts` | Сохранение/загрузка чекпоинтов через Memory Tree + tasks |
| `orchestrator-monitor` | `.opencode/plugins/orchestrator-monitor.ts` | Хуки `session.created/updated/status/error/deleted` → метрики |

---

## 2. Поток от запуска до результата

```mermaid
flowchart TD
    A["npx tsx src/orchestrator.ts [args]"] --> B["parseArgs()"]
    B --> C{"Режим?"}

    C -->|"--help"| HLP["printHelp() → exit"]
    C -->|"--index / --kb-stats / --metrics"| NOSRV["Обработка без сервера"]
    C -->|"оркестрация / pipeline / agent / parallel / dag / sub-orch / resume / demo"| D

    D["main()"] --> E["validate --cwd<br/>path traversal защита"]
    E --> F["ensureDeusDir()<br/>создаёт .deus/kb .deus/runs .gitignore"]
    F --> G["copyOpenCodeToTarget() + writeProjectAgentsMd()<br/>если cwd ≠ process.cwd"]
    G --> SRV["ensureServerRunning()<br/>health-check / spawn opencode serve --port 4096<br/>ожидание до 30 сек"]

    SRV --> M{"Режим"}
    M -->|orchestrate| ORCH["runOrchestrate()"]
    M -->|pipeline| PIPE["runPipeline()"]
    M -->|direct| DIR["runDirect()"]
    M -->|parallel| PAR["runParallel()"]
    M -->|dag| DAG["runDAG()"]
    M -->|sub-orch| SUB["spawnSubOrchestrators()"]
    M -->|resume| RES["resume из CheckpointManager"]
    M -->|demo| DEM["runDemo()"]

    ORCH --> SESS["runSessionWithRetry()"]
    PIPE --> SESS
    DIR --> SESS
    PAR --> SESS
    DAG --> WORK["runWorker()"]
    SUB --> SPAWN["spawnSubOrchestrator()"]
    RES --> SESS

    SESS --> POLL["Polling session.messages()<br/>каждые 2 сек"]
    WORK --> POLL
    SPAWN --> POLL

    POLL --> FIN["finish=stop или error"]
    FIN --> CHK["[SUBORCH]-разбор / checkpoint / обычный вывод"]
    CHK --> SAVE["saveResults()<br/>.deus/runs/run-{ts}/index.md"]
    SAVE --> EXIT["shutdownAndExit()<br/>SIGTERM сервера если сам запускали"]
```

---

## 3. Режимы запуска

| Режим | Команда | Что делает |
|-------|---------|------------|
| `orchestrate` (default) | `"задача"` или `--orchestrate` | LLM-дирижёр сам выбирает пайплайн и агентов |
| `pipeline` | `--pipeline build "задача"` | Жёстко заданная последовательность агентов (см. PIPELINES) |
| `direct` | `--agent implementer-builder "задача"` | Один агент |
| `parallel` | `--parallel "задача1" "задача2"` | Несколько независимых сессий параллельно |
| `dag` | `--dag graph.json` | Выполнение DAG графа через `DAGEngine` |
| `sub-orch` | `--sub-orch domains.json` | Параллельные sub-orchestrators по доменам |
| `resume` | `--resume [checkpointId]` | Возобновление из чекпоинта |
| `index` | `--index ./project` | Принудительная индексация в KB |
| `kb-stats` | `--kb-stats` | Статистика KB |
| `metrics` | `--metrics` | Метрики из `metrics.db` |
| `demo` | `--demo` | Три демо-сценария |

---

## 4. Orchestrate-режим: от задачи к dispatch

```mermaid
sequenceDiagram
    autonumber
    participant U as Пользователь
    participant O as orchestrator.ts
    participant KB as Knowledge Base
    participant SDK as OpenCode SDK
    participant C as orchestrator-conductor
    participant A as Специализированные агенты
    participant SO as Sub Orchestrator

    U->>O: npx tsx src/orchestrator.ts --cwd . задача
    O->>O: ensureServerRunning
    O->>KB: getKB
    alt KB пуста
        O->>KB: indexDirectory(globalCwd)
        opt has GEMINI_API_KEY
            O->>KB: generateEmbeddings
        end
    end
    O->>KB: getContext(task)
    KB-->>O: Project Context (auto-injected)
    O->>SDK: createSession(title)
    SDK-->>O: sessionId
    O->>SDK: promptAsync(fullTask, agent=conductor)
    loop Polling каждые 2 сек
        O->>SDK: session.messages
        SDK-->>O: finish or error
    end

    alt Conductor вернул SUBORCH
        O->>O: parse JSON домены
        par Независимые домены
            O->>SO: spawnSubOrchestrator(domain)
            SO->>A: task() dispatch sub-agents
            SO-->>O: JSON report
        end
        O->>O: aggregateReports
        O->>SDK: promptAsync(synthesis) в conductor
        Note over O,C: продолжаем polling conductor
    end

    C-->>O: Финальный ответ
    O->>KB: upsertMemory(task, summary)
    O->>O: saveResults
```

### Что делает conductor (`.opencode/agents/orchestrator-conductor.md`)

1. **Классифицирует** домен: software / content / data / design.
2. **Выбирает pipeline** по сложности:
   - trivial → direct implementer/debug
   - simple → `build`
   - standard → `build-review`
   - high-stakes (auth/payments/security) → `full-cycle` с pro-агентами
   - bug → `debug-fix`
   - multi-domain >8 агентов → `sub-orch`
3. **Диспатчит** через `task()` (sub-agents не имеют общей памяти — контекст копируется целиком).
4. **Не выполняет работу сам** — нет прав `edit/bash/glob/grep`.
5. **Контролирует контекст**: при переполнении выводит `[CHECKPOINT]` или `[SUBORCH]`.

---

## 5. Static pipeline: как выполняются шаги

```mermaid
flowchart TD
    A["runPipeline(PIPELINES.build)"] --> B["prev = ''"]
    B --> C["i = 0"]
    C --> D{i < steps.length?}
    D -->|нет| Z["✅ success"]
    D -->|да| E{parallelGroup?}

    E -->|undefined| SEQ["Последовательный шаг"]
    SEQ --> F["task = replace {task},{prev} в шаблоне"]
    F --> G["runSessionWithRetry(agent, task)"]
    G --> H{success?}
    H -->|да| I["prev = output"]
    H -->|нет / suspended| J["⛔ fail / checkpoint"]
    I --> K["completedDispatches.push(...)"]
    K --> L["i++"]
    L --> D

    E -->|число| PAR["Собрать batch всех шагов с этим parallelGroup"]
    PAR --> M["Promise.all runSessionWithRetry(...)"]
    M --> N{все success?}
    N -->|да| O["prev = merge(outputs по агентам)"]
    O --> P["completedDispatches.push для каждого"]
    P --> D
    N -->|нет / suspended| J

    J --> Q["return PipelineResult<br/>success=false"]
```

### Статические пайплайны (константа `PIPELINES`)

| Пайплайн | Шаги |
|----------|------|
| `build` | researcher → architect → implementer → reviewer → qa |
| `build-pro` | researcher → architect-pro → implementer → reviewer-pro → qa |
| `full-cycle` | researcher → architect-pro → reviewer-pro → implementer → reviewer-pro → qa → doc |
| `audit` | security → code-reviewer → reviewer |
| `debug` | researcher → debug → implementer → qa |
| `docs` | researcher → content-writer → reviewer |
| `parallel-audit` | security ∥ code-reviewer ∥ reviewer |
| `parallel-research` | 3 researcher-explorer параллельно |
| `parallel-review` | security ∥ code-reviewer ∥ reviewer (на одном контексте) |
| `content` | researcher → content-writer → reviewer |
| `data` | researcher → data-analyst → reviewer |
| `design` | researcher → ux-designer → reviewer → implementer |
| `plan` | researcher → architect |
| `research` | researcher |

Переменные в шаблонах:
- `{task}` — исходная задача (или `prev`, если предыдущего контекста нет).
- `{prev}` — вывод предыдущего шага (или merge параллельной группы).

---

## 6. DAG-режим

```mermaid
flowchart TD
    A["runDAG(graph.json, cwd)"] --> B["StateDatabase(dbPath) + TaskManager"]
    B --> C["DAGEngine.execute(graph)"]
    C --> V["validateGraph()<br/>уникальность id, существование deps, проверка циклов"]
    V --> D["createTask + createNode для каждого"]
    D --> E["updateTaskStatus('running')"]
    E --> F["Kahn's algorithm"]
    F --> G{"queue not empty?"}
    G -->|да| H["batch = queue.splice(0, maxConcurrent)"]
    H --> I["Promise.all executeNode(batch)"]
    I --> J{failed?}
    J -->|critical=false| K["продолжаем"]
    J -->|critical=true| L["aborted = true"]
    K --> M["уменьшить in-degree потомков"]
    M --> G
    G -->|нет / aborted| N["Определить status: completed / failed / partial"]
    N --> O["updateTaskStatus / completeTask"]
    O --> P["return DAGResult"]
```

### Формат `TaskGraph`

```ts
interface TaskGraph {
  id: string;
  nodes: TaskNodeDefinition[];
  config: { maxConcurrent: number; maxCost: number; defaultTimeout: number };
}

interface TaskNodeDefinition {
  id: string;
  agent: string;
  prompt: string;        // шаблоны {{nodeId.result}} / {{nodeId.error}} / {{nodeId.summary}}
  dependsOn: string[];
  retry?: number;        // default 2
  fallbackAgent?: string; // при context-limit после исчерпания retries
  timeout?: number;      // default 300000
  critical?: boolean;    // default true
}
```

---

## 7. Sub-Orchestrator: распараллеливание по доменам

```mermaid
flowchart TD
    A["Conductor выводит [SUBORCH]"]
    A --> B["orchestrator.ts парсит JSON DomainTask[]"]
    B --> C["split independent / dependent"]
    C --> D["independent: batches по maxParallel"]
    D --> E["Promise.all spawnSubOrchestrator(domain)"]
    E --> F["dependent: последовательно"]
    F --> G["parseSubOrchestratorReport(output)"]
    G --> H["aggregateReports()"]
    H --> I["buildSubOrchSynthesis()"]
    I --> J["promptAsync(synthesis) обратно в conductor"]
    J --> K["Conductor продолжает интеграцию / финальный QA"]
```

### `DomainTask`

```ts
interface DomainTask {
  domain: string;
  subTask: string;
  kbContext?: string;
  dependsOn?: string[];
}
```

### `SubOrchestratorReport`

```ts
{
  subOrchestratorId: string;
  status: "done" | "blocked" | "failed";
  summary: string;
  artifacts: string[];
  decisions: string[];
  blockers: string[];
  recommendations: string[];
  agentsUsed: number;
  contextUsedApprox?: number;
}
```

Константы:
- `SUB_ORCHESTRATOR_TIMEOUT_MS = 600_000` (10 мин).
- `SUB_ORCHESTRATOR_MAX_PARALLEL = 3`.
- `SUB_ORCHESTRATOR_DEFAULT_MAX_DEPTH = 2` (управляется `--max-depth`).

---

## 8. Жизненный цикл одной сессии

```mermaid
sequenceDiagram
    autonumber
    participant O as runSession
    participant SDK as OpenCode SDK
    participant S as OpenCode Session
    participant MT as Monitor plugin

    O->>SDK: session.create(title)
    SDK-->>O: sessionId
    SDK->>MT: event session.created
    O->>SDK: session.promptAsync(parts, agent)
    O->>O: start = Date.now
    loop Пока не timeout
        O->>SDK: session.messages(id)
        SDK-->>O: messages
        O->>O: ищем assistant finish stop или error
        alt finish is stop
            O->>O: output = extractText(parts)
        else finish is error
            O->>O: errorStr
        end
        O->>O: sleep(POLL_INTERVAL_MS)
    end
    SDK->>MT: event session.status или idle или error
    O->>O: success = output.length больше 0
    O-->>O: return StepResult
```

### Retry-политика

- `runSessionWithRetry`: **одна** повторная попытка при неуспехе (для pipeline/direct/orchestrate).
- `DAGEngine`: `retry` по умолчанию **2** (итого 3 попытки) с экспоненциальной задержкой `5s * 2^(attempt-1)`.
- Если в DAG ошибка context-limit и задан `fallbackAgent` — последняя попытка идёт с fallback-агентом.

### Таймауты

| Режим | Таймаут |
|-------|---------|
| `runSession` | `DEFAULT_TIMEOUT_MS = 30 * 60 * 1000` (30 мин) |
| `runWorker` / DAG-нода | `defaultTimeout = 300_000` (5 мин) или `node.timeout` |
| Sub-orchestrator | `SUB_ORCHESTRATOR_TIMEOUT_MS = 600_000` (10 мин) |
| Ожидание `opencode serve` | 60 итераций × 500 мс = 30 сек |

---

## 9. Knowledge Base: индексация и контекст

```mermaid
flowchart TD
    A["getKB(cwd, useRag)"] --> B{"useRag?"}
    B -->|нет| NOOP["NoopKbProvider<br/>все методы no-op"]
    B -->|да| RAG["RagKbProvider"]
    RAG --> DB["openKB(dbPath)"]
    DB --> SCH["KB схема + SmartContext схема"]
    RAG --> E["getEmbeddings() если GEMINI_API_KEY"]

    IND["indexDirectory(projectRoot)"] --> WALK["walk: пропуск node_modules, .git, dist, ..."]
    WALK --> FILE["indexFile(path)"]
    FILE --> HASH["md5 content_hash"]
    HASH --> CHUNK["chunkMarkdown(content)<br/>по заголовкам → параграфы → предложения"]
    CHUNK --> INS["INSERT kb_documents / kb_chunks"]
    INS --> FTS["FTS5 триггеры обновляют kb_chunks_fts"]
    IND --> SCI["smartContext.indexDirectory(projectRoot)"]

    CTX["getContext(task)"] --> FTSC["FTS5 по kb_chunks_fts"]
    CTX --> MEM["LIKE по kb_memory_tree"]
    CTX --> PROJ["project level summary"]
    CTX --> ASS["assemble в markdown"]
```

### Таблицы KB

| Таблица | Назначение |
|---------|------------|
| `kb_documents` | Проиндексированные файлы (path, content_hash) |
| `kb_chunks` | Семантические чанки (heading, level, content, token_count) |
| `kb_chunks_fts` | Виртуальная FTS5-таблица (`tokenize='porter unicode61'`) |
| `kb_embeddings` | Векторы Gemini `gemini-embedding-2`, 3072 dim |
| `kb_memory_tree` | Иерархические саммари: file/section/project/checkpoint |

### Smart Context Engine

Реализована в `src/kb/smart-context/`:
- `indexer.ts` — парсинг файлов, извлечение символов/импортов.
- `graph.ts` — Symbol Graph + Import Graph.
- `search.ts` — стратегии: BM25, path, import, symbol.
- `ranker.ts` — ранжирование с учётом категории запроса (bugfix/feature/refactor).
- `budget.ts` — сборка контекста с учётом лимита токенов.
- Используется через `KbProvider.searchCode(query, topN)`.

---

## 10. Checkpoint и auto-resume

```mermaid
flowchart TD
    A["runSession polling"] --> B{"Превышен лимит токенов?<br/>totalTokens > 140_000"}
    B -->|да| C["buildStructuredSummary()"]
    C --> D["CheckpointManager.save(taskId, summary)"]
    D --> E["return StepResult<br/>suspended=true"]

    E --> F["main(): isSuspended?"]
    F -->|да| G["abortSession(sessionId)"]
    G --> H["cm.getLatest() / cm.load()"]
    H --> I["buildResumeTask()"]
    I --> J["executeMode(..., skipKbContext=true)"]
    J --> K{"MAX_AUTO_RESUME < 5?"}
    K -->|да| L["iteration++ → повтор"]
    K -->|нет| M["shutdownAndExit(1)"]

    F -->|нет| N["saveResults / print"]
```

### Правила чекпоинтов

- Срабатывает при `> 140 000` токенов в одной сессии.
- Состояние сохраняется в SQLite: `completedDispatches` и `pendingDispatches` — в JSON-поле `tasks.graph`, саммари — в `kb_memory_tree` (`level='checkpoint'`).
- `MAX_AUTO_RESUME = 5` автоматических продолжений.
- После успешного resume старые чекпоинты обрезаются до 5 последних (`prune(5)`).
- Ручной resume: `--resume [checkpointId]` — последний, если id не указан.

---

## 11. Плагин мониторинга

```mermaid
flowchart LR
    S[OpenCode Server] -->|event| P[orchestrator-monitor.ts]
    P --> M1[incrementMetric totalCreated]
    P --> M2[incrementMetric totalCompleted]
    P --> M3[incrementMetric totalFailed]
    P --> M4[updateAvgDuration]
    P --> M5[upsertSession / deleteSession]
    P --> L[client.app.log]
```

### Обрабатываемые события

| Событие | Действие |
|---------|----------|
| `session.created` | `totalCreated++`, `activeSessions++`, `upsertSession(status=active)` |
| `session.updated` | обновление title / directory |
| `session.status` | `idle` → `totalCompleted++`, `activeSessions--`, средняя длительность |
| `session.error` | `totalFailed++`, пометка сессии failed |
| `session.deleted` | удаление из активных, `deleteSession` |

### Метрики (`metrics.db`)

| Ключ | Смысл |
|------|-------|
| `totalCreated` | Всего создано сессий |
| `totalCompleted` | Успешно завершено |
| `totalFailed` | Упало с ошибкой |
| `activeSessions` | Активных сейчас |
| `avgDurationMs` | Средняя длительность |

---

## 12. Правила, условия и зависимости

### Общие правила оркестрации

| # | Правило | Где реализовано |
|---|---------|-----------------|
| 1 | Conductor **не выполняет работу сам** — только `task()`/`skill()` | `.opencode/agents/orchestrator-conductor.md` |
| 2 | Sub-agents **stateless** — контекст копируется целиком в каждый `task()` | conductor.md + sub-orchestrator.md |
| 3 | Для high-stakes (auth/payments/security) используются pro-агенты | conductor.md, `opencode.json` |
| 4 | При переполнении контекста — `[CHECKPOINT]` или `[SUBORCH]` | conductor.md, `runSession` |
| 5 | Pipeline прерывается при первой ошибке (fail-fast) | `runPipeline` |
| 6 | DAG-нода может быть `critical=false` — тогда падение не останавливает граф | `DAGEngine.execute` |
| 7 | Path traversal защита: `--cwd` должен быть внутри `process.cwd()` | `isValidTargetPath` |
| 8 | Сервер `opencode serve` авто-стартует, если не запущен | `ensureServerRunning` |

### Модели агентов

| Агент | Модель (фактически в `opencode.json`) | Назначение |
|-------|---------------------------------------|------------|
| `orchestrator-conductor` | `opencode-go/deepseek-v4-flash` | Дирижёр |
| `architect-planner-pro` | `opencode-go/deepseek-v4-pro` | Сложная архитектура |
| `reviewer-critic-pro` | `opencode-go/deepseek-v4-pro` | High-stakes ревью |
| Остальные 15 | `opencode-go/deepseek-v4-flash` | Исполнители |

> В README/ARCHITECTURE указано, что conductor работает на pro-модели, но в актуальном `.opencode/opencode.json` conductor настроен на `deepseek-v4-flash`. Pro-агенты только `architect-planner-pro` и `reviewer-critic-pro`.

### Зависимости данных

```mermaid
graph LR
    Task["Пользовательская задача"] --> Conductor
    KB["KB Context"] --> Conductor
    Conductor --> Researcher
    Researcher --> Architect
    Architect --> Implementer
    Implementer --> Reviewer
    Reviewer --> QA
    QA --> Report[".deus/runs/run-*/index.md"]
    Conductor -.->|multi-domain| Sub[Sub-Orchestrator]
    Sub --> Implementer2
    Sub --> Reviewer2
```

### Зависимости компонентов кода

```mermaid
graph LR
    orch[orchestrator.ts] --> client[opencode-client.ts]
    orch --> kb[index.ts / RagKbProvider]
    orch --> cm[CheckpointManager]
    orch --> tm[TaskManager]
    orch --> dag[DAGEngine]
    dag --> tm
    cm --> tm
    cm --> mt[MemoryTree]
    kb --> db[KBDatabase / schema]
    kb --> idx[KBIndexer]
    kb --> fts[FTS5Index]
    kb --> mem[MemoryTree]
    kb --> sc[SuperContext]
    kb --> sce[SmartContextEngine]
    Plugin --> metrics[metrics.ts]
```

---

## 13. Структура артефактов

После каждого прогона создаётся директория:

```
.deus/
├── .gitignore              # игнорирует всё внутри
├── kb/
│   ├── orchestrator.db     # KB + State
│   └── metrics.db          # метрики мониторинга
└── runs/
    └── run-2026-07-03T09-21-46/
        ├── index.md        # сводная таблица
        ├── researcher-explorer.md
        ├── architect-planner.md
        ├── implementer-builder.md
        └── ...
```

---

## 14. Где смотреть исходники

| Логика | Файл |
|--------|------|
| CLI, аргументы, режимы | `src/orchestrator.ts` |
| SDK-клиент | `src/opencode-client.ts` |
| DAG-движок | `src/dag/engine.ts`, `src/dag/types.ts` |
| State/чекпоинты | `src/state/schema.ts`, `src/state/task-manager.ts`, `src/kb/checkpoint.ts` |
| Knowledge Base | `src/kb/rag-provider.ts`, `src/kb/indexer.ts`, `src/kb/search.ts`, `src/kb/super-context.ts`, `src/kb/schema.ts` |
| Smart Context | `src/kb/smart-context/index.ts` |
| Memory Tree | `src/kb/memory-tree.ts` |
| Мониторинг | `.opencode/plugins/orchestrator-monitor.ts`, `src/metrics.ts` |
| Промпты агентов | `.opencode/agents/orchestrator-conductor.md`, `.opencode/agents/sub-orchestrator.md` |
| Custom tool `search_code` | `.opencode/tools/search-code.ts` |
| Конфиг моделей | `.opencode/opencode.json` |
| Планы развития / статус | `CONTEXT-OVERFLOW-PLAN.md`, `SCALING-PLAN.md`, `REPAIR-PLAN.md` |

---

> Актуально для версии `2.0.0` (`package.json`). Если структура кода изменится — обнови этот файл вместе с ней.
