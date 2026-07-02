import type Database from 'better-sqlite3';
import type { Config, ParsedQuery, Lang } from '../types.ts';
import type { RawCandidate, SearchStrategy } from './types.ts';
import { levenshtein } from './utils.ts';

export class SymbolStrategy implements SearchStrategy {
  constructor(private db: Database.Database, private config: Config) {}

  search(parsed: ParsedQuery): RawCandidate[] {
    if (parsed.entities.length === 0) return [];
    const candidates = new Map<number, RawCandidate>();
    for (const entity of parsed.entities) {
      let rows = this.db
        .prepare(
          `
          SELECT s.file_id, f.path, f.lang, s.name, s.type
          FROM sc_symbols s
          JOIN sc_files f ON f.id = s.file_id
          WHERE s.name LIKE ?
          `
        )
        .all(`%${entity}%`) as {
        file_id: number;
        path: string;
        lang: Lang;
        name: string;
        type: string;
      }[];

      let isFuzzy = false;
      const similarities = new Map<string, number>();

      if (rows.length === 0 && entity.length >= 3) {
        const minLen = Math.max(1, entity.length - 3);
        const maxLen = entity.length + 3;
        const fuzzyCandidates = this.db
          .prepare(
            `
            SELECT s.file_id, f.path, f.lang, s.name, s.type
            FROM sc_symbols s
            JOIN sc_files f ON f.id = s.file_id
            WHERE length(s.name) BETWEEN ? AND ?
            ORDER BY s.id ASC
            LIMIT 500
            `
          )
          .all(minLen, maxLen) as {
          file_id: number;
          path: string;
          lang: Lang;
          name: string;
          type: string;
        }[];

        const matches: { row: typeof fuzzyCandidates[0]; similarity: number }[] = [];
        for (const row of fuzzyCandidates) {
          const dist = levenshtein(entity.toLowerCase(), row.name.toLowerCase());
          const maxLenVal = Math.max(entity.length, row.name.length);
          const similarity = 1 - dist / maxLenVal;
          if (similarity >= 0.7) {
            matches.push({ row, similarity });
          }
        }

        matches.sort((a, b) => b.similarity - a.similarity);
        const topMatches = matches.slice(0, 5);
        rows = topMatches.map((m) => m.row);
        for (const m of topMatches) {
          similarities.set(`${m.row.file_id}:${m.row.name}`, m.similarity);
        }
        isFuzzy = true;
      }

      for (const r of rows) {
        if (!candidates.has(r.file_id)) {
          candidates.set(r.file_id, {
            fileId: r.file_id,
            path: r.path,
            lang: r.lang,
            bm25Score: 0,
            symbolScore: 0,
            importScore: 0,
            pathScore: 0,
            matchedSymbols: [],
            matchedImports: [],
          });
        }
        const c = candidates.get(r.file_id)!;
        c.matchedSymbols.push(`${r.type}:${r.name}`);
        if (isFuzzy) {
          const sim = similarities.get(`${r.file_id}:${r.name}`) ?? 0.7;
          c.symbolScore += sim * 0.8;
        } else {
          c.symbolScore += r.name === entity ? 1.0 : 0.5;
        }
      }
    }
    return Array.from(candidates.values());
  }
}
