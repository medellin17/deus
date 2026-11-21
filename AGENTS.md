# AGENTS.md — Agentic Orchestrator v2

> **Единственный источник правды** по агентам, пайплайнам и Knowledge Base. README.md и ARCHITECTURE.md ссылаются сюда.

## Обзор

Multi-agent оркестратор на базе OpenCode SDK. Управляет 18 агентами (17 + sub-orchestrator) через HTTP API, имеет встроенную Knowledge Base (SQLite + FTS5), State DB для задач/чекпоинтов, DAG-движок и плагин мониторинга.

**Стек:** TypeScript, @opencode-ai/sdk, better-sqlite3, Node.js 20+, tsx

## Модели

| Агент | Модель | Thinking |
|-------|--------|----------|
| orchestrator-conductor | `opencode-go/deepseek-v4-flash` | `reasoningEffort: "max"` |
| architect-planner-pro | `opencode-go/deepseek-v4-pro` | `reasoningEffort: "max"` |
| reviewer-critic-pro | `opencode-go/deepseek-v4-pro` | `reasoningEffort: "max"` |
| Остальные 15 агентов | `opencode-go/deepseek-v4-flash` | `reasoningEffort: "max"` |

## Структура

```
agentic-orchestrator-v2/
├── .opencode/
│   ├── opencode.json          # Модели + thinking
│   ├── agents/                # 18 агентов (17 + sub-orchestrator)
│   ├── tools/
│   │   └── search-code.ts     # Smart Context tool (built-in)
│   ├── plugins/
│   │   └── orchestrator-monitor.ts # Плагин мониторинга
│   └── skills/                # 32 skill'а
├── src/
│   ├── orchestrator.ts        # Основной скрипт (CLI + SDK)
│   ├── types.ts               # Типы SubOrchestratorReport и др.
│   ├── metrics.ts             # Метрики из плагина
│   ├── opencode-client.ts     # Адаптер SDK
│   ├── dag/                   # DAG-движок
│   │   ├── engine.ts          # Топологическая сортировка, retries, fallback
│   │   ├── types.ts           # TaskGraph, TaskNodeDefinition
│   │   └── index.ts           # Public API
│   ├── state/                 # State DB
│   │   ├── schema.ts          # tasks, task_nodes, session_log, agent_stats
│   │   ├── task-manager.ts    # CRUD задач и нод
│   │   └── index.ts
│   └── kb/                    # Knowledge Base
│       ├── schema.ts          # SQLite: documents, chunks, FTS5, embeddings, memory_tree
│       ├── chunker.ts         # Семантический чанкинг по Markdown заголовкам
│       ├── fts5.ts            # Keyword поиск (BM25)
│       ├── embeddings.ts      # Gemini gemini-embedding-2 (3072 dim)
│       ├── memory-tree.ts     # Иерархические саммари
│       ├── search.ts          # Гибридный поиск (FTS5 + memory tree)
│       ├── super-context.ts   # Авто-инжект контекста
│       ├── indexer.ts         # Индексация файлов
│       ├── checkpoint.ts      # CheckpointManager (чекпоинты в SQLite)
│       ├── index.ts           # Public API
│       └── smart-context/     # SmartContextEngine (built-in)
├── package.json
└── tsconfig.json
```

## Запуск

```bash
# Оркестрация (LLM-conductor сам выбирает пайплайн)
npx tsx src/orchestrator.ts --cwd ../target-project "задача"

# Статический пайплайн
npx tsx src/orchestrator.ts --cwd ../target-project --pipeline build "задача"

# Один агент
npx tsx src/orchestrator.ts --cwd ../target-project --agent researcher-explorer "задача"

# Параллельные задачи
npx tsx src/orchestrator.ts --cwd ../target-project --parallel "задача1" "задача2"

# DAG из JSON
npx tsx src/orchestrator.ts --cwd ../target-project --dag graph.json

# Sub-orchestrators из JSON
npx tsx src/orchestrator.ts --cwd ../target-project --sub-orch domains.json

# Resume последнего чекпоинта
npx tsx src/orchestrator.ts --cwd ../target-project --resume

# Индексация проекта в KB
npx tsx src/orchestrator.ts --index ../target-project

# Статистика KB
npx tsx src/orchestrator.ts --kb-stats --cwd ../target-project

# Метрики оркестратора
npx tsx src/orchestrator.ts --cwd ../target-project --metrics
```

## Автоматика

При запуске с `--cwd`:
1. Копирует `.opencode/` в целевой проект (если нет)
2. Создаёт `.deus/` (kb, runs, .gitignore)
3. Запускает `opencode serve` в целевой директории
4. Если KB пуста — индексирует проект
5. При наличии `GEMINI_API_KEY` — генерирует эмбеддинги
6. Инжектит контекст из KB перед планированием
7. При переполнении контекста (>140k токенов) — автоматически сохраняет чекпоинт и делает до 5 попыток resume
8. После завершения — сохраняет результат в memory tree

## Агенты (18)

