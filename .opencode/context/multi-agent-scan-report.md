# Отчет по результатам мульти-агентного сканирования системы (Multi-Agent Scan Report)

Этот отчет содержит консолидированные результаты параллельного аудита кодовой базы проекта `agentic-orchestrator-v2-deus` тремя специализированными суб-агентами по функциональным доменам:
1. **Core Orchestration & State**
2. **Knowledge Base & Smart Context**
3. **Plugins & OpenCode Integration**

---

## ТОП-5 угроз, недопустимых для выпуска в релиз

Ниже приведены 5 наиболее критических уязвимостей и ошибок, которые заблокируют работу системы в продакшене.

### 1. Относительные импорты из `../../src/...` в плагинах и инструментах `.opencode/`
* **Problem description**: Плагин `orchestrator-monitor.ts` импортирует функции базы данных метрик напрямую из исходников Deus: `import { ... } from "../../src/metrics.ts"`. Аналогично инструмент `search-code.ts` динамически импортирует `../../src/kb/smart-context/index.ts`. Так как папка `.opencode/` копируется в целевые проекты пользователя в изолированном виде, папки `src/` там не будет. Это приведет к ошибкам `Module not found` и падению плагина и инструментов.
* **Severity**: `[Critical]`
* **File/line**:
  - [.opencode/plugins/orchestrator-monitor.ts:L3-10](file:///C:/Users/gleb7/OneDrive/Рабочий%20стол/vibecoding/Project-Systems/agentic-orchestrator-v2-deus/.opencode/plugins/orchestrator-monitor.ts#L3-L10)
  - [.opencode/tools/search-code.ts:L31](file:///C:/Users/gleb7/OneDrive/Рабочий%20стол/vibecoding/Project-Systems/agentic-orchestrator-v2-deus/.opencode/tools/search-code.ts#L31)
* **Recommendation**:
  - Для плагина: перейти на легковесный локальный HTTP API / Socket-сервер оркестратора для передачи метрик по сети.
  - Для инструмента: выполнять HTTP-запросы к локальному API-эндпоинту оркестратора (например, `/kb/search-code`) вместо прямого импорта кода.

### 2. Ошибка синтаксиса MATCH в запросе FTS5 (BM25)
* **Problem description**: В SQL-запросе BM25-поиска используется выражение `WHERE content_fts MATCH ?`. Но виртуальной таблицы с именем `content_fts` не существует (виртуальная таблица называется `sc_content_fts` и в запросе имеет алиас `c`). Это вызовет синтаксическую ошибку SQLite `no such column: content_fts` при любом поисковом запросе и полностью ломает работу BM25-стратегии.
* **Severity**: `[Critical]`
* **File/line**: [src/kb/smart-context/search-strategies/bm25-strategy.ts:L50](file:///C:/Users/gleb7/OneDrive/Рабочий%20стол/vibecoding/Project-Systems/agentic-orchestrator-v2-deus/src/kb/smart-context/search-strategies/bm25-strategy.ts#L50)
* **Recommendation**:
  Заменить `content_fts MATCH ?` на алиас таблицы `c MATCH ?` (или `c.content MATCH ?`):
  ```typescript
  WHERE c MATCH ?
  ```

### 3. Нарушение внешнего ключа в `sc_session_entries` (SQL constraint error)
* **Problem description**: Таблица `sc_session_entries` ссылается на `sc_sessions(id)` (целочисленный первичный ключ). Однако при добавлении записи о сессии в `SessionStore.addEntry()` в качестве внешнего ключа передается строковый `sessionId` (например, `'session-123'`). При включенном `PRAGMA foreign_keys = ON` это гарантированно приводит к ошибке `SQLITE_CONSTRAINT_FOREIGNKEY` и сбою при попытке сохранить лог сессии.
* **Severity**: `[Critical]`
* **File/line**: [src/kb/smart-context/sessions.ts:L30-38](file:///C:/Users/gleb7/OneDrive/Рабочий%20стол/vibecoding/Project-Systems/agentic-orchestrator-v2-deus/src/kb/smart-context/sessions.ts#L30-L38)
* **Recommendation**:
  Изменить метод `getOrCreate` in `sessions.ts`, чтобы он возвращал целочисленный `id` вставленной или найденной сессии, и в `addEntry` передавать именно числовой `id`.

### 4. Логический сбой при переключении на fallbackAgent в DAG Engine
* **Problem description**: В методе `executeNode` при возникновении ошибки лимита контекста на последней попытке (`attempt === maxRetries`) управление переключается на `fallbackAgent`, и вызывается `continue` для следующей итерации. Но из-за инкремента `attempt++` в цикле условие `attempt <= maxRetries` становится ложным, цикл завершается, и узел сразу переходит в статус `failed` без запуска попытки со сменным агентом.
* **Severity**: `[Critical]`
* **File/line**: [src/dag/engine.ts:L215-218](file:///C:/Users/gleb7/OneDrive/Рабочий%20стол/vibecoding/Project-Systems/agentic-orchestrator-v2-deus/src/dag/engine.ts#L215-L218)
* **Recommendation**:
  Уменьшать счетчик попыток `attempt--` при активации fallback-агента, чтобы дать циклу совершить дополнительную итерацию:
  ```typescript
  if (isContextLimitError(err) && def.fallbackAgent && attempt === maxRetries) {
    def.agent = def.fallbackAgent;
    attempt--; 
    continue;
  }
  ```

### 5. Блокировки базы данных (SQLITE_BUSY) из-за независимых соединений
* **Problem description**: Модуль базы знаний `createKB` и модуль управления чекпоинтами `new StateDatabase` независимо открывают один и тот же файл базы данных `orchestrator.db`. При параллельном выполнении задач в суб-оркестраторах это приводит к частым блокировкам файла БД и ошибкам `SQLITE_BUSY: database is locked`.
* **Severity**: `[Critical]`
* **File/line**: [src/orchestrator.ts:L251-267](file:///C:/Users/gleb7/OneDrive/Рабочий%20стол/vibecoding/Project-Systems/agentic-orchestrator-v2-deus/src/orchestrator.ts#L251-L267)
* **Recommendation**:
  1. Объединить соединения: использовать общий экземпляр класса `Database` драйвера `better-sqlite3` для всего процесса.
  2. Задать таймаут ожидания освобождения блокировки: `new Database(path, { timeout: 10000 })`.

---

## Полный реестр прочих обнаруженных проблем

### [Major] Race Condition из-за неблокирующей индексации Smart Context
* **Problem description**: В методе `RagKbProvider.indexDirectory()` индексация запускается асинхронно без `await` (метод возвращает `void`). Из-за этого оркестратор сразу переходит к выполнению задачи и поиску по кодовой базе, возвращая пустые результаты, так как фоновая индексация еще не завершилась.
* **File/line**: [src/kb/rag-provider.ts:L50-52](file:///C:/Users/gleb7/OneDrive/Рабочий%20стол/vibecoding/Project-Systems/agentic-orchestrator-v2-deus/src/kb/rag-provider.ts#L50-L52)
* **Recommendation**: Сделать метод `indexDirectory` асинхронным (`Promise<void>`) во всем интерфейсе `KbProvider` и вызывать его с `await` в `orchestrator.ts`.

### [Major] Двойная JSON-сериализация поля `depends_on`
* **Problem description**: В `DAGEngine.execute` массив зависимостей сериализуется в JSON-строку: `depends_on: JSON.stringify(def.dependsOn)`. В то же время метод `TaskManager.createNode` повторно выполняет `JSON.stringify` над этим полем. В результате данные в БД сохраняются с двойным экранированием кавычек, ломая последующее чтение.
* **File/line**:
  - [src/dag/engine.ts:L27](file:///C:/Users/gleb7/OneDrive/Рабочий%20стол/vibecoding/Project-Systems/agentic-orchestrator-v2-deus/src/dag/engine.ts#L27)
  - [src/state/task-manager.ts:L53](file:///C:/Users/gleb7/OneDrive/Рабочий%20стол/vibecoding/Project-Systems/agentic-orchestrator-v2-deus/src/state/task-manager.ts#L53)
* **Recommendation**: Избегать повторного вызова `JSON.stringify` в `TaskManager.createNode` (проверять тип данных на строку перед сериализацией).

### [Major] Папка `.opencode` исключена из проверки типов `tsconfig.json`
* **Problem description**: В конфигурации TypeScript папка `.opencode` не включена в секцию `include`. Ошибки типов в плагинах и инструментах не будут обнаружены на этапе сборки проекта и в CI.
* **File/line**: [tsconfig.json:L13](file:///C:/Users/gleb7/OneDrive/Рабочий%20стол/vibecoding/Project-Systems/agentic-orchestrator-v2-deus/tsconfig.json#L13)
* **Recommendation**: Добавить `.opencode/**/*.ts` в `"include"` в `tsconfig.json`.

### [Major] Отсутствие зависимостей `js-yaml` и `web-tree-sitter` в `package.json`
* **Problem description**: Файлы модуля `smart-context` импортируют `js-yaml` и `web-tree-sitter` напрямую, но эти пакеты не задекларированы в зависимостях корневого проекта, что приведет к ошибкам сборки на чистой системе.
* **File/line**: [package.json](file:///C:/Users/gleb7/OneDrive/Рабочий%20стол/vibecoding/Project-Systems/agentic-orchestrator-v2-deus/package.json) (отсутствие зависимостей)
* **Recommendation**: Добавить `js-yaml` и `web-tree-sitter` в `dependencies` и `@types/js-yaml` в `devDependencies`.

### [Major] Некорректная регистрация плагина `orchestrator-monitor`
* **Problem description**: Плагин не зарегистрирован в `opencode.json`, и экспортируется как именованная константа `OrchestratorMonitor` вместо `export default plugin(...)`, что ломает механизм автозагрузки плагинов в OpenCode.
* **File/line**:
  - [opencode.json](file:///C:/Users/gleb7/OneDrive/Рабочий%20стол/vibecoding/Project-Systems/agentic-orchestrator-v2-deus/.opencode/opencode.json)
  - [.opencode/plugins/orchestrator-monitor.ts:L14](file:///C:/Users/gleb7/OneDrive/Рабочий%20стол/vibecoding/Project-Systems/agentic-orchestrator-v2-deus/.opencode/plugins/orchestrator-monitor.ts#L14)
* **Recommendation**: Добавить `"plugin": ["orchestrator-monitor"]` в `opencode.json` и изменить экспорт в файле плагина на дефолтный `export default plugin(...)`.

### [Minor] Дублирование баз данных и таблиц сессий
* **Problem description**: В проекте параллельно создаются БД `metrics.db` и `orchestrator.db`, при этом сессии пишутся в три разные таблицы, что усложняет консистентность и архитектуру.
* **File/line**: [src/metrics.ts:L45](file:///C:/Users/gleb7/OneDrive/Рабочий%20стол/vibecoding/Project-Systems/agentic-orchestrator-v2-deus/src/metrics.ts#L45) и [src/kb/schema.ts:L50](file:///C:/Users/gleb7/OneDrive/Рабочий%20стол/vibecoding/Project-Systems/agentic-orchestrator-v2-deus/src/kb/schema.ts#L50)
* **Recommendation**: Объединить все данные в единой базе `orchestrator.db`.
