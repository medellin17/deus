import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
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
    console.warn(`Warning: failed to read config from ${configPath}: ${err instanceof Error ? err.message : err}. Using defaults.`);
    return normalizeConfig({});
  }
  const parsed = yaml.load(raw) as any; // reason: parsed external data
  return normalizeConfig(parsed);
}

export function normalizeCategoryWeights(catWeights: any /* reason: parsed external data */): SearchWeights {
  const keys: (keyof SearchWeights)[] = ['text', 'symbol', 'import', 'ema', 'hub', 'path'];
  const defaults: Record<string, number> = { text: 0.0, symbol: 0.0, import: 0.0, ema: 0.0, hub: 0.0, path: 0.3 };

  const result = {} as SearchWeights;
  for (const key of keys) {
    let val = catWeights[key];
    if (val === undefined || val === null) {
      val = defaults[key];
    } else {
      val = Number(val);
      if (!isFinite(val) || val < 0) {
        console.warn(`Warning: weight "${key}" is invalid (${catWeights[key]}). Treating as 0.`);
        val = 0;
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

function clamp01(val: unknown, defaultVal: number, name: string): number {
  if (val === undefined || val === null) return defaultVal;
  const num = Number(val);
  if (!isFinite(num) || num < 0 || num > 1) {
    console.warn(`Warning: ${name} must be between 0 and 1, got ${val}. Clamping to [0, 1].`);
    return Math.max(0, Math.min(1, num));
  }
  return num;
}

function normalizeConfig(raw: any /* reason: parsed external data */): Config {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Config must be an object');
  }

  const rawWeights = raw.weights ?? {};
  const categories: QueryCategory[] = ['default', 'bugfix', 'feature', 'refactor', 'style', 'config'];

  const baseWeights: Record<QueryCategory, Record<string, number>> = {
    default: { text: 0.4, symbol: 0.25, import: 0.25, ema: 0.1, hub: 0.05, path: 0.3 },
    bugfix: { text: 0.5, symbol: 0.25, import: 0.15, ema: 0.1, hub: 0.05, path: 0.3 },
    feature: { text: 0.35, symbol: 0.2, import: 0.3, ema: 0.15, hub: 0.05, path: 0.3 },
    refactor: { text: 0.25, symbol: 0.2, import: 0.3, ema: 0.25, hub: 0.05, path: 0.3 },
    style: { text: 0.45, symbol: 0.15, import: 0.15, ema: 0.1, hub: 0.05, path: 0.3 },
    config: { text: 0.5, symbol: 0.1, import: 0.2, ema: 0.1, hub: 0.05, path: 0.3 },
  };

  const weights = {} as Config['weights'];
  for (const cat of categories) {
    const combined = { ...baseWeights[cat], ...rawWeights[cat] };
    weights[cat] = normalizeCategoryWeights(combined);
  }
  return {
    indexing: {
      ignore: raw.indexing?.ignore ?? ['node_modules', 'dist', '.git'],
      maxFileSizeKb: raw.indexing?.maxFileSizeKb ?? 500,
      workers: raw.indexing?.workers ?? 0,
    },
    search: {
      dependencyDepth: raw.search?.dependencyDepth ?? 2,
      bm25Limit: raw.search?.bm25Limit ?? 20,
      graphWalkMinScore: raw.search?.graphWalkMinScore ?? 0.3,
      graphWalkMaxSymbols: raw.search?.graphWalkMaxSymbols ?? 20,
      sessionTimeoutMin: raw.search?.sessionTimeoutMin ?? 10,
      sessionHistoryLength: raw.search?.sessionHistoryLength ?? 5,
      chunkMergeDistanceLines: raw.search?.chunkMergeDistanceLines ?? 20,
      skeletonThresholdLines: raw.search?.skeletonThresholdLines ?? 400,
    },
    model: {
      contextWindow: raw.model?.contextWindow ?? 128000,
      outputReserve: raw.model?.outputReserve ?? 4096,
    },
    weights,
    ema: {
      alphaFast: clamp01(raw.ema?.alphaFast, 0.3, 'ema.alphaFast'),
      alphaSlow: clamp01(raw.ema?.alphaSlow, 0.1, 'ema.alphaSlow'),
      sampleThreshold: raw.ema?.sampleThreshold ?? 50,
      explorationBonus: raw.ema?.explorationBonus ?? 0.05,
    },
    confidence: {
      extracted: raw.confidence?.extracted ?? 1.0,
      inferred: raw.confidence?.inferred ?? 0.6,
      ambiguous: raw.confidence?.ambiguous ?? 0.3,
    },
    contextTiers: {
      tier1: {
        ratio: clamp01(raw.contextTiers?.tier1?.ratio, 0.6, 'contextTiers.tier1.ratio'),
        maxFiles: raw.contextTiers?.tier1?.maxFiles ?? 5,
      },
      tier2: {
        ratio: clamp01(raw.contextTiers?.tier2?.ratio, 0.3, 'contextTiers.tier2.ratio'),
        maxFiles: raw.contextTiers?.tier2?.maxFiles ?? 8,
      },
      tier3: {
        ratio: clamp01(raw.contextTiers?.tier3?.ratio, 0.1, 'contextTiers.tier3.ratio'),
        maxFiles: raw.contextTiers?.tier3?.maxFiles ?? 50,
      },
      truncateRatio: clamp01(raw.contextTiers?.truncateRatio, 0.95, 'contextTiers.truncateRatio'),
    },
    synonyms: raw.synonyms ?? {},
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
