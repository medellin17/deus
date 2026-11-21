# Agentic Orchestrator v2: SDK-based Architecture

> Архитектурная документация multi-agent системы оркестрации для OpenCode.

---

## 1. Что нового в v2

### Ограничения v1

Версия v1 работала как **prompt-only** система — все 16 агентов и 23 skill'а определялись через `.md` файлы и конфигурацию `opencode.json`. Оркестрация выполнялась в рамках одной сессии OpenCode: пользователь запускал агента, тот вручную переключался между промптами, и результат зависел от качества написания каждого промпта.

**Ключевые ограничения v1:**

- Нет программного контроля — управление через текстовые инструкции
- Одна сессия на задачу — невозможно запустить параллельные пайплайны
- Нет мониторинга — невозможно отслеживать метрики агентов
- Нет повторяемости — каждый запуск зависит от контекста сессии

### Что добавляет v2

Версия v2 строится на **Node.js SDK** (`@opencode-ai/sdk`) и добавляет ключевые слои:

**1. Программная оркестрация** — скрипт `orchestrator.ts` управляет сессиями через API:
- Создание/форк сессий
- Отправка задач агентам
- Мониторинг статуса через polling
- Сбор и агрегация результатов

**2. Knowledge Base** — SQLite + FTS5 + Memory Tree + Smart Context для контекста между сессиями, авто-индексация, чекпоинты.
**3. Плагин мониторинга** — `orchestrator-monitor.ts` отслеживает lifecycle сессий:
- Хуки: `session.created`, `session.idle`, `session.error`
- Метрики: количество созданных/завершённых/упавших сессий
- Средняя длительность выполнения

**4. Три режима взаимодействия:**
- CLI скрипт (основной режим)
- Web-панель (в планах, через `opencode web`)
- Telegram-бот (в планах, через grammY/telegraf)

### Что остаётся без изменений

Все `.md` файлы агентов и skill'ов **копируются из v1 как есть**. Конфигурация `opencode.json` также не меняется. Новая версия — это надстройка, а не замена.

---

## 2. Архитектура

### Общая схема

```
┌─────────────────────────────────────────────────────────────┐
│  Пользователь                                                │
│  ┌──────┐  ┌──────────────┐  ┌───────────────┐               │
│  │ CLI  │  │ Web Panel    │  │ Telegram Bot  │               │
│  │      │  │ (future)     │  │ (future)      │               │
│  └──┬───┘  └──────┬───────┘  └───────┬───────┘               │
│     └─────────────┼──────────────────┘                        │
│                   ▼                                           │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  orchestrator.ts (Node.js SDK)                      │    │
│  │  • runOrchestrate() / runPipeline() / runParallel() │    │
│  │  • runDirect() / runDAG() / spawnSubOrchestrators() │    │
│  │  • --resume / --checkpoint / auto-resume loop       │    │
│  └──────────────┬───────────────────────────────────────┘    │
│                 │ HTTP (localhost:4096)                       │
│  ┌──────────────▼───────────────────────┐                    │
│  │  opencode serve                      │                    │
│  │  ┌─────────────────────────────────┐ │                    │
│  │  │ 18 агентов + sub-orchestrator  │ │                    │
│  │  │ 32 skills                       │ │                    │
│  │  │ Plugin: orchestrator-monitor    │ │                    │
│  │  └─────────────────────────────────┘ │                    │
│  └──────────────┬───────────────────────┘                    │
│                 ▼                                             │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Persistence (SQLite)                                 │  │
│  │  ┌────────────────────┐  ┌──────────────────────────┐ │  │
│  │  │ Knowledge Base     │  │ State DB                 │ │  │
│  │  │ • BM25 / FTS5      │  │ • tasks                  │ │  │
│  │  │ • Memory Tree      │  │ • task_nodes             │ │  │
│  │  │ • Embeddings (opt) │  │ • session_log            │ │  │
│  │  │ • Smart Context    │  │ • agent_stats            │ │  │
│  │  └────────────────────┘  └──────────────────────────┘ │  │
│  │  ┌────────────────────┐  ┌──────────────────────────┐ │  │
│  │  │ metrics.db         │  │ CheckpointManager        │ │  │
│  │  │ • sessions         │  │ • tasks.graph +          │ │  │
│  │  │ • metric counters  │  │   kb_memory_tree         │ │  │
│  │  └────────────────────┘  └──────────────────────────┘ │  │
│  └────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### Поток данных

```
Пользователь (CLI/Web/TG)
       │
       ▼
