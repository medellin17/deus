# Отчет о ревью плана реализации (Plan Review Report)

Этот отчет содержит результаты 5-проходного ревью плана реализации [REPAIR-PLAN.md](file:///C:/Users/gleb7/OneDrive/Рабочий%20стол/vibecoding/Project-Systems/agentic-orchestrator-v2-deus/REPAIR-PLAN.md).

---

## Шаг 0. Предварительная проверка целостности

План **частично проходит** предварительную проверку. Выявлены следующие структурные недостатки:
*   **Секция "Зачем?"**: Отсутствует под таким названием. Роль этой секции выполняет раздел `## Цель`, который достаточно подробно описывает решаемые проблемы.
*   **Секция "Что?"**: Полностью отсутствует. Ожидаемое поведение системы и сценарии использования не вынесены в отдельную секцию, а распределены по стадиям (например, CLI-команды в Stage 1.2 и Stage 3.3).
*   **Критерии готовности**: Присутствуют для каждого шага, требования к ним соблюдены.

> [!WARNING]
> Рекомендуется доработать структуру плана, добавив явные секции **"Зачем?"** и **"Что?"** с описанием целевых пользовательских сценариев перед началом реализации.

---

## Проходы ревью

### A. Первичный обзор (Архитектура, Логика, Безопасность)

1.  **[Critical] Проблема разрешения путей импорта в плагинах и инструментах OpenCode**
    *   *Локализация*: Stage 1.1 ([REPAIR-PLAN.md:L54-70](file:///C:/Users/gleb7/OneDrive/Рабочий%20стол/vibecoding/Project-Systems/agentic-orchestrator-v2-deus/REPAIR-PLAN.md#L54-L70)) и Stage 2.4 ([REPAIR-PLAN.md:L278-290](file:///C:/Users/gleb7/OneDrive/Рабочий%20стол/vibecoding/Project-Systems/agentic-orchestrator-v2-deus/REPAIR-PLAN.md#L278-L290)).
    *   *Суть проблемы*: Плагин `.opencode/plugins/orchestrator-monitor.ts` делает относительный импорт `import { ... } from "../../src/metrics.ts"`, а инструмент `.opencode/tools/search-code.ts` динамически импортирует `../../src/kb/smart-context/index.ts`. При копировании папки `.opencode/` в целевой проект (функция `copyOpenCodeToTarget` в [src/orchestrator.ts](file:///C:/Users/gleb7/OneDrive/Рабочий%20стол/vibecoding/Project-Systems/agentic-orchestrator-v2-deus/src/orchestrator.ts)) эти относительные пути сломаются, так как исходного кода Deus (`src/`) в целевом проекте не будет.
    *   *Почему важно*: Плагины и инструменты не смогут инициализироваться и упадут с ошибкой `Module not found` при запуске в любом целевом проекте.

2.  **[Major] Отсутствие проверки типов для папки `.opencode`**
    *   *Локализация*: Stage 3.2 ([REPAIR-PLAN.md:L380-388](file:///C:/Users/gleb7/OneDrive/Рабочий%20стол/vibecoding/Project-Systems/agentic-orchestrator-v2-deus/REPAIR-PLAN.md#L380-L388)).
    *   *Суть проблемы*: В [tsconfig.json](file:///C:/Users/gleb7/OneDrive/Рабочий%20стол/vibecoding/Project-Systems/agentic-orchestrator-v2-deus/tsconfig.json) папка `.opencode` не включена в секцию `include` (там прописаны только `src/**/*.ts` и `plugins/**/*.ts`). Команда `npm run typecheck` (`tsc --noEmit`) не проверяет плагин и инструменты в `.opencode/`.
    *   *Why important*: Ошибки компиляции или несовместимости типов в коде плагина/инструментов не будут обнаружены на этапе сборки/CI.

3.  **[Major] Потенциальный провал typecheck из-за отсутствия типов зависимостей**
    *   *Локализация*: Stage 2.1 ([REPAIR-PLAN.md:L179-181](file:///C:/Users/gleb7/OneDrive/Рабочий%20стол/vibecoding/Project-Systems/agentic-orchestrator-v2-deus/REPAIR-PLAN.md#L179-L181)) и Stage 3.2 ([REPAIR-PLAN.md:L400-401](file:///C:/Users/gleb7/OneDrive/Рабочий%20стол/vibecoding/Project-Systems/agentic-orchestrator-v2-deus/REPAIR-PLAN.md#L400-L401)).
    *   *Суть проблемы*: `smart-context` использует библиотеки `js-yaml` и `web-tree-sitter`. Они не прописаны в `dependencies` корневого [package.json](file:///C:/Users/gleb7/OneDrive/Рабочий%20стол/vibecoding/Project-Systems/agentic-orchestrator-v2-deus/package.json). Если мы полностью избавляемся от `as any`/`as unknown as` (Stage 3.2), TypeScript не сможет скомпилировать проект без деклараций типов этих библиотек.
    *   *Why important*: Сборка проекта и CI упадут.

4.  **[Minor] Дублирование таблиц сессий в базах данных**
    *   *Локализация*: Stage 1.1 ([REPAIR-PLAN.md:L75-76](file:///C:/Users/gleb7/OneDrive/Рабочий%20стол/vibecoding/Project-Systems/agentic-orchestrator-v2-deus/REPAIR-PLAN.md#L75-L76)) и Stage 2.2 ([REPAIR-PLAN.md:L201-214](file:///C:/Users/gleb7/OneDrive/Рабочий%20стол/vibecoding/Project-Systems/agentic-orchestrator-v2-deus/REPAIR-PLAN.md#L201-L214)).
    *   *Суть проблемы*: База данных `metrics.db` содержит таблицу `sessions`, а база данных `orchestrator.db` содержит таблицы `sc_sessions` and `sc_session_entries`.
    *   *Why important*: Избыточное дублирование схемы усложняет поддержку и может вызвать рассинхронизацию данных.

---

### B. Связи между частями

*   **Зависимость Stage 2.4 от структуры сборки**: Инструмент `search-code.ts` (Stage 2.4) использует `SmartContextEngine` из `src/kb/smart-context/`. Изменение структуры БД в Stage 2.2 напрямую влияет на то, сможет ли инструмент корректно прочитать данные. Если миграция DB layer в Stage 2.2 не учитывает обратную совместимость или структуру данных, инструмент упадет.

---

### C. Кросс-доменные риски

1.  **Асинхронная индексация vs Чтение (Race Condition)**
    *   *Суть риска*: В [RagKbProvider](file:///C:/Users/gleb7/OneDrive/Рабочий%20стол/vibecoding/Project-Systems/agentic-orchestrator-v2-deus/src/kb/rag-provider.ts) метод `indexDirectory` запускает индексацию `smartContext` асинхронно без `await` (фоном):
        ```ts
        this.smartContext.indexDirectory(path).catch(...)
        ```
        Если агент сразу после старта выполнит поиск через `searchCode` (Stage 2.4), он получит пустые или неполные результаты, так как фоновая индексация еще не завершилась.
    *   *Почему важно*: Нестабильное поведение поиска в тестах и при реальном использовании агентами.

2.  **Параллельный доступ к SQLite при выполнении плагина**
    *   *Суть риска*: Плагин `orchestrator-monitor` пишет метрики в `metrics.db` при получении событий от сервера OpenCode. В то же время, CLI-процесс оркестратора может читать эти метрики при вызове с флагом `--metrics`.
    *   *Почему важно*: Возможна блокировка базы данных SQLite (`SQLITE_BUSY`), если транзакции записи/чтения перекроются во времени (хотя WAL-режим частично решает эту проблему, риск остается при высокой интенсивности событий).

---

### D. Консолидация и сведение

Ниже представлен итоговый список проблем:

| Приоритет | Часть плана | Проблема | Почему важно |
| :--- | :--- | :--- | :--- |
| **[Critical]** | Stage 1.1 / 2.4 | Относительные импорты из `../../src/...` в плагинах и инструментах `.opencode/` сломаются при копировании в целевой проект. | Плагин мониторинга и инструмент `search_code` не запустятся в целевых проектах. |
| **[Major]** | Stage 3.2 | Папка `.opencode` исключена из проверки типов `tsconfig.json`. | Ошибки типов в плагинах не отслеживаются сборщиком и CI. |
| **[Major]** | Stage 2.1 / 3.2 | Отсутствие деклараций типов для `js-yaml` и `web-tree-sitter` при строгом typecheck. | Сборка проекта (`npm run build` / `typecheck`) упадет. |
| **[Major]** | Stage 2.3 / 2.4 | Фоновая (асинхронная) индексация `smartContext` приводит к race condition. | Агенты могут выполнять поиск по еще не проиндексированной базе данных. |
| **[Minor]** | Stage 1.1 / 2.2 | Дублирование таблиц сессий в `metrics.db` и `orchestrator.db`. | Усложняет поддержку кодовой базы и структуры данных. |

---

> [!TIP]
> **Рекомендация по исправлению критической проблемы импортов**:
> Вместо импорта исходников из `../../src/...` в плагинах и инструментах, находящихся в `.opencode/`, рассмотрите возможность:
> 1. Публикации логики метрик как части устанавливаемого npm-пакета (или локального модуля, упакованного при сборке).
> 2. Или копирования необходимых скомпилированных JS-файлов в `.opencode/dist/` при инсталляции.
