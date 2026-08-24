import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { generateRates, loadSources } from "../generate.ts";
import { normalizeModelsDev } from "../models-dev.ts";
import { parseSourceYaml, renderSourceYaml } from "../source-yaml.ts";
import { mergeProvider, validateOverrides } from "../sync.ts";
import type { ProviderCatalog, SyncOverrides } from "../types.ts";
import { validateSources } from "../validate.ts";

const TEXT_MODALITIES = { input: ["text"], output: ["text"] };

const source = parseSourceYaml(`provider: anthropic\nasOf: "2026-05-13"\nsourceUrl: "https://example.test"\nsyncSourceUrl: "https://models.dev/api.json"\nsyncedAt: "2026-05-13"\nmodels:\n  - id: old\n    aliases:\n      - snapshot\n    inputPerMTokUSD: 1\n    outputPerMTokUSD: 2\n    cacheReadPerMTokUSD: 0.1\n    cacheWritePerMTokUSD: 1.25\n`, "test.yaml");

test("source YAML render is deterministic and retains nullable components", () => {
  source.models[0]!.cacheWritePerMTokUSD = null;
  const rendered = renderSourceYaml(source, "# retained header\n");
  assert.match(rendered, /cacheWritePerMTokUSD: null/);
  assert.deepEqual(parseSourceYaml(rendered, "roundtrip.yaml").models, source.models);
  assert.equal(renderSourceYaml(source, "# retained header\n"), rendered);
});

test("models.dev normalization skips tiers and leaves Google cache writes unavailable", () => {
  const catalog = normalizeModelsDev("google", { google: { models: {
    "gemini-simple": { modalities: TEXT_MODALITIES, last_updated: "2026-07-29", cost: { input: 1, output: 2, cache_read: 0.2 } },
    "gemini-tiered": { modalities: TEXT_MODALITIES, last_updated: "2026-07-29", cost: { input: 1, output: 2, context_over_200k: { input: 2 } } },
    "lyria-mixed-output": { modalities: { input: ["text"], output: ["text", "audio"] }, last_updated: "2026-07-29", cost: { input: 0, output: 0 } },
    "gemini-audio-tier": { modalities: TEXT_MODALITIES, last_updated: "2026-07-29", cost: { input: 1, output: 2, input_audio: 3 } },
  } } }, "2026-07-29T00:00:00.000Z");
  assert.equal(catalog.models[0]!.rates?.cacheWritePerMTokUSD, null);
  assert.equal(catalog.models[1]!.rates, null);
  assert.equal(catalog.models[1]!.reason, "context-tiered pricing");
  assert.equal(catalog.models[2]!.rates, null);
  assert.equal(catalog.models[2]!.reason, "non-text model");
  assert.equal(catalog.models[3]!.rates, null);
  assert.equal(catalog.models[3]!.reason, "non-text model");
});

test("merge promotes a canonical ID out of an old alias and preserves history", () => {
  const catalog = { provider: "anthropic", sourceUrl: "https://models.dev/api.json", syncedAt: "2026-07-29T00:00:00.000Z", diagnostics: [], models: [
    { id: "snapshot", rateSourceUrl: "https://models.dev/api.json", rateAsOf: "2026-07-29", rates: { inputPerMTokUSD: 3, outputPerMTokUSD: 4, cacheReadPerMTokUSD: 0.3, cacheWritePerMTokUSD: 3.75 } },
  ] };
  const merged = mergeProvider(source, catalog, {});
  assert.deepEqual(merged.source.models.find((model) => model.id === "old")?.aliases, []);
  assert.equal(merged.source.models.find((model) => model.id === "snapshot")?.inputPerMTokUSD, 3);
  assert.deepEqual(merged.summary.promoted, ["snapshot"]);
});

test("inactive ledger models are omitted from runtime rates", () => {
  const inactive = { ...source, models: [{ ...source.models[0]!, syncStatus: "inactive" as const }] };
  assert.equal(generateRates([inactive], "2026-07-29T00:00:00.000Z").models.length, 0);
});

test("all committed Google cache-write rates are unavailable", () => {
  const google = loadSources(join(process.cwd(), "pricing-sources"))
    .find((pricingSource) => pricingSource.provider === "google");
  assert.ok(google);
  assert.ok(google.models.length > 0);
  assert.ok(google.models.every((model) => model.cacheWritePerMTokUSD === null));
});

test("strict source validation rejects duplicate fields and invalid statuses", () => {
  const duplicateField = `provider: anthropic\nasOf: "2026-05-13"\nsourceUrl: "https://example.test"\nmodels:\n  - id: "model"\n    id: "other"\n    inputPerMTokUSD: 1\n    outputPerMTokUSD: 2\n    cacheReadPerMTokUSD: 0\n    cacheWritePerMTokUSD: 0\n`;
  assert.throws(() => parseSourceYaml(duplicateField, "duplicate.yaml"), /duplicate model field id/);
  assert.throws(
    () => parseSourceYaml(
      duplicateField.replace('    id: "other"\n', "").replace("inputPerMTokUSD: 1", "inputPerMTokUSD:"),
      "empty-rate.yaml",
    ),
    /rate component cannot be empty/,
  );

  const invalidStatus = parseSourceYaml(`provider: anthropic\nasOf: "2026-05-13"\nsourceUrl: "https://example.test"\nmodels:\n  - id: "model"\n    inputPerMTokUSD: 1\n    outputPerMTokUSD: 2\n    cacheReadPerMTokUSD: 0\n    cacheWritePerMTokUSD: 0\n    syncStatus: inactiv\n`, "status.yaml");
  assert.throws(() => validateSources([invalidStatus]), /invalid syncStatus/);
  assert.throws(() => validateSources([invalidStatus, { ...invalidStatus }]), /invalid syncStatus|duplicate provider/);
});

