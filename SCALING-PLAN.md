# План масштабирования оркестратора

> **Связанные планы:** [CONTEXT-OVERFLOW-PLAN.md](./CONTEXT-OVERFLOW-PLAN.md) — Phase 1 (Checkpoints) + Phase 2 (Sub-orchestrators)

Статус: **утверждено пользователем** (28.06.2026)

Цель: перейти от простых пайплайнов (3-5 агентов) к сложным задачам на десятки агентов
с отказоустойчивостью, контрольом бюджета, накопленным контекстом и real-time мониторингом.

---

## 1. SQLite State Manager

### Проблема
JSON-файлы для чекпоинтов:缓慢ий поиск при 100+ задачах, гонки при параллельном доступе, нет аналитики.

### Решение
SQLite вместо JSON-файлов. Один файл `.agents/orchestrator.db`, ACID, WAL mode.

### Схема БД

```sql
-- Задачи
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  status TEXT,              -- pending/running/completed/failed
  graph JSON,               -- DAG-определение (TaskGraph)
  config JSON,              -- бюджет, таймауты
  created_at INTEGER,
  completed_at INTEGER,
  total_cost REAL
);

-- Ноды (агенты внутри задачи)
CREATE TABLE task_nodes (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id),
  agent TEXT,
  status TEXT,              -- pending/running/completed/failed/skipped
  result TEXT,
  error TEXT,
  session_id TEXT,
  started_at INTEGER,
  completed_at INTEGER,
  cost REAL,
  retries INTEGER DEFAULT 0
);

-- История сессий (для аналитики)
CREATE TABLE session_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT,
  node_id TEXT,
  session_id TEXT,
  agent TEXT,
  model TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  cost REAL,
  duration_ms INTEGER,
  created_at INTEGER
);

-- Статистика агентов
CREATE TABLE agent_stats (
  agent TEXT PRIMARY KEY,
  total_runs INTEGER DEFAULT 0,
  total_cost REAL DEFAULT 0,
  avg_duration_ms REAL DEFAULT 0,
  success_rate REAL DEFAULT 1.0,
  last_used INTEGER
);
```

### Resume
```
Найдена незавершённая задача: task_2026-06-28_001
  Статус: running
  Завершено: 12/20 нод
  Стоимость: $3.20
  Продолжить? (y/n)
```

### Аналитика

```sql
-- Средняя стоимость агента
SELECT agent, AVG(cost), COUNT(*) FROM task_nodes
WHERE status = 'completed' GROUP BY agent;

-- Успешность агентов
SELECT agent,
  SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END)::FLOAT / COUNT(*) as success_rate
FROM task_nodes GROUP BY agent;
```

### Приоритет: **высокий** — база для всех остальных модулей

---

## 2. Knowledge Base (FTS5 + RAG + Memory Tree)

### Проблема
При каждом запуске задачи оркестратор "заново" знакомится с проектом. Нет накопленного контекста.
Агенты не знают прошлые задачи, архитектуру, паттерны.

### Решение
Гибридная база знаний: SQLite FTS5 (keyword) + Gemini embeddings (RAG) + Memory Tree (summaries).

### Архитектура

```
┌─────────────────────────────────────────────────────────────┐
│                    Knowledge Base                            │
│                                                              │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐   │
│  │  FTS5 Index  │    │  Embeddings  │    │ Memory Tree  │   │
│  │  (keyword)   │    │  (RAG)       │    │ (summaries)  │   │
│  └──────┬───────┘    └──────┬───────┘    └──────┬───────┘   │
│         │                   │                   │            │
│         └─────────┬─────────┘                   │            │
│                   ▼                             │            │
│         ┌─────────────────┐                     │            │
│         │  Search Engine  │◄────────────────────┘            │
│         │  (hybrid)       │                                  │
│         └────────┬────────┘                                  │
│                  │                                           │
│  ┌───────────────▼───────────────┐                          │
│  │      SuperContext Pipeline     │                          │
│  │  1. FTS5: точные совпадения   │                          │
│  │  2. RAG: семантика            │                          │
│  │  3. Memory Tree: обзор        │                          │
│  │  4. Ранжирование + top-k      │                          │
│  └───────────────┬───────────────┘                          │
│                  │                                           │
│  ┌───────────────▼───────────────┐                          │
│  │      Context Injector          │                          │
│  │  • Для оркестратора (авто)     │                          │
│  │  • Для воркеров (on-demand)    │                          │
│  └───────────────────────────────┘                          │
└─────────────────────────────────────────────────────────────┘
```