orchestrator.ts ──HTTP──▶ opencode serve ──▶ Агент (сессия)
       │                                         │
       │◀──────────── JSON ответ ────────────────┘
       │
       ▼
  Агрегация результатов
       │
       ▼
  Вывод пользователю
```

### Ключевые компоненты

| Компонент | Тип | Описание |
|---|---|---|
| `orchestrator.ts` | Скрипт | Оркестратор пайплайнов, CLI, управление сессиями, auto-resume |
| `opencode-client.ts` | Адаптер | Синглтон `@opencode-ai/sdk` |
| `DAGEngine` | Движок | Выполнение DAG графа: топология, параллелизм, retry, fallback |
| `TaskManager` / `StateDatabase` | State | SQLite-хранилище задач, нод, логов сессий, статистики агентов |
| `CheckpointManager` | State | Сохранение/загрузка чекпоинтов через Memory Tree + tasks |
| `RagKbProvider` | KB | Фасад Knowledge Base: индексация, поиск, Smart Context, embeddings |
| `orchestrator-monitor.ts` | Плагин | Мониторинг lifecycle сессий, сбор метрик |
| `metrics.ts` | Метрики | SQLite `metrics.db` для плагина |
| `opencode.json` | Конфиг | Модели и thinking для каждого агента |
| `agents/*.md` | Промпты | Определения 18 агентов (17 + sub-orchestrator) |
| `skills/*/SKILL.md` | Промпты | Определения 32 skill'ов |

---

## 3. Модели

### Распределение моделей

| Агент | Модель | thinking |
|---|---|---|
| `orchestrator-conductor` | `opencode-go/deepseek-v4-flash` | `reasoningEffort: max` |
| `architect-planner-pro` | `opencode-go/deepseek-v4-pro` | `reasoningEffort: max` |
| `reviewer-critic-pro` | `opencode-go/deepseek-v4-pro` | `reasoningEffort: max` |
| Остальные 16 агентов | `opencode-go/deepseek-v4-flash` | `reasoningEffort: max` |

### Почему два класса моделей

**Pro-модель** (`opencode-go/deepseek-v4-pro`) используется для high-stakes агентов:
- `architect-planner-pro` — проектирует архитектуру для сложных/критичных задач
- `reviewer-critic-pro` — ревьюит критичные участки (auth, payments, security)

**Базовая модель** (`opencode-go/deepseek-v4-flash`) используется для всех остальных агентов, включая `orchestrator-conductor`, `implementer-builder`, `reviewer-critic`, `researcher-explorer` и остальных.

### Особенность: адаптация промптов

Оркестратор **осознаёт разницу в capabilities** моделей. При отправке задач агенту на базовой модели он:
- Упрощает инструкции
- Добавляет больше контекста
- Разбивает сложные задачи на подзадачи
- Уточняет критерии успеха

Пример:

```
# Для architect-planner-pro (pro-модель)
"Спроектируй архитектуру payment шлюза с учётом PCI DSS"

# Для implementer-builder (базовая модель)
"Создай файл src/payment/gateway.ts:
 - Экспортируй функцию processPayment(amount, currency, cardToken)
 - Используй try/catch для обработки ошибок
 - Возвращай объект { success: boolean, transactionId?: string, error?: string }
 - Не хардкодь ключи — используй env vars"
```

---

## 4. Взаимодействие: три режима

### 4.1. CLI (основной режим)

Пользователь запускает скрипт из терминала:

```bash
npx tsx src/orchestrator.ts "Добавить OAuth2 в проект"
```

**Что делает скрипт:**

1. Подключается к OpenCode серверу через SDK
2. Анализирует задачу и выбирает пайплайн
3. Создаёт сессии для каждого агента
4. Отправляет задачи и мониторит прогресс
5. Агрегирует результаты
6. Выводит структурированный отчёт

**Пример вывода:**

```
$ npx tsx src/orchestrator.ts "Добавить OAuth2 в проект"

