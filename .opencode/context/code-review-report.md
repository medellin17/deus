# Code Review Report: Deus (Agentic Orchestrator v2)

**Дата:** 2026-07-01
**Версия:** 2.0.0
**Путь:** `/agentic-orchestrator-v2-deus`
**Коммит:** Все файлы src/ + plugins/

---

## Итого

| Категория | Count |
|-----------|-------|
| **Critical** | 6 |
| **High** | 10 |
| **Medium** | 12 |
| **Low / Style** | 9 |

---

## 1. Critical Issues

### C1 — process.exit() в main() до регистрации signal-handler'ов

**Файл:** `src/orchestrator.ts:1031,1043,1054,1061,1098,1101-1103`

**Проблема:** В каждой ветке `switch(mode)` вызывается `process.exit()` (строки 1031, 1043, 1054, 1061, 1098). Signal-обработчики `SIGINT`/`SIGTERM` (строки 1101-1102) и `exit` (строка 1103) регистрируются **после** всех exit-путей. При нормальном завершении они не регистрируются. В результате `stopServer()` **никогда не вызывается** — opencode serve остаётся висеть процессом.

```
main()
  └─ parseArgs()          ← может process.exit(1) на invalid arg
  └─ ensureDeusDir()
  └─ ensureServerRunning() ← spawn opencode serve
  └─ switch(mode)
       ├─ "orchestrate" → process.exit() ← сервер НЕ остановлен
       ├─ "direct"      → process.exit() ← сервер НЕ остановлен
       ├─ "pipeline"    → process.exit() ← сервер НЕ остановлен
       ├─ "parallel"    → process.exit() ← сервер НЕ остановлен
       └─ ...
  └─ // ✗ сюда никогда не доходит
  └─ process.on("SIGINT", stopServer) ← не регистрируется
  └─ process.on("exit", stopServer)   ← не регистрируется
```

**Фикс:** Вынести регистрацию обработчиков ДО switch-блока. В каждом exit-пути вместо прямого `process.exit()` использовать функцию `shutdown(exitCode)`:

```typescript
function shutdown(exitCode: number) {
  stopServer();
  process.exit(exitCode);
}

// В начале main() или сразу после ensureServerRunning:
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
```

### C2 — O(N) brute-force semanticSearch загружает ВСЕ эмбеддинги в память

**Файл:** `src/kb/search.ts:92-128`

**Проблема:** `semanticSearch()` выполняет `SELECT * FROM kb_embeddings` без LIMIT, загружая все векторы (3072-dim Float32) в память, затем делает полный перебор с cosineSimilarity. Для проекта с 10k чанков: ~120MB RAM + 10M арифметических операций на каждый поиск. На 50k+ чанках становится неработоспособным.

```typescript
// search.ts:92-100 — грузит ВСЁ
const rows = this.db.prepare(`
  SELECT e.chunk_id, e.embedding, e.dimension, ...
  FROM kb_embeddings e
  JOIN kb_chunks c ON c.id = e.chunk_id
  ...
`).all();  // ← без LIMIT
```

**Фикс:** Добавить ANN-индекс (например, `sqlite-vec`, `usearch` или `faiss`) или хотя бы предварительный FTS5-filter перед semantic search:

```typescript
async semanticSearch(query: string, limit = 10): Promise<SearchResult[]> {
  if (!this.embedder) return [];
  // Шаг 1: быстрый pre-filter через FTS5 (снижает N до ~200)
  const ftsHits = this.searchChunks(query, 200);
  const chunkIds = ftsHits.map(r => /* получить chunk_id */);
  if (chunkIds.length === 0) return [];
  // Шаг 2: semantic search только по pre-filtered
  const rows = this.db.prepare(`
    SELECT ... FROM kb_embeddings e
    WHERE e.chunk_id IN (${chunkIds.map(() => '?').join(',')})
  `).all(...chunkIds);
  // ... cosine similarity ...
}
```

### C3 — SuperContext.getContext() использует raw task как FTS5 MATCH-параметр без экранирования

**Файл:** `src/kb/super-context.ts:12-16`