### Схема БД (дополнение к SQLite State)

```sql
-- Документы (для FTS5)
CREATE VIRTUAL TABLE kb_documents USING fts5(
  path UNINDEXED,
  title,
  content,
  category UNINDEXED,
  updated_at UNINDEXED,
  tokenize='porter unicode61'
);

-- Чанки (метаданные)
CREATE TABLE kb_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  token_count INTEGER NOT NULL,
  level INTEGER NOT NULL,        -- глубина заголовка (1=H1, 2=H2...)
  sort_order INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Эмбеддинги (для RAG)
CREATE TABLE kb_embeddings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chunk_id INTEGER REFERENCES kb_chunks(id) ON DELETE CASCADE,
  model TEXT NOT NULL DEFAULT 'gemini-embedding-2',
  dimension INTEGER NOT NULL DEFAULT 3072,
  embedding BLOB NOT NULL,       -- Float32Array
  created_at INTEGER NOT NULL
);

-- Memory Tree (иерархические саммари)
CREATE TABLE kb_memory_tree (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  level TEXT NOT NULL,           -- 'file' | 'section' | 'project'
  summary TEXT NOT NULL,         -- саммари (≤500 токенов)
  token_count INTEGER NOT NULL,
  parent_id INTEGER REFERENCES kb_memory_tree(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Индексы
CREATE INDEX idx_chunks_path ON kb_chunks(path);
CREATE INDEX idx_embeddings_chunk ON kb_embeddings(chunk_id);
CREATE INDEX idx_memory_parent ON kb_memory_tree(parent_id);
```

### Chunking (семантический, по Markdown заголовкам)

1. Парсим Markdown → дерево заголовков (H1-H6)
2. Группируем чанки по H2/H3 секциям
3. Если секция > 3k токенов → разбиваем по H4/абзацам
4. Если секция < 500 токенов → объединяем с соседней
5. Каждый чанк: `{ path, title, content, level, token_count }`

### Модули

| # | Модуль | Описание |
|---|--------|----------|
| 1 | `src/kb/schema.ts` | Типы + SQL миграции |
| 2 | `src/kb/chunker.ts` | Markdown → semantic chunks |
| 3 | `src/kb/fts5.ts` | FTS5 индексация + BM25 поиск |
| 4 | `src/kb/embeddings.ts` | Gemini Embedding API (`gemini-embedding-2`, 3072 dim) |
| 5 | `src/kb/memory-tree.ts` | Авто-генерация саммари через мелкую модель |
| 6 | `src/kb/search.ts` | Hybrid search (FTS5 + RAG) |
| 7 | `src/kb/super-context.ts` | Auto-context pipeline |
| 8 | `src/kb/indexer.ts` | Индексация файлов проекта |
| 9 | `src/kb/index.ts` | Public API |

### SuperContext Pipeline

```typescript
async getSuperContext(task: string): Promise<SuperContext> {
  // 1. FTS5: точные совпадения
  const ftsResults = await this.fts5Search(task, { topK: 10 });

  // 2. RAG: семантический поиск
  const ragResults = await this.ragSearch(task, { topK: 10 });

  // 3. Объединение и ранжирование
  const merged = this.mergeResults(ftsResults, ragResults);

  // 4. Memory Tree: обзор проекта
  const overview = await this.getProjectOverview();

  // 5. Формирование контекста (≤ 3k токенов)
  return {
    projectOverview: overview,
    relevantDocs: merged.slice(0, 5),
    similarTasks: [],
    totalTokens: this.countTokens(merged)
  };
}
```

### Интеграция с оркестратором

```
Задача → Оркестратор
         │
         ├─ SuperContext: FTS5 + RAG → контекст проекта (авто)
         ├─ Планирование DAG
         │
         └─ Dispatch воркеров:
              ├─ Воркер 1: промпт + релевантный контекст из KB
              ├─ Воркер 2: промпт + релевантный контекст
              └─ ...
```

### Инструменты

- **FTS5:** SQLite встроенный (zero dependencies, BM25 ranking)
- **RAG:** Gemini Embedding API (`gemini-embedding-2`, 3072 dimensions, auto-normalization)
- **Memory Tree:** Мелкая модель (gemini-2.0-flash / gpt-4o-mini) для саммари ≤500 токенов

### Приоритет: **высокий** — реализовать параллельно с SQLite State

---

## 3. DAG (Directed Acyclic Graph)