→ [orchestrator] Анализ задачи...
→ [orchestrator] Пайплайн: build-review
→ [session:abc123] researcher-explorer: исследование кодовой базы...
→ [session:def456] architect-planner-pro: проектирование OAuth2...
→ [orchestrator] Spot-check: чтение src/auth/...
→ [session:ghi789] implementer-builder: реализация...
→ [session:jkl012] reviewer-critic: ревью...
→ [session:mno345] integrator-qa: тестирование...

✅ Готово. Отчёт: data/tasks/oauth2/result.md
```

### 4.2. Web Panel (не реализовано)

> **Статус:** запланировано на будущее. В текущей версии Web Panel не реализована.

OpenCode предоставляет встроенный веб-интерфейс:

```bash
# Запуск сервера
opencode serve --port 4096

# Запуск веб-панели
opencode web
```

Веб-панель работает ** параллельно** со скриптом оркестратора:
- Скрипт управляет сессиями через SDK
- Веб-панель показывает все активные сессии
- Пользователь может читать сообщения агентов в реальном времени
- Веб-панель доступна только для чтения (мониторинг)

**Для кастомной веб-панели** (расширенной):

```typescript
// Пример Express.js сервера с SSE
import express from 'express';
import { OpenCodeClient } from '@opencode-ai/sdk';

const app = express();
const client = new OpenCodeClient('http://localhost:4096');

// SSE endpoint для real-time обновлений
app.get('/events', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  
  const events = await client.subscribe();
  events.on('session.update', (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  });
});

// Dashboard с метриками из плагина
app.get('/metrics', async (req, res) => {
  const metrics = await client.getPluginMetrics('orchestrator-monitor');
  res.json(metrics);
});
```

### 4.3. Telegram Bot (не реализовано)

> **Статус:** запланировано на будущее. В текущей версии Telegram Bot не реализован.

Telegram-бот работает как тонкая обёртка над скриптом оркестратора:

```
Пользователь ──▶ Telegram Bot ──▶ orchestrator.ts ──▶ OpenCode
     │                                        │
     │◀──────── Прогресс-обновления ─────────┘
     │◀──────── Итоговый отчёт ──────────────┘
```

**Реализация:**

```typescript
import { Bot } from 'grammy';
import { exec } from 'child_process';

const bot = new Bot(process.env.TELEGRAM_TOKEN!);

bot.command('task', async (ctx) => {
  const task = ctx.message.text.replace('/task ', '');
  
  // Запуск оркестратора как дочерний процесс
  const proc = exec(`npx tsx src/orchestrator.ts "${task}"`);
  
  // Стриминг прогресса в чат
  proc.stdout?.on('data', async (data) => {
    await ctx.reply(`⏳ ${data.toString().trim()}`);
  });
  
  // Итоговый отчёт
  proc.on('close', async () => {
    await ctx.reply('✅ Задача выполнена! Отчёт отправлен.');
  });
});
```

---

## 5. SDK Script: orchestrator.ts

Скрипт оркестратора — это **Node.js приложение**, использующее `@opencode-ai/sdk` для управления сессиями OpenCode.

### Ключевые функции

```typescript
// Типы
interface SessionResult {
  sessionId: string;
  agent: string;
  output: string;
  duration: number;
  status: 'success' | 'error';
}

interface PipelineStep {
  agent: string;
  task: string;
  timeout?: number;
}

// Основные функции
async function runSession(
  task: string,
  agent: string,
  timeout?: number
): Promise<SessionResult>

async function runPipeline(
  steps: PipelineStep[]
): Promise<SessionResult[]>

async function runParallel(
  tasks: Array<{ agent: string; task: string }>
): Promise<SessionResult[]>

async function runDirect(
  task: string,
  agent?: string
): Promise<SessionResult>
```

### Описание функций

**`runSession(task, agent, timeout)`** — создаёт сессию для одного агента:
- Создаёт сессию через SDK
- Отправляет промпт агенту
- Ждёт завершения (polling с интервалом 500ms)
- Возвращает результат с output и метриками

**`runPipeline(steps)`** — последовательное выполнение шагов:
- Каждый шаг — отдельная сессия
- Output предыдущего шага передаётся как контекст следующему
- Если шаг упал — пайплайн прерывается

**`runParallel(tasks)`** — параллельное выполнение:
- Все задачи запускаются одновременно через `Promise.all`
- Каждая задача — отдельная сессия
- Результаты агрегируются после завершения всех

**`runDirect(task, agent)`** — одиночная простая задача:
- Обёртка над `runSession` для быстрого вызова
- Агент по умолчанию — `implementer-builder`

### Обработка ошибок

```typescript
// Таймаут по умолчанию: 5 минут
const DEFAULT_TIMEOUT = 5 * 60 * 1000;