**Проблема:** В `getContext()` raw-строка `task` передаётся напрямую в FTS5 MATCH без экранирования. Если задача содержит кавычки, скобки или спецсимволы FTS5 (`"`, `*`, `(`, `)`, `AND`, `OR`, `NOT`, `^`), FTS5 парсер выбросит ошибку или даст некорректные результаты. В `fts5.ts` и `search.ts` экранирование есть, в `super-context.ts` — нет.

```typescript
// super-context.ts:15 — нет экранирования
.all(task) as Array<{...}>;
```

**Фикс:** Использовать `escapeFts` из search.ts (или вынести в общую функцию):

```typescript
import { escapeFts } from "./fts5.js"; // или вынести в shared util

// super-context.ts:15
const escaped = escapeFts(task);
const chunks = this.db.prepare(`...MATCH ?...`).all(escaped);
```

### C4 — memory-tree.ts upsert сбрасывает created_at через INSERT OR REPLACE

**Файл:** `src/kb/memory-tree.ts:25-29`

**Проблема:** `INSERT OR REPLACE` при повторном вызове upsert заменяет всю строку. Поле `created_at` имеет `DEFAULT (unixepoch())`, поэтому при upsert'е **creation date перезаписывается текущим временем**. Теряется информация о том, когда впервые создана запись.

```typescript
// memory-tree.ts:27 — created_at будет сброшен
"INSERT OR REPLACE INTO kb_memory_tree(path, level, summary, token_count) VALUES(?, ?, ?, ?)"
```

**Фикс:** Использовать `INSERT ... ON CONFLICT DO UPDATE`:

```typescript
this.db.prepare(`
  INSERT INTO kb_memory_tree(path, level, summary, token_count, created_at)
  VALUES (?, ?, ?, ?, unixepoch())
  ON CONFLICT(path, level) DO UPDATE SET
    summary = excluded.summary,
    token_count = excluded.token_count
`).run(path, level, summary, tokenCount ?? null);
```

### C5 — Plugin orchestrator-monitor.ts импортирует несуществующий модуль `@opencode-ai/plugin`

**Файл:** `plugins/orchestrator-monitor.ts:1`

**Проблема:** `import type { Plugin } from "@opencode-ai/plugin"` — пакет `@opencode-ai/plugin` отсутствует в `package.json`. TypeScript выдаёт ошибку `TS2307: Cannot find module '@opencode-ai/plugin' or its corresponding type declarations`. Этот файл никогда не скомпилируется. Плагин не может быть загружен.

```bash
# tsc --noEmit:
plugins/orchestrator-monitor.ts(1,29): error TS2307: Cannot find module '@opencode-ai/plugin'
```

**Фикс:** Либо добавить пакет в dependencies, либо определить локальный тип:

```typescript
// Вариант 1: npm install @opencode-ai/plugin
// Вариант 2: локальный тип
type Plugin = (ctx: unknown) => Record<string, (event: unknown) => Promise<void>>;
```

### C6 — `semanticSearch` HybridSearch не имеет индекса — O(N) scan на каждую операцию

**Файл:** `src/kb/search.ts:85-129`

Дублирует C2, но это отдельная инстанция — тот же метод на том же уровне важности. Semantic search в текущей реализации **не масштабируется вообще**. Для проекта размером с целевой (17 агентов, тысячи чанков) каждый поиск будет загружать все эмбеддинги.

---

## 2. High Issues

### H1 — parseArgs: `--cwd` без аргумента даёт undefined, а не ошибку

**Файл:** `src/orchestrator.ts:948`

```typescript
if (a === "--cwd") { cwd = args[++i]; continue; }
```

Если `--cwd` — последний аргумент, `args[++i]` будет `undefined`. Потом `globalCwd = path.resolve(undefined)` на строке 993 бросит ошибку. Все остальные флаги с аргументом (`--agent`, `--pipeline`, `-o`) защищены через `|| ""`.

**Фикс:** 
```typescript
if (a === "--cwd") {
  cwd = args[++i];
  if (!cwd) { log("ERROR", "--cwd требует путь"); process.exit(1); }
  continue;
}
```

### H2 — Пустые catch-блоки скрывают ошибки

