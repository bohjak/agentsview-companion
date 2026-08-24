import type { PricingModel, PricingSource, ProviderCatalog, ProviderSummary, SyncOverride, SyncOverrides } from "./types.ts";
import { validateSources } from "./validate.ts";

function summary(): ProviderSummary { return { added: [], promoted: [], updated: [], unchanged: [], preserved: [], skipped: [], unresolved: [] }; }
function cloneModel(model: PricingModel): PricingModel { return { ...model, aliases: [...model.aliases] }; }
function inactive(model: PricingModel): PricingModel { return { ...model, syncStatus: "inactive" }; }
function overrideFor(overrides: SyncOverrides, provider: string, id: string): SyncOverride | undefined { return overrides[`${provider}/${id}`]; }
export function validateOverrides(overrides: SyncOverrides): void {
  const allowed = new Set(["aliases", "canonical", "rates", "exclude", "rateSourceUrl", "rateAsOf", "reason"]);
  for (const [path, raw] of Object.entries(overrides)) {
    if (!/^(anthropic|google|openai|xai)\/[^\u0000-\u001f\u007f]+$/.test(path)) throw new Error(`${path}: override key must be <provider>/<model-id>`);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${path}: override must be an object`);
    for (const [key, value] of Object.entries(raw)) {
      if (!allowed.has(key)) throw new Error(`${path}: unknown override field ${key}`);
      if ((key === "canonical" || key === "exclude") && typeof value !== "boolean") throw new Error(`${path}: ${key} must be boolean`);
      if ((key === "rateSourceUrl" || key === "rateAsOf" || key === "reason") && (typeof value !== "string" || value.trim() === "")) throw new Error(`${path}: ${key} must be a non-empty string`);
      if (key === "aliases") {
        if (!Array.isArray(value) || !value.every((alias) => typeof alias === "string" && alias.length > 0 && !/[\u0000-\u001f\u007f]/.test(alias))) throw new Error(`${path}: aliases must be a control-character-free string array`);
        if (new Set(value).size !== value.length) throw new Error(`${path}: aliases must be unique`);
      }
      if (key === "rates") {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path}: rates must be an object`);
        const rates = value as Record<string, unknown>; const fields = ["inputPerMTokUSD", "outputPerMTokUSD", "cacheReadPerMTokUSD", "cacheWritePerMTokUSD"];
        if (Object.keys(rates).length !== fields.length || !fields.every((field) => Object.hasOwn(rates, field))) throw new Error(`${path}: rates must contain exactly all four components`);
        if (!fields.every((field) => rates[field] === null || (typeof rates[field] === "number" && Number.isFinite(rates[field]) && rates[field] >= 0))) throw new Error(`${path}: rates components must be non-negative numbers or null`);
      }
    }
    if (raw.rateAsOf !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(raw.rateAsOf) || !Number.isFinite(Date.parse(raw.rateAsOf)))) throw new Error(`${path}: rateAsOf must be an ISO date`);
    if (raw.exclude && (raw.canonical || raw.rates !== undefined || raw.aliases !== undefined)) throw new Error(`${path}: exclude cannot be combined with canonical, rates, or aliases`);
    if (raw.canonical && raw.rates === undefined) throw new Error(`${path}: canonical additions require complete rates`);
    if (raw.aliases === undefined && !raw.canonical && raw.rates === undefined && !raw.exclude) throw new Error(`${path}: override has no action`);
    validOverride(path.split("/", 1)[0]!, path.slice(path.indexOf("/") + 1), raw);
  }
}

function validOverride(provider: string, id: string, override: SyncOverride): void {
  const needsCitation = override.canonical || override.rates || override.exclude;
  if (needsCitation && (!override.rateSourceUrl || !override.rateAsOf || !override.reason)) throw new Error(`${provider}/${id}: override action requires rateSourceUrl, rateAsOf, and reason`);
  if (override.rates && (override.rates.inputPerMTokUSD === null || override.rates.outputPerMTokUSD === null)) throw new Error(`${provider}/${id}: override input/output must be known`);
}

