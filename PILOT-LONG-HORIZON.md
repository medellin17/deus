# Пилот длинных задач: `--prune` в deus

> **К:** [`DESIGN-LONG-HORIZON.md`](DESIGN-LONG-HORIZON.md) и [`DESIGN-DECISIONS.md`](DESIGN-DECISIONS.md).
> **Что это:** регламент одного реального пилота на 12–18 часов. Не код, не benchmark.
> **Цель:** проверить процесс (контракт → recon → варианты → план → исполнение → steward → ретро) на горизонте 1–2 дней до стройки 100-часового режима.
> **Статус:** draft. Запускать после утверждения контракта пилота.

---

## 0. TL;DR

Берём реальную задачу `deus --prune` (уборка старых worktree/веток/сессий), проходим её через новую модель работы, играя недостающую автоматизацию руками, и замеряем:

- поймал ли контракт допущения до первого change;
- ускорил ли параллельный recon;
- удержал ли коридор D1–D4 без остановки на каждом шаге;
- переживает ли state kill процесса;
- даёт ли acceptance ledger полную картину «готово».

Провал пилота — тоже результат: он показывает, какой кирпич чинить первым.

---

## 1. Гипотезы, которые проверяем

| # | Гипотеза | Как проверяем | Провал |
|---|---|---|---|
| H1 | Контракт + assumptions ловят load-bearing неизвестные до первого change | Все S* со статусом `unverified` закрыты до T2 | хоть одно всплыло после первого change |
| H2 | Параллельный recon даёт достаточно фактов за приемлемое время | 3 ветки за ≤90 мин, ≥10 фактов с evidence; скорость против последовательного **не** измеряется (нет baseline) | >3 ч или <5 фактов |
| H3 | Коридор D1–D4 не останавливает работу на локальных отклонениях | D1/D2 идут без остановки, D3 — один checkpoint | D2 останавливает, или D3 не пойман |
| H4 | State переживает kill процесса | kill после первой волны, resume ≤15 мин | потеряна задача/evidence |
| H5 | Acceptance ledger даёт полную картину | 100% пунктов с evidence, manual — с артефактом | есть пункт без evidence |

Дополнительно: измерить человеческую нагрузку, стоимость, rework и время отката.

H2 не доказывает ускорение: для этого нужен отдельный A/B с последовательным recon, которого в пилоте нет. Пилот фиксирует абсолютное время и качество фактов.

---

## 2. Задача пилота

**`deus --prune`: уборка старых артефактов.**

### Почему она

- реальная, из P2-бэклога, не выдуманная ради пилота;
- 1–2 дня, без миграций данных и внешних эффектов;
- есть тесты и понятный acceptance;
- обратима: код, не данные;
- тренирует все этапы: recon, варианты, план, параллельные задачи, gate, review, rollback.

**Fallback:** если `--prune` уже реализован к дате пилота — взять `runtime P1` (async gate + AbortSignal) или пагинацию доски. Задачу не менять после старта.

### Контракт пилота (сокращённо)

```json
{
  "version": 1,
  "id": "mission-pilot-prune-2026-11-24",
  "title": "Добавить deus --prune",
  "goal": "deus --prune --dry-run показывает кандидатов на удаление, а deus --prune --older-than <N> удаляет только старые worktree, смерженные ветки deus/* и старые сессии, не трогая живые задачи.",
  "non_goals": [
    "не добавлять cron/автозапуск",
    "не трогать remote-ветки",
    "не делать vacuum БД",
    "не удалять без dry-run"
  ],
  "invariants": [
    "worktree и ветки живых задач не удаляются",
    "зависимости живых задач не ломаются",
    "main остаётся чистым и рабочим",
    "секреты не попадают в артефакты"
  ],
  "acceptance": [
    { "id": "A1", "check": "deus --prune --dry-run", "evidence": "список кандидатов, exit 0, ничего не изменено" },
    { "id": "A2", "check": "deus --prune --older-than 30d", "evidence": "удалены только кандидаты; живые задачи и их worktree на месте" },
    { "id": "A3", "check": "npm test", "evidence": "exit 0; новые тесты на retention, live-protection, dry-run" },
    { "id": "A4", "check": "manual", "evidence": "src/v2/README.md обновлён" },
    { "id": "A5", "check": "diff review", "evidence": "нет изменений в gate/merge поведении", "manual": true }
  ],
  "assumptions": [
    { "id": "S1", "text": "worktree лежат в .deus/worktrees, ветки — deus/*", "status": "unverified", "load_bearing": true },
    { "id": "S2", "text": "сессии можно перечислять и удалять через клиент", "status": "unverified", "load_bearing": true },
    { "id": "S3", "text": "ни одна живая задача не ссылается на старый worktree", "status": "unverified", "load_bearing": true }
  ],
  "budgets": { "max_cost_usd": 2.0, "max_hours": 18, "max_attempts_per_task": 3, "max_tasks": 8, "max_waves": 3 },
  "decision_rights": {
    "human": ["goal", "non_goals", "acceptance", "budgets", "D3", "D4"],
    "agent": ["architecture", "task_order", "implementation", "D1", "D2"]
  },
  "protected_surfaces": [".git", ".deus/board.db", ".env*", "*.pem", "*.key"],
  "workspace": { "allow": ["src/v2/**", "src/__tests__/**", "src/v2/README.md"], "deny": [".github/**", "infra/**"] }
}
```