**Файлы:** `src/orchestrator.ts:597,627,648,833,852`; `src/kb/indexer.ts:98-100`

5 пустых/немых catch-блоков. Ошибки глотаются без логирования. При отладке это делает невозможным понять, почему не работает KB, память, сохранение или индексация.

**Фикс:** Минимум `catch { log("DEBUG", "...") }` — добавить логи на `DEBUG` уровень.

### H3 — FTS5 экранирование не консистентно между модулями

**Файлы:** `src/kb/fts5.ts:18`, `src/kb/search.ts:131-133`, `src/kb/super-context.ts:15`

Три разных подхода к экранированию FTS5-запросов:
| Файл | Экранирование |
|------|--------------|
| `fts5.ts` | `query.replace(/["]/g, '""')` — только кавычки, оборачивает в `""` |
| `search.ts` | `query.replace(/["*()]/g, "")` — вырезает `" * ( )`, оборачивает в `""` |
| `super-context.ts` | **нет экранирования** — raw task |

Это приводит к неожиданным результатам: один и тот же запрос даёт разные результаты в зависимости от того, какой path поиска используется. Нужно вынести в единую функцию `sanitizeFtsQuery()`.

### H4 — `search.ts` deduplication by content может дать false positives

**Файл:** `src/kb/search.ts:29`

```typescript
const key = r.content;  // content используется как ключ дедупликации
merged.set(key, { ...r, source: "fts5" });
```

Если два разных чанка имеют одинаковое содержимое (редко, но возможно — импорт/экспорт одного модуля, повторяющиеся doc-blocks), второй будет отброшен. Лучше использовать `(chunkId)` или `(path + heading)` как ключ.

**Фикс:** Добавить `chunkId` или `path` + `heading` в `SearchResult` и использовать их как ключ дедупликации.

### H5 — `search.ts` memory results rank = 0 доминирует над FTS5 rank

**Файл:** `src/kb/search.ts:81`

```typescript
// memory.ts:81
rank: 0,
```

Все memory-результаты получают rank = 0, а FTS5 BM25 rank обычно > 0. При сортировке по возрастанию (line 44-46) memory-результаты **всегда** идут перед FTS5-результатами. Это искажает релевантность: старые саммари могут забивать релевантные чанки из кода.

### H6 — `fts5.ts:search` оборачивает запрос в кавычки, убивая FTS5 синтаксис

**Файл:** `src/kb/fts5.ts:23`

```typescript
.all(`"${escaped}"`, limit)
```

Оборачивание в двойные кавычки превращает весь запрос в phrase query. Пользователь не может использовать `AND`, `OR`, `-`, `*` и другие FTS5-операторы. `search.ts` делает то же самое.

### H7 — `chunkMarkdown` не обрабатывает контент без заголовков

**Файл:** `src/kb/chunker.ts:14-48`

Если файл не содержит markdown-заголовков (нет строк с `#`), весь контент попадает в один big chunck с `heading=""`, `level=0`. Для больших файлов (>300k символов) это создаёт чанк > maxTokens, который `chunkSection` разобьёт по параграфам/предложениям, но все чанки получат `heading=""`. Потеря семантической структуры.

### H8 — `process.on("exit")` в main() не сработает из-за process.exit()

**Файл:** `src/orchestrator.ts:1101-1103`

Дублирует проблему из C1. Даже если бы обработчики были до exit, сам `process.exit()` прерывает выполнение настолько быстро, что `exit`-обработчик может не успеть выполниться полностью (особенно для async-операций, а `stopServer()` синхронный, но это всё равно хрупко).

### H9 — Хардкод `model: 'gemini-embedding-2'` в трёх местах

**Файлы:** `src/kb/embeddings.ts:19`, `src/kb/search.ts:99`, `src/kb/indexer.ts:159`

Название модели эмбеддингов хардкодом в трёх независимых файлах. При смене модели Gemini придётся менять в трёх местах. Нужно вынести в константу.

### H10 — `opencode` не указан в dependencies/peerDependencies

**Файл:** `package.json:11-15`

