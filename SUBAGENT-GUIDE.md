# Полная инструкция: как сделать так, чтобы агент вызывал других агентов в OpenCode

> Инструкция для настройки вложенных вызовов агентов (nested subagents) в OpenCode через `.opencode/agents/*.md`.

## Что нужно знать

- Агенты в OpenCode бывают двух режимов: `primary` и `subagent`.
- `primary` — агент, с которым общается пользователь напрямую.
- `subagent` — агент, которого можно вызвать из другого агента через инструмент `task()`.
- Один subagent **может** вызывать другого subagent, если у него есть разрешение `task`.

## Минимальные условия для вызова subagent

1. Вызываемый агент должен иметь `mode: subagent`.
2. Вызывающий агент должен иметь `permission.task` с `allow` на имя вызываемого агента.
3. Оба агента должны быть в `.opencode/agents/*.md`.
4. В промпте вызывающего агента должна быть инструкция использовать `task({ subagent_type: "..." })`.

## Структура файлов

```text
project/
└── .opencode/
    ├── agents/
    │   ├── conductor.md          # primary, вызывает planner
    │   ├── planner.md            # subagent, вызывает researcher
    │   ├── researcher.md         # subagent, только читает
    │   └── implementer.md        # subagent, пишет код
    └── opencode.json             # опционально, для model/thinking
```

## Пример 1. Primary агент вызывает subagent

### `.opencode/agents/conductor.md`

```markdown
---
description: Main orchestrator that delegates to planner
mode: primary
model: opencode-go/deepseek-v4-pro
temperature: 0.2
permission:
  edit: deny
  read:
    "*": deny
    "*.md": allow
  glob: deny
  grep: deny
  bash:
    "*": deny
  task:
    "*": deny
    planner: allow
---

# Conductor

You are the conductor. You do not execute work yourself. You delegate to subagents via `task()`.

When you need a plan, call:

```ts
task({
  description: "Create implementation plan",
  prompt: `We need to implement: <describe feature>. Return a detailed plan with files and steps.`,
  subagent_type: "planner"
})
```

Return the planner's response to the user.
```

### `.opencode/agents/planner.md`

```markdown
---
description: Creates implementation plans
mode: subagent
model: opencode-go/deepseek-v4-flash
temperature: 0.2
permission:
  edit: deny
  read:
    "*": deny
    "*.md": allow
  glob: deny
  grep: deny
  bash:
    "*": deny
  task:
    "*": deny
---

# Planner

You are a planner. Read the relevant documentation and create a step-by-step implementation plan.

Do not write code. Only return the plan.
```

## Пример 2. Subagent вызывает другого subagent (nested)

### `.opencode/agents/nested-caller.md`

```markdown
---
description: Middle subagent that calls nested-target
mode: subagent
model: opencode-go/deepseek-v4-flash
temperature: 0.2
permission:
  edit: deny
  read:
    "*": deny
    "*.md": allow
    ".deus/*": allow
  glob: deny
  grep: deny
  bash:
    "*": deny
  task:
    "*": deny
    nested-target: allow
---

# Nested Caller

Your job: call `nested-target` via `task()` and return its response.

Use exactly:

```ts
task({
  description: "Call nested target",
  prompt: `Create a proof file at .deus/nested-proof.txt and confirm.`,
  subagent_type: "nested-target"
})
```

After receiving the response, read `.deus/nested-proof.txt` and return the full report.
```

### `.opencode/agents/nested-target.md`

```markdown
---
description: Inner subagent that creates a proof file
mode: subagent
model: opencode-go/deepseek-v4-flash
temperature: 0.2
permission:
  edit:
    "*": deny
    ".deus/*": allow
  read:
    "*": deny
    "*.md": allow
    ".deus/*": allow
  glob: deny
  grep: deny
  bash:
    "*": deny
  task:
    "*": deny
---

# Nested Target

Create `.deus/nested-proof.txt` with:

```text
Proof file created by nested-target.
```

Return exactly:

```text
[NESTED-TARGET-DONE]
Created .deus/nested-proof.txt
```
```

### `.opencode/agents/test-conductor.md`

```markdown
---
description: Primary agent that starts nested subagent chain
mode: primary
model: opencode-go/deepseek-v4-flash
temperature: 0.2
permission:
  edit: deny
  read:
    "*": deny
    "*.md": allow
    ".deus/*": allow
  glob: deny
  grep: deny
  bash:
    "*": deny
  task:
    "*": deny
    nested-caller: allow
---

# Test Conductor

Call `nested-caller` via `task()` and ask it to call `nested-target`. Return the full chain of responses.
```

## Проверка в TUI

1. Открой папку проекта в терминале:
   ```bash
   cd /path/to/project
   opencode
   ```

2. Переключись на агента `test-conductor`:
   - `Tab` → выбери `test-conductor` → `Enter`.

3. Отправь промпт:
   ```text
   Call nested-caller and ask it to call nested-target. Return the full chain of responses.
   ```

4. Дождись ответа.

5. Проверь созданный файл:
   ```bash
   cat .deus/nested-proof.txt
   ```

6. Проверь дочерние сессии:
   - В TUI выполни `/sessions`.
   - Или открой `opencode web`.

## Проверка через API

Если хочешь автоматизировать:

```bash
# 1. Запустить сервер
opencode serve --port 4097 --hostname 127.0.0.1

# 2. Создать сессию
curl -u opencode:<password> -X POST http://127.0.0.1:4097/session \
  -H "Content-Type: application/json" \
  -d '{"title":"nested test"}'

# 3. Отправить prompt_async (замени <session-id>)
curl -u opencode:<password> -X POST \
  http://127.0.0.1:4097/session/<session-id>/prompt_async \
  -H "Content-Type: application/json" \
  -d '{"agent":"test-conductor","parts":[{"type":"text","text":"Call nested-caller"}]}'

# 4. Получить сообщения
curl -s -u opencode:<password> \
  http://127.0.0.1:4097/session/<session-id>/message
```

## Частые ошибки

### 1. Агент не видит инструмент `task`

Причина: у него нет `permission.task.allow` ни на одного агента.

Решение: добавь в frontmatter:
```yaml
permission:
  task:
    "*": deny
    target-agent: allow
```

### 2. Subagent не создаётся

Причина: в `.md` файле нет `mode: subagent`.

Решение: добавь:
```yaml
mode: subagent
```

### 3. Subagent не может вызвать другого subagent

Причина: у него нет `permission.task` на целевого агента.

Решение: в `.md` вызывающего subagent добавь:
```yaml
permission:
  task:
    "*": deny
    another-subagent: allow
```

### 4. Изменения не применились

Причина: OpenCode сервер кэширует конфигурацию.

Решение: закрой TUI и открой заново, либо перезапусти `opencode serve`.

## Приоритет настроек

Если агент описан и в `.md`, и в `.opencode/opencode.json`, **приоритет у `opencode.json`**.

Рекомендация:
- Держи описание агента, промпт и базовые permissions в `.md`.
- В `opencode.json` оставь только то, что нельзя задать в `.md`: `thinking`, сложные model-настройки, plugin-регистрацию.

## Чеклист для nested subagents

- [ ] У вызывающего агента `mode: primary` или `subagent`.
- [ ] У вызываемого агента `mode: subagent`.
- [ ] У вызывающего агента в `permission.task` есть `allow` на имя вызываемого.
- [ ] Оба `.md` файла лежат в `.opencode/agents/`.
- [ ] В промпте вызывающего агента есть пример `task({ subagent_type: "..." })`.
- [ ] После изменений конфига сервер перезапущен.
- [ ] В TUI видны дочерние сессии после вызова.
