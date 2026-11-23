# Deus: решения по длинным задачам (addendum)

> **К:** [`DESIGN-LONG-HORIZON.md`](DESIGN-LONG-HORIZON.md).
> **Что это:** закрывает 4 Critical и 3 Major из ревью `.context/plan-review-report-long-horizon-2026-11-23.md`.
> **Статус:** предложенные решения, не код. После пилота переносятся в дизайн v2.
> **Правило:** если решение принято, оно заменяет соответствующий раздел дизайн-дока. Старый текст не переписываем до пилота, чтобы видеть разницу.
> **После ревью 2026-11-24:** исправлены C3 partial apply, границы доверия, stable project ID, export consistency, replan authority/classification, acceptance status/coverage, D3 independence, recon allowlist. См. §0.1 и §10.

---

## 0. Сводка

| ID | Решение | Заменяет |
|---|---|---|
| C1 | Approved-контракт живёт вне агентского workspace; hash проверяется перед каждым gate; approval требует TTY | §5.1, §5.4 |
| C2 | Durable state = event log + export bundle; `.deus` — рабочий индекс, не источник истины | §5.1, §9.3 |
| C3 | Replan/смена контракта — двухфазная транзакция с freeze/drain/snapshot/classify/apply | §6.5, §7.3 |
| C4 | Mission rollback: merge-ledger + checkpoint tags; для длинных миссий — integration-ветка | §9.3 |
| M1 | Acceptance ledger: mission/task/post-merge/manual с evidence | §5.2, §6.6 |
| M2 | D3 state machine: `running → blocked` до паузы; зависимые/независимые ветки | §7.1, §7.3 |
| M3 | Recon: phase 1 — file-only + runner evidence; phase 2 — allowlist shell | §6.2 |

---

## 0.1. Границы доверия

Один раздел, чтобы не обещать больше, чем можно при same uid.

| Что | Статус | Механизм | Что это значит |
|---|---|---|---|
| Approved-контракт | **tamper-evident** | hash перед каждым gate, approval в TTY, версии в append-only логе | Правку видно; предотвратить нельзя |
| Board / run.json / merge_ledger / acceptance | **журнал** | append-only события, manifest, checks | При доверенном агенте — источник истины; при shell у агента — можно подделать |
| Evidence (gate, diff, logs) | **пишет runner** | runner запускает checks и пишет результат | Локально; при same uid агент может переписать файл |
| Настоящая граница | **отдельный uid / контейнер** | runner и state вне агентского workspace, контракт read-only, shell внутри контейнера | Только это защищает от злонамеренного агента |

Правила:

- Этот документ гарантирует **защиту от ошибок**, а не от злонамеренного агента.
- Все «hash», «mode 0400», «TTY» — это детекторы и speed bumps, а не граница безопасности.
- Если угроза меняется (чужие агенты, чужие репозитории, сеть) — сначала контейнер/uid, потом всё остальное.
- `src/v2/README.md` уже говорит: доска — журнал, а не доказательство. Это правило остаётся.

---

## 1. C1. Контракт: вне агентского workspace, tamper-evident

### Решение

1. **Draft** контракта лежит в репозитории: `.deus/missions/<missionId>/mission.draft.json`. Агент может его читать и даже править — это черновик, ему не доверяют.
2. **Approved** контракт лежит вне проекта:
   ```
   $XDG_STATE_HOME/deus/missions/<projectId>/<missionId>/
   ├── mission.approved.v<n>.json   # mode 0400
   ├── approval.v<n>.json
   ├── approval.log                 # append-only JSONL, hash-chain
   └── contract.sha256
   ```
   `<projectId>` — **stable id**, не `realpath`:
   - если есть `.deus/project-id` — взять его;
   - иначе `sha256(git remote get-url origin + git rev-list --max-parents=0 HEAD)`;
   - fallback `sha256(realpath(projectDir))` только для не-git проекта.
   `deus mission attach --project-id <id>` — для переезда/клона. Проект можно переместить, id останется.
3. **Approval** делает человек командой `deus mission approve <missionId>`. Команда:
   - требует интерактивный TTY (`process.stdin.isTTY === true`), но это **speed bump**, не контроль: агент может выделить PTY (см. §0.1);
   - показывает diff draft → approved и отдельно подсвечивает goal/non-goals/acceptance/assumptions;
   - считает `contractHash` и пишет `approval.v<n>.json` + строку в `approval.log`;
   - отказывает, если draft невалиден, содержит `load_bearing` допущения без статуса или duplicate keys.
