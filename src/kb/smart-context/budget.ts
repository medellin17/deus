import type { Config, SearchResult, AssembledContext } from './types.ts';
import { assembleFileContent } from './context-assembler.ts';

/**
 * Rough token count heuristic for source code.
 * Code averages ~3.5 chars per token (mix of single-char symbols and longer identifiers).
 */
function roughTokenCount(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 3);
}

export function allocateTiers(results: SearchResult[], config: Config): SearchResult[] {
  const tiers = config.contextTiers;
  const out: SearchResult[] = [];

  // Tier 1
  let tier1Count = 0;
  for (const r of results) {
    if (tier1Count >= tiers.tier1.maxFiles) break;
    out.push({ ...r, tier: 1 });
    tier1Count++;
  }

  // Tier 2
  let tier2Count = 0;
  for (const r of results.slice(tier1Count)) {
    if (tier2Count >= tiers.tier2.maxFiles) break;
    out.push({ ...r, tier: 2 });
    tier2Count++;
  }

  // Tier 3
  let tier3Count = 0;
  for (const r of results.slice(tier1Count + tier2Count)) {
    if (tier3Count >= tiers.tier3.maxFiles) break;
    out.push({ ...r, tier: 3 });
    tier3Count++;
  }

  return out;
}

export function buildContext(
  results: SearchResult[],
  projectRoot: string,
  config: Config,
  queryTokens: string[] = []
): AssembledContext {
  const withTiers = allocateTiers(results, config);
  const availableTokens = config.model.contextWindow - config.model.outputReserve;
  const tier1Budget = Math.floor(availableTokens * config.contextTiers.tier1.ratio);
  const tier2Budget = Math.floor(availableTokens * config.contextTiers.tier2.ratio);
  const tier3Budget = Math.floor(availableTokens * config.contextTiers.tier3.ratio);
  const truncateLimit = Math.floor(availableTokens * config.contextTiers.truncateRatio);

  const parts: string[] = [];
  let used = 0;
  const included: string[] = [];
  const referenced: string[] = [];

  function add(text: string, file: string, maxBudget: number): boolean {
    let finalPartsText = text;
    let tokens = roughTokenCount(text);

    if (tokens > maxBudget) {
      const allowedBytes = Math.floor(maxBudget * 3);
      const buf = Buffer.from(text, 'utf8');
      if (buf.length > allowedBytes) {
        finalPartsText = buf.subarray(0, allowedBytes).toString('utf8') + '\n// ... [truncated] ...';
      }
      tokens = roughTokenCount(finalPartsText);
    }

    if (used + tokens > truncateLimit) {
      referenced.push(file);
      return false;
    }

    parts.push(finalPartsText);
    used += tokens;
    included.push(file);
    return true;
  }

  // Tier 1
  for (const r of withTiers.filter((x) => x.tier === 1)) {
    const { text } = assembleFileContent(r, projectRoot, config, queryTokens);
    const header = `\n===== ${r.path} (score=${r.relevance.toFixed(3)}) =====\n`;
    add(header + text, r.path, tier1Budget);
  }

  // Tier 2
  for (const r of withTiers.filter((x) => x.tier === 2)) {
    const { text } = assembleFileContent(r, projectRoot, config, queryTokens);
    const header = `\n----- ${r.path} (reference) -----\n`;
    add(header + text, r.path, tier2Budget);
  }

  // Tier 3
  for (const r of withTiers.filter((x) => x.tier === 3)) {
    const { text } = assembleFileContent(r, projectRoot, config, queryTokens);
    const header = `\n# ${r.path} (relevance=${r.relevance.toFixed(3)})\n`;
    if (!add(header + text, r.path, tier3Budget)) break;
  }

  return {
    text: parts.join('\n'),
    tokensUsed: used,
    filesIncluded: included,
    filesReferenced: referenced,
  };
}
