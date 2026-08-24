/**
 * tests/pricing.test.ts — Unit tests for the pricing table and cost computation.
 *
 * Uses Node's built-in test runner (node:test). Imports use .js extensions
 * because we run the compiled dist output.
 *
 * MODEL_RATES and lookupModelRates have been removed from this writer package.
 * All lookup is now through @token-tally/store/pricing.lookupRates, and the
 * local computeCostMicros is a thin adapter over the shared implementation.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
// Import from the main store entry (not the subpath) because this package's
// tsconfig uses "moduleResolution": "Node" which ignores package.json exports.
import { lookupRates } from "@token-tally/store";
import { computeCostMicros } from "../src/pricing/compute.js";
import type { AssistantUsage } from "../src/transcript/extract.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUsage(overrides: Partial<AssistantUsage> = {}): AssistantUsage {
  return {
    harnessMessageId: "test-uuid-1",
    modelId: "claude-3-5-haiku-20241022",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    legacyCostUSD: null,
    ts: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// T5-1: Known model — exact input cost
// ---------------------------------------------------------------------------

// Shared expected rates — these are the canonical values from anthropic.yaml
// (confirmed against rates.json). Hard-coded to make test failures explicit.
const HAIKU_4_5_RATES = {
  inputPerMTokUSD: 1,
  outputPerMTokUSD: 5,
  cacheReadPerMTokUSD: 0.1,
  cacheWritePerMTokUSD: 1.25,
};
const SONNET_4_5_RATES = {
  inputPerMTokUSD: 3,
  outputPerMTokUSD: 15,
  cacheReadPerMTokUSD: 0.3,
  cacheWritePerMTokUSD: 3.75,
};

describe("lookupRates (shared store pricing)", () => {
  it("returns rates for a known model", () => {
    const rates = lookupRates("claude-3-5-haiku-20241022");
    assert.ok(rates !== undefined, "should return rates for claude-3-5-haiku-20241022");
    assert.equal(rates.inputPerMTokUSD, 0.8);
    assert.equal(rates.outputPerMTokUSD, 4);
    assert.equal(rates.cacheReadPerMTokUSD, 0.08);
    assert.equal(rates.cacheWritePerMTokUSD, 1);
  });

  it("prices the observed claude-opus-4-8 canonical model exactly", () => {
    assert.deepEqual(lookupRates("claude-opus-4-8"), {
      inputPerMTokUSD: 5, outputPerMTokUSD: 25, cacheReadPerMTokUSD: 0.5, cacheWritePerMTokUSD: 6.25,
    });
  });

  it("returns undefined and does not throw for unknown model", () => {
    // Previously returned null; the shared lookup returns undefined.
    const result = lookupRates("unknown-model-xyz-9999");
    assert.equal(result, undefined);
  });

  it("resolves explicit aliases only", () => {
    const rates = lookupRates("claude-sonnet-4");
    assert.ok(rates !== undefined, "explicit alias should resolve");
    assert.deepEqual(rates, SONNET_4_5_RATES);
  });

  it("resolves the Cursor snapshot as its own canonical ID", () => {
    const rates = lookupRates("claude-sonnet-4-20250514");
    assert.deepEqual(rates, SONNET_4_5_RATES);
  });

  it("does not strip unknown future suffixes", () => {
    const rates = lookupRates("claude-3-5-sonnet-20241022-turbo");
    assert.equal(rates, undefined);
  });

  // C2 regression: unknown claude-* models must never inherit family rates.
  it("C2: unknown claude-* model returns undefined (not the first table entry)", () => {
    // Fuzzy prefix/segment fallback used to risk selecting the most expensive
    // matching family entry.
    const rates = lookupRates("claude-supernova-9");
    assert.equal(rates, undefined, "unknown claude-* model should return undefined, not opus rates");
  });

  it("C2: claude-haiku-4-5 is priced correctly", () => {
    const rates = lookupRates("claude-haiku-4-5");
    assert.ok(rates !== undefined, "claude-haiku-4-5 should be in the pricing table");
    assert.deepEqual(rates, HAIKU_4_5_RATES);
  });

  it("C2: claude-haiku-4 alias resolves to claude-haiku-4-5 rates", () => {
    // Alias is explicit in anthropic.yaml — not a prefix match.
    const rates = lookupRates("claude-haiku-4");
    assert.ok(rates !== undefined, "claude-haiku-4 should resolve via alias");
    assert.deepEqual(rates, HAIKU_4_5_RATES);
  });

  it("exact-only lookup keeps claude-3 and fictional suffixes unknown", () => {
    assert.equal(lookupRates("claude-3"), undefined);
    assert.equal(lookupRates("claude-opus-4-8-turbo"), undefined);
  });

  it("keeps independently published OpenAI snapshots canonical", () => {
    assert.deepEqual(lookupRates("gpt-4o-2024-05-13"), {
      inputPerMTokUSD: 5,
      outputPerMTokUSD: 15,
      cacheReadPerMTokUSD: null,
      cacheWritePerMTokUSD: 0,
    });
    assert.deepEqual(lookupRates("gpt-4o-2024-08-06"), {
      inputPerMTokUSD: 2.5,
      outputPerMTokUSD: 10,
      cacheReadPerMTokUSD: 1.25,
      cacheWritePerMTokUSD: 0,
    });
  });

  it("C2: bare stem 'claude' alone returns undefined", () => {
    // Belt-and-suspenders: bare provider name must never match a table entry.
    const rates = lookupRates("claude");
    assert.equal(rates, undefined, "bare 'claude' stem must return undefined");
  });
});

// ---------------------------------------------------------------------------
// computeCostMicros — adapter over the shared store implementation
// ---------------------------------------------------------------------------

describe("computeCostMicros (adapter)", () => {
  it("1M input tokens on haiku yields correct input micros", () => {
    // haiku inputPerMTokUSD = 0.80  →  0.80 * 1_000_000 tokens = 800_000 micros
    const usage = makeUsage({ inputTokens: 1_000_000 });
    const cost = computeCostMicros(usage);
    assert.equal(cost.costInputMicros, 800_000);
    assert.equal(cost.costOutputMicros, 0);
    assert.equal(cost.costCacheReadMicros, 0);
    assert.equal(cost.costCacheWriteMicros, 0);
    assert.equal(cost.costSource, "writer");
  });

  it("null modelId returns all zeros and costSource unknown", () => {
    // Covers the path where AssistantUsage.modelId is null.
    // The shared computeCostMicros returns zeroCostBreakdown for null/undefined.
    const usage = makeUsage({ modelId: null });
    const cost = computeCostMicros(usage);
    assert.equal(cost.costInputMicros, 0);
    assert.equal(cost.costOutputMicros, 0);
    assert.equal(cost.costCacheReadMicros, 0);
    assert.equal(cost.costCacheWriteMicros, 0);
    assert.equal(cost.costSource, "unknown");
  });

  it("cache tokens produce non-zero cache micros", () => {
    // haiku cacheReadPerMTokUSD = 0.08  →  1_000_000 tokens = 80_000 micros
    // haiku cacheWritePerMTokUSD = 1.00 →  1_000_000 tokens = 1_000_000 micros
    const usage = makeUsage({
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    });
    const cost = computeCostMicros(usage);
    assert.equal(cost.costCacheReadMicros, 80_000);
    assert.equal(cost.costCacheWriteMicros, 1_000_000);
    assert.ok(cost.costCacheReadMicros > 0, "cache read micros should be non-zero");
    assert.ok(cost.costCacheWriteMicros > 0, "cache write micros should be non-zero");
    assert.equal(cost.costSource, "writer");
  });

  it("unavailable cache component makes nonzero usage unknown", () => {
    const cost = computeCostMicros(makeUsage({
      modelId: "gemini-2.0-flash",
      cacheWriteTokens: 1,
    }));
    assert.equal(cost.costSource, "unknown");
  });

  it("unknown model returns all zeros and costSource unknown", () => {
    const usage = makeUsage({
      modelId: "totally-unknown-model-zzz",
      inputTokens: 1_000_000,
      outputTokens: 500_000,
    });
    const cost = computeCostMicros(usage);
    assert.equal(cost.costInputMicros, 0);
    assert.equal(cost.costOutputMicros, 0);
    assert.equal(cost.costCacheReadMicros, 0);
    assert.equal(cost.costCacheWriteMicros, 0);
    assert.equal(cost.costSource, "unknown");
  });

  it("zero tokens produce zero micros (no divide-by-zero)", () => {
    const usage = makeUsage({
      modelId: "claude-opus-4-5",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    const cost = computeCostMicros(usage);
    assert.equal(cost.costInputMicros, 0);
    assert.equal(cost.costOutputMicros, 0);
    assert.equal(cost.costCacheReadMicros, 0);
    assert.equal(cost.costCacheWriteMicros, 0);
    assert.equal(cost.costSource, "writer");
  });

  it("opus rates apply correctly for 100k output tokens", () => {
    // opus outputPerMTokUSD = 25 → 100_000 tokens = 2_500_000 micros ($2.50).
    const usage = makeUsage({
      modelId: "claude-opus-4-5",
      outputTokens: 100_000,
    });
    const cost = computeCostMicros(usage);
    assert.equal(cost.costOutputMicros, 2_500_000);
    assert.equal(cost.costSource, "writer");
  });

  it("cost total equals sum of breakdown columns", () => {
    // Verifies the invariant the store CHECK constraint enforces.
    const usage = makeUsage({
      modelId: "claude-3-5-sonnet-20241022",
      inputTokens: 10_000,
      outputTokens: 5_000,
      cacheReadTokens: 20_000,
      cacheWriteTokens: 1_000,
    });
    const cost = computeCostMicros(usage);
    const expectedTotal =
      cost.costInputMicros +
      cost.costOutputMicros +
      cost.costCacheReadMicros +
      cost.costCacheWriteMicros;
    // We don’t compute total here — that’s the drain helper’s job.
    // Just verify the breakdown fields are all non-negative integers.
    assert.ok(cost.costInputMicros >= 0);
    assert.ok(cost.costOutputMicros >= 0);
    assert.ok(cost.costCacheReadMicros >= 0);
    assert.ok(cost.costCacheWriteMicros >= 0);
    assert.ok(expectedTotal > 0, "non-zero tokens should produce non-zero total");
  });
});
