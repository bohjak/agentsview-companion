export type RateComponent = number | null;

export type ModelRates = {
  inputPerMTokUSD: RateComponent;
  outputPerMTokUSD: RateComponent;
  cacheReadPerMTokUSD: RateComponent;
  cacheWritePerMTokUSD: RateComponent;
};

export type SyncStatus = "current" | "overridden" | "historical" | "inactive";

export type PricingModel = ModelRates & {
  id: string;
  aliases: string[];
  rateSourceUrl: string;
  rateAsOf: string | null;
  syncStatus: SyncStatus;
};

export type PricingSource = {
  provider: string;
  asOf: string;
  sourceUrl: string;
  syncSourceUrl: string;
  syncedAt: string;
  models: PricingModel[];
};

export type GeneratedRates = {
  generatedAt: string;
  sources: Array<Pick<PricingSource, "provider" | "asOf" | "sourceUrl" | "syncSourceUrl" | "syncedAt">>;
  models: Array<PricingModel & { provider: string }>;
};

export type UpstreamModel = {
  id: string;
  rates: ModelRates | null;
  rateAsOf: string | null;
  rateSourceUrl: string;
  reason?: string;
  deprecated?: boolean;
};

export type ProviderCatalog = {
  provider: string;
  sourceUrl: string;
  syncedAt: string;
  models: UpstreamModel[];
  diagnostics: string[];
};

export type SyncOverride = {
  aliases?: string[];
  canonical?: boolean;
  rates?: ModelRates;
  exclude?: boolean;
  rateSourceUrl?: string;
  rateAsOf?: string;
  reason?: string;
};

export type SyncOverrides = Record<string, SyncOverride>;

export type ProviderSummary = {
  added: string[];
  promoted: string[];
  updated: string[];
  unchanged: string[];
  preserved: string[];
  skipped: string[];
  unresolved: string[];
};