`orchestrator.ts` вызывает `spawn("opencode", ["serve", ...])`. CLI `opencode` нигде не перечислен в зависимостях. В README сказано `npm i -g opencode`, но это не явная зависимость. При установке только через `npm install` сервер не запустится.

**Фикс:** Добавить в package.json:
```json
"peerDependencies": {
  "opencode": ">=1.0.0"
}
```

---

## 3. Medium Issues

### M1 — `@opencode-ai/sdk` указан как `"latest"`

**Файл:** `package.json:13`

`"@opencode-ai/sdk": "latest"` — установка latest при `npm install` может принести breaking changes в любое время. Нужен semver-диапазон (например `"^0.x.x"`) или конкретная версия.

### M2 — `smart-context-retrieving` указан как file-зависимость

**Файл:** `package.json:15`

`"smart-context-retrieving": "file:../smart-context-retrieving"` — зависимость от локальной файловой системы. В CI/CD или у другого разработчика проекта не будет.

### M3 — Тесты не используют глобальный test runner

**Файл:** `src/__tests__/run-tests.ts`

`run-tests.ts` — кастомный раннер, импортирующий тесты как модули. Это работает, но нет:
- coverage reporting (`--experimental-test-coverage`)
- watch mode
- параллельного запуска тестов
- стандартного выхода (exit code always 0?)
- файлы `.test.ts` не в `exclude` tsconfig

### M4 — RagKbProvider.generateEmbeddings() не входит в KbProvider interface

**Файлы:** `src/kb/provider.ts`, `src/kb/rag-provider.ts:75`

`generateEmbeddings()` (async) и `semanticSearch()` не объявлены в интерфейсе `KbProvider`, из-за чего `orchestrator.ts` вынужден использовать `as any` в строках 615 и 1078.

**Фикс:** Расширить интерфейс или сделать тип-гард:
```typescript
// provider.ts
export interface KbProvider {
  // ... существующие методы ...
  generateEmbeddings?(): Promise<number>;
  semanticSearch?(query: string, limit?: number): Promise<SearchResult[]>;
}
```

### M5 — `orchestrator.ts` глобальные состояния (client, kb, serverProcess)

**Файлы:** `src/orchestrator.ts:197-202,227-228`

Глобальные переменные:
- `let client: OpencodeClient` — не чистится, не пересоздаётся
- `let kb: KbProvider | null` — не thread-safe (но в Node.js это ок)
- `let serverProcess: ChildProcess | null` — может устареть уже после выхода
- `let serverWasAlreadyRunning` — используется только для stopServer

Для CLI-скрипта это приемлемо, но для модульного тестирования или использования как библиотеки — проблема. Рекомендую вынести в класс `Orchestrator` с инкапсулированным состоянием.

### M6 — `extractText` в `runSession` не обрабатывает все типы parts

**Файл:** `src/orchestrator.ts:481-486`

```typescript
function extractText(parts: Array<{ type: string; text?: string }>): string {
  return parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");
}
```

SDK может возвращать `type: "code"` или `type: "tool_result"` с текстовым содержимым. Они игнорируются. Для контекста пайплайнов (передача `prev`) теряется существенная часть ответа.

### M7 — `runSession` не сохраняет `stepIndex` корректно

**Файл:** `src/orchestrator.ts:581`

`return { stepIndex: -1, ... }` — все результаты вне пайплайна получают `stepIndex: -1`. В `runOrchestrate` это исправляется на строке 634 (`r.stepIndex = 0`). Для `runDirect` не исправляется. При сохранении отчёта (строка 834) `s.stepIndex + 1` для orchestrate покажет 1, для direct покажет 0 (из-за -1).

### M8 — Token estimation только по длине текста

**Файл:** `src/kb/chunker.ts:10-12`

```typescript
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
```

Для русского текста с UTF-8 это даёт погрешность до 2x в обе стороны. Для кода (много одно-двухсимвольных токенов) — ещё больше. Предложить использовать `tiktoken` для точного подсчёта.

### M9 — `semanticSearch` в `rag-provider.ts` возвращает `[]` при отсутствии embedder

**Файл:** `src/kb/rag-provider.ts:87-90`

