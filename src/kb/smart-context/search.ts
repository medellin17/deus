import type Database from 'better-sqlite3';
import path from 'path';
import type { Config, ParsedQuery, SearchOptions, Lang } from './types.ts';
import { SymbolGraph } from './graph.ts';
import { cleanPath } from './search-strategies/utils.ts';
import type { RawCandidate } from './search-strategies/types.ts';
import { Bm25Strategy } from './search-strategies/bm25-strategy.ts';
import { SymbolStrategy } from './search-strategies/symbol-strategy.ts';
import { ImportStrategy } from './search-strategies/import-strategy.ts';
import { PathStrategy } from './search-strategies/path-strategy.ts';
import {
  HIGH_PATH_CANDIDATE_THRESHOLD,
  SESSION_BOOST_BASE,
  SESSION_DECAY_PER_STEP,
  TOP_FILES_FOR_GRAPH_WALK,
  GRAPH_WALK_MISSING_IMPORT_MULTIPLIER,
  GRAPH_WALK_EXISTING_IMPORT_MULTIPLIER,
  IMPORTERS_QUERY_LIMIT,
} from './constants.ts';

export type { RawCandidate } from './search-strategies/types.ts';

export class SearchEngine {
  private bm25Strategy: Bm25Strategy;
  private symbolStrategy: SymbolStrategy;
  private importStrategy: ImportStrategy;
  private pathStrategy: PathStrategy;

  constructor(private db: Database.Database, private config: Config, private graph: SymbolGraph) {
    this.bm25Strategy = new Bm25Strategy(db, config);
    this.symbolStrategy = new SymbolStrategy(db, config);
    this.importStrategy = new ImportStrategy(db, config);
    this.pathStrategy = new PathStrategy(db, config);
  }

