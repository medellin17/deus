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

Версия v2 строится на **Node.js SDK** (`@opencode-ai/sdk`) и добавляет три ключевых слоя:

**1. Программная оркестрация** — скрипт `orchestrator.ts` управляет сессиями через API:
- Создание/форк сессий
- Отправка задач агентам
- Мониторинг статуса через polling
- Сбор и агрегация результатов

**2. Плагин мониторинга** — `orchestrator-monitor.ts` отслеживает lifecycle сессий:
- Хуки: `session.created`, `session.idle`, `session.error`
- Метрики: количество созданных/завершённых/упавших сессий
- Средняя длительность выполнения

**3. Три режима взаимодействия:**
- CLI скрипт (основной режим)
- Web-панель (опционально, через `opencode web`)
- Telegram-бот (опционально, через grammY/telegraf)

### Что остаётся без изменений

Все `.md` файлы агентов и skill'ов **копируются из v1 как есть**. Конфигурация `opencode.json` также не меняется. Новая версия — это надстройка, а не замена.

---

## 2. Архитектура

### Общая схема

```
┌─────────────────────────────────────────────────────────────┐
│  Пользователь                                                │
│  ┌──────┐  ┌──────────┐  ┌─────────────┐                    │
│  │ CLI  │  │ Web Panel│  │ Telegram Bot│                    │
│  └──┬───┘  └────┬─────┘  └──────┬──────┘                    │
│     └───────────┼───────────────┘                            │
│                 ▼                                             │
│  ┌──────────────────────────────────┐                        │
│  │  orchestrator.ts (Node.js SDK)  │                        │
│  │  • runPipeline()                │                        │
│  │  • runParallel()                │                        │
│  │  • runSequential()              │                        │
│  │  • runDirect()                  │                        │
│  └──────────────┬───────────────────┘                        │
│                 │ HTTP (localhost:4096)                       │
│  ┌──────────────▼───────────────────┐                        │
│  │  opencode serve                  │                        │
│  │  ┌─────────────────────────────┐ │                        │
│  │  │ 16 агентов (из v1)         │ │                        │
│  │  │ 23 skills (из v1)          │ │                        │
│  │  │ Plugin: orchestrator-      │ │                        │
│  │  │   monitor                  │ │                        │
│  │  └─────────────────────────────┘ │                        │
│  └──────────────────────────────────┘                        │
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
| `orchestrator.ts` | Скрипт | Оркестратор пайплайнов, управление сессиями |
| `orchestrator-monitor.ts` | Плагин | Мониторинг lifecycle сессий, сбор метрик |
| `opencode.json` | Конфиг | Модели и thinking для каждого агента |
| `agents/*.md` | Промпты | Определения 16 агентов |
| `skills/*/SKILL.md` | Промпты | Определения 23 skill'ов |

---

## 3. Модели

### Распределение моделей

| Агент | Модель | thinking |
|---|---|---|
| `orchestrator-conductor` | `opencode-go/mimo-v2.5-pro` | `reasoningEffort: high` |
| `architect-planner-pro` | `opencode-go/mimo-v2.5-pro` | `reasoningEffort: high` |
| Остальные 14 агентов | `opencode-go/mimo-v2.5` | (default) |

### Почему два класса моделей

**Pro-модель** (`mimo-v2.5-pro`) используется для агентов, принимающих стратегические решения:
- `orchestrator-conductor` — декомпозирует задачи, выбирает пайплайны, проверяет результаты
- `architect-planner-pro` — проектирует архитектуру для сложных/критичных задач

**Базовая модель** (`mimo-v2.5`) используется для агентов, выполняющих конкретную работу:
- `implementer-builder` — пишет код
- `reviewer-critic` — ревьюит код
- `researcher-explorer` — исследует кодовую базу
- Все остальные агенты

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

### 4.2. Web Panel (опционально)

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

### 4.3. Telegram Bot (опционально)

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

Плагин мониторинга отслеживает lifecycle сессий и собирает метрики.

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
| `agents/*.md` (16 файлов) | Без изменений |
| `skills/*/SKILL.md` (23 файла) | Без изменений |
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

---

## 8. Структура v2

```
agentic-orchestrator-v2/
├── .opencode/
│   ├── opencode.json              # Конфигурация моделей и thinking
│   ├── agents/                    # Промпты агентов (из v1)
│   │   ├── orchestrator-conductor.md
│   │   ├── researcher-explorer.md
│   │   ├── architect-planner.md
│   │   ├── architect-planner-pro.md
│   │   ├── implementer-builder.md
│   │   ├── reviewer-critic.md
│   │   ├── integrator-qa.md
│   │   ├── debug.md
│   │   ├── doc-maintainer.md
│   │   ├── content-writer.md
│   │   ├── data-analyst.md
│   │   ├── ux-designer.md
│   │   ├── code-reviewer.md
│   │   ├── test-engineer.md
│   │   ├── security-auditor.md
│   │   └── skills-indexer.md
│   └── skills/                    # Skill'ы (из v1)
│       ├── agentic-orchestrator/
│       ├── architecture-security-reviewer/
│       ├── architecture-update/
│       ├── code-verifier/
│       ├── commit-reviewer/
│       ├── deep-auditor/
│       ├── doc-audit/
│       ├── doc-pruner/
│       ├── doc-scaffold/
│       ├── doc-transfer/
│       ├── doc-update/
│       ├── multi-agent-scanner/
│       ├── peer-reviewer/
│       ├── plan-creator/
│       ├── plan-intent-validator/
│       ├── plan-refiner/
│       ├── plan-reviewer/
│       ├── project-code-auditor/
│       ├── security-prompt-crafter/
│       ├── skill-creator/
│       ├── skills-indexer/
│       ├── white-box-review-runner/
│       └── ...
├── agents/                        # Агенты (исходники, из v1)
├── skills/                        # Skill'ы (исходники, из v1)
├── src/
│   └── orchestrator.ts            # Оркестратор (НОВОЕ)
├── plugins/
│   └── orchestrator-monitor.ts    # Плагин мониторинга (НОВОЕ)
├── data/
│   └── tasks/                     # Результаты задач
├── package.json                   # Зависимости (НОВОЕ)
├── ARCHITECTURE.md                # Этот документ
└── README.md
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
| **Режимы работы** | OpenCode UI | CLI + Web + Telegram | Web UI |
| **Модели** | 2 класса (pro/base) | 2 класса (pro/base) | Зависит от конфига |
| **Агенты** | 16 | 16 | Зависит от конфига |
| **Skill'ы** | 23 | 23 | Нет аналога |

### Преимущества v2 перед v1

- **Программный контроль** — управление сессиями через API, а не промпты
- **Параллельные пайплайны** — возможность запускать нескольких агентов одновременно
- **Мониторинг** — метрики в реальном времени, трекинг ошибок
- **Множественные интерфейсы** — CLI, Web, Telegram
- **Повторяемость** — один и тот же скрипт даёт предсказуемый результат

### Преимущества v2 перед OpenHands

- **Полный контроль** — доступ ко всем агентам и skill'ам через SDK
- **Гибкость** — можно создавать кастомные пайплайны
- **Интеграция** — работа с существующей инфраструктурой OpenCode
- **Прозрачность** — видно каждый шаг оркестрации

---

> Документ создан для Agentic Orchestrator v2.
> Актуально для версии с 16 агентами и 23 skill'ами.