Если S2 не подтверждается — acceptance A2 сужается до worktree/веток, сессии уходят в non-goals. Это **D3**, а не тихое изменение.

---

## 3. Baseline

| Что | Как фиксируем |
|---|---|
| Как убирают сейчас | вручную: `git worktree prune`, `git branch -d`, удаление сессий через TUI/API. Оценка 30–60 мин/мес, ошибки возможны |
| Текущий deus на этой задаче | не запускаем второй прогон ради A/B: дорого. Используем исторические прогоны/оценку, помечаем `ГИПОТЕЗА` |
| Baseline тестов | `npm test`, `npm run typecheck` на чистом HEAD до старта; сохранить вывод и список падений |
| Время до первого change | замеряем от старта до первого change-шага |

Пилот — не контролируемый A/B. Он проверяет жизнеспособность процесса, а не доказывает ускорение в процентах.

---

## 4. Роли

| Роль | Кто | Что делает |
|---|---|---|
| Владелец | человек | Контракт, approval, D3/D4, финальный merge, оценка результата |
| Pilot lead | человек или агент | Ведёт runbook, пишет drift/acceptance, следит за stop rules |
| Recon-воркеры | 3 агента | Кодовая база, git-артефакты, сессии/тесты |
| Архитектор | 1–2 агента | Варианты и ADR |
| Исполнители | 1–2 агента | Change-задачи в worktree |
| Steward | человек | Играет роль советника: классифицирует D1–D4, пишет решение |
| Observer | человек | Считает метрики, не даёт агенту self-report |

Один человек может совмещать владельца, steward и observer, но роли фиксируются в `metrics.md`.

---

## 5. Runbook

### День 0 — контракт и подготовка (2–3 ч)

1. **Выбрать задачу** и записать 5–10 строк замысла.
2. **Написать draft-контракт** (45 мин): goal, non-goals, invariants, acceptance, assumptions, budgets, workspace.
3. **Проверить assumptions:** S1–S3 пока `unverified`; это нормально, их закроет recon.
4. **Approval (ручной workaround C1):**
   - projectId для пилота — фиксированный `pilot-deus`, **не** realpath: проверяем stable id;
   - скопировать draft в `~/.local/state/deus-pilot/pilot-deus/mission-pilot-prune-2026-11-24/mission.approved.v1.json`;
   - `sha256sum` в `contract.sha256`, записать hash в `metrics.md`;
   - добавить строку в `approval.log` (timestamp, hash, `previousHash: null`);
   - перед каждым change-шагом сверять `sha256sum` (30 секунд).
5. **Backup (ручной workaround C2):**
   - `tar czf /tmp/deus-pilot-backup-day0.tgz .deus`;
   - bundle писать вне проекта: `~/.local/state/deus-pilot/bundles/pilot-deus/...`;
   - повторить перед каждой волной.
6. **Baseline:** `npm test`, `npm run typecheck`; сохранить вывод.
7. **Создать папку** `.context/pilot-prune-2026-11-24/` с `metrics.md`, `drift.md`, `acceptance.md`, `merge-ledger.md`.
8. **Создать команду** (если её нет):
   ```bash
   deus --team-add --team-name pilot --team-goal "prune pilot"
   ```
   Дальше в командах — `--board-team pilot`, не `main`.
9. **Подготовить contract injection:** сохранить `contract.txt`; в каждом промпте агента — блок `## Contract` с текстом. Путь к approved-файлу агенту не давать.

### День 1 — recon, варианты, план, первый change (6–8 ч)

1. **Recon fan-out (60–90 мин).** 3 агента, file-only:
   - **Кодовая база:** `worktree.ts`, `team.ts`, `board.ts`, `cli.ts`; где сейчас cleanup, какие naming-схемы.
   - **Git-артефакты:** `git worktree list`, `git branch --list 'deus/*'`, какие ветки смержены, какие висят.
   - **Сессии/тесты:** `sessions.ts`, клиентский API, можно ли list/delete; существующие тесты и README.
   - Runner-evidence: `git status --short`, `git log -5 --oneline`, `git diff --stat`, baseline tests, `rg --files | wc -l`.
