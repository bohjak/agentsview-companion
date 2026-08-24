import type { PricingModel, PricingSource, RateComponent } from "./types.ts";

function validRate(value: RateComponent): boolean { return value === null || (Number.isFinite(value) && value >= 0); }
function validDate(value: string): boolean { return /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)?$/.test(value) && Number.isFinite(Date.parse(value)); }
function validIdentifier(value: string): boolean { return value.length > 0 && !/[\u0000-\u001f\u007f]/.test(value); }
const STATUSES = new Set(["current", "overridden", "historical", "inactive"]);

export function validateModel(model: PricingModel, provider: string): void {
  if (!validIdentifier(model.id)) throw new Error(`${provider}: model id must be non-empty and control-character-free`);
  if (!STATUSES.has(model.syncStatus)) throw new Error(`${provider}/${model.id}: invalid syncStatus ${model.syncStatus}`);
  if (!model.rateSourceUrl.trim()) throw new Error(`${provider}/${model.id}: missing rate source provenance`);
  if (model.rateAsOf === null) {
    if (model.syncStatus !== "inactive") throw new Error(`${provider}/${model.id}: active model requires rateAsOf provenance`);
  } else if (!validDate(model.rateAsOf)) {
    throw new Error(`${provider}/${model.id}: invalid rateAsOf ${model.rateAsOf}`);
  }
  for (const key of ["inputPerMTokUSD", "outputPerMTokUSD", "cacheReadPerMTokUSD", "cacheWritePerMTokUSD"] as const) {
    if (!validRate(model[key])) throw new Error(`${provider}/${model.id}: ${key} must be non-negative finite or null`);
  }
  if (model.syncStatus !== "inactive" && (model.inputPerMTokUSD === null || model.outputPerMTokUSD === null)) throw new Error(`${provider}/${model.id}: active input/output rates cannot be unavailable`);
  if (!model.aliases.every(validIdentifier)) throw new Error(`${provider}/${model.id}: aliases must be non-empty and control-character-free`);
}

export function validateSources(sources: PricingSource[]): void {
  const canonical = new Map<string, string>();
  const aliases = new Map<string, string>();
  const providers = new Set<string>();
  for (const source of sources) {
    if (!validIdentifier(source.provider) || !source.sourceUrl.trim() || !source.syncSourceUrl.trim()) throw new Error(`${source.provider || "<unknown>"}: missing or invalid source metadata`);
    if (providers.has(source.provider)) throw new Error(`duplicate provider: ${source.provider}`);
    providers.add(source.provider);
    if (!validDate(source.asOf) || !validDate(source.syncedAt)) throw new Error(`${source.provider}: invalid asOf or syncedAt`);
    for (const model of source.models) {
      validateModel(model, source.provider);
      const owner = canonical.get(model.id);
      if (owner) throw new Error(`canonical ID collision: ${model.id} (${owner}, ${source.provider})`);
      if (aliases.has(model.id)) throw new Error(`canonical ID collides with alias: ${model.id}`);
      canonical.set(model.id, source.provider);
      for (const alias of model.aliases) {
        const aliasOwner = aliases.get(alias);
        if (aliasOwner) throw new Error(`alias collision: ${alias} (${aliasOwner}, ${source.provider}/${model.id})`);
        if (canonical.has(alias)) throw new Error(`alias collides with canonical ID: ${alias}`);
        aliases.set(alias, `${source.provider}/${model.id}`);
      }
    }
  }
}

export function activeModels(source: PricingSource): PricingModel[] {
  return source.models.filter((model) => model.syncStatus !== "inactive");
}
