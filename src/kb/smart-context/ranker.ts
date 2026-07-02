import type Database from 'better-sqlite3';
import type { Config, ParsedQuery, SearchResult, SearchOptions, SearchWeights } from './types.ts';
import type { RawCandidate } from './search-strategies/types.ts';
import { getCategoryWeights, confidenceWeight } from './config.ts';
import { SymbolGraph } from './graph.ts';
import { HUB_MIN_DEGREE_MULTIPLIER, BARREL_PENALTY_MULTIPLIER, BARREL_PATH_SCORE_THRESHOLD } from './constants.ts';

export class Ranker {
  constructor(private db: Database.Database, private config: Config, private graph: SymbolGraph) {}

  rank(candidates: RawCandidate[], parsed: ParsedQuery, options?: SearchOptions): SearchResult[] {
    let weights = getCategoryWeights(this.config, parsed.category);
    if (options?.weights) {
      const mergeWeights = (base: SearchWeights, partial?: Partial<SearchWeights>): SearchWeights => {
        if (!partial) return base;
        const merged = { ...base };
        const keys: (keyof SearchWeights)[] = ['text', 'symbol', 'import', 'ema', 'hub', 'path'];
        for (const key of keys) {
          if (partial[key] !== undefined) {
            merged[key] = partial[key] as number;
          }
        }
        return merged;
      };

      const weightKeys: (keyof SearchWeights)[] = ['text', 'symbol', 'import', 'ema', 'hub', 'path'];
      const hasDirectWeightKey = weightKeys.some(key => key in (options.weights as object));

      if (hasDirectWeightKey) {
        weights = mergeWeights(weights, options.weights as Partial<SearchWeights>);
      } else {
        const catWeights = (options.weights as Record<string, Partial<SearchWeights>>)[parsed.category] || (options.weights as Record<string, Partial<SearchWeights>>).default;
        if (catWeights) {
          weights = mergeWeights(weights, catWeights);
        }
      }
    }
    const validateWeights = (w: SearchWeights): void => {
      for (const [key, value] of Object.entries(w)) {
        if (typeof value !== 'number' || !isFinite(value) || value < 0) {
          throw new Error(`Invalid weight for ${key}: ${value}`);
        }
      }
    };
    validateWeights(weights);

    const allFileIds = candidates.map((c) => c.fileId);
    const totalFilesCountRow = this.db.prepare('SELECT COUNT(*) AS cnt FROM sc_files').get() as { cnt: number } | undefined;
    const totalFilesCount = totalFilesCountRow?.cnt ?? 0;
    const hubMinDegree = Math.max(3, Math.floor(totalFilesCount * HUB_MIN_DEGREE_MULTIPLIER));
    const hubs = this.graph.getHubNodes(allFileIds, hubMinDegree);

    // Load EMA weights
    const emaMap = new Map<number, number>();
    const candidateIds = candidates.map(c => c.fileId);
    if (candidateIds.length > 0) {
      const emaRows: { file_id: number; weight: number; samples: number }[] = [];
      for (let i = 0; i < candidateIds.length; i += 900) {
        const chunk = candidateIds.slice(i, i + 900);
        const placeholders = chunk.map(() => '?').join(',');
        const rows = this.db.prepare(`SELECT file_id, weight, samples FROM sc_file_ema WHERE file_id IN (${placeholders})`).all(...chunk) as {
          file_id: number;
          weight: number;
          samples: number;
        }[];
        emaRows.push(...rows);
      }
      for (const r of emaRows) {
        emaMap.set(r.file_id, r.samples === 0 ? 0.5 : r.weight);
      }
    }

    const scored = candidates.map((c) => {
      const ema = emaMap.get(c.fileId) ?? 0.5;
      const hubBonus = hubs.has(c.fileId) ? weights.hub : 0;
      let score =
        weights.text * c.bm25Score +
        weights.symbol * Math.min(1, c.symbolScore) +
        weights.import * Math.min(1, c.importScore) +
        weights.path * (c.pathScore ?? 0) +
        weights.ema * ema +
        hubBonus;

      // Barrel file penalty
      const isBarrel =
        c.path.endsWith('/index.ts') ||
        c.path.endsWith('/index.tsx') ||
        c.path.endsWith('/index.js') ||
        c.path.endsWith('/index.jsx') ||
        c.path.endsWith('/index.mjs') ||
        c.path === 'index.ts' ||
        c.path === 'index.tsx' ||
        c.path === 'index.js' ||
        c.path === 'index.jsx' ||
        c.path === 'index.mjs' ||
        c.path.endsWith('/__init__.py') ||
        c.path.endsWith('/index.go');
      if (isBarrel && (c.pathScore ?? 0) < BARREL_PATH_SCORE_THRESHOLD) {
        score *= BARREL_PENALTY_MULTIPLIER;
      }
      return { c, score, ema, hubBonus };
    });

    const maxScore = scored.reduce((m, s) => Math.max(m, s.score), 0);

    const results: SearchResult[] = scored.map(({ c, score, ema, hubBonus }) => ({
      fileId: c.fileId,
      path: c.path,
      lang: c.lang,
      score,
      bm25Score: c.bm25Score,
      symbolScore: Math.min(1, c.symbolScore),
      importScore: Math.min(1, c.importScore),
      pathScore: c.pathScore ?? 0,
      emaScore: ema,
      hubBonus,
      matchedSymbols: c.matchedSymbols,
      matchedImports: c.matchedImports,
      chunks: [],
      isSkeleton: false,
      tier: 3,
      relevance: maxScore > 0 ? score / maxScore : 0,
    }));

    return results.sort((a, b) => b.score - a.score);
  }
}