```typescript
async semanticSearch(query: string, limit?: number): Promise<SearchResult[]> {
  if (!this.embedder) return [];
  return await this.hybridSearch.semanticSearch(query, limit);
}
```

При отсутствии embedder'а возвращает `[]` без fallback на FTS5 search. Лучше вернуть хотя бы keyword search.

### M10 — `indexDirectory` использует синхронный walk

**Файл:** `src/kb/indexer.ts:78-91`

`readdirSync` / `readFileSync` — для тысяч файлов это блокирует event loop. `indexFile` тоже синхронный (`readFileSync`). Для больших проектов (>10k файлов) нужно делать асинхронный walk с parallel limit.

### M11 — WAL + FTS5 external content может рассинхронизироваться

**Файл:** `src/kb/schema.ts:76-81,102-113`

FTS5 external content (`content='kb_chunks'`) + WAL mode — известная комбинация, при которой после восстановления после краха FTS5 индекс может отличаться от content table. Рекомендую добавить `reindex()` после `initialize()` для перестроения FTS при старте.

### M12 — `main()` не await'ит перед process.exit()

**Файл:** `src/orchestrator.ts:1031,1043,1054,1061`

```typescript
process.exit(r.success ? 0 : 1);
```

После `process.exit()` Node.js прерывает выполнение. Незавершённые промисы, запись логов, close() на БД могут не выполниться. Правильно: заставить main быть последним вызовом без process.exit внутри или использовать `await` + `return`.

---

## 4. Low Issues / Style

### L1 — Неиспользуемый импорт `glob` в Arch文档 (не в коде)

Не ошибка, но: `src/__tests__/orchestrator/parse-args.test.ts:2` импортирует `execSync`, `fileURLToPath`, `path`, `createKB`, `NoopKbProvider`. Все используются — ок.

### L2 — `cosineSimilarity` экспортируется из `embeddings.ts` и `index.ts`, но используется только в `search.ts`

**Файл:** `src/kb/embeddings.ts:53`, `src/kb/index.ts:22`

Экспорт есть для публичного API, но в самом проекте используется только в search.ts. Ок, но стоит отметить.

### L3 — `MemoryNode` interface определён в двух местах с разными полями

**Файлы:** `src/kb/schema.ts:33-40` vs `src/kb/memory-tree.ts:3-10`

Два разных интерфейса `MemoryNode`:
- `schema.ts`: `created_at: number` (snake_case)
- `memory-tree.ts`: `createdAt: number`, `tokenCount: number` (camelCase)

Это приводит к путанице. Нужен единый каноничный тип.

### L4 — `KBDatabase.raw` getter возвращает `Database.Database` — нарушение инкапсуляции

**Файл:** `src/kb/schema.ts:121-123`

Getter `raw` даёт прямой доступ к `better-sqlite3` instance. Все модули (FTS5Index, MemoryTree, HybridSearch, etc.) получают raw db и работают напрямую. Это связывает их с конкретной реализацией. Лучше передавать только нужные prepared statements или сделать слой репозитория.

### L5 — Магические числа

- `src/kb/super-context.ts:13` — `LIMIT 5` хардкод
- `src/kb/super-context.ts:46` — `.slice(0, 500)` хардкод
- `src/kb/indexer.ts:8` — SKIP_DIRS хардкод
- `src/orchestrator.ts:66` — `POLL_INTERVAL_MS = 2000` (ok)
- `src/orchestrator.ts:280` — магическое `60` в цикле ожидания сервера

### L6 — `console.log` vs `log()` функция

В `orchestrator.ts` везде используется `log("INFO", ...)`, но в нескольких местах (строка 851-853) — `console.log` напрямую. Консистентность нарушена.

### L7 — `ensureServerRunning` дублирует проверку здоровья на строке 230 и в цикле 282

**Файл:** `src/orchestrator.ts:239-288`

Сначала `checkServerRunning(baseUrl)` на строке 240, потом цикл с `checkServerRunning(baseUrl)` на строке 282. Дублирование. Можно упростить: всегда входить в цикл ожидания и выходить при первой успешной проверке.

### L8 — `saveResults` не синхронизирует запись с `console.log`

**Файл:** `src/orchestrator.ts:851`

