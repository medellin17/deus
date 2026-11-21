import fs from 'fs';
import path from 'path';
import * as yaml from 'js-yaml';
import type { Config, QueryCategory, Confidence, SearchWeights } from './types.ts';

function getDefaultConfigPath(): string {
  const cwdConfig = path.resolve(process.cwd(), 'config.yaml');
  if (fs.existsSync(cwdConfig)) return cwdConfig;
  if (process.argv[1]) {
    const fallback = path.resolve(process.argv[1], '..', 'config.yaml');
    if (fs.existsSync(fallback)) return fallback;
  }
  return cwdConfig;
}

export function loadConfig(userPath?: string): Config {
  const configPath = userPath || getDefaultConfigPath();
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') {
      return normalizeConfig({});
    }
    console.warn(`Warning: failed to read config from ${configPath}: ${err instanceof Error ? err.message : err}. Using defaults.`);
    return normalizeConfig({});
  }
  const parsed = yaml.load(raw) as Record<string, unknown> | null | undefined;
  return normalizeConfig(parsed ?? {});
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

export function normalizeCategoryWeights(catWeights: unknown): SearchWeights {
  const keys: (keyof SearchWeights)[] = ['text', 'symbol', 'import', 'ema', 'hub', 'path'];
  const defaults: Record<string, number> = { text: 0.0, symbol: 0.0, import: 0.0, ema: 0.0, hub: 0.0, path: 0.3 };

  const result: SearchWeights = { text: 0, symbol: 0, import: 0, ema: 0, hub: 0, path: 0 };
  if (!catWeights || typeof catWeights !== 'object' || Array.isArray(catWeights)) {
    return normalizeCategoryWeights({});
  }
  const rawWeights = catWeights as Record<string, unknown>;
  for (const key of keys) {
    const rawVal = rawWeights[key];
    let val: number;
    if (rawVal === undefined || rawVal === null) {
      val = defaults[key];
    } else {
      const num = Number(rawVal);
      if (!isFinite(num) || num < 0) {
        console.warn(`Warning: weight "${key}" is invalid (${rawVal}). Treating as 0.`);
        val = 0;
      } else {
        val = num;
      }
    }
    result[key] = val;
  }

  const max = Math.max(result.text, result.symbol, result.import, result.ema, result.hub, result.path);
  if (max <= 0) {
    return { text: 0, symbol: 0, import: 0, ema: 0, hub: 0, path: 1 };
  }
  return {
    text: result.text / max,
    symbol: result.symbol / max,
    import: result.import / max,
    ema: result.ema / max,
    hub: result.hub / max,
    path: result.path / max,
  };
}

function asRecord(val: unknown): Record<string, unknown> | undefined {
  if (!val || typeof val !== 'object' || Array.isArray(val)) return undefined;
  return val as Record<string, unknown>;
}

function asStringArray(val: unknown, defaultVal: string[]): string[] {
  if (Array.isArray(val) && val.every((v): v is string => typeof v === 'string')) return val;
  return defaultVal;
}

function asNumber(val: unknown, defaultVal: number): number {
  if (val === undefined || val === null) return defaultVal;
  const num = Number(val);
  return isFinite(num) ? num : defaultVal;
}

function clamp01(val: unknown, defaultVal: number, name: string): number {
  const num = asNumber(val, defaultVal);
  if (num < 0 || num > 1) {
    console.warn(`Warning: ${name} must be between 0 and 1, got ${val}. Clamping to [0, 1].`);
    return Math.max(0, Math.min(1, num));
  }
  return num;
}

