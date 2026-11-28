# SPEC — Runtime P1

> Статус: approved пользователем `medellin17` через чат, 2026-11-28.
> Дата: 2026-11-28.
> Проект: deus V2 runner.
> Модель локальных smoke-прогонов: `opencode-go/hungerg-free`.

## 1. Цель

Сделать V2 runner устойчивым к медленным проверкам и молчащим HTTP-вызовам, а cost cap — честным:

- параллельные задачи не получают ложный timeout из-за синхронного gate;
- зависший HTTP/service вызов не удерживает процесс и project lock бесконечно;
- неизвестная стоимость не выдаётся за ноль и не обходит `maxCost`;
- abort не приводит к commit/merge/accept после остановки.

## 2. Пользовательские сценарии

1. **Две параллельные change-задачи с медленным check.**
   Обе задачи обслуживаются в одном event loop; быстрая задача и heartbeat продолжаются, пока медленный check работает. Ни одна не получает ложный `step timed out`.

2. **OpenCode API принимает соединение и не отвечает.**
   Runner завершает операцию по deadline, освобождает project lock и не оставляет активный socket.

3. **Пользователь запускает неизвестную модель с `--max-cost`.**
   Runner отказывает до создания первой сессии и объясняет, что стоимость модели неизвестна.

4. **Пользователь запускает `opencode-go/hungerg-free` с cap.**
   Модель распознаётся как явно бесплатная; cap не блокирует её ошибочно. `--max-cost 0` ничего не запускает.

5. **Первая попытка имела неизвестную стоимость, вторая — известную.**
   Итог остаётся `cost=unknown`; известная вторая попытка не скрывает unknown первой.

6. **Пользователь прерывает прогон.**
   Abort до/во время gate не приводит к новому retry, commit, merge или accept. Если собственный merge уже произошёл, runner пытается безопасно откатить только его.

7. **Пользователь возобновляет старый checkpoint.**
   Чекпоинт читается. Без cap unknown показывается явно; с cap legacy unknown приводит к отказу до новой сессии. `--no-max-cost` позволяет явно продолжить без лимита.

## 3. Функциональные требования

### FR-1. Async gate

- `runCheck` и `runGate` становятся async.
- Порядок checks, `stopOnFirstFailure`, baseline comparison, timeout и output truncation сохраняются.
- Signal передаётся во все gate call sites.
- Aborted baseline не сохраняется как обычный red baseline.

### FR-2. HTTP/service deadlines

- Все runner-owned вызовы OpenCode получают `AbortSignal` и конечный deadline.
- Defaults: HTTP 30 s, cleanup 5 s общий budget, service discovery/ensure 120 s.
- Per-call timeout не превышает остаток абсолютного deadline операции.
- `followUp` deadline начинается до snapshot и включает prompt, polling и finish.
- Wave deadline включает reconciliation.
- Cleanup не удваивает верхний предел шага и использует свежий signal.
- Timeout prompt после отправки помечается `deliveryUnknown`; wake не повторяет его автоматически после наблюдаемого unknown.

### FR-3. Честная стоимость

- `estimateCost` возвращает `number | undefined`.
- Явно известные free-модели: `opencode-go/hungerg-free`, `opencode-go/hy4-flash-free`, `tokenharbor/deepseek-v4.1-flash:free`.
- Reported cost > 0, известный free-zero и finite token estimate считаются известными.
- Paid model без tokens, неизвестная модель без reported cost и невалидные numerics считаются unknown.
- Unknown сохраняется через retries, planner, advisor, resolver и team aggregate.
- `cost=unknown` не форматируется как `$0.0000`.

### FR-4. Cost cap

- Unknown + cap → отказ/остановка.
- Перед новой работой `knownSpent >= cap` → стоп.
- После завершения текущей операции `knownSpent > cap` → fail.
- Точное равенство cap позволяет текущей задаче завершить gate/merge, но не запускает новые.
- `maxCost=0` ничего не запускает.
- `--no-max-cost` явно перекрывает cap из `deus.json`.
- Ранний team cost-stop сохраняет diff/branch/worktree/review evidence.

### FR-5. Abort boundaries

- Top-level `applyRun` получает signal.
- Перед commit/merge/accept проверяется abort.
- Post-merge abort использует существующий безопасный rollback.
- Abort не маскируется под обычный gate failure/retry.

## 4. Инварианты

1. Один писатель на worktree; Parallel change остаётся через отдельные worktree и serialized merge.
2. `done` возможен только после настоящего gate и post-gate.
3. Abort не создаёт новых side effects после точки остановки.
4. Unknown стоимость никогда не трактуется как известный ноль при включённом cap.
5. Каждая оплаченная попытка сохраняется до запуска следующей.
6. Timeout не означает успешную доставку prompt.
7. Baseline/merge/rollback semantics не меняются, кроме явных abort guards.
8. Board schema в Runtime P1 не меняется.

## 5. Acceptance / доказательства

| ID | Критерий | Evidence |
|---|---|---|
| A1 | Медленный gate не блокирует event loop | heartbeat/concurrency тест |
| A2 | Реальный молчащий HTTP не удерживает процесс/socket/lock | local TCP/HTTP server + subprocess watchdog |
| A3 | Abort во всех gate и side-effect окнах | pipeline/apply/team тесты |
| A4 | Unknown model + cap отказывает до сессии | тест + smoke, session count 0 |
| A5 | `hungerg-free` и default free распознаются | pricing/preflight тесты |
| A6 | Unknown сохраняется через retries/planner/advisor/resolver/team | spend-path тесты |
| A7 | Legacy checkpoints покрыты матрицей | fixture tests, resume с/без cap |
| A8 | `cost=unknown` вместо нуля | output tests |
| A9 | `npm run typecheck` | exit 0 |
| A10 | `npm test` | все тесты зелёные |
| A11 | `npm run v2:smoke` | ok |
| A12 | Live team smoke на `hungerg-free` | две задачи `done`, lock отсутствует |

## 6. Non-goals

- Plugin и native subagents.
- Mission contract, Steward, `--prune`.
- Sandbox/container, process-tree kill checks, сетевые ФС.
- Изменение board schema.
- Durable wake cost states и exactly-once prompt protocol — отдельный Runtime P1b.
- Оптимизация followUp transcript polling при ×10 нагрузке — follow-up.
- Гарантия, что любой provider loop исчезнет.

## 7. Ограничения

- Локальная разработка; основной `master` не меняется до отдельного approve.
- Коммит и push — только по явной команде пользователя.
- Для smoke используется `/tmp/opencode`.
- При недоступности provider live smoke помечается blocked; unit/typecheck не заменяют его.

## 8. Открытые вопросы

Нет. Решения по wake P1b, legacy checkpoint и `--no-max-cost` зафиксированы в плане.

## 9. Подтверждение

Пользователь подтверждает цель, non-goals, инварианты и acceptance этого SPEC. После подтверждения план реализуется по карточкам R1 → R2 → R3a → R3b → R4.
