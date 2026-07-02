import type Database from 'better-sqlite3';
import type { Config, ParsedQuery, Lang, SearchOptions } from '../types.ts';
import type { RawCandidate, SearchStrategy } from './types.ts';
import { getSynonyms } from './utils.ts';

export class Bm25Strategy implements SearchStrategy {
  constructor(private db: Database.Database, private config: Config) {}

  search(parsed: ParsedQuery, options?: SearchOptions): RawCandidate[] {
    if (parsed.tokens.length === 0) return [];

    const groups: string[] = [];
    const synonyms = options?.synonyms ?? this.config.synonyms;
    const bm25Limit = options?.bm25Limit ?? this.config.search.bm25Limit;
    for (const t of parsed.tokens) {
      const cleanToken = t.replace(/[^\p{L}\p{N}_]/gu, '');
      if (cleanToken.length === 0) continue;

      const syns = getSynonyms(cleanToken, synonyms);
      const terms = [cleanToken, ...syns];

      const formattedTerms = terms
        .map((term) => {
          const cleanTerm = term.replace(/[^\p{L}\p{N}_]/gu, '');
          if (cleanTerm.length === 0) return '';
          if (cleanTerm.length >= 2) {
            return `"${cleanTerm}"*`;
          }
          return `"${cleanTerm}"`;
        })
        .filter(Boolean);

      if (formattedTerms.length === 1) {
        groups.push(formattedTerms[0]);
      } else if (formattedTerms.length > 1) {
        groups.push(`(${formattedTerms.join(' OR ')})`);
      }
    }

    if (groups.length === 0) return [];
    const ftsQuery = groups.join(' AND ');

    const rows = this.db
      .prepare(
        `
        SELECT f.id, f.path, f.lang,
               rank AS bm25_score
        FROM sc_content_fts AS c
        JOIN sc_files AS f ON f.path = c.path
        WHERE content_fts MATCH ?
        ORDER BY bm25_score ASC
        LIMIT ?
        `
      )
      .all(ftsQuery, bm25Limit) as {
      id: number;
      path: string;
      lang: Lang;
      bm25_score: number;
    }[];

    const minScore = rows.length ? Math.min(...rows.map((r) => r.bm25_score)) : 0;
    const maxScore = rows.length ? Math.max(...rows.map((r) => r.bm25_score)) : 0;
    const range = maxScore - minScore || 1;

    return rows.map((r) => ({
      fileId: r.id,
      path: r.path,
      lang: r.lang,
      bm25Score: 1 - (r.bm25_score - minScore) / range,
      symbolScore: 0,
      importScore: 0,
      pathScore: 0,
      matchedSymbols: [],
      matchedImports: [],
    }));
  }
}