4. **Инъекция в промпт — структурированная.** Контракт не вставляется одним сырым блоком. Runner цитирует поля отдельно (`goal`, `non_goals`, `invariants`, `acceptance`, `assumptions`) в своих delimiter-ах. `mission.md` — человеческий текст, не команды. Approval UI показывает diff, чтобы агентский draft не протащил инструкции («игнорируй non-goals», «считай D3 разрешённым»). Lint на instruction-like паттерны — эвристика, не гарантия.
5. **Проверка** перед каждым change-gate, перед merge и на `--resume`:
   - перечитать approved-файл;
   - канонизировать и посчитать hash;
   - сравнить с `missionHash` в памяти и в `run.json`;
   - при расхождении — `contract_tampered`, стоп, merge запрещён.
6. **История approval.** `approval.log` append-only, hash-chain: каждая запись содержит `previousHash`. Старые версии `mission.approved.v<n>.json` не перезаписываются. Для 100-часовой миссии это аудит: кто, когда, что изменил.

### Approval record

```json
{
  "schemaVersion": 1,
  "missionId": "mission-2026-11-24-prune",
  "contractVersion": 3,
  "contractHash": "sha256:...",
  "previousHash": "sha256:...",
  "approvedBy": "medellin17",
  "approvedAt": "2026-11-24T10:00:00Z",
  "tty": "/dev/pts/3",
  "cwd": "/mnt/disk-e/vibecoding/Project-Systems/deus",
  "nonce": "8f3c...",
  "tool": "deus 2.0.0"
}
```

### Канонизация

- RFC 8785 (JCS) или точная спецификация: сортировка ключей, без пробелов, UTF-8, **reject duplicate keys**, NFC, фиксированный формат чисел, массивы сохраняют порядок.
- `contractHash = sha256(canonical(contract without approval))`.
- `approval.*` не входит в hash; иначе рекурсия. История approval хешируется отдельно.
- `run.json` хранит `missionHash`, `contractVersion`, `approvalHash`.
- `approval.log` хранит hash-chain; проверка цепочки — на старте и на resume.

### Что агент всё ещё может

| Действие | Последствие |
|---|---|
| Править draft | Ничего: runner читает approved |
| Править approved-файл | Detected на следующем gate; не prevented |
| Править `approval.log` | Detected по hash-chain, если есть внешняя копия; иначе — журнал |
| Править `run.json` | В памяти есть hash; после рестарта — cross-check с board events и backup |
| Запустить `deus mission approve` | Требуется TTY; агент может выделить PTY — это дыра, признаём |
| Прочитать `$XDG_STATE_HOME` через shell | Возможно при same uid; политика может запретить `external_directory`, но не гарантирует |

### Границы доверия

См. §0.1. Коротко: same uid — **tamper-evident**, не tamper-proof. Настоящая защита — отдельный uid/контейнер, approved-файл read-only, runner и state вне агентского workspace, shell агента — внутри контейнера.

### Тесты

- hash стабилен между запусками и не зависит от форматирования;
- duplicate keys / NFC / number format дают предсказуемый hash;
- approve без TTY → отказ; approve в PTY — предупреждение в логе, не ошибка;
- stable project id сохраняется после перемещения каталога;
- `deus mission attach` находит старую миссию;
- правка approved до gate → `contract_tampered`;
- правка после последнего gate, перед merge → merge запрещён;
- `--resume` с другим hash → отказ;
- draft без `load_bearing`-статуса → отказ;
- approval.log с разорванной цепочкой → отказ на старте;
- structured injection: поля не смешиваются, `mission.md` не управляет поведением.

### Код

`src/v2/mission/contract.ts`, `approval.ts`, `verify.ts`, `project-id.ts`; CLI `deus mission approve`, `deus mission verify`, `deus mission attach`.

---

## 2. C2. Durable state: event log + export bundle

### Решение

1. **`board.db` — рабочий индекс, не источник истины.** Источник истины:
   - `board_events` (append-only) — что произошло;
   - mission-артефакты (mission, ADR, drift, acceptance) — почему;
   - `merge_ledger` — что влито.
