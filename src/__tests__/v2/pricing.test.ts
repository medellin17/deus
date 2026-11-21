import assert from "node:assert";
import { describe, it } from "node:test";

import { estimateCost } from "../../v2/pricing.ts";
import type { TokenUsage } from "../../v2/types.ts";

function tokens(input: number, output: number, cacheRead = 0): TokenUsage {
  return {
    input,
    output,
    reasoning: 0,
    cache: { read: cacheRead, write: 0 },
  };
}

void describe("estimateCost", () => {
  void it("uses the flash price for the default model", () => {
    const cost = estimateCost(
      "opencode-go/deepseek-v4.1-flash#max",
      tokens(1_000_000, 1_000_000),
    );
    assert.ok(Math.abs(cost - 0.75) < 0.0001, `unexpected cost: ${cost}`);
  });

  void it("ignores the variant suffix", () => {
    const plain = estimateCost("opencode-go/deepseek-v4.1-flash", tokens(1_000_000, 0));
    const variant = estimateCost("opencode-go/deepseek-v4.1-flash#max", tokens(1_000_000, 0));
    assert.equal(plain, variant);
  });

  void it("returns zero for an unknown model", () => {
    assert.equal(estimateCost("unknown/model", tokens(1000, 1000)), 0);
  });
});
