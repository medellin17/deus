# Agentic Orchestrator v2

Multi-agent оркестратор для OpenCode. 16 специализированных агентов, Knowledge Base, автоматическая оркестрация.

## Быстрый старт

```bash
npm install
npx tsx src/orchestrator.ts --cwd /path/to/project "задача"
```

При первом запуске автоматически:
- Копирует `.opencode/` (агенты + конфиг) в целевой проект
- Запускает `opencode serve` в целевой директории
- Индексирует проект в Knowledge Base
- Инжектит контекст перед планированием

## Режимы работы

| Команда | Что делает |
|---------|-----------|
| `npx tsx src/orchestrator.ts "задача"` | LLM-конductor выбирает пайплайн и dispatch-ит агентов |
| `--pipeline build "задача"` | Фиксированный пайплайн (researcher → architect → implementer → reviewer → qa) |
| `--agent implementer-builder "задача"` | Один агент |
| `--parallel "задача1" "задача2"` | Параллельное выполнение |
| `--index /path/to/project` | Ручная индексация в KB |
| `--kb-stats` | Статистика Knowledge Base |

## Архитектура

```
orchestrator.ts (CLI + SDK)
    ↓
opencode serve (HTTP API, порт 4096)
    ↓
┌─────────────────────────────────────────────┐
│  Conductor (orchestrator-conductor)         │
│  ├── researcher-explorer (исследование)     │
│  ├── architect-planner* (планирование)     │
│  ├── implementer-builder (реализация)       │
│  ├── reviewer-critic (ревью)                │
│  ├── integrator-qa (тестирование)           │
│  └── 11 других агентов                      │
└─────────────────────────────────────────────┘
    ↓
Knowledge Base (SQLite + FTS5)
    ├── Авто-индексация проекта
    ├── Контекст перед планированием
    └── Память между сессиями
```

## Модели

| Агент | Модель | Thinking |
|-------|--------|----------|
| orchestrator-conductor | `deepseek-v4-pro` | `max` |
| architect-planner-pro | `deepseek-v4-pro` | `max` |
| Остальные 14 | `deepseek-v4-flash` | `max` |

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
│       ├── schema.ts        # SQLite схема
│       ├── chunker.ts       # Чанкинг по Markdown заголовкам
│       ├── fts5.ts          # Keyword поиск
│       ├── embeddings.ts    # Gemini embeddings (3072 dim)
│       ├── memory-tree.ts   # Иерархические саммари
│       ├── search.ts        # Гибридный поиск
│       ├── super-context.ts # Авто-инжект контекста
│       ├── indexer.ts       # Индексация файлов
│       └── index.ts         # Public API
├── package.json
└── tsconfig.json
```

## Автоматика

| Что | Как |
|-----|-----|
| Копирование `.opencode/` | Автоматически при `--cwd` |
| Запуск `opencode serve` | Автоматически (auto-spawn) |
| Индексация проекта | Автоматически если KB пуста |
| Инжект контекста | Автоматически перед планированием |
| Сохранение результатов | Автоматически в memory tree |

## Knowledge Base

- **FTS5** — keyword поиск (BM25, zero dependencies)
- **Memory Tree** — иерархические саммари (file/module/project)
- **SuperContext** — авто-генерация контекста для задач
- **Per-project** — каждый проект имеет свою БД (`.agents/orchestrator.db`)

### Таблицы

| Таблица | Назначение |
|---------|-----------|
| `kb_documents` | Индексированные файлы |
| `kb_chunks` | Семантические чанки |
| `kb_chunks_fts` | FTS5 индекс |
| `kb_embeddings` | Векторные эмбеддинги |
| `kb_memory_tree` | Иерархические саммари |

## Переменные окружения

| Переменная | Назначение |
|------------|-----------|
| `OPENCODE_URL` | URL сервера (по умолчанию: `http://localhost:4096`) |
| `GEMINI_API_KEY` | Ключ для Gemini embeddings (для RAG) |

## Добавление агента

1. Создать `.opencode/agents/{name}.md`
2. Добавить в `VALID_AGENTS` в `src/orchestrator.ts`
3. Добавить в `.opencode/opencode.json` (если нужна своя модель)

## Требования

- Node.js 20+
- OpenCode CLI (`npm i -g opencode`)
- `GEMINI_API_KEY` (опционально, для embeddings)