### Проблема
Сейчас `runPipeline` — только линейная последовательность, `runParallel` — все сразу.
Нет возможности выразить зависимости типа "2 researcher-а параллельно, потом analyst агрегирует".

### Решение
Граф зависимостей вместо линейных цепочек.

```typescript
interface TaskNode {
  id: string;
  agent: string;
  prompt: string | ((results: Map<string, string>) => string);
  dependsOn: string[];
  retry?: number;
  fallbackAgent?: string;
  timeout?: number;
}

interface TaskGraph {
  id: string;
  nodes: TaskNode[];
  config: OrchestratorConfig;
}
```

### Пример графа

```
         ┌─ researcher-langchain ─┐
start ───┼─ researcher-crewai   ──┼─── analyst ────┬── reviewer-ux ──┐
         └─ researcher-mcp      ──┘                └── reviewer-perf ─┘
                                                            │
                                                     implementer
                                                            │
                                                       integrator-qa
```

### Алгоритм
1. Топологическая сортировка графа (Kahn's algorithm)
2. Запуск нод с `dependsOn === []` параллельно
3. По завершении ноды — проверить, можно ли запустить следующие
4. Передавать результаты зависимостей в `prompt` через функцию
5. При ошибке ноды — retry или fallback, пометить как failed
6. Если критическая нода упала — прервать граф

### Приоритет: **высокий** — основа для масштабирования

---

## 4. Agent-as-Worker паттерн

### Проблема
Сейчас оркестратор сам обрабатывает результаты каждого агента. При 30+ агентах
оркестратор будет перегружен контекстом.

### Решение
Оркестратор только **назначает воркеров** и **агрегирует результаты**.
Каждый воркер — изолированная сессия со своей задачей.

```typescript
const researchResults = await Promise.all([
  runWorker({ agent: "researcher-explorer", prompt: "Исследуй LangChain" }),
  runWorker({ agent: "researcher-explorer", prompt: "Исследуй CrewAI" }),
  runWorker({ agent: "researcher-explorer", prompt: "Исследуй MCP" }),
]);

const summary = await runWorker({
  agent: "content-writer",
  prompt: `Объедини:\n${researchResults.map(r => r.text).join("\n---\n")}`
});
```

### Sub-Orchestrators (Phase 2 контекст-оверфлоу)

> **Детальная спецификация:** [CONTEXT-OVERFLOW-PLAN.md](./CONTEXT-OVERFLOW-PLAN.md) — Phase 2

Sub-orchestrator'ы решают две проблемы:
1. **Контекстный бюджет** — каждая подзадача в своей сессии, контекст не смешивается
2. **Параллелизм** — независимые домены выполняются одновременно

Зависимость: Phase 1 (Checkpoints) → Phase 2 → DAG Engine.

Sub-Orchestrator при переполнении контекста использует Phase 1 (чекпоинты) внутри своей сессии.

### Иерархические подоркестраторы (для 50+ агентов)

```
Глобальный оркестратор (mimo-v2.5-pro)
├── Research-оркестратор (10 агентов)
│   ├── researcher-explorer × 5
│   ├── content-writer × 3
│   └── reviewer-critic × 2
├── Code-оркестратор (15 агентов)
│   ├── implementer-builder × 8
│   ├── integrator-qa × 4
│   └── reviewer-critic × 3
├── Review-оркестратор (5 агентов)
└── Deploy-оркестратор (3 агента)
```

### Приоритет: **высокий**

---

## 5. Retry и fallback

### Проблема
При ошибке агента (таймаут, модель упала, context limit) — вся задача ломается.

### Решение
Автоматические повторы и запасные агенты.

```typescript
interface RetryConfig {
  retries: number;        // макс. попыток (default 2)
  backoff: "fixed" | "exponential";
  fallbackAgent?: string;
  timeout: number;
}
```

### Логика
```
Нода "researcher" упала:
  → retry 1/2 (через 5 сек)
  → retry 2/2 (через 10 сек)
  → fallback на "content-writer" (если указан)
  → пометить как failed, продолжить граф
```

### Приоритет: **высокий** — реализовать вместе с DAG

---

## 6. Budget-aware orchestration

### Проблема
Крупные задачи могут стоить $5-50. Нет контроля над расходами.

### Решение
Бюджетный контроль на уровне оркестратора.

```typescript
interface OrchestratorConfig {
  maxCost: number;
  maxConcurrent: number;
  costPerAgent: Record<string, number>;
  onCostUpdate: (total: number) => void;
  onBudgetWarning: (percent: number) => void; // 50%, 80%, 95%
}
```

### Поведение при достижении лимита
- **50%**: предупреждение в лог/Telegram
- **80%**: снижение параллелизма
- **95%**: прерывание, сохранение состояния, уведомление
- **100%**: полная остановка

### Статус: **записать, пока не нужно**

---

## 7. Real-time мониторинг

### Проблема
При 30+ агентах непонятно, что происходит. Нет прогресса.

### Решение
Два канала: Telegram (легко) + Web-панель (удобно, потом).

### Telegram (первичный канал)

```typescript
interface ProgressUpdate {
  taskId: string;
  phase: string;
  completed: number;
  total: number;
  currentAgent: string;
  cost: number;
  eta: number;
  errors: string[];
}

// Формат:
// 🔨 Build pipeline: 12/20 агентов
// 📊 Бюджет: $3.20 / $10.00
// ⏱ ETA: ~8 мин
// ❌ implementer-builder: retry 2/3
```

### Web-панель (потом)

- React + WebSocket
- DAG визуализация (n8n-style)
- Живые метрики

### Приоритет: **Telegram — средний, Web — низкий**

---

## 8. Итоговая архитектура

```
orchestrator-cli
├── SQLite State        # задачи, ноды, аналитика
├── Knowledge Base      # FTS5 + RAG + Memory Tree
│   ├── FTS5 Index      # keyword search (BM25)
│   ├── Embeddings      # Gemini (3072 dim)
│   └── Memory Tree     # hierarchical summaries
├── Checkpoint Manager  # COF Phase 1: чекпоинты + resume
├── DAG Engine          # топологическая сортировка, выполнение
├── Worker Pool         # пул параллельных сессий
├── Retry Engine        # повторы, fallback
├── Budget Controller   # контроль стоимости
├── Monitor             # Telegram + Web (потом)
└── Sub-Orchestrators   # COF Phase 2: иерархия для 50+ агентов
```

### Порядок реализации

| # | Модуль | Сложность | Приоритет | Зависит от |
|---|--------|-----------|-----------|------------|
| 1a | SQLite State Manager | средняя | высокий | — |
| 1b | Knowledge Base (FTS5) | средняя | высокий | SQLite |
| 1c | Knowledge Base (RAG + Gemini) | средняя | высокий | SQLite |
| 1d | Knowledge Base (Memory Tree) | средняя | высокий | SQLite, LLM |
| 1e | SuperContext Pipeline | средняя | высокий | FTS5 + RAG |
| 1f | Checkpoints (COF Phase 1) | средняя | высокий | SQLite |
| 2 | DAG Engine | высокая | высокий | SQLite, Checkpoints |
| 3 | Retry + fallback | средняя | высокий | SQLite |
| 4 | Agent-as-Worker | средняя | высокий | DAG |
| 5 | Budget controller | низкая | записать | SQLite |
| 6 | Telegram monitor | средняя | средний | — |
| 7 | Sub-orchestrators (COF Phase 2) | высокая | высокий | DAG, SQLite, KB, Checkpoints |
| 8 | Web-панель | высокая | низкий | — |

---

## 9. Примеры сценариев

### Сценарий A: "Сделай лендинг для стартапа" (20 агентов)

```
plan-creator
├── ux-designer × 3        (параллельно: layout, copy, brand)
├── implementer-builder × 5 (параллельно: components, pages, styles)
├── integrator-qa × 2      (параллельно: visual, functional)
├── reviewer-critic × 2    (параллельно: UX review, code review)
├── implementer-builder × 3 (fix по замечаниям)
└── integrator-qa × 1      (финальная проверка)
```

### Сценарий B: "Аудит безопасности проекта" (30 агентов)

```
security-auditor
├── project-code-auditor × 5     (по модулям параллельно)
├── module-security-scanner × 10 (глубокий скан каждого модуля)
├── peer-reviewer × 5            (валидация находок)
├── implementer-builder × 5      (фикс уязвимостей)
└── integrator-qa × 5            (проверка фиксов)
```

### Сценарий C: "Напиши документацию" (15 агентов)

```
doc-scaffold
├── researcher-explorer × 3    (параллельно: API, architecture, examples)
├── content-writer × 5         (параллельно: разделы документации)
├── reviewer-critic × 3        (параллельно: review каждого раздела)
├── content-writer × 2         (доработка по замечаниям)
└── integrator-qa × 2          (сборка + проверка ссылок)
```