  search(parsed: ParsedQuery, sessionFileIds: number[] = [], options?: SearchOptions): RawCandidate[] {
    if (options?.weights) {
      const knownKeys = new Set(['text', 'symbol', 'import', 'ema', 'hub', 'path']);
      const directKeys = ['text', 'symbol', 'import', 'ema', 'hub', 'path'];
      const isDirect = directKeys.some(k => k in options.weights!);

      if (isDirect) {
        for (const [key, val] of Object.entries(options.weights as Partial<Record<string, number>>)) {
          if (!knownKeys.has(key)) {
            throw new Error(`Unknown weight key: ${key}`);
          }
          if (typeof val !== 'number' || !isFinite(val) || val < 0) {
            throw new Error(`Invalid weight value for ${key}: ${val}`);
          }
        }
      } else {
        for (const [cat, catWeights] of Object.entries(options.weights as Record<string, Partial<Record<string, number>>>)) {
          if (catWeights && typeof catWeights === 'object') {
            for (const [key, val] of Object.entries(catWeights)) {
              if (!knownKeys.has(key)) {
                throw new Error(`Unknown weight key: ${key} in category ${cat}`);
              }
              if (typeof val !== 'number' || !isFinite(val) || val < 0) {
                throw new Error(`Invalid weight value for ${key} in category ${cat}: ${val}`);
              }
            }
          }
        }
      }
    }

    const bm25Candidates = this.bm25Strategy.search(parsed, options);
    const symbolCandidates = this.symbolStrategy.search(parsed);
    const importCandidates = this.importStrategy.search(parsed);
    const pathCandidates = this.pathStrategy.search(parsed);

    const merged = new Map<number, RawCandidate>();

    for (const c of bm25Candidates) merged.set(c.fileId, c);
    for (const c of symbolCandidates) {
      const existing = merged.get(c.fileId);
      if (existing) {
        existing.symbolScore = Math.max(existing.symbolScore, c.symbolScore);
        existing.matchedSymbols = Array.from(
          new Set([...existing.matchedSymbols, ...c.matchedSymbols])
        );
      } else {
        merged.set(c.fileId, c);
      }
    }
    for (const c of importCandidates) {
      const existing = merged.get(c.fileId);
      if (existing) {
        existing.importScore = Math.max(existing.importScore, c.importScore);
        existing.matchedImports = Array.from(
          new Set([...existing.matchedImports, ...c.matchedImports])
        );
      } else {
        merged.set(c.fileId, c);
      }
    }
    for (const c of pathCandidates) {
      const existing = merged.get(c.fileId);
      if (existing) {
        existing.pathScore = Math.max(existing.pathScore, c.pathScore);
      } else {
        merged.set(c.fileId, c);
      }
    }

    // Import graph extension for fuzzy paths
    const highPathCandidates = Array.from(merged.values()).filter((c) => c.pathScore >= HIGH_PATH_CANDIDATE_THRESHOLD);
    const commonNames = new Set(['index', 'main', 'app', 'utils', 'config', 'setup', 'mod', '__init__', 'page', 'layout']);

    for (const target of highPathCandidates) {
      const resolvedPath = target.path;
      const segments = resolvedPath.split('/');
      const lastSegment = segments[segments.length - 1];
      const dotIndex = lastSegment.lastIndexOf('.');
      let targetBasename = dotIndex !== -1 ? lastSegment.slice(0, dotIndex) : lastSegment;

      if (commonNames.has(targetBasename.toLowerCase()) && segments.length > 1) {
        targetBasename = segments[segments.length - 2];
      }

      if (targetBasename.length < 2 || commonNames.has(targetBasename.toLowerCase())) {
        continue;
      }

      const importers = this.db
        .prepare(
          `
          SELECT i.file_id, f.path AS importer_path, f.lang, i.imported_module
          FROM sc_imports i
          JOIN sc_files f ON f.id = i.file_id
          WHERE i.imported_module LIKE ? OR i.imported_module = ?
          LIMIT ${IMPORTERS_QUERY_LIMIT}
          `
        )
        .all(`%/${targetBasename}`, targetBasename) as {
        file_id: number;
        importer_path: string;
        lang: Lang;
        imported_module: string;
      }[];

      for (const r of importers) {
        const targetClean = cleanPath(resolvedPath).toLowerCase();

        const impSegments = r.imported_module.split('/');
        const hasSegment = impSegments.some((s) => s.toLowerCase() === targetBasename.toLowerCase());
        if (!hasSegment) continue;

        let isValid = false;
        if (r.imported_module.startsWith('.')) {
          const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(r.importer_path), r.imported_module));
          const resolvedClean = cleanPath(resolved).toLowerCase();
          isValid = resolvedClean === targetClean;
        } else {
          let cleanImport = r.imported_module;
          if (cleanImport.startsWith('@/')) {
            cleanImport = cleanImport.slice(2);
          } else if (cleanImport.startsWith('~/')) {
            cleanImport = cleanImport.slice(2);
          }
          const importClean = cleanPath(cleanImport).toLowerCase();
          isValid = targetClean.endsWith(importClean);
        }

        if (isValid) {
          const bonus = GRAPH_WALK_MISSING_IMPORT_MULTIPLIER * target.pathScore;
          const existing = merged.get(r.file_id);
          if (existing) {
            existing.importScore = Math.max(existing.importScore, bonus);
            if (!existing.matchedImports.includes(r.imported_module)) {
              existing.matchedImports.push(r.imported_module);
            }
          } else {
            merged.set(r.file_id, {
              fileId: r.file_id,
              path: r.importer_path,
              lang: r.lang,
              bm25Score: 0,
              symbolScore: 0,
              importScore: bonus,
              pathScore: 0,
              matchedSymbols: [],
              matchedImports: [r.imported_module],
            });
          }
        }
      }
    }

    // Session boost with decay (20% per step of age)
    for (let i = 0; i < sessionFileIds.length; i++) {
      const fid = sessionFileIds[i];
      const c = merged.get(fid);
      if (c) {
        const decay = Math.pow(SESSION_DECAY_PER_STEP, i);
        c.bm25Score += SESSION_BOOST_BASE * decay;
      }
    }

    // Graph walk
    const topFileIds = Array.from(merged.values())
      .sort((a, b) => this.roughScore(b) - this.roughScore(a))
      .slice(0, TOP_FILES_FOR_GRAPH_WALK)
      .map((c) => c.fileId);

    const graphWalkMinScore = options?.graphWalkMinScore ?? this.config.search.graphWalkMinScore;
    const graphWalkMaxSymbols = options?.graphWalkMaxSymbols ?? this.config.search.graphWalkMaxSymbols;
    const dependencyDepth = options?.dependencyDepth ?? this.config.search.dependencyDepth;

    const graphScores = this.graph.walk(
      topFileIds,
      graphWalkMinScore,
      graphWalkMaxSymbols,
      dependencyDepth
    );

    const missingFids = Array.from(graphScores.keys()).filter(fid => !merged.has(fid));
    if (missingFids.length > 0) {
      const placeholders = missingFids.map(() => '?').join(',');
      const files = this.db.prepare(`SELECT id, path, lang FROM sc_files WHERE id IN (${placeholders})`).all(...missingFids) as {
        id: number;
        path: string;
        lang: Lang;
      }[];
      for (const file of files) {
        const score = graphScores.get(file.id)!;
        merged.set(file.id, {
          fileId: file.id,
          path: file.path,
          lang: file.lang,
          bm25Score: 0,
          symbolScore: 0,
          importScore: score * GRAPH_WALK_MISSING_IMPORT_MULTIPLIER,
          pathScore: 0,
          matchedSymbols: [],
          matchedImports: [],
        });
      }
    }

    for (const [fid, score] of graphScores.entries()) {
      if (merged.has(fid)) {
        const c = merged.get(fid)!;
        c.importScore = Math.max(c.importScore, score * GRAPH_WALK_EXISTING_IMPORT_MULTIPLIER);
      }
    }

    return Array.from(merged.values());
  }

  private roughScore(c: RawCandidate): number {
    return c.bm25Score + c.symbolScore + c.importScore + c.pathScore;
  }
}