test("override validation rejects malformed aliases and partial rates", () => {
  assert.throws(
    () => validateOverrides({ "anthropic/model": { aliases: "ab" } } as unknown as SyncOverrides),
    /aliases must be/,
  );
  assert.throws(
    () => validateOverrides({
      "anthropic/model": {
        rates: { inputPerMTokUSD: 1 } as never,
        rateSourceUrl: "https://example.test",
        rateAsOf: "2026-07-29",
        reason: "test",
      },
    }),
    /exactly all four components/,
  );
});

test("models.dev normalization rejects malformed payloads and preserves missing provenance as unresolved", () => {
  assert.throws(
    () => normalizeModelsDev("anthropic", { anthropic: { models: { broken: "not-an-object" } } }),
    /malformed model payload/,
  );
  assert.throws(
    () => normalizeModelsDev("anthropic", { anthropic: { models: {
      broken: { status: 7, modalities: TEXT_MODALITIES, cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 1.25 } },
    } } }),
    /status must be a string/,
  );

  const missingDate = normalizeModelsDev("anthropic", { anthropic: { models: {
    model: { modalities: TEXT_MODALITIES, cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 1.25 } },
    beta: { status: "beta", modalities: TEXT_MODALITIES, last_updated: "2026-07-29", cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 1.25 } },
  } } }, "2026-07-29T12:34:56.000Z");
  assert.equal(missingDate.syncedAt, "2026-07-29");
  assert.equal(missingDate.models[0]?.rateAsOf, null);
  assert.equal(missingDate.models[0]?.rates, null);
  assert.equal(missingDate.models[0]?.reason, "missing or invalid last_updated");
  assert.equal(missingDate.models[1]?.rates, null);
  assert.equal(missingDate.models[1]?.reason, "unsupported model status beta");
});

test("deprecated models preserve complete historical rates for backfills", () => {
  const catalog = normalizeModelsDev("anthropic", { anthropic: { models: {
    old: {
      status: "deprecated",
      modalities: TEXT_MODALITIES,
      last_updated: "2026-07-29",
      cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 1.25 },
    },
  } } }, "2026-07-29");
  const currentSource = {
    ...source,
    models: source.models.map((model) => ({ ...model, syncStatus: "current" as const })),
  };
  const merged = mergeProvider(currentSource, catalog, {});
  assert.equal(merged.source.models.find((model) => model.id === "old")?.syncStatus, "historical");
  assert.ok(generateRates([merged.source]).models.some((model) => model.id === "old"));
});

test("upstream-missing current models become preserved historical entries", () => {
  const currentSource = {
    ...source,
    models: source.models.map((model) => ({ ...model, syncStatus: "current" as const })),
  };
  const emptyCatalog: ProviderCatalog = {
    provider: "anthropic",
    sourceUrl: "https://models.dev/api.json",
    syncedAt: "2026-07-29",
    diagnostics: [],
    models: [],
  };
  const merged = mergeProvider(currentSource, emptyCatalog, {});
  assert.equal(merged.source.models[0]?.syncStatus, "historical");
  assert.equal(merged.source.models[0]?.rateAsOf, currentSource.models[0]?.rateAsOf);
  assert.deepEqual(merged.summary.preserved, ["old"]);
});

test("an unresolved promoted alias becomes an honest inactive identity", () => {
  const catalog: ProviderCatalog = {
    provider: "anthropic",
    sourceUrl: "https://models.dev/api.json",
    syncedAt: "2026-07-29",
    diagnostics: [],
    models: [{
      id: "snapshot",
      rates: null,
      rateAsOf: null,
      rateSourceUrl: "https://models.dev/api.json",
      reason: "missing cost",
    }],
  };
  const merged = mergeProvider(source, catalog, {});
  const promoted = merged.source.models.find((model) => model.id === "snapshot");
  assert.equal(promoted?.syncStatus, "inactive");
  assert.equal(promoted?.inputPerMTokUSD, null);
  assert.equal(promoted?.rateAsOf, null);
  assert.deepEqual(merged.source.models.find((model) => model.id === "old")?.aliases, []);
});

test("global identity collisions fail validation", () => {
  const first = parseSourceYaml(renderSourceYaml(source), "first.yaml");
  const second = {
    ...first,
    provider: "other",
    models: [{ ...first.models[0]!, aliases: [] }],
  };
  assert.throws(() => validateSources([first, second]), /canonical ID collision/);
});