2. **Export только на границе волны** (или с явным `board_seq` high-water mark). `deus export` использует SQLite backup API / `VACUUM INTO`, фиксирует `boardSeq`, считает manifest и проверяет counts. Экспорт во время волны либо ждёт, либо падает с `export_in_progress` — torn bundle запрещён.
3. **Bundle пишется вне проекта:** `$XDG_STATE_HOME/deus/bundles/<projectId>/<missionId>/` или отдельный backup-каталог. В git — только read-only копия для человека. Import сверяет manifest, approval hash и hash-chain; требует `--approve-recovery` в TTY.
4. **Каденс:** после каждой волны, на 50/80% бюджета, перед merge. Для 100 часов — commit bundle в приватный git или backup.
5. **RPO ≤ 1 волна (2–6 ч), RTO ≤ 15 мин.** Это принятый риск, а не «почти ноль»: одна волна работы может потеряться. Длина волны ограничивается, чтобы RPO не стал сутками.
6. **Rebuild требует полноты.** Либо `board_events` содержит полный payload задачи, либо snapshot обязателен на каждой границе. Если событий не хватает — rebuild отказывает, а не угадывает.
7. **Retention:** mission/ADR — навсегда; run-артефакты и bundle — последние N + все milestone-срезы. Иначе 100 часов забьют диск.

### Bundle

```
$XDG_STATE_HOME/deus/bundles/<projectId>/<missionId>/
├── manifest.json
├── mission.approved.v<n>.json   # копия, hash сверяется с approval
├── approval.v<n>.json
├── approval.log
├── mission.md
├── recon.md
├── options.md
├── adr.md
├── drift.md
├── acceptance.md
├── plan/
│   ├── plan-v1.json
│   └── plan-v2.json
├── board/
│   ├── events.jsonl
│   ├── snapshot.json
│   └── board-seq.txt
├── merge-ledger.jsonl
├── evidence/
│   ├── index.json
│   └── ...
└── runs/
    └── <runId>/run.json
```

`manifest.json`:

```json
{
  "version": 1,
  "missionId": "mission-...",
  "exportedAt": "2026-11-24T18:00:00Z",
  "contractHash": "sha256:...",
  "approvalChainHash": "sha256:...",
  "board": { "events": 123, "lastEventId": 456, "boardSeq": 789 },
  "git": { "head": "abc123", "branch": "main" },
  "files": [{ "path": "mission.approved.v3.json", "sha256": "..." }]
}
```

### Export consistency

- Export берёт `board_seq` до чтения, читает events/snapshot, затем повторно проверяет `board_seq`; если изменился — повтор или ошибка.
- Evidence пишет runner, не агент: gate output, diff, checks. Агентские заметки — отдельно, с пометкой `source=agent`.
- Перед записью bundle проверяется отсутствие секретов: `.env*`, `*.pem`, `*.key`, `.ssh/.aws/.gnupg`, токены в выводе.

### Import

1. Проверить manifest и хеши всех файлов.
2. Проверить approval hash-chain.
3. Восстановить board из snapshot + events до `boardSeq`.
4. Сравнить число задач, id, статусы, `depends_on`, последние события.
5. `mission_phase = recovered`; до merge — `deus mission verify` и checks.
6. При расхождении — отказ, ничего не перезаписывать.

### Тесты

- kill после merge, до export → восстановление из последнего bundle + событий;
- export во время волны → `export_in_progress`, bundle не создан;
- битый manifest / hash файла → отказ;
- отсутствующий evidence-файл → отказ;
- rebuild даёт те же статусы и поля;
- bundle не содержит секретов (тест на `.env`, `*.pem`);
- bundle, изменённый агентом, не проходит import;
- approval.log с разорванной цепочкой → отказ.

### Код

`src/v2/export.ts`, `import.ts`, `board/rebuild.ts`; CLI `deus export/import`.

---

## 3. C3. Replan и смена контракта: двухфазная транзакция

### Решение

`mission_phase` — явное состояние:

```
draft → approved → running
                   ├→ freezing → draining → snapshot → classifying → applying → running
                   ├→ paused            # глобальный D3/D4
                   ├→ blocked           # инфраструктура
                   ├→ done
                   └→ failed
```

Replan **не** меняет план на лету. Это транзакция:

