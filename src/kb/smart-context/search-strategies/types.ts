import type { Lang, ParsedQuery, SearchOptions } from '../types.ts';

export interface RawCandidate {
  fileId: number;
  path: string;
  lang: Lang;
  bm25Score: number;
  symbolScore: number;
  importScore: number;
  pathScore: number;
  matchedSymbols: string[];
  matchedImports: string[];
}

export interface SearchStrategy {
  search(parsed: ParsedQuery, options?: SearchOptions): RawCandidate[];
}