2. **Synthesis:** обновить S1–S3 (`verified`/`risk`), записать факты с `file:line`; **CP1** — человек смотрит assumptions.
3. **Варианты (45 мин):** 2 агента:
   - минимальный: только worktree старше N;
   - полный: worktree + смерженные ветки + сессии, с dry-run и retention.
   - **CP2** — ADR: выбор, отвергнутые, residual risks.
4. **План (30 мин):** 6 задач с зависимостями; создать на доске:
   ```bash
   deus --board-task add --board-title "T1 retention rules" --board-team pilot
   deus --board-task add --board-title "T2 prune core" --board-depends-on <T1> --board-team pilot
   ...
   ```
   **CP3** — человек смотрит план; перед первым change — сверка contract hash.
5. **T1/T2:** design + core; gate после T2; drift-лог; 2–3 ч.
6. **50% checkpoint:** стоимость, остаток, прогноз, скоуп.

### День 2 — исполнение, D3, kill drill, acceptance, rollback (6–8 ч)

1. **T3/T4/T5:** CLI/dry-run, тесты, docs. T3 и T4 — параллельно после T2, T5 — после T3. Gate после каждого.
2. **D3 drill:** когда дойдёт до удаления сессий, проверить S2. Если API не даёт list/delete или это рискованно — **block T3**, записать D3, варианты:
   - A: только worktree/ветки (безопасно);
   - B: сессии тоже (нужен API);
   - C: отложить сессии в non-goal.
   Замерить время до решения. Независимые задачи (T4/T5, если не зависят от T3) продолжаются.
3. **Kill drill (E6):** два сценария, потому что `--resume` для team-run отказывает:
   - **Pipeline:** отдельный короткий прогон `npm run v2 -- --cwd . --pipeline audit "smoke"`; `kill -9` посреди шага; `--resume <runId>`; замерить время, проверить, что succeeded-шаги не повторились.
   - **Team:** после первой волны `kill -9` team-run; следующий `--team-run` должен увидеть `.deus/crashed-run.json`, перевести running-задачи в `blocked`; `--board-task retry`; замерить. `--resume` для team-run не использовать.
4. **T6 review:** diff против контракта; **CP4**.
5. **Acceptance:** заполнить `acceptance.md`; A1–A5 с evidence; manual A5 — файл с ревьюером и датой.
6. **Merge:** финальный gate + post-gate; записать в `merge-ledger.md`.
7. **Rollback drill:** в отдельном worktree с symlink `node_modules` (не голый клон) откатить merge пилота в обратном топологическом порядке; замерить; worktree удалить.
8. **Retro:** что сработало, что нет, какие кирпичи чинить.

---

## 6. Метрики

| Метрика | Определение | Цель | Провал |
|---|---|---|---|
| Время до контракта | старт → approved draft | ≤45 мин | >90 мин |
| Load-bearing допущения до change | все S* `verified`/`risk` до T2 | 100% | любое после T2 |
| Recon-факты | факты с `file:line`/evidence | ≥10 | <5 |
| Recon wall-clock | старт → synthesis | ≤90 мин | >3 ч |
| Ложные таймауты | шаг упал по timeout при прогрессе | 0 | ≥1 |
| D3 до merge | пойман до merge / все D3 | 100% | любой после merge |
| Незапланированные вмешательства | действия вне CP0–CP4/D3 | ≤2 | >4 |
| Cost ratio | факт / оценка | ≤1.5x | >2x или cap не сработал |
| Rework | попыток на задачу | ≤2 | >3 |
| Recovery (pipeline) | kill → `--resume`, потеряно | ≤15 мин, 0 потерь | любая потеря |
| Recovery (team) | kill → crashed-run recovery → `retry` | ≤15 мин, 0 потерь | любая потеря |
| Acceptance coverage | пункты с evidence | 100% | любой без evidence |
| Main broken | сломан ли main | 0 | любой |
| Rollback time | откат пилота в worktree с `node_modules` | ≤30 мин | >2 ч |
| Ясность для человека | 1–5, субъективно | ≥4 | ≤2 |

Метрики считает observer; агент не заполняет их сам.

---

## 7. Stop rules

**Немедленно:**

- main сломан или post-gate не проходит;
- секрет попал в артефакт/лог;
- contract hash не совпал;
- D4: агент пытается изменить goal/non-goals/acceptance или сделать необратимое;
- rollback drill провалился.

**Стоп и replan:**

- 2 подряд gate-провала по одной причине;
- стоимость >80% при acceptance <50%;
- незапланированных вмешательств >4 до половины задач;
- load-bearing допущение всплыло после первого change;
- D3 обнаружен после merge.