1. **Freeze.** Остановить claim новых задач. `mission_phase = freezing`. Wake может доставлять события, но новые задачи не берутся.
2. **Drain.** Дождаться, пока все `running` задачи дойдут до `review`/`done`/`blocked`/`cancelled`. Таймаут: `max(step timeout, replanDrainMs)`, по умолчанию **20 минут**, настраиваемый. По таймауту — прервать сессию, `block(reason=replan_timeout)`, записать, сколько задач прервано.
3. **Snapshot.** Записать `replan/<n>/snapshot.json`: `boardSeq`, задачи, статусы, ветки, коммиты, gate, стоимость, drift, `planHash`, `missionHash`.
4. **Classify.** Для каждой затронутой задачи — один из четырёх классов по критериям ниже. Если меняется контракт — human approval.
5. **Apply.** Записать `plan-v<n+1>.json`, обновить задачи (`supersedes`), выполнить revert-ы **атомарно**, пометить `re-gate`, пересчитать ready-set.
6. **Resume.** `mission_phase = running`.

Любой сбой на шаге 2–5 → откат к snapshot и к git-состоянию до apply, старый план остаётся, `mission_phase = blocked`, человеку отчёт. **Fail-closed.**

### Apply atomicity

Главное правило: **apply не оставляет main полуоткаченным.**

1. Перед apply поставить tag `pre-replan-<n>` на текущий HEAD.
2. Все revert-ы делать на временной ветке `deus/replan-<n>` **или** через `git revert --no-commit` с одним коммитом в конце.
3. При конфликте или падении checks:
   - `git revert --abort` (если `--no-commit`);
   - `git reset --hard pre-replan-<n>` (если ветка);
   - удалить временную ветку;
   - main не тронут, старый план остаётся.
4. Только после всех revert-ов и зелёных checks — merge временной ветки или коммит в main.
5. Записать `revert_commit` в ledger, `mission_phase = running`.
6. Никаких «половина откачена, остальное потом». Либо всё, либо ничего.

### Кто имеет право на replan

- **Человек** — всегда.
- **Steward** — может предложить и выполнить replan в рамках контракта; при D3/D4 — только предложить, человек approves.
- **Worker-агент** — не может. CLI `deus mission replan` требует TTY/approval; сессиям worker-ов действие `replan` запрещено политикой.
- Replan не может расширить `workspace`, `protected_surfaces`, бюджет или права. Только сузить/переставить.

### Критерии классификации

| Класс | Когда | Кто решает |
|---|---|---|
| `keep` | Acceptance не изменился, checks те же, evidence всё ещё указывает на этот commit/branch | Steward |
| `re-gate` | Checks или acceptance изменились, но diff валиден и его можно перепроверить | Steward |
| `revert` | Acceptance больше не требует изменения, или оно ломает инвариант; merge уже в main | Steward + human, если D3 |
| `cancel` | Задача больше не входит в goal/non-goals | Human |

Спорный случай → `escalate` (D3), не «на глаз». Steward не может выбрать `keep` только потому, что переделывать дорого.

### Правила

- Replan запрещён, пока идёт merge (`merge_lock` занят). Сначала дождаться merge/post-gate.
- Не больше 3 replan на milestone; каждый — запись в `drift.md`.
- Смена контракта = replan + `deus mission approve` новой версии. Задачи классифицируются против нового acceptance.
- Задачи, уже `done`, не переоткрываются автоматически; для них `revert` или новая задача.
- Snapshot и apply используют общий `boardSeq`: события после snapshot либо применяются к новому плану, либо откатываются.

### Snapshot

```json
{
  "replanId": "replan-1",
  "missionId": "mission-...",
  "at": "2026-11-24T18:00:00Z",
  "boardSeq": 789,
  "preApplyTag": "pre-replan-1",
  "fromPlanHash": "...",
  "toPlanHash": "...",
  "missionHash": "...",
  "cost": 0.84,
  "tasks": [
    {
      "id": "bt-...",
      "status": "running",
      "branch": "deus/t-.../a1/run-...",
      "commit": "abc123",
      "gate": "passed",
      "classification": "keep"
    }
  ]
}
```

### Тесты

