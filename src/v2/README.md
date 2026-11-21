# Deus V2 runner

Детерминированный раннер автономных прогонов поверх OpenCode 2.x.

Он не поднимает свой сервер и не использует V1 SDK. Раннер подключается к общему
OpenCode-сервису через `@opencode/client`, создаёт отдельную сессию на каждый шаг,
сам отвечает на permission-запросы и сохраняет чекпоинт после каждого шага.

## Требования

- OpenCode 2.x с запущенным сервисом (`opencode` уже работает; `Service.discover()` найдёт его).
- Node.js 20+ (проверено на Node 26).
- Git-репозиторий в целевом проекте (для изоляции в worktree; можно отключить `--no-worktree`).

## Быстрый старт

```bash
npm install
npm run v2:smoke
```

`smoke` проверяет связку «сервис → модель → сессия → ответ» без изменения проекта.

Пайплайн:

```bash
npm run v2 -- --cwd /path/to/project --pipeline build "Добавь multiply(a, b) в math.js и тест"
```

## Пайплайны

| Пайплайн | Шаги | Когда |
|---|---|---|
| `build` | `plan` → `implement` → `review` | Новая фича или изменение |
| `fix` | `investigate` → `fix` → `verify` | Баг с неизвестной причиной |
| `audit` | `survey` → `audit` → `synthesize` | Аудит без изменений в коде |

`plan`, `investigate`, `survey`, `review`, `verify`, `audit`, `synthesize` работают
с запретом на `edit`, `shell` и `subagent`. Реализация (`implement`, `fix`) получает
полный доступ, но её действия ограничены permission-политикой и worktree.

## Один агент

```bash
npm run v2 -- --cwd /path/to/project --direct --agent build "Почини тест в math.test.js"
```

`--direct` не запускает пайплайн: один шаг, один агент.

## Resume

Если процесс убит или получил `Ctrl+C`, раннер прерывает активную сессию и пишет
чекпоинт. Продолжить:

```bash
npm run v2 -- --cwd /path/to/project --resume run-20261121T114203
```

Успешные шаги не повторяются. Повторяется только шаг, который был прерван или упал.
Worktree и модель берутся из чекпоинта; `--model` можно передать явно.

## Worktree

По умолчанию прогон идёт в отдельном git worktree:

```
<project>/.deus/worktrees/<runId>
```

Это защищает основное дерево от изменений агента. Незакоммиченные изменения в
основное дерево **не попадают** — worktree создаётся от `HEAD`. Если нужен прямой
прогон:

```bash
npm run v2 -- --no-worktree ...
```

После успешного прогона worktree остаётся для ревью:

```bash
git -C <project>/.deus/worktrees/<runId> diff
```

Удалить worktree после успеха: `--cleanup` (изменения будут потеряны, если их не
перенести в основное дерево).

## Permission-политика

По умолчанию раннер разрешает обычные команды и запрещает опасные:

- `git push`
- `git reset --hard`
- `git clean -f`
- `rm -rf /`
- `sudo`
- `mkfs`, `dd if=`
- `shutdown`, `reboot`
- `curl | sh`, `wget | bash`

Свой файл: `.deus/policy.json` в проекте или `--policy <file>`.

```json
{
  "default": "allow",
  "rules": [
    { "match": "git push", "decision": "deny", "reason": "push is a human decision" },
    { "match": "npm test", "decision": "allow", "reason": "tests are safe" }
  ]
}
```

Правила применяются по порядку, побеждает последнее совпадение. `match` — регулярное
выражение по строке `action resource`. Решение `deny` отправляется агенту как
`reject`; решение `allow` — как `once`.

Важно: `ask` в permission-настройках OpenCode в headless-сессии может не дождаться
интерактивного подтверждения. Для чувствительных путей используйте `deny` на уровне
agent/session permissions или policy.

## Чекпоинты и артефакты

```
<project>/.deus/
├── runs/<runId>/
│   ├── run.json          # состояние, шаги, стоимость
│   ├── run.md            # сводка
│   ├── step-00-plan.md
│   ├── step-01-implement.md
│   └── step-02-review.md
└── worktrees/<runId>/    # изолированное дерево
```

`run.json` обновляется после каждого шага. Если процесс убит между шагами,
`--resume` продолжит с незавершённого шага.

## Модель и стоимость

По умолчанию:

```
opencode-go/deepseek-v4.1-flash#max
```

Переопределить: `--model opencode-go/deepseek-v4.1-flash#high`.

Провайдер не всегда отдаёт стоимость сессии, поэтому при нулевой стоимости раннер
считает её по токенам и таблице цен (`src/v2/pricing.ts`). Это оценка, а не биллинг.
Лимит: `--max-cost 0.05`.

## Ограничения текущего среза

- Нет LLM-conductor: пайплайн фиксирован. Планировщик, который сам выбирает шаги,
  будет отдельным слоем поверх стабильного раннера.
- Нет параллельных шагов и DAG в V2-раннере (старый `src/dag` пока не подключён).
- Нет автоматического merge worktree в основное дерево: изменения ревьюятся вручную.
- KB/smart-context из старого deus не подключены к V2-раннеру.
- Сессии по умолчанию сохраняются для отладки. Их можно удалить через TUI/API.

## Тесты

```bash
npm run typecheck
npm test
```

Юнит-тесты покрывают порядок шагов, подстановку `{task}/{prev}`, resume, лимит
стоимости, abort и permission-политику. Реальный smoke:

```bash
npm run v2:smoke
```

## Файлы

| Файл | Назначение |
|---|---|
| `src/v2/client.ts` | Подключение к общему V2-сервису, разбор `provider/model#variant` |
| `src/v2/executor.ts` | Одна сессия: prompt, permission, ожидание, финальный ответ |
| `src/v2/pipeline.ts` | Шаги, чекпоинты, resume, артефакты, стоимость |
| `src/v2/pipelines.ts` | Определения `build`, `fix`, `audit` |
| `src/v2/permissions.ts` | Политика разрешений |
| `src/v2/pricing.ts` | Оценка стоимости по токенам |
| `src/v2/worktree.ts` | Создание и удаление git worktree |
| `src/v2/cli.ts` | CLI |
