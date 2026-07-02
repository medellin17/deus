/**
 * Tokenizer for BM25 indexing and query parsing.
 * Splits camelCase and snake_case into separate tokens so that
 * `getUserData` becomes `get User Data` and `get_user_data` becomes `get user data`.
 */

export function splitCamelCase(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z0-9])/g, '$1 $2');
}

export function splitSnakeCase(input: string): string {
  return input.replace(/_/g, ' ');
}

export function tokenizeForIndex(text: string): string {
  let out = text;
  out = splitSnakeCase(out);
  out = splitCamelCase(out);
  return out;
}

export function normalizeQuery(query: string): string {
  // Lowercase and remove extra punctuation, but keep cyrillic/alphanumeric
  return query
    .replace(/[^\p{L}\p{N}_\.\/\-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function tokenizeQuery(query: string): string[] {
  const expanded = tokenizeForIndex(query);
  const normalized = normalizeQuery(expanded);
  return normalized
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1 || /[\p{L}]/u.test(t));
}

export function extractEntities(text: string): string[] {
  const entities: string[] = [];
  // camelCase / PascalCase identifiers
  const camel = text.match(/\b[a-zA-Z_][a-zA-Z0-9_]*[A-Z][a-zA-Z0-9_]*\b|\b[A-Z][a-zA-Z0-9_]*\b/g) ?? [];
  // snake_case identifiers
  const snake = text.match(/\b[a-zA-Z_][a-zA-Z0-9_]*_[a-zA-Z0-9_]+\b/g) ?? [];
  // quoted strings
  const quoted = text.match(/['"`]([^'"`]+)['"`]/g) ?? [];
  for (const id of camel) {
    entities.push(id);
    const split = splitCamelCase(id).split(/\s+/).filter(Boolean);
    entities.push(...split);
  }
  for (const id of snake) {
    entities.push(id);
    const split = id.split('_').filter(Boolean);
    entities.push(...split);
  }
  for (const q of quoted) {
    const inner = q.slice(1, -1);
    if (inner.length > 1) entities.push(inner);
  }
  return Array.from(new Set(entities));
}

import { EXT_LANG_MAP } from './scanner.ts';

const EXTENSIONS_FOR_REGEX = Object.keys(EXT_LANG_MAP).map(e => e.slice(1)).join('|');
const singleFileRegex = new RegExp(`\\b[\\w\\-]+\\.(?:${EXTENSIONS_FOR_REGEX})\\b`, 'g');

export function extractPathFragments(text: string): string[] {
  const pathsRegex = /[\w\-\.@~]+(?:[/\\][\w\-\.]+)+/g;

  const matches: string[] = [];

  const pathMatches = text.match(pathsRegex) ?? [];
  
  // Replace path matches with spaces to avoid duplicate extraction of their components
  let remainingText = text;
  for (const pm of pathMatches) {
    remainingText = remainingText.replaceAll(pm, ' ');
  }

  const singleMatches = remainingText.match(singleFileRegex) ?? [];

  for (const m of [...pathMatches, ...singleMatches]) {
    // Normalize backslashes to forward slashes
    const normalized = m.replace(/\\/g, '/');
    
    // Get the base name (without extension)
    const segments = normalized.split('/');
    const lastSegment = segments[segments.length - 1];
    
    const dotIndex = lastSegment.lastIndexOf('.');
    const baseName = dotIndex !== -1 ? lastSegment.slice(0, dotIndex) : lastSegment;
    
    if (baseName.length >= 2) {
      matches.push(normalized);
    }
  }

  return Array.from(new Set(matches));
}
