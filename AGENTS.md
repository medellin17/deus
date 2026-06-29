# AGENTS.md — Agentic Orchestrator v2

## Обзор

Multi-agent оркестратор на базе OpenCode SDK. Управляет 16 агентами через HTTP API, имеет встроенную Knowledge Base (SQLite + FTS5) для контекста между сессиями.

**Стек:** TypeScript, @opencode-ai/sdk, better-sqlite3, Node.js 20+, tsx

## Модели

| Агент | Модель | Thinking |
|-------|--------|----------|
| orchestrator-conductor | `opencode-go/deepseek-v4-pro` | `reasoningEffort: "max"` |
| architect-planner-pro | `opencode-go/deepseek-v4-pro` | `reasoningEffort: "max"` |
| Остальные 14 агентов | `opencode-go/deepseek-v4-flash` | `reasoningEffort: "max"` |

## Структура

```
agentic-orchestrator-v2/
├── .opencode/
│   ├── opencode.json        # Модели + thinking
│   ├── agents/              # 16 агентов (.md промпты)
│   └── skills/              # 23 skills
├── src/
│   ├── orchestrator.ts      # Основной скрипт
│   └── kb/                  # Knowledge Base
│       ├── schema.ts        # SQLite: documents, chunks, FTS5, embeddings, memory_tree
│       ├── chunker.ts       # Семантический чанкинг по Markdown заголовкам
│       ├── fts5.ts          # Keyword поиск (BM25)
│       ├── embeddings.ts    # Gemini gemini-embedding-2 (3072 dim)
│       ├── memory-tree.ts   # Иерархические саммари (file/module/project)
│       ├── search.ts        # Гибридный поиск (FTS5 + memory tree)
│       ├── super-context.ts # Авто-инжект контекста
│       ├── indexer.ts       # Индексация файлов проекта
│       └── index.ts         # Public API
├── package.json
└── tsconfig.json
```

## Запуск

```bash
# Оркестрация (LLM-конductor сам выбирает пайплайн)
npx tsx src/orchestrator.ts --cwd ../target-project "задача"

# Статический пайплайн
npx tsx src/orchestrator.ts --cwd ../target-project --pipeline build "задача"

# Один агент
npx tsx src/orchestrator.ts --cwd ../target-project --agent researcher-explorer "задача"

# Индексация проекта в KB
npx tsx src/orchestrator.ts --index ../target-project

# Статистика KB
npx tsx src/orchestrator.ts --kb-stats --cwd ../target-project
```

## Автоматика

При запуске с `--cwd`:
1. Копирует `.opencode/` в целевой проект (если нет)
2. Запускает `opencode serve` в целевой директории
3. Если KB пуста — индексирует проект
4. Инжектит контекст из KB перед планированием
5. После завершения — сохраняет результат в memory tree

## Агенты (16)

### Оркестрация
- `orchestrator-conductor` — главный дирижёр, декомпозирует, dispatch-ит, spot-check
- `architect-planner` — базовый архитектор
- `architect-planner-pro` — продвинутый архитектор (deepseek-v4-pro)

### Разработка
- `implementer-builder` — пишет код
- `integrator-qa` — тестирование
- `debug` — диагностика багов

### Исследование
- `researcher-explorer` — анализ кодовой базы
- `content-writer` — тексты, документация
- `data-analyst` — анализ данных

### Ревью
- `reviewer-critic` — код-ревью
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
| `build-pro` | researcher → architect-pro → implementer → reviewer → qa |
| `audit` | security → code-reviewer → reviewer |
| `debug` | researcher → debug → implementer → qa |
| `docs` | researcher → content-writer → reviewer |

## Knowledge Base

- **FTS5** — keyword поиск по BM25 (zero dependencies)
- **Memory Tree** — иерархические саммари (file/module/project)
- **SuperContext** — авто-инжект контекста перед планированием
- **Embeddings** — Gemini `gemini-embedding-2` (3072 dim, требует `GEMINI_API_KEY`)

### Таблицы SQLite

| Таблица | Назначение |
|---------|-----------|
| `kb_documents` | Индексированные файлы |
| `kb_chunks` | Семантические чанки (по заголовкам) |
| `kb_chunks_fts` | FTS5 виртуальная таблица |
| `kb_embeddings` | Векторные эмбеддинги |
| `kb_memory_tree` | Иерархические саммари |

## Добавление агента

1. Создать `.opencode/agents/{name}.md` с промптом
2. Добавить в `VALID_AGENTS` в `src/orchestrator.ts`
3. Добавить в `.opencode/opencode.json` (если нужна своя модель)

## Ограничения

- Windows: скрипт использует PowerShell
- Сервер: `opencode serve` должен быть запущен (auto-spawn)
- `.opencode/` копируется автоматически при `--cwd`
- БД: `.agents/orchestrator.db` — per-project, не коммитить в git