- freeze при running-задаче: drain ждёт, не теряет;
- drain timeout: сессия прервана, задача `blocked`, snapshot цел;
- kill между snapshot и apply → resume из snapshot;
- падение на втором revert → main не изменён, tag `pre-replan-<n>` на месте;
- два replan одновременно → второй `replan_in_progress`;
- replan во время merge → отказ;
- worker не может вызвать replan;
- `keep` без evidence → отказ;
- `revert`-классификация: merge откатан, post-gate;
- contract change без approve → отказ;
- события после `boardSeq` не теряются.

### Код

`src/v2/mission/phase.ts`, `replan.ts`, `replan-apply.ts`; board: `missions.phase`, `replan_snapshots`.

---

## 4. C4. Mission rollback

### Решение

1. **Merge ledger** — обязателен для всех миссий:
   ```
   merge_ledger(
     id, mission_id, task_id, attempt, branch, base_commit, merge_commit,
     merged_at, post_gate_status, revert_commit
   )
   ```
2. **Короткие миссии (< 20 ч или < 10 задач):** текущая модель (merge в основную ветку) + ledger. Откат:
   ```
   deus mission revert --mission <id> --to <checkpoint>
   ```
   Идёт по ledger в **обратном топологическом порядке** (не просто по времени), `git revert -m 1 <merge_commit>`, после каждого — checks. Конфликт → остановка, ветка `deus/revert-<id>`, человеку.
3. **Длинные миссии (≥ 20 ч или ≥ 10 задач):** integration-ветка `deus/mission-<id>`.
   - Все задачи мержатся в неё, не в main.
   - После каждого milestone — tag `deus/mission-<id>/cp-<n>`.
   - В main — один merge в конце, после mission acceptance.
   - Откат: reset ветки к checkpoint или revert одного mission-merge в main.
4. **Данные и миграции** не откатываются git-ом. Для них: snapshot БД, rollback-скрипт, D4-approval. Внешние эффекты (письма, API) — вне гарантии.
5. **Rollback drill** — обязательная часть пилота: откатить миссию в worktree с `node_modules` (symlink), замерить время.

### Integration-ветка: семантика

- `mission.mergeTarget: "main" | "mission-branch"`. Для длинных миссий — `mission-branch`.
- Task merge идёт в mission branch; post-gate запускается **там**; milestone tag только после зелёного post-gate.
- Финальный merge mission branch → main — один `--no-ff` merge. После него **обязательный post-gate на main**. Если он падает — `git revert -m 1` этого merge, main возвращается к состоянию до миссии; mission branch остаётся для разбора.
- На каждом milestone main вливается в mission branch (`git merge main`), чтобы не накопить конфликт к концу. Конфликт — human, не автоматический resolver.
- Две миссии на одном репо: каждая стартует от текущего main; перед milestone вливает main; откат возможен только до checkpoint, после которого нет чужих merge. Иначе — human.
- Пока mission branch не влита в main, main не трогается. Это и есть главная защита длинной миссии.

### Алгоритм `mission revert`

1. Проверить, что main чист и не detached.
2. Взять ledger до checkpoint; отсортировать **в обратном топологическом порядке** по `depends_on`, при равенстве — по времени назад.
3. Для каждого merge: `git revert -m 1 --no-edit <commit>`.
4. После каждого revert: checks; при провале — стоп, оставить revert-ветку.
5. Записать `revert_commit` в ledger, `mission_phase = reverted`.
6. Если конфликт: остановиться, не force-push, отчёт с конфликтными файлами.
7. Для длинной миссии: либо reset mission branch к checkpoint tag, либо один revert mission-merge в main — что выбрано в контракте.

### Тесты

- откат 5 merge подряд в топологическом порядке;
- конфликт в середине;
- post-gate после revert;
- mission branch: reset к checkpoint;
- финальный merge в main + post-gate; провал post-gate → revert mission-merge;
- main влит в mission branch на milestone;
- две миссии: откат первой не ломает вторую или останавливается с human;
- data migration: snapshot restore;
- повторный revert идемпотентен.

### Код

`src/v2/mission/rollback.ts`, `merge-target.ts`; board `merge_ledger`; CLI `deus mission revert`.

---

## 5. M1. Acceptance ledger

### Решение

Статус не хранится руками. Он **выводится** из append-only событий.