**Правило:** после stop — никаких «ещё одну задачку». Фиксируем состояние, пишем отчёт, решаем.

---

## 8. Evidence

Сохраняем в `.context/pilot-prune-2026-11-24/`:

```
contract.approved.json + contract.sha256
baseline-tests.txt
recon.md
options.md
adr.md
plan.json
board-events.jsonl
drift.md
acceptance.md
merge-ledger.md
metrics.md
retro.md
```

Секреты не сохраняем; вывод тестов проверяем на `.env`, токены, пути.

---

## 9. Ручные workaround-ы

Пилот проверяет процесс, не безопасность. `same uid` — не граница; trust boundary см. `DESIGN-DECISIONS.md` §0.1. Ручные workaround-ы — процедурные, не криптографические.

| Что | Как в пилоте | Что автоматизировать потом |
|---|---|---|
| C1 контракт | stable project id `pilot-deus`, approved вне `.deus`, `v1`, hash + `approval.log` перед каждым change | `deus mission approve/verify/attach` |
| C2 backup | tar `.deus` + bundle вне проекта перед каждой волной | `deus export/import` |
| C3 replan | ручной freeze: не создавать задачи, дождаться running, snapshot в `drift.md`; **без git revert** (только план) | `mission_phase`, `replan` |
| C4 rollback | `merge-ledger.md` + `git revert` в worktree, топологический порядок | `deus mission revert` |
| M1 acceptance | таблица в `acceptance.md`, статус выводится из evidence, не правится руками | ledger в board |
| M2 D3 | `deus --board-task block`, `touches`/diff для зависимых | `d3_checkpoint`, steward actor |
| M3 recon | file-only + runner evidence | `RECON_RULES` allowlist |

---

## 10. Критерии решения после пилота

**Идём в реализацию**, если:

- все Critical workaround-ы выдержали;
- acceptance coverage 100%, manual — с артефактом;
- нет D3 после merge;
- незапланированных вмешательств ≤2;
- ложных таймаутов 0;
- recovery ≤15 мин без потерь;
- rollback ≤30 мин;
- cost ≤1.5x.

**Правим дизайн**, если 1–2 крупных провала, но процесс в целом жив.

**Останавливаемся и пересматриваем**, если:

- контракт не поймал допущения;
- вмешательств >4;
- потерян state;
- rollback не сработал;
- main сломан.

---

## 11. Чего пилот не докажет

- 100 часов, multi-model, multi-host;
- злонамеренного агента (same uid — не граница);
- большие команды и 200 задач;
- миграции данных и прод-деплой;
- что модель всегда будет давать хорошие варианты.

Это следующий горизонт, не этот пилот.

---

## 12. Бюджет и время

- 2 дня, 12–18 часов человека+агентов;
- `max_cost_usd: 2.0`;
- 3 волны максимум;
- если к 20 часам не закончили — stop, отчёт, не «дожимать».

---

## Приложение A. Задачи на доске

| ID | Задача | Зависит | Режим |
|---|---|---|---|
| T1 | Retention rules: что считается старым, что живым | — | analyze |
| T2 | Prune core: сбор кандидатов, dry-run, удаление | T1 | change |
| T3 | CLI `--prune`, `--older-than`, `--dry-run` | T2 | change |
| T4 | Тесты: retention, live-protection, dry-run | T2 | change |
| T5 | Docs: `src/v2/README.md` | T3 | change |
| T6 | Review diff против контракта | T3, T4, T5 | analyze |

T3 и T4 можно параллелить: разные файлы, общий T2.

---

## Приложение B. D3-сценарий

**Триггер:** S2 не подтверждается — клиент не даёт list/delete сессий или это рискованно.

1. `deus --board-task block --board-id <T3> --board-reason "D3: session API unavailable"`.
2. Записать в `drift.md`: класс D3, что изменилось, варианты A/B/C, цена, deadline.
3. Определить зависимые: T5 зависит от T3 → ждёт; T4 не зависит → продолжается.
4. Решение: A (только worktree/ветки) — сузить acceptance A2; B — отложить; C — cancel T3.
5. Записать resolution и обновить контракт (если A — это изменение acceptance → human approve).

---

## Приложение C. Rollback drill

1. Клонировать проект в `/tmp/deus-rollback-drill`.
2. Взять `merge-ledger.md`, отсортировать merge-коммиты назад.
3. `git revert -m 1 --no-edit <commit>` по одному.
4. После каждого — `npm test` (или быстрый smoke).
5. Замерить время; конфликт — зафиксировать файл и остановиться.
6. Клон удалить; в основной проект ничего не менять.