### Оркестрация
- `orchestrator-conductor` — главный дирижёр, декомпозирует, dispatch-ит, синтезирует (не проверяет сам — делегирует reviewer'ам)
- `architect-planner` — базовый архитектор
- `architect-planner-pro` — продвинутый архитектор (deepseek-v4-pro)
- `sub-orchestrator` — доменный дирижёр; выполняет sub-task от conductor и возвращает структурированный JSON-отчёт

### Разработка
- `implementer-builder` — пишет код
- `integrator-qa` — тестирование
- `debug` — диагностика багов

### Исследование
- `researcher-explorer` — анализ кодовой базы
- `content-writer` — тексты, документация
- `data-analyst` — анализ данных

### Ревью
- `reviewer-critic` — код-ревью (deepseek-v4-flash, для стандартных задач)
- `reviewer-critic-pro` — продвинутое ревью (deepseek-v4-pro, для high-stakes: auth, payments, security)
- `code-reviewer` — структурированный ревью
- `security-auditor` — аудит безопасности
- `ux-designer` — UX/UI

### Поддержка
- `doc-maintainer` — ведение документации
- `test-engineer` — написание тестов
- `skills-indexer` — индексация skills

## Пайплайны (static)

| Название | Шаги |
|----------|------|
| `build` | researcher → architect → implementer → reviewer → qa |
| `build-pro` | researcher → architect-pro → implementer → reviewer-pro → qa |
| `full-cycle` | researcher → architect-pro → reviewer-pro → implementer → reviewer-pro → qa → doc |
| `audit` | security → code-reviewer → reviewer |
| `debug` | researcher → debug → implementer → qa |
| `docs` | researcher → content-writer → reviewer |
| `parallel-audit` | security ∥ code-reviewer ∥ reviewer |
| `parallel-research` | 3× researcher-explorer |
| `parallel-review` | security ∥ code-reviewer ∥ reviewer (на одном контексте) |
| `content` | researcher → content-writer → reviewer |
| `data` | researcher → data-analyst → reviewer |
| `design` | researcher → ux-designer → reviewer → implementer |
| `plan` | researcher → architect |
| `research` | researcher |

Параллельные шаги внутри одного `parallelGroup` выполняются одновременно; их результаты объединяются и передаются дальше как `{prev}`.

## Knowledge Base

- **FTS5** — keyword поиск по BM25 (встроен в SQLite)
- **Memory Tree** — иерархические саммари (file/section/project/checkpoint)
- **SuperContext** — авто-инжект контекста перед планированием
- **Embeddings** — Gemini `gemini-embedding-2` (3072 dim, требует `GEMINI_API_KEY`)
- **Smart Context Engine** — встроенный поиск кода (BM25 + symbol graph + import graph); Tree-sitter-парсинг опционален

### Таблицы SQLite

| Таблица | Назначение |
|---------|-----------|
| `kb_documents` | Индексированные файлы |
| `kb_chunks` | Семантические чанки (по заголовкам) |
| `kb_chunks_fts` | FTS5 виртуальная таблица |
| `kb_embeddings` | Векторные эмбеддинги |
| `kb_memory_tree` | Иерархические саммари |

## Custom Tools

### search-code

Встроенный инструмент умного поиска кода на базе `SmartContextEngine` (BM25 + symbol graph + import graph). Реализован внутри проекта в `src/kb/smart-context/`.

- **BM25** — keyword поиск с синонимами
- **Symbol Graph** — парсинг функций/классов/типов + call_graph
- **Import Graph** — 1-2 hops по графу импортов
- **Category Weights** — per-category веса для bugfix/feature/refactor
- **Skeletonization** — сжатие файлов >400 строк до структуры
- **Tree-sitter (опционально)** — более точный парсинг при наличии `web-tree-sitter` и WASM-грамматик в `grammars/`

**Использование:**
```
search_code(query="user authentication", project="/path/to/project")
```

**Индексация:**
Происходит автоматически при запуске с флагом `--index`, при `--cwd`-запуске (если KB пуста) или при вызове `indexDirectory()`. Поиск встроен в KB.

## Добавление агента

1. Создать `.opencode/agents/{name}.md` с промптом
2. Добавить в `VALID_AGENTS` в `src/orchestrator.ts`
3. Добавить в `.opencode/opencode.json` (если нужна своя модель)

## State, чекпоинты и мониторинг

- **State DB** — `tasks`, `task_nodes`, `session_log`, `agent_stats` в той же SQLite (`orchestrator.db`). Используется DAG-движком и CheckpointManager.
- **CheckpointManager** — сохраняет состояние при переполнении контекста (>140k токенов) и восстанавливает через `--resume`.
- **Monitor plugin** — отслеживает lifecycle сессий и пишет метрики в `metrics.db` (`totalCreated`, `totalCompleted`, `totalFailed`, `activeSessions`, `avgDurationMs`).

## Ограничения

- Сервер: `opencode serve` должен быть запущен (auto-spawn на `localhost:4096`)
- `.opencode/` копируется автоматически при `--cwd`
- Результаты прогонов: `.deus/runs/run-{ts}/` — отчёты в `.md`
- БД: `.deus/kb/orchestrator.db` — per-project, не коммитить в git (`.deus/.gitignore` создаётся автоматически)
- Auto-resume: до 5 попыток продолжения после checkpoint
- Sub-orchestrators: до 3 параллельных независимых доменов (настраивается `--max-depth`)
