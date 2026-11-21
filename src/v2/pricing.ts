import type { TokenUsage } from "./types.ts";

interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
}

/**
 * USD per million tokens. Copied from the provider catalog; used only when
 * the server does not report a cost for the session.
 */
const MODEL_PRICES: Record<string, ModelPrice> = {
  "opencode-go/deepseek-v4.1-flash": { input: 0.15, output: 0.6, cacheRead: 0.003 },
  "tokenharbor/deepseek-v4.1-flash": { input: 0.3, output: 1.2, cacheRead: 0 },
  "tokenharbor/deepseek-v4.1-flash:free": { input: 0, output: 0, cacheRead: 0 },
  "opencode-go/deepseek-v4-pro": { input: 0.66, output: 1.98, cacheRead: 0.022 },
  "opencode/deepseek-v4.1-flash": { input: 0.3, output: 1.2, cacheRead: 0.006 },
  "opencode/deepseek-v4-pro": { input: 1.74, output: 3.48, cacheRead: 0.145 },
  "commandcode/deepseek/deepseek-v4.1-flash-fast": {
    input: 0.16,
    output: 0.58,
    cacheRead: 0.016,
  },
  "commandcode/deepseek/deepseek-v4-pro": { input: 0.66, output: 1.98, cacheRead: 0.022 },
};

function withoutVariant(model: string): string {
  const hash = model.indexOf("#");
  return hash === -1 ? model : model.slice(0, hash);
}

export function estimateCost(model: string, tokens: TokenUsage): number {
  const price = MODEL_PRICES[withoutVariant(model)];
  if (!price) return 0;

  return (
    (tokens.input * price.input +
      tokens.output * price.output +
      tokens.cache.read * price.cacheRead) /
    1_000_000
  );
}