// Retry: до 2 попыток при transient ошибках
async function runWithRetry(fn: () => Promise<SessionResult>, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === retries) throw error;
      console.log(`Retry ${i + 1}/${retries}...`);
    }
  }
}
```

---

## 6. Plugin: orchestrator-monitor.ts

Плагин мониторинга отслеживает lifecycle сессий и собирает метрики. Расположен в `.opencode/plugins/orchestrator-monitor.ts`.

### Lifecycle hooks

| Хук | Описание |
|---|---|
| `session.created` | Новая сессия создана |
| `session.idle` | Сессия завершилась успешно |
| `session.error` | Сессия завершилась с ошибкой |
| `session.status` | Обновление статуса сессии |

### Метрики

```typescript
interface OrchestratorMetrics {
  totalCreated: number;      // Всего создано сессий
  totalCompleted: number;    // Успешно завершено
  totalFailed: number;       // Упало с ошибкой
  avgDuration: number;       // Средняя длительность (ms)
  activeSessions: number;    // Активные сессии сейчас
}
```

### Интеграция с SDK

```typescript
// Получение метрик из плагина
const metrics = await client.getPluginMetrics('orchestrator-monitor');
console.log(`Создано: ${metrics.totalCreated}`);
console.log(`Завершено: ${metrics.totalCompleted}`);
console.log(`Упало: ${metrics.totalFailed}`);
console.log(`Средняя длительность: ${metrics.avgDuration}ms`);
```

---

## 7. Миграция от v1

### Что остаётся без изменений

| Компонент | Статус |
|---|---|
| `agents/*.md` | Базовые промпты без изменений |
| `skills/*/SKILL.md` (32 skill'а) | Без изменений |
| `.opencode/opencode.json` | Без изменений |
| `.opencode/agents/*.md` | Без изменений |
| `.opencode/skills/*/SKILL.md` | Без изменений |

### Что добавляется

| Компонент | Файл |
|---|---|
| Оркестратор | `src/orchestrator.ts` |
| Плагин мониторинга | `plugins/orchestrator-monitor.ts` |
| Зависимости | `package.json` |

### Шаги миграции

```bash
# 1. Скопировать v1 агентов и skill'ов (уже сделано)
cp -r ../agentic-orchestrator-v1/agents ./
cp -r ../agentic-orchestrator-v1/skills ./
cp -r ../agentic-orchestrator-v1/.opencode ./

# 2. Установить SDK
npm install @opencode-ai/sdk

# 3. Запустить сервер
opencode serve --port 4096

