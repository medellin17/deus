export type Lang =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'go'
  | 'ruby'
  | 'php'
  | 'kotlin'
  | 'swift'
  | 'shell'
  | 'plain';

export type SymbolType =
  | 'function'
  | 'class'
  | 'method'
  | 'interface'
  | 'type'
  | 'variable'
  | 'import'
  | 'export'
  | 'unknown';

export type Confidence = 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS';

export type QueryCategory =
  | 'feature'
  | 'bugfix'
  | 'refactor'
  | 'style'
  | 'config'
  | 'default';

export interface SymbolInfo {
  fileId: number;
  name: string;
  type: SymbolType;
  line: number;
  signature?: string;
  col?: number;
}

export interface ImportInfo {
  fileId: number;
  importedModule: string;
  importedName?: string;
  isRelative: boolean;
  resolvedPath?: string;
  line: number;
}

export interface CallEdge {
  callerFileId: number;
  callerSymbol?: string;
  calleeFileId: number;
  calleeSymbol?: string;
  confidence: Confidence;
  line?: number;
}

export interface FileRecord {
  readonly id: number;
  readonly path: string;
  readonly mtime: number;
  readonly size: number;
  readonly lang: Lang;
  readonly content?: string;
  readonly indexedAt: number;
}

export interface SearchResult {
  readonly fileId: number;
  readonly path: string;
  readonly lang: Lang;
  readonly score: number;
  readonly bm25Score: number;
  readonly symbolScore: number;
  readonly importScore: number;
  readonly pathScore: number;
  readonly emaScore: number;
  readonly hubBonus: number;
  readonly matchedSymbols: string[];
  readonly matchedImports: string[];
  readonly chunks: Chunk[];
  readonly isSkeleton: boolean;
  readonly tier: 1 | 2 | 3;
  readonly relevance: number;
}

export interface Chunk {
  readonly fileId: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
  readonly relevance: number;
}

export interface SessionEntry {
  timestamp: number;
  query: string;
  category: QueryCategory;
  selectedFileIds: number[];
  entities: string[];
}

export interface ParsedQuery {
  raw: string;
  category: QueryCategory;
  tokens: string[];
  entities: string[];
  paths: string[];
  isFollowUp: boolean;
  inheritsCategory: boolean;
}

export interface SearchWeights {
  text: number;
  symbol: number;
  import: number;
  ema: number;
  hub: number;
  path: number;
}

export interface SearchOptions {
  weights?: Partial<Record<QueryCategory, Partial<SearchWeights>>> | Partial<SearchWeights>;
  dependencyDepth?: number;
  bm25Limit?: number;
  graphWalkMinScore?: number;
  graphWalkMaxSymbols?: number;
  synonyms?: Record<string, string[]>;
}

export interface Config {
  indexing: {
    ignore: string[];
    maxFileSizeKb: number;
    workers: number;
  };
  search: {
    dependencyDepth: number;
    bm25Limit: number;
    graphWalkMinScore: number;
    graphWalkMaxSymbols: number;
    sessionTimeoutMin: number;
    sessionHistoryLength: number;
    chunkMergeDistanceLines: number;
    skeletonThresholdLines: number;
  };
  model: {
    contextWindow: number;
    outputReserve: number;
  };
  weights: Record<QueryCategory, SearchWeights>;
  ema: {
    alphaFast: number;
    alphaSlow: number;
    sampleThreshold: number;
    explorationBonus: number;
  };
  confidence: {
    extracted: number;
    inferred: number;
    ambiguous: number;
  };
  contextTiers: {
    tier1: { ratio: number; maxFiles: number };
    tier2: { ratio: number; maxFiles: number };
    tier3: { ratio: number; maxFiles: number };
    truncateRatio: number;
  };
  synonyms?: Record<string, string[]>;
}

export interface AssembledContext {
  text: string;
  tokensUsed: number;
  filesIncluded: string[];
  filesReferenced: string[];
}