```
mission_acceptance(
  id, mission_id, text, check, manual_required, created_at
)

acceptance_events(
  id, acceptance_id, event, task_id, stage, kind, ref, commit,
  sha256, created_by, created_at, note
)
```

`stage`: `pre-merge | post-merge | manual`.
`kind`: `command | file | diff | signoff`.
`event`: `evidence | pass | fail | waive`.
`status` — view:

```
pending     # нет событий
evidenced   # есть pre-merge evidence
passed      # post-merge pass или manual signoff
failed      # post-merge fail
waived      # human waive
```

Правила:

- Прямой `UPDATE mission_acceptance.status` запрещён (trigger или view). Только события.
- Миссия `done` только когда **все** пункты `passed` или `waived`.
- Задача может быть `done` с локальным gate, а миссия — ещё `evidenced`: это нормально.
- Evidence содержит `commit` и `diffHash`: после rebase/merge видно, к какому состоянию относится проверка.
- Ручной пункт без артефакта `evidence/manual/<id>.md` (чеклист, ревьюер, дата, diff hash) не принимается.
- `waived` — это D3: причина, кто, когда, что приняли вместо проверки.
- **Проверка покрытия на этапе плана:** каждый acceptance item должен иметь хотя бы одну задачу с `acceptance: [id]` или явный manual-шаг. Если пункт не покрыт — план не запускается (`acceptance_uncovered`). Waive до старта — только human.

### CLI

```
deus acceptance status --mission <id>
deus acceptance coverage --mission <id>
deus acceptance evidence --mission <id> --id A1 --stage post-merge --kind command --ref run-.../gate.json --commit <sha>
deus acceptance signoff --mission <id> --id A3 --file evidence/manual/A3.md
deus acceptance waive --mission <id> --id A3 --reason "..." --approve
```

### Тесты

- план без покрытия A3 → отказ до первого change;
- прямой UPDATE status → отказ/триггер;
- задача прошла gate, post-merge упал → миссия не `done`;
- evidence с commit сохраняется после rebase;
- manual без файла → отказ;
- waive без approve → отказ;
- все passed → миссия `done`;
- evidence с тем же id идемпотентен.

### Код

`src/v2/mission/acceptance.ts`; board tables/view; CLI.

---

## 6. M2. D3 state machine

### Решение

D3 — это не «пауза ветки» на словах, а переход состояния.

1. **Фиксация.** Steward или человек создаёт `d3_checkpoint`:
   ```
   d3_checkpoints(id, mission_id, task_id, class, status, options_json,
                  deadline, created_at, resolved_at, resolution)
   ```
2. **Остановка задачи.**
   - Если `running`: `session.interrupt`, затем **дождаться** `outcome`/`idle` (не 2 секунды на глаз). Если сессия не остановилась за grace — убить процесс/сессию, только потом `board.block(task, actor=steward, reason=D3:<id>)`.
   - Если `review`: `board.block` сразу.
   - Если `done`: блокировать нельзя; D3 идёт в mission-level replan/revert.
   - После `block` не должно быть записей в worktree. Если сессия успела — worktree помечается `dirty_after_block`, новая попытка с чистого дерева.
3. **Зависимые/независимые.**
   - Сначала — явное поле `touches: ["src/a.ts", "src/b/"]` в плане. Оно задаёт пересечение точно.
   - Fallback: `git diff --name-only base..branch` у обеих задач.
   - `workspace: src/**` **не считается** доказательством независимости: это слишком грубо. Если точного `touches` нет — считать зависимой (fail-closed).
   - Зависимые: потомки по `depends_on` + пересечение `touches`/diff.
   - Независимые продолжаются.
4. **Глобальный D3.** Если затронут инвариант, `protected_surfaces` или acceptance миссии — `mission_phase = paused`, останавливаются все.
5. **Несколько D3.** Один активный D3 на задачу. Несколько на разные задачи — можно; глобальный D3 отменяет локальные. Приоритет: D4 > глобальный D3 > локальный D3.
6. **Решение.** `apply option` / `replan` / `cancel`; после — `d3_checkpoint.status = resolved`, задача возвращается в `backlog`/`review`. Старый worktree/branch после D3 считается stale: новая попытка создаёт новое дерево от текущего HEAD.
7. **Дедлайн.** Хранится с timezone (`2026-11-24T18:00:00+03:00`), уведомление — через канал из M7. Если человек не ответил — задача остаётся `blocked`, независимые идут; уведомление повторяется. Автоматического «разрешаю» нет.