После `console.log` о сохранении файлы могут быть не полностью записаны на диск (fs.writeFileSync синхронный, так что это не проблема, но `console.log` может буферизироваться).

### L9 — `parseArgs` возвращает `CliArgs`, но `mode` может быть `"help"` с пустыми `tasks`

**Файл:** `src/orchestrator.ts:945`

```typescript
if (a === "--help" || a === "-h") { mode = "help"; return { mode, agent, pipeline, tasks, cwd, useRag, outputDir: undefined }; }
```

Возвращает `tasks: []` (пустой массив) для `--help`. Это не проблема, т.к. `main()` проверяет `mode === "help"` первым. Но семантически неверно — у `--help` нет задач.

---

## 5. What's Done Well

1. **Strategy Pattern для RAG toggle**: `KbProvider` → `RagKbProvider` / `NoopKbProvider` + фабрика `createKB()` — чистая архитектура, легко тестировать и расширять.

2. **ESM-совместимость**: Все импорты с `.js` расширениями, `"type": "module"` в package.json, использование `import.meta.url` и `fileURLToPath`. Никаких `require()`, CJS-проблем или оставшихся `__dirname` без polyfill.

3. **Тесты для граничных сценариев `--rag`/`--no-rag`**: parse-args тесты проверяют порядок флагов, переопределение, комбинации. Это те случаи, которые ломаются при рефакторинге.

4. **FTS5 external content schema**: Корректно настроена синхронизация через триггеры (INSERT/UPDATE/DELETE). Ниже уровень ошибок sync, чем с ручным управлением FTS.

5. **Incremental indexing**: MD5-хеши контента, проверка перед переиндексацией. Для больших проектов экономит часы.

6. **Parallel pipeline groups**: Архитектура с `parallelGroup` и `Promise.all` в `runPipeline` — правильное решение для независимых задач (3 review'ера одновременно).

7. **Graceful degradation для эмбеддингов**: Если нет GEMINI_API_KEY — KB работает без эмбеддингов, `generateEmbeddings` возвращает 0, семантический поиск возвращает []. Никаких крашей.

8. **Документация**: ARCHITECTURE.md, AGENTS.md, README.md покрывают архитектуру, использование, агентов, пайплайны, KB. Это выше среднего уровня для опенсорс-проекта.

---

## 6. Verification Story

- **Tests reviewed:** Yes. 3 test files (84+70+37 = 191 строк). Покрытие:
  - NoopKbProvider: 100% методов
  - createKB factory: все комбинации аргументов
  - parseArgs --rag/--no-rag: 7 кейсов
  - **Не покрыто:** chunker, fts5, embeddings, memory-tree, search, super-context, indexer, orchestrator (кроме parseArgs)

- **Build verified:** Yes. `tsc --noEmit` выдаёт 2 ошибки:
  - `TS2307: Cannot find module '@opencode-ai/plugin'` (plugins/orchestrator-monitor.ts)
  - `TS7006: Parameter '_ctx' implicitly has 'any' type` (plugins/orchestrator-monitor.ts)

- **Security checked:** Yes.
  - SQL-инъекции: все запросы параметризованы (`?` placeholders) — OK
  - FTS5-инъекции: частично экранированы, но не консистентно (H3, C3)
  - Path traversal: `indexDirectory` принимает user-provided путь без валидации — риск
  - Секреты: GEMINI_API_KEY через env var — OK
  - MD5: используется только для дедупликации, не для security — OK

---

## 7. Рекомендуемый порядок исправлений

1. **Critical**: C1 (process.exit без stopServer), C5 (@opencode-ai/plugin) — блокируют корректную работу
2. **Critical**: C2/C6 (O(N) semanticSearch) — performance-бомба
3. **Critical**: C3 (FTS5 injection в super-context) — data loss при спецсимволах
4. **High**: H1 (--cwd undefined), H2 (silent catches), H3 (inconsistent FTS5 escaping)
5. **High**: H10 (opencode dependency) — блокирует установку
6. **Medium**: M1 (latest sdk), M2 (file dependency) — ломают CI/CD
7. **Medium**: M4 (as any через interface gap), M5 (global state)
