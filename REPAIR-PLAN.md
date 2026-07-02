# REPAIR-PLAN.md — Agentic Orchestrator v2 Deus

> Этот план предназначен для исполнения оркестратором. Каждая стадия — самодостаточный модуль работы с чётким входом, выходом и критериями готовности. Стадии 1.x и 2.x могут выполняться параллельно, если не указано иное.

## Цель

Поднять проект с текущего состояния (~6–7/10) до production-ready (~8.5/10), устранив:

1. Хрупкую интеграцию с OpenCode SDK (`as any` / `as unknown as`).
2. Нерабочий plugin `orchestrator-monitor.ts`.
3. Зависимость от локального пакета `smart-context-retrieving` через `file:../`.
4. Документационный дрейф и дублирование.
5. Слабое покрытие тестами.

## Исключения

- `disable-model-invocation: true` в `.opencode/skills/agentic-orchestrator/SKILL.md` — не трогаем. Skill вызывается через `skill()` в conductor/sub-orchestrator.

## Карта стадий

```
Этап 1. Plugin orchestrator-monitor
  ├── Stage 1.1 — Переписать plugin под официальный API @opencode-ai/plugin
  ├── Stage 1.2 — Зарегистрировать plugin и добавить CLI --metrics
  └── Stage 1.3 — Написать тесты на plugin

Этап 2. Smart Context в KB
  ├── Stage 2.1 — Мигрировать core smart-context код в src/kb/smart-context/
  ├── Stage 2.2 — Переписать DB layer на общую SQLite KB
  ├── Stage 2.3 — Расширить KbProvider методом searchCode()
  ├── Stage 2.4 — Переписать .opencode/tools/search-code.ts
  └── Stage 2.5 — Удалить внешнюю зависимость smart-context-retrieving

Этап 3. Инфраструктура и документация
  ├── Stage 3.1 — Синхронизировать документацию и убрать дубли
  ├── Stage 3.2 — Убрать as any / as unknown as, добавить typecheck/lint
  └── Stage 3.3 — Финальная валидация
```

---

## Этап 1. Plugin orchestrator-monitor

### Stage 1.1. Переписать plugin под официальный API

**Вход:**
- `plugins/orchestrator-monitor.ts` (текущий, с самодельным `type Plugin`).
- `.opencode/node_modules/@opencode-ai/plugin/dist/index.d.ts` (официальные типы).
- `.opencode/node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts` (типы `Event`, `Session`, `SessionStatus`).

**Задачи:**
1. Создать/переписать `.opencode/plugins/orchestrator-monitor.ts`.
2. Использовать официальный API:
   ```ts
   import { plugin } from "@opencode-ai/plugin";
   import type { Event, Session } from "@opencode-ai/sdk";

   export default plugin(async (input, options) => {
     return {
       event: async ({ event }) => { /* handle Event */ },
       "tool.execute.before": async ({ tool, sessionID }) => { /* log */ },
       "tool.execute.after": async ({ tool, sessionID }) => { /* log */ },
     };
   });
   ```
3. Внутри `event` switch по `event.type`:
   - `session.created` → `metrics.totalCreated++`, `metrics.activeSessions++`, сохранить `agent`/`task` из `event.properties.info.title`.
   - `session.updated` → обновить agent/task.
   - `session.status` → при `completed`/`failed`/`errored` зафиксировать длительность и обновить `avgDurationMs`.
   - `session.idle` → debug log.
   - `session.error` → `metrics.totalFailed++`.
   - `session.deleted` → удалить из active sessions.
4. Хранить metrics в SQLite (`.deus/kb/metrics.db`) вместо in-memory `Map`, чтобы метрики переживали перезапуск.
5. Экспортировать `getMetrics()` / `getSessions()` из `src/metrics.ts` (новый файл), который читает из БД.

**Выход:**
- `.opencode/plugins/orchestrator-monitor.ts` — рабочий plugin.
- `src/metrics.ts` — чтение/запись метрик.
- `src/metrics-schema.ts` — схема SQLite для метрик (опционально, можно в `src/state/schema.ts`).

**Критерий готовности:**
- `npm run typecheck` проходит для `.opencode/plugins/orchestrator-monitor.ts`.
- Нет самодельного `type Plugin`.

---

### Stage 1.2. Зарегистрировать plugin и добавить CLI `--metrics`

**Вход:**
- Результат Stage 1.1.
- `src/orchestrator.ts`.
- `.opencode/opencode.json`.

**Задачи:**
1. Добавить в `.opencode/opencode.json`:
   ```json
   "plugin": ["./plugins/orchestrator-monitor.ts"]
   ```