### Права Steward

- `block`, `comment`, `rework` — да.
- `accept`, `cancel`, `approve contract`, `merge` — нет.
- Actor `steward` получает сервисный токен; без токена block разрешён только lead.

### Тесты

- block running-задачи: сессия реально остановлена, задача `blocked`, повторный claim невозможен;
- сессия пишет после block → `dirty_after_block`, новая попытка;
- независимая задача продолжается;
- зависимая ждёт;
- `src/**` не делает задачи независимыми;
- глобальный D3 → `paused`;
- два локальных D3 на разные задачи;
- deadline с timezone → blocked остаётся, уведомление;
- stale worktree после D3 → новое дерево;
- steward не может accept/cancel.

### Код

`src/v2/mission/d3.ts`, `src/v2/board.ts` (steward actor), CLI `deus d3 ...`.

---

## 7. M3. Recon mode

### Решение

Две фазы. Пилот идёт на phase 1.

**Phase 1 — file-only + runner evidence.**

- Recon-агенты получают `analyze` (edit/shell/subagent denied), читают файлы инструментами.
- Runner до recon собирает evidence и инжектит в промпт:
  - `git status --short`, `git log -5 --oneline`, `git diff --stat`;
  - baseline `npm test` / `typecheck` из gate (не перезапускать);
  - `rg --files | wc -l`, top-level tree, список тестов.
- Факт без `file:line` или runner-evidence — это гипотеза, а не факт.
- Read-инструменты тоже проверяют путь: только workspace, `realpath` внутри, без `/proc`, `/dev`, `/sys`, без `.env*`/ключей.

**Phase 2 — allowlist shell.**

`RECON_RULES` = `READ_ONLY_RULES` + shell только для:

```
git --no-pager log|show|diff|status|rev-parse|ls-files
rg --no-config (без --pre, --hostname-bin)
ls, cat, head, tail, wc
find (только workspace; без -exec/-delete/-ok/-fprintf/-fls)
```

Обязательная гигиена:

