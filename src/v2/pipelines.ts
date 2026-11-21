import type { PermissionRule, PipelineStepDef } from "./types.ts";

export const READ_ONLY_RULES: PermissionRule[] = [
  { action: "edit", resource: "*", effect: "deny" },
  { action: "shell", resource: "*", effect: "deny" },
  { action: "subagent", resource: "*", effect: "deny" },
];

const PLANNING_PROMPT = `Исследуй проект в текущей рабочей директории и составь план реализации задачи.

## Задача

{task}

## Требования

- Только чтение: не изменяй файлы и не запускай команды.
- Найди конкретные файлы, которые нужно изменить, и существующие паттерны.
- Дай пошаговый план, список рисков и команды проверки.
- Формат: markdown, кратко и по делу.`;

const IMPLEMENTATION_PROMPT = `Реализуй задачу по плану ниже.

## Задача

{task}

## План

{prev}

## Правила

- Минимальный дифф. Не рефактори несвязанный код.
- Следуй существующим паттернам проекта.
- После изменений запусти доступные тесты, линтер или сборку.
- В конце верни: изменённые файлы, выполненные команды и их результат, оставшиеся риски.`;

const REVIEW_PROMPT = `Проверь реализацию. Только чтение: не изменяй файлы и не запускай команды.

## Задача

{task}

## Отчёт реализации

{prev}

## Текущий diff

{diff}

## Формат

Найди проблемы в порядке важности:
- **Критично** — сломает работу, потеря данных, безопасность.
- **Важно** — неверная логика, пропущенные edge cases, отсутствующие тесты.
- **Предложение** — стиль, читаемость, необязательные улучшения.

Для каждой находки укажи файл и строку. Если проблем нет — напиши это явно.`;

const FIX_INVESTIGATION_PROMPT = `Найди причину бага и предложи минимальный фикс.

## Задача

{task}

## Требования

- Только чтение: не изменяй файлы и не запускай команды.
- Найди точное место ошибки и объясни root cause.
- Предложи минимальный фикс и regression-тест.
- Укажи файлы, функции и риски.`;

const FIX_IMPLEMENTATION_PROMPT = `Исправь баг по плану ниже.

## Задача

{task}

## План

{prev}

## Правила

- Исправляй причину, а не симптом. Минимальный дифф.
- Добавь regression-тест, который падает без фикса.
- Запусти доступные тесты.
- В конце верни: изменённые файлы, команды и результаты, остаточные риски.`;

const FIX_REVIEW_PROMPT = `Проверь исправление бага. Только чтение: не изменяй файлы и не запускай команды.

## Задача

{task}

## Отчёт об исправлении

{prev}

## Текущий diff

{diff}

## Формат

- **Критично** — фикс не устраняет root cause, ломает поведение, нет regression-теста.
- **Важно** — неполный edge case, хрупкий тест, побочные изменения.
- **Предложение** — стиль и необязательные улучшения.

Для каждой находки укажи файл и строку. Если проблем нет — напиши это явно.`;

const AUDIT_SURVEY_PROMPT = `Изучи проект и определи область аудита.

## Задача

{task}

## Требования

- Только чтение: не изменяй файлы и не запускай команды.
- Определи точки входа, границы модулей и высокорисковые места.
- Составь карту файлов, которые нужно проверить.`;

const AUDIT_REVIEW_PROMPT = `Проведи аудит по карте ниже. Только чтение.

## Задача

{task}

## Карта проекта

{prev}

## Формат

Находки в порядке важности:
- **Критично** — уязвимость, потеря данных, сломанная логика.
- **Важно** — неверные допущения, отсутствующие проверки, хрупкие места.
- **Предложение** — улучшения.

Для каждой находки: файл, строка, сценарий эксплуатации или поломки, рекомендация. Если проблем нет — напиши это явно.`;

const AUDIT_SYNTHESIS_PROMPT = `Собери итоговый отчёт по аудиту.

## Задача

{task}

## Находки

{prev}

## Требования

- Убери дубли и отсортируй по риску.
- Для каждой находки: приоритет, файл, суть, что делать.
- В конце дай короткий план исправлений.
- Не изменяй файлы.`;

export const PIPELINES: Record<string, PipelineStepDef[]> = {
  build: [
    {
      id: "plan",
      agent: "plan",
      permissions: READ_ONLY_RULES,
      task: PLANNING_PROMPT,
    },
    {
      id: "implement",
      agent: "build",
      task: IMPLEMENTATION_PROMPT,
    },
    {
      id: "review",
      agent: "build",
      permissions: READ_ONLY_RULES,
      task: REVIEW_PROMPT,
    },
  ],
  fix: [
    {
      id: "investigate",
      agent: "plan",
      permissions: READ_ONLY_RULES,
      task: FIX_INVESTIGATION_PROMPT,
    },
    {
      id: "fix",
      agent: "build",
      task: FIX_IMPLEMENTATION_PROMPT,
    },
    {
      id: "verify",
      agent: "build",
      permissions: READ_ONLY_RULES,
      task: FIX_REVIEW_PROMPT,
    },
  ],
  audit: [
    {
      id: "survey",
      agent: "plan",
      permissions: READ_ONLY_RULES,
      task: AUDIT_SURVEY_PROMPT,
    },
    {
      id: "audit",
      agent: "build",
      permissions: READ_ONLY_RULES,
      task: AUDIT_REVIEW_PROMPT,
    },
    {
      id: "synthesize",
      agent: "build",
      permissions: READ_ONLY_RULES,
      task: AUDIT_SYNTHESIS_PROMPT,
    },
  ],
};

export function getPipeline(name: string): PipelineStepDef[] {
  const pipeline = PIPELINES[name];
  if (!pipeline) {
    throw new Error(
      `unknown pipeline "${name}". Available: ${Object.keys(PIPELINES).join(", ")}`,
    );
  }
  return pipeline;
}