# 4. Запустить оркестратор
npx tsx src/orchestrator.ts "ваша задача"
```

### Совместимость

v2 **полностью обратно совместим** с v1:
- Все агенты работают как раньше
- Все skill'ы доступны
- Конфигурация моделей сохранена
- Новые компоненты — дополнение, а не замена
- Добавлен суб-оркестратор для декомпозиции больших задач

---

## 8. Структура v2

```
agentic-orchestrator-v2/
├── .opencode/
│   ├── opencode.json              # Конфигурация моделей и thinking
│   ├── agents/                    # Промпты 18 агентов (17 + sub-orchestrator)
│   │   ├── orchestrator-conductor.md
│   │   ├── researcher-explorer.md
│   │   ├── architect-planner.md
│   │   ├── architect-planner-pro.md
│   │   ├── implementer-builder.md
│   │   ├── reviewer-critic.md
│   │   ├── reviewer-critic-pro.md
│   │   ├── integrator-qa.md
│   │   ├── debug.md
│   │   ├── doc-maintainer.md
│   │   ├── content-writer.md
│   │   ├── data-analyst.md
│   │   ├── ux-designer.md
│   │   ├── code-reviewer.md
│   │   ├── test-engineer.md
│   │   ├── security-auditor.md
│   │   ├── skills-indexer.md
│   │   └── sub-orchestrator.md
│   ├── tools/
│   │   └── search-code.ts         # Smart Context tool (built-in)
│   ├── plugins/
│   │   └── orchestrator-monitor.ts# Плагин мониторинга
│   └── skills/                    # Skill'ы
│       ├── agentic-orchestrator/
│       ├── code-verifier/
│       ├── ...                    # 32 skill'а
│       └── white-box-review-runner/
├── src/
│   ├── orchestrator.ts            # Оркестратор (CLI + SDK)
│   ├── types.ts                   # Типы SubOrchestratorReport и др.
│   ├── metrics.ts                 # Метрики из плагина мониторинга
│   ├── opencode-client.ts         # Адаптер над @opencode-ai/sdk
│   ├── dag/                       # DAG-движок
│   │   ├── engine.ts              # Выполнение графа
│   │   ├── types.ts               # TaskGraph, TaskNodeDefinition
│   │   └── index.ts
│   ├── state/                     # State DB
│   │   ├── schema.ts              # tasks, task_nodes, session_log, agent_stats
│   │   ├── task-manager.ts        # CRUD задач/нод/логов
│   │   └── index.ts
│   └── kb/                        # Knowledge Base (SQLite + FTS5)
│       ├── schema.ts              # SQLite схема
│       ├── chunker.ts             # Семантический чанкинг
│       ├── fts5.ts                # BM25 поиск
│       ├── embeddings.ts          # Gemini эмбеддинги
│       ├── memory-tree.ts         # Иерархические саммари
│       ├── search.ts              # Гибридный поиск
│       ├── super-context.ts       # Авто-инжект контекста
│       ├── indexer.ts             # Индексация файлов
│       ├── checkpoint.ts          # CheckpointManager
│       ├── index.ts               # Public API
│       └── smart-context/         # SmartContextEngine (built-in)
├── data/
│   └── tasks/                     # Результаты задач
├── package.json                   # Зависимости
├── AGENTS.md                      # Single source of truth по агентам
├── README.md
└── ARCHITECTURE.md                # Этот документ
```

---

## 9. Финальная сводка

### Сравнение версий

| Критерий | v1 (prompt-only) | v2 (SDK-based) | OpenHands |
|---|---|---|---|
| **Управление** | Промпты в .md файлах | Node.js SDK | Встроенный UI |
| **Сессии** | Одна на задачу | Множественные, программные | Неизвестно |
| **Параллелизм** | Нет | `runParallel()` | Неизвестно |
| **Мониторинг** | Нет | Плагин + метрики | Встроенный |
| **Повторяемость** | Низкая | Высокая | Средняя |
| **Режимы работы** | OpenCode UI | CLI (Web/TG — future) | Web UI |
| **Модели** | 2 класса (pro/base) | 2 класса (pro/base) | Зависит от конфига |
| **Агенты** | 16 | 18 (17 + sub-orchestrator) | Зависит от конфига |
| **Skill'ы** | 23 | 32 | Нет аналога |
| **DAG execution** | Нет | `DAGEngine` + `--dag` | Зависит от конфига |
| **State DB / checkpoints** | Нет | SQLite `tasks` + `kb_memory_tree` | Зависит от конфига |
| **Smart Context** | Нет | Встроен в KB | Зависит от конфига |

### Преимущества v2 перед v1

- **Программный контроль** — управление сессиями через API, а не промпты
- **Параллельные пайплайны** — возможность запускать нескольких агентов одновременно
- **Мониторинг** — метрики в реальном времени, трекинг ошибок
- **Множественные интерфейсы** — CLI (Web и Telegram — в планах)
- **Повторяемость** — один и тот же скрипт даёт предсказуемый результат

### Преимущества v2 перед OpenHands

- **Полный контроль** — доступ ко всем агентам и skill'ам через SDK
- **Гибкость** — можно создавать кастомные пайплайны
- **Интеграция** — работа с существующей инфраструктурой OpenCode
- **Прозрачность** — видно каждый шаг оркестрации

---

> Документ создан для Agentic Orchestrator v2.
> Актуально для версии с 18 агентами (17 + sub-orchestrator) и 32 skill'ами.