function normalizeConfig(raw: unknown): Config {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Config must be an object');
  }
  const obj = raw as Record<string, unknown>;
  const rawWeights = asRecord(obj.weights) ?? {};
  const categories: QueryCategory[] = ['default', 'bugfix', 'feature', 'refactor', 'style', 'config'];

  const baseWeights: Record<QueryCategory, Record<string, number>> = {
    default: { text: 0.4, symbol: 0.25, import: 0.25, ema: 0.1, hub: 0.05, path: 0.3 },
    bugfix: { text: 0.5, symbol: 0.25, import: 0.15, ema: 0.1, hub: 0.05, path: 0.3 },
    feature: { text: 0.35, symbol: 0.2, import: 0.3, ema: 0.15, hub: 0.05, path: 0.3 },
    refactor: { text: 0.25, symbol: 0.2, import: 0.3, ema: 0.25, hub: 0.05, path: 0.3 },
    style: { text: 0.45, symbol: 0.15, import: 0.15, ema: 0.1, hub: 0.05, path: 0.3 },
    config: { text: 0.5, symbol: 0.1, import: 0.2, ema: 0.1, hub: 0.05, path: 0.3 },
  };

  const weights: Config['weights'] = {
    default: { text: 0, symbol: 0, import: 0, ema: 0, hub: 0, path: 0 },
    bugfix: { text: 0, symbol: 0, import: 0, ema: 0, hub: 0, path: 0 },
    feature: { text: 0, symbol: 0, import: 0, ema: 0, hub: 0, path: 0 },
    refactor: { text: 0, symbol: 0, import: 0, ema: 0, hub: 0, path: 0 },
    style: { text: 0, symbol: 0, import: 0, ema: 0, hub: 0, path: 0 },
    config: { text: 0, symbol: 0, import: 0, ema: 0, hub: 0, path: 0 },
  };
  for (const cat of categories) {
    const combined = { ...baseWeights[cat], ...asRecord(rawWeights[cat]) };
    weights[cat] = normalizeCategoryWeights(combined);
  }

  const indexing = asRecord(obj.indexing);
  const search = asRecord(obj.search);
  const model = asRecord(obj.model);
  const ema = asRecord(obj.ema);
  const confidence = asRecord(obj.confidence);
  const contextTiers = asRecord(obj.contextTiers);
  const synonyms = asRecord(obj.synonyms);

  return {
    indexing: {
      ignore: asStringArray(indexing?.ignore, ['node_modules', 'dist', '.git']),
      maxFileSizeKb: asNumber(indexing?.maxFileSizeKb, 500),
      workers: asNumber(indexing?.workers, 0),
    },
    search: {
      dependencyDepth: asNumber(search?.dependencyDepth, 2),
      bm25Limit: asNumber(search?.bm25Limit, 20),
      graphWalkMinScore: asNumber(search?.graphWalkMinScore, 0.3),
      graphWalkMaxSymbols: asNumber(search?.graphWalkMaxSymbols, 20),
      sessionTimeoutMin: asNumber(search?.sessionTimeoutMin, 10),
      sessionHistoryLength: asNumber(search?.sessionHistoryLength, 5),
      chunkMergeDistanceLines: asNumber(search?.chunkMergeDistanceLines, 20),
      skeletonThresholdLines: asNumber(search?.skeletonThresholdLines, 400),
    },
    model: {
      contextWindow: asNumber(model?.contextWindow, 128000),
      outputReserve: asNumber(model?.outputReserve, 4096),
    },
    weights,
    ema: {
      alphaFast: clamp01(ema?.alphaFast, 0.3, 'ema.alphaFast'),
      alphaSlow: clamp01(ema?.alphaSlow, 0.1, 'ema.alphaSlow'),
      sampleThreshold: asNumber(ema?.sampleThreshold, 50),
      explorationBonus: asNumber(ema?.explorationBonus, 0.05),
    },
    confidence: {
      extracted: asNumber(confidence?.extracted, 1.0),
      inferred: asNumber(confidence?.inferred, 0.6),
      ambiguous: asNumber(confidence?.ambiguous, 0.3),
    },
    contextTiers: {
      tier1: {
        ratio: clamp01(asRecord(contextTiers?.tier1)?.ratio, 0.6, 'contextTiers.tier1.ratio'),
        maxFiles: asNumber(asRecord(contextTiers?.tier1)?.maxFiles, 5),
      },
      tier2: {
        ratio: clamp01(asRecord(contextTiers?.tier2)?.ratio, 0.3, 'contextTiers.tier2.ratio'),
        maxFiles: asNumber(asRecord(contextTiers?.tier2)?.maxFiles, 8),
      },
      tier3: {
        ratio: clamp01(asRecord(contextTiers?.tier3)?.ratio, 0.1, 'contextTiers.tier3.ratio'),
        maxFiles: asNumber(asRecord(contextTiers?.tier3)?.maxFiles, 50),
      },
      truncateRatio: clamp01(contextTiers?.truncateRatio, 0.95, 'contextTiers.truncateRatio'),
    },
    synonyms: (synonyms as Record<string, string[]> | undefined) ?? {},
  };
}

export function getCategoryWeights(config: Config, category: QueryCategory) {
  return config.weights[category] ?? config.weights.default;
}

export function confidenceWeight(config: Config, confidence: Confidence): number {
  if (confidence === 'EXTRACTED') return config.confidence.extracted;
  if (confidence === 'INFERRED') return config.confidence.inferred;
  return config.confidence.ambiguous;
}
