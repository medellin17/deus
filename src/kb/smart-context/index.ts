import type Database from 'better-sqlite3';
import { loadConfig } from './config.ts';
import { parseQuery } from './query-parser.ts';
import { SearchEngine } from './search.ts';
import { SymbolGraph } from './graph.ts';
import { Ranker } from './ranker.ts';
import { buildContext } from './budget.ts';
import { buildIndex } from './indexer.ts';
import type { Config, SearchResult, AssembledContext } from './types.ts';
import type { RawCandidate } from './search-strategies/types.ts';

export class SmartContextEngine {
  private config: Config;

  constructor(private db: Database.Database) {
    this.config = loadConfig();
  }

  async indexDirectory(projectRoot: string): Promise<void> {
    await buildIndex(this.db, projectRoot, this.config);
  }

  search(query: string, projectRoot: string, topN: number = 10): string {
    const parsed = parseQuery(query);
    const graph = new SymbolGraph(this.db);
    const engine = new SearchEngine(this.db, this.config, graph);
    const candidates: RawCandidate[] = engine.search(parsed, []);
    const ranker = new Ranker(this.db, this.config, graph);
    const ranked: SearchResult[] = ranker.rank(candidates, parsed);
    const top = ranked.slice(0, topN);

    if (top.length === 0) {
      return `No results found for: "${query}". Try indexing the project first.`;
    }

    const context = buildContext(top, projectRoot, this.config, parsed.tokens);
    return context.text;
  }
}

export type { SearchResult, AssembledContext, Config } from './types.ts';
