import type Database from 'better-sqlite3';
import type { Config, ParsedQuery, Lang } from '../types.ts';
import type { RawCandidate, SearchStrategy } from './types.ts';

export class ImportStrategy implements SearchStrategy {
  constructor(private db: Database.Database, private config: Config) {}

  search(parsed: ParsedQuery): RawCandidate[] {
    if (parsed.paths.length === 0) return [];
    const candidates = new Map<number, RawCandidate>();
    for (const p of parsed.paths) {
      const lastPart = p.split(/[/\\]/).pop() || '';
      const queryBasename = lastPart.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/i, '');

      const rows = this.db
        .prepare(
          `
          SELECT i.file_id, f.path, f.lang, i.imported_module
          FROM sc_imports i
          JOIN sc_files f ON f.id = i.file_id
          WHERE i.imported_basename = ?
          `
        )
        .all(queryBasename) as {
        file_id: number;
        path: string;
        lang: Lang;
        imported_module: string;
      }[];
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
        c.matchedImports.push(r.imported_module);
        c.importScore += 0.5;
      }
    }
    return Array.from(candidates.values());
  }
}