2. В `package.json` добавить `@opencode-ai/plugin` в `devDependencies` (для typecheck).
3. В `src/orchestrator.ts` добавить режим `--metrics`:
   - `npx tsx src/orchestrator.ts --metrics --cwd <project>`
   - Читает метрики из `src/metrics.ts` и печатает JSON/таблицу.
4. Убедиться, что plugin path резолвится относительно `.opencode/`.
5. Если OpenCode server уже запущен — логировать предупреждение, что plugin требует перезапуска сервера.

**Выход:**
- `.opencode/opencode.json` с `plugin".
- `src/orchestrator.ts` с режимом `--metrics`.
- Обновлённый `package.json`.

**Критерий готовности:**
- `opencode serve` загружает plugin без ошибок (проверить логи сервера).
- `npx tsx src/orchestrator.ts --metrics --cwd <project>` выводит актуальные метрики.

---

### Stage 1.3. Написать тесты на plugin

**Вход:**
- Результат Stage 1.1–1.2.

**Задачи:**
1. Создать `src/__tests__/metrics.test.ts`:
   - Эмулировать `EventSessionCreated`, `EventSessionStatus`, `EventSessionError`, `EventSessionDeleted`.
   - Проверить, что `totalCreated`, `activeSessions`, `totalCompleted`, `totalFailed` корректно обновляются.
   - Проверить расчёт `avgDurationMs`.
2. Создать `src/__tests__/orchestrator-monitor-plugin.test.ts`:
   - Проверить, что plugin возвращает hooks `event`, `tool.execute.before`, `tool.execute.after`.

**Выход:**
- Тесты для metrics и plugin.

**Критерий готовности:**
- `npm test` проходит.

---

## Этап 2. Smart Context в KB

### Stage 2.1. Мигрировать core smart-context код

**Вход:**
- `C:/Users/gleb7/OneDrive/Рабочий стол/vibecoding/Project-Systems/smart-context-retrieving/src/`.
- `src/kb/` в Deus.

**Задачи:**
1. Создать директорию `src/kb/smart-context/`.
2. Скопировать и адаптировать только core-модули:
   - `indexer.ts`
   - `scanner.ts`
   - `tokenizer.ts`
   - `query-parser.ts`
   - `search.ts`
   - `search-strategies/` (bm25, symbol, import, path, utils)
   - `graph.ts`
   - `ranker.ts`
   - `context-assembler.ts`
   - `budget.ts`
   - `extractors/` (regex, treesitter, common)
   - `types.ts`
   - `constants.ts`
   - `config.ts`
3. Удалить CLI/MCP/utility зависимости:
   - Убрать `commander`.
   - Убрать `@modelcontextprotocol/sdk`.
   - Убрать ссылки на `cli/`, `mcp-server.ts`, `sessions.ts`, `feedback.ts`, `install.ts`, `hook.ts`, `benchmark.ts`.
4. Сделать `web-tree-sitter` опциональным:
   - Попытаться динамически импортировать; при неудаче использовать regex extractor.
   - Не добавлять `web-tree-sitter` в обязательные `dependencies`.

**Выход:**
- `src/kb/smart-context/*.ts` — перенесённые и очищенные модули.

**Критерий готовности:**
- `npm run typecheck` проходит для `src/kb/smart-context/`.
- Нет импортов `commander`, `@modelcontextprotocol/sdk`.

---

### Stage 2.2. Переписать DB layer на общую SQLite KB

**Вход:**
- Результат Stage 2.1.
- `src/kb/schema.ts` (схема Deus KB).

**Задачи:**
1. В `src/kb/schema.ts` добавить таблицы smart-context:
   ```sql
   CREATE TABLE IF NOT EXISTS sc_documents (
     id INTEGER PRIMARY KEY,
     path TEXT UNIQUE NOT NULL,
     mtime INTEGER,
     size INTEGER,
     content TEXT
   );
   CREATE TABLE IF NOT EXISTS sc_symbols (...);
   CREATE TABLE IF NOT EXISTS sc_imports (...);
   CREATE TABLE IF NOT EXISTS sc_call_graph (...);
   CREATE VIRTUAL TABLE IF NOT EXISTS sc_content_fts USING fts5(...);
   ```
2. Переписать `src/kb/smart-context/db.ts` (или удалить, заменив на `KbDatabase` из Deus):
   - Все запросы выполнять через `better-sqlite3` connection из KB.
   - Убрать логику миграций smart-context, заменив на `CREATE TABLE IF NOT EXISTS`.
3. Обновить `indexer.ts` и `graph.ts`, чтобы они принимали `Database` / `BetterSqlite3.Database` извне.

**Выход:**
- `src/kb/schema.ts` с таблицами smart-context.
- `src/kb/smart-context/indexer.ts` интегрирован с общей БД.

**Критерий готовности:**
- KB-БД создаёт таблицы `sc_*` при первой индексации.
- `npm run typecheck` проходит.

---

### Stage 2.3. Расширить KbProvider методом `searchCode()`

**Вход:**
- Результат Stage 2.2.
- `src/kb/index.ts` (интерфейс `KbProvider`).
- `src/kb/rag-provider.ts`.
- `src/kb/noop-provider.ts`.

**Задачи:**
1. В `src/kb/index.ts` расширить интерфейс:
   ```ts
   export interface KbProvider {
     indexDirectory(dir: string): void;
     hasContext(): boolean;
     getContext(task: string): string;
     stats(): KbStats;
     upsertMemory(key: string, type: string, summary: string): void;
     searchCode(query: string, topN?: number): string;
   }
   ```
2. В `RagKbProvider`:
   - Добавить поле `smartContext: SmartContextSearch`.
   - В `indexDirectory()` вызывать и существующую KB-индексацию, и `smartContext.indexer.buildIndex(dir)`.
   - Реализовать `searchCode(query, topN)` через `smartContext.searchEngine.ask(query, topN)`.
3. В `NoopKbProvider`:
   - `searchCode()` возвращает строку `"Smart Context поиск отключён (no-rag mode)."`.
4. Создать `src/kb/smart-context/index.ts` — фасад `SmartContextSearch`.

**Выход:**
- `KbProvider` с методом `searchCode`.
- Рабочая реализация в `RagKbProvider`.

**Критерий готовности:**
- `kb.searchCode("authentication", 5)` возвращает отформатированный результат.

---

### Stage 2.4. Переписать `.opencode/tools/search-code.ts`

**Вход:**
- Результат Stage 2.3.
- `.opencode/tools/search-code.ts`.

**Задачи:**
1. Удалить старый tool, который вызывает `npx code-assistant ask`.
2. Написать новый tool, который обращается к встроенному API Deus KB.
   - Вариант A (рекомендуется): tool делает HTTP-запрос к локальному endpoint.
     - Добавить в Deus lightweight HTTP endpoint `/kb/search-code`.
     - Использовать `@opencode-ai/plugin` `tool` API для регистрации.
   - Вариант B: tool вызывает глобально доступную функцию (например, через `process.deusKb`).
3. Обновить сигнатуру tool: `search_code(query: string, project: string, topN?: number)`.
4. Добавить graceful fallback: если индекса отсутствует, вернуть подсказку `Index project first`.

**Выход:**
- Новый `.opencode/tools/search-code.ts`.
- (Опционально) endpoint `/kb/search-code` в orchestrator.

**Критерий готовности:**
- Агент может вызвать `search_code(query="auth", project="/path")` без `npx code-assistant`.

---

### Stage 2.5. Удалить внешнюю зависимость `smart-context-retrieving`

**Вход:**
- Результат Stage 2.4.
- `package.json`, `package-lock.json`.
- `src/orchestrator.ts`.
- Документация.

**Задачи:**
1. Удалить `"smart-context-retrieving": "file:../smart-context-retrieving"` из `package.json`.
2. Удалить `package-lock.json` (или пересоздать `npm install`).
3. Удалить функцию `installSmartContext()` из `src/orchestrator.ts`.
4. Удалить вызов `installSmartContext(globalCwd)` в `main()`.
5. Обновить `README.md`, `AGENTS.md`, `ARCHITECTURE.md`:
   - Убрать `npm install smart-context-retrieving`.
   - Убрать `npx code-assistant index .`.
   - Описать, что поиск встроен в KB.

**Выход:**
- Очищенный `package.json`.
- Очищенный `src/orchestrator.ts`.
- Обновлённая документация.

**Критерий готовности:**
- `npm install` в чистом клоне проходит без `file:` зависимостей.
- `grep -R "smart-context-retrieving\|code-assistant" .` не находит совпадений, кроме исторических ссылок.

---

## Этап 3. Инфраструктура и документация

### Stage 3.1. Синхронизировать документацию и убрать дубли

**Вход:**
- `README.md`, `AGENTS.md`, `ARCHITECTURE.md`.
- `.opencode/opencode.json`.

**Задачи:**
1. В `ARCHITECTURE.md`:
   - Заменить `mimo-v2.5-pro` → `opencode-go/deepseek-v4-pro`.
   - Заменить `mimo-v2.5` → `opencode-go/deepseek-v4-flash`.
   - Обновить число агентов: 17 + sub-orchestrator = 18.
   - Добавить KB, DAG, state, checkpoints, sub-orchestrators в архитектурные схемы.
   - Убрать не реализованные Telegram Bot / Web Panel или пометить как "future".
2. В `README.md`:
   - Оставить только overview, quick start, ссылки на `AGENTS.md` и `ARCHITECTURE.md`.
   - Убрать дублирующие таблицы агентов/пайплайнов.
3. В `AGENTS.md`:
   - Сделать единственным источником правды по агентам, пайплайнам, KB.
   - Добавить notice в начале.
4. В `orchestrator-conductor.md` и `SKILL.md`:
   - Вынести общие таблицы pipeline selection в `references/pipelines/quick-reference.md`.
   - Оставить только conductor-specific инструкции.

**Выход:**
- Обновлённые `.md` файлы.

**Критерий готовности:**
- `grep -R "mimo-v2\.5" .` → пусто.
- `README.md` не содержит таблиц агентов/пайплайнов.

---

### Stage 3.2. Убрать `as any` / `as unknown as`, добавить typecheck/lint

**Вход:**
- `src/orchestrator.ts`.
- `tsconfig.json`.

**Задачи:**
1. Создать `src/opencode-client.ts` — адаптер над `@opencode-ai/sdk`.
2. Перенести в него:
   - `session.create`
   - `promptAsync`
   - `session.messages`
   - `session.abort`
3. Заменить все вызовы в `src/orchestrator.ts` на адаптер.
4. Убрать `SessionWithPrompt` и другие самодельные касты.
5. Добавить в `package.json`:
   ```json
   "scripts": {
     "typecheck": "tsc --noEmit",
     "build": "tsc",
     "test": "node --test dist/__tests__/**/*.test.js",
     "lint": "eslint src plugins .opencode/plugins"
   }
   ```
6. Добавить `.github/workflows/ci.yml`:
   - `npm ci`
   - `npm run typecheck`
   - `npm run build`
   - `npm test`

**Выход:**
- `src/opencode-client.ts`.
- Обновлённый `src/orchestrator.ts`.
- CI workflow.

**Критерий готовности:**
- `grep -R "as any\|as unknown as" src plugins .opencode/plugins` → пусто.
- `npm run typecheck` проходит.

---

### Stage 3.3. Финальная валидация

**Вход:**
- Результаты всех предыдущих стадий.

**Задачи:**
1. Запустить в чистом окружении:
   ```bash
   rm -rf node_modules package-lock.json .deus
   npm install
   npm run typecheck
   npm run build
   npm test
   ```
2. Прогнать orchestrator на тестовом проекте:
   ```bash
   npx tsx src/orchestrator.ts --cwd ../test-project "опиши структуру проекта"
   ```
3. Проверить plugin:
   ```bash
   npx tsx src/orchestrator.ts --metrics --cwd ../test-project
   ```
4. Проверить search_code:
   - Запустить сессию и вызвать `search_code(query="...")`.

**Выход:**
- CI green.
- Ручной smoke test пройден.

**Критерий готовности:**
- Все чекбоксы ниже отмечены.

---

## Граф зависимостей стадий

```
Stage 1.1 ─┬─► Stage 1.2 ─► Stage 1.3
            │
Stage 2.1 ─► Stage 2.2 ─► Stage 2.3 ─► Stage 2.4 ─► Stage 2.5
            │
            ▼
Stage 3.1 ─► Stage 3.2 ─► Stage 3.3
```

- Stage 1.x и Stage 2.x можно вести параллельно.
- Stage 3.x начинается после завершения 1.x и 2.x.

---

## Финальный чеклист

- [ ] `orchestrator-monitor.ts` в `.opencode/plugins/`, зарегистрирован, typecheck проходит.
- [ ] `npx tsx src/orchestrator.ts --metrics` выводит метрики.
- [ ] `smart-context-retrieving` отсутствует в `package.json`.
- [ ] `search_code` tool работает без `npx code-assistant`.
- [ ] `grep -R "as any\|as unknown as" src plugins .opencode/plugins` → пусто.
- [ ] `npm run typecheck` проходит.
- [ ] `npm test` проходит.
- [ ] `npm run build` проходит.
- [ ] `grep -R "mimo-v2\.5" .` → пусто.
- [ ] `README.md` не дублирует `AGENTS.md`.
- [ ] Ручной прогон orchestrator на тестовом проекте успешен.