- запуск через `execFile(argv)`, **не** через shell-строку; метасимволы — вторая линия, не первая;
- env: `GIT_PAGER=cat`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_EXTERNAL_DIFF=`, `RIPGREP_CONFIG_PATH=`;
- `git --no-pager`; запрет `git config`, `checkout`, `reset`, `clean`, `commit`, `push`;
- `realpath` каждого пути внутри workspace; symlink, ведущий наружу, запрещён; `/proc`, `/dev`, `/sys` запрещены;
- `.env*`, `*.pem`, `*.key`, `.ssh`, `.aws`, `.gnupg` запрещены и для `cat`, и для `rg`, и для `find`;
- метасимволы `|`, `>`, `<`, `;`, `&&`, `||`, `$`, backtick, newline — запрещены;
- `find -fprintf`/`-fls` пишут файлы — запрещены наравне с `-exec`/`-delete`.

Это не песочница: allowlist — эвристика. Граница — контейнер/uid. Если нужна настоящая изоляция recon-а — отдельный контейнер с read-only монтированием.

### Тесты

- `git log` разрешён; `git log; rm -rf` запрещён;
- `GIT_PAGER=less git log` не запускает pager;
- `rg --files` разрешён; `rg --pre` запрещён; `RIPGREP_CONFIG_PATH` игнорируется;
- `cat src/a.ts` разрешён; `cat .env` запрещён;
- symlink `src/link -> /etc/passwd` → отказ;
- `cat /proc/self/environ` → отказ;
- `find . -exec rm` и `find . -fprintf` запрещены;
- phase 1 recon не может запустить shell;
- read-инструмент с абсолютным путём вне workspace → отказ.

### Код

`src/v2/mission/recon.ts`, `permissions.ts` (`RECON_RULES`), `path-guard.ts`; CLI `--recon-mode=file|allowlist`.

---

## 8. Что осталось открытым

Эти пункты сознательно не закрываются до пилота:

- M4 матрица деградации service/git/SQLite/provider/checks;
- M5 single-writer для drift/acceptance/cost;
- M6 evidence bundle для Steward и лимиты diff;
- M7 канал уведомлений и SLA;
- M8 метрики mission control;
- M10 drift budget и leading indicators;
- M11 миграция схемы контракта;
- M12 масштаб 200 задач и пагинация;
- M13 полная тест-матрица;
- M14 валидация mission/plan/steward/notes;
- M15 workspace/protected surfaces как граница (сейчас — декларация);
- M16 `cancelled` родитель и разблокировка детей.

Пилот даст данные, какие из них реальны на 10–20 часах, а какие ждут 100.

---

## 9. Порядок

1. **Перед пилотом** зафиксировать в этом документе решения, которые уже внесены: §0.1 (trust boundary), §1 (stable project id, approval history), §2 (export consistency, bundle вне проекта), §3 (apply atomicity, authority, classification), §5–§7.
2. **Пилот** использует ручные версии C1–C4, M1–M3 (см. `PILOT-LONG-HORIZON.md`). Код не обязателен.
3. **После пилота:** реализовать C1 + C2 (контракт + export), затем C3 + C4 (barrier + rollback), затем M1 + M2 + M3.
4. **До 100 часов:** закрыть M4–M13 по данным пилота.
5. Дизайн v2 пишется после пилота, а не до.

---

## 10. Что изменено после ревью 2026-11-24

| Из ревью | Куда внесено |
|---|---|
| A1 C3 partial apply | §3 «Apply atomicity»: tag, временная ветка / `revert --no-commit`, `abort`, main не трогается |
| A2 trust boundary | §0.1: prevented / detected / trusted, настоящая граница — uid/контейнер |
| A3 prompt injection | §1 п.4: структурированная инъекция, approval UI, lint |
| A4 project id | §1 п.2: stable id из git, `deus mission attach` |
| A5 approval history | §1 п.6: versioned approvals, `approval.log` hash-chain |
| A6 canonicalization | §1 «Канонизация»: JCS, duplicate keys, NFC, числа |
| A7 TTY | §1 п.3: TTY — speed bump, не контроль |
| B1 torn export | §2 п.2: граница волны, `boardSeq`, backup API |
| B2 bundle tamper | §2 п.3: bundle вне проекта, import сверяет manifest/approval |
| B3 rebuild completeness | §2 п.6: полный payload или обязательный snapshot |
| B4 RPO | §2 п.5: принятый риск одной волны, ограничение длины волны |
| B5 retention | §2 п.7: mission/ADR навсегда, runs/bundles по сроку |
| C1 replan authority | §3 «Кто имеет право на replan»: human/steward, worker denied |
| C2 classification | §3 «Критерии классификации»: keep/re-gate/revert/cancel |
| C3 drain timeout | §3 п.2: `max(step timeout, 20 мин)` |
| C4 snapshot cutoff | §3 п.3/§3 «Правила»: `boardSeq`, события после snapshot |
| C5 multiple D3 | §6 п.5: один на задачу, глобальный отменяет локальные |
| C6 stale worktree | §6 п.6: новая попытка с нового дерева |
| D2 integration branch | §4 «Integration-ветка: семантика»: mergeTarget, post-gate, final merge |
| D3 revert order | §4 «Алгоритм»: обратный топологический порядок |
| D4 multiple missions | §4: main в mission branch на milestone, откат до checkpoint |
| D5 data rollback | §4 п.4: snapshot + rollback-скрипт, D4 |
| D6 drill | §4 п.5: worktree с `node_modules`, не голый клон |
| E1 status | §5: append-only `acceptance_events`, status — view |
| E2 acceptance coverage | §5: `acceptance_uncovered` до старта |
| E3 file overlap | §6 п.3: `touches`, `src/**` не доказательство |
| E4 interrupt grace | §6 п.2: дождаться outcome или убить, `dirty_after_block` |
| E5 allowlist bypass | §7: `execFile`, env-санитайзинг, `--no-config`, symlink/realpath, `find` write flags |
| E6 kill drill | `PILOT-LONG-HORIZON.md`: pipeline `--resume` или team crashed-run recovery |
| E7 addendum integration | баннер в `DESIGN-LONG-HORIZON.md` |
| E8 pilot team/contract | `PILOT-LONG-HORIZON.md`: `--team-add`, contract injection |
| E9 recon baseline | `PILOT-LONG-HORIZON.md`: H2 переформулирован, без ложного A/B |
