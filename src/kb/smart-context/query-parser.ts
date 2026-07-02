import type { ParsedQuery, QueryCategory } from './types.ts';
import { tokenizeQuery, extractEntities, extractPathFragments } from './tokenizer.ts';

const CATEGORY_HINTS: Record<QueryCategory, string[]> = {
  bugfix: ['баг', 'ошибка', 'error', 'bug', 'fix', 'исправ', 'почин', 'падает', 'не работает', 'broken', 'crash', 'exception'],
  feature: ['добав', 'feature', 'реализ', 'сделай', 'создай', 'implement', 'add', 'новый', 'new', 'внедри'],
  refactor: ['рефактор', 'refactor', 'перепис', 'rewrite', 'clean', 'cleanup', 'упрости', 'simplify', 'перенес'],
  style: ['стиль', 'style', 'css', 'theme', 'цвет', 'дизайн', 'design', 'верст', 'layout', 'ui', 'ux'],
  config: ['конфиг', 'config', 'настрой', 'setting', 'env', 'yaml', 'json', 'webpack', 'vite'],
  default: [],
};

const FOLLOW_UP_WORDS = ['там', 'тут', 'тоже', 'также', 'еще', 'ещё', 'и', 'а', 'но', 'значит'];

export function detectCategory(query: string): QueryCategory {
  const lower = query.toLowerCase();
  let best: QueryCategory = 'default';
  let bestScore = 0;
  for (const [cat, hints] of Object.entries(CATEGORY_HINTS) as [QueryCategory, string[]][]) {
    if (cat === 'default') continue;
    let score = 0;
    for (const h of hints) {
      if (lower.includes(h)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = cat;
    }
  }
  return best;
}

export function parseQuery(raw: string, previousCategory: QueryCategory = 'default'): ParsedQuery {
  const category = detectCategory(raw);
  const effectiveCategory: QueryCategory = category === 'default' ? previousCategory : category;
  const inheritsCategory = category === 'default' && previousCategory !== 'default';
  const tokens = tokenizeQuery(raw);
  const entities = extractEntities(raw);
  const paths = extractPathFragments(raw);
  const lower = raw.toLowerCase().trim();
  const FOLLOW_UP_REGEX = /^(там|тут|тоже|также|еще|ещё|и|а|но|значит)(?![a-zA-Zа-яА-ЯёЁ0-9_])/i;
  const isFollowUp = FOLLOW_UP_REGEX.test(lower);

  return {
    raw,
    category: effectiveCategory,
    tokens,
    entities,
    paths,
    isFollowUp,
    inheritsCategory,
  };
}
