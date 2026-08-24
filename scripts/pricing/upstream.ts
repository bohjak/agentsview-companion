import { fetchModelsDev, normalizeModelsDev } from "./models-dev.ts";
import type { ProviderCatalog } from "./types.ts";

export const SUPPORTED_PROVIDERS = ["anthropic", "google", "openai", "xai"] as const;
export type SupportedProvider = typeof SUPPORTED_PROVIDERS[number];

export async function loadCatalogs(providers: readonly SupportedProvider[], fixture: unknown | null): Promise<ProviderCatalog[]> {
  const payload = fixture ?? await fetchModelsDev();
  const syncedAt = new Date().toISOString();
  return providers.map((provider) => normalizeModelsDev(provider, payload, syncedAt));
}