/** Conservative, side-effect-free source merge. */
export function mergeProvider(source: PricingSource, catalog: ProviderCatalog, overrides: SyncOverrides): { source: PricingSource; summary: ProviderSummary } {
  if (source.provider !== catalog.provider) throw new Error(`provider mismatch: ${source.provider} vs ${catalog.provider}`);
  const result = summary();
  const models = new Map(source.models.map((model) => [model.id, cloneModel(model)]));
  const upstreamIds = new Set(catalog.models.map((model) => model.id));
  const promotedIds = new Set<string>();

  // A provider-native canonical identity always beats an older local alias.
  for (const model of models.values()) {
    const promoted = model.aliases.filter((alias) => upstreamIds.has(alias));
    if (promoted.length > 0) {
      model.aliases = model.aliases.filter((alias) => !upstreamIds.has(alias));
      for (const id of promoted) promotedIds.add(id);
      result.promoted.push(...promoted);
    }
  }
  for (const upstream of catalog.models) {
    const existing = models.get(upstream.id);
    const override = overrideFor(overrides, source.provider, upstream.id); if (override) validOverride(source.provider, upstream.id, override);
    if (override?.exclude) { result.skipped.push(`${upstream.id}: ${override.reason}`); if (existing) models.set(upstream.id, inactive(existing)); continue; }
    if (upstream.deprecated) {
      result.unresolved.push(`${upstream.id}: deprecated`);
      if (existing && existing.syncStatus === "current") {
        // Deprecated does not make a complete historical rate ambiguous.
        // Keep it available for log backfills, but stop calling it current.
        models.set(upstream.id, { ...existing, syncStatus: "historical" });
      } else if (!existing && promotedIds.has(upstream.id) && upstream.rates) {
        models.set(upstream.id, {
          id: upstream.id,
          aliases: [],
          ...upstream.rates,
          rateSourceUrl: upstream.rateSourceUrl,
          rateAsOf: upstream.rateAsOf,
          syncStatus: "inactive",
        });
      }
      continue;
    }
    if (!upstream.rates) {
      result.unresolved.push(`${upstream.id}: ${upstream.reason ?? "unresolved"}`);
      if (existing) {
        models.set(upstream.id, inactive(existing));
      } else if (promotedIds.has(upstream.id)) {
        // Preserve the now-independent identity without inventing rates. The
        // old alias must not continue routing it to a different model.
        models.set(upstream.id, {
          id: upstream.id,
          aliases: [],
          inputPerMTokUSD: null,
          outputPerMTokUSD: null,
          cacheReadPerMTokUSD: null,
          cacheWritePerMTokUSD: null,
          rateSourceUrl: upstream.rateSourceUrl,
          rateAsOf: upstream.rateAsOf,
          syncStatus: "inactive",
        });
      }
      continue;
    }
    const next: PricingModel = {
      id: upstream.id, aliases: existing?.aliases ?? [], ...upstream.rates,
      rateSourceUrl: upstream.rateSourceUrl, rateAsOf: upstream.rateAsOf!, syncStatus: "current",
    };
    if (!existing) result.added.push(upstream.id);
    else if (JSON.stringify(existing) === JSON.stringify(next)) result.unchanged.push(upstream.id);
    else result.updated.push(upstream.id);
    models.set(upstream.id, next);
  }
  for (const [id, model] of models) {
    if (upstreamIds.has(id)) continue;
    result.preserved.push(id);
    if (model.syncStatus === "current") models.set(id, { ...model, syncStatus: "historical" });
  }
  // Overrides apply last and may add a missing canonical model with complete rates.
  for (const [key, override] of Object.entries(overrides)) {
    const prefix = `${source.provider}/`; if (!key.startsWith(prefix)) continue;
    const id = key.slice(prefix.length); validOverride(source.provider, id, override);
    let model = models.get(id);
    if (!model && override.canonical && override.rates) {
      model = { id, aliases: [], ...override.rates, rateSourceUrl: override.rateSourceUrl!, rateAsOf: override.rateAsOf!, syncStatus: "overridden" };
      models.set(id, model); result.added.push(id);
    }
    if (!model) { if (override.aliases?.length) throw new Error(`${key}: aliases require a canonical model`); continue; }
    if (override.aliases) model.aliases = [...new Set([...model.aliases, ...override.aliases])];
    if (override.rates) Object.assign(model, override.rates, { rateSourceUrl: override.rateSourceUrl!, rateAsOf: override.rateAsOf!, syncStatus: "overridden" });
    if (override.exclude) Object.assign(model, { syncStatus: "inactive" });
  }
  const merged: PricingSource = { ...source, syncSourceUrl: catalog.sourceUrl, syncedAt: catalog.syncedAt, models: [...models.values()].sort((a, b) => a.id.localeCompare(b.id)) };
  validateSources([merged]);
  return { source: merged, summary: result };
}
