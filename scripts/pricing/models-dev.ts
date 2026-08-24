import type { ModelRates, ProviderCatalog, UpstreamModel } from "./types.ts";

const PROVIDER_KEYS: Record<string, string> = { anthropic: "anthropic", google: "google", openai: "openai", xai: "xai" };
const SOURCE_URL = "https://models.dev/api.json";
const MAX_CATALOG_BYTES = 10 * 1024 * 1024;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function number(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null; }
function date(value: unknown): string | null { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) && Number.isFinite(Date.parse(value)) ? value.slice(0, 10) : null; }
function hasAlternateTextTier(cost: Record<string, unknown>): boolean {
  return ["tiers", "context_over_200k", "context_over_128k", "long_context"].some((key) => key in cost);
}
function isNonTextModel(id: string, model: Record<string, unknown>, cost: Record<string, unknown>): boolean {
  const haystack = `${id} ${String(model.name ?? "")} ${String(model.type ?? "")}`.toLowerCase();
  if (/(embedding|tts|audio|image|vision|realtime|video|moderation)/.test(haystack)) return true;
  if (Object.keys(cost).some((key) => /(^|_)(audio|image|video|realtime|embedding)(_|$)/.test(key))) return true;

  const modalities = object(model.modalities);
  const input = modalities?.input;
  const output = modalities?.output;
  if (!Array.isArray(input) || !input.every((value) => typeof value === "string") || !input.includes("text")) return true;
  if (!Array.isArray(output) || output.length !== 1 || output[0] !== "text") return true;
  return false;
}
function optionalCacheRate(value: unknown): number | null | undefined {
  if (value === undefined) return null;
  const parsed = number(value);
  return parsed === null ? undefined : parsed;
}

function cacheRates(provider: string, cost: Record<string, unknown>): Pick<ModelRates, "cacheReadPerMTokUSD" | "cacheWritePerMTokUSD"> | null {
  if (provider === "google") {
    const read = optionalCacheRate(cost.cache_read);
    return read === undefined ? null : { cacheReadPerMTokUSD: read, cacheWritePerMTokUSD: null };
  }
  if (provider === "openai") {
    const read = optionalCacheRate(cost.cache_read);
    return read === undefined ? null : { cacheReadPerMTokUSD: read, cacheWritePerMTokUSD: 0 };
  }
  if (provider === "xai") {
    const read = optionalCacheRate(cost.cache_read);
    const write = optionalCacheRate(cost.cache_write);
    return read === undefined || write === undefined ? null : { cacheReadPerMTokUSD: read, cacheWritePerMTokUSD: write };
  }
  const read = number(cost.cache_read);
  const write = number(cost.cache_write);
  return read === null || write === null ? null : { cacheReadPerMTokUSD: read, cacheWritePerMTokUSD: write };
}

export function normalizeModelsDev(provider: string, payload: unknown, syncedAt = new Date().toISOString().slice(0, 10)): ProviderCatalog {
  const root = object(payload); if (!root) throw new Error("models.dev: root must be an object");
  const providerKey = PROVIDER_KEYS[provider]; if (!providerKey) throw new Error(`unsupported provider ${provider}`);
  const providerValue = object(root[providerKey]); if (!providerValue) throw new Error(`models.dev: missing configured provider ${providerKey}`);
  const rawModels = object(providerValue.models); if (!rawModels) throw new Error(`models.dev: ${providerKey}.models must be an object`);
  const models: UpstreamModel[] = []; const diagnostics: string[] = [];
  for (const [id, rawModel] of Object.entries(rawModels)) {
    const model = object(rawModel);
    if (!id.trim() || /[\u0000-\u001f\u007f]/.test(id) || !model) throw new Error(`${provider}/${id || "<empty>"}: malformed model payload`);
    if (model.status !== undefined && typeof model.status !== "string") throw new Error(`${provider}/${id}: status must be a string`);
    const rateAsOf = date(model.last_updated);
    const costValue = model.cost;
    const cost = object(costValue);
    if (costValue !== undefined && !cost) throw new Error(`${provider}/${id}: cost must be an object`);
    const unresolved = (reason: string): void => { models.push({ id, rates: null, rateAsOf, rateSourceUrl: SOURCE_URL, reason }); };
    if (model.status !== undefined && model.status !== "deprecated") {
      unresolved(`unsupported model status ${model.status}`);
      continue;
    }
    if (!cost) { unresolved("missing cost"); continue; }
    if (isNonTextModel(id, model, cost)) { unresolved("non-text model"); continue; }
    if (hasAlternateTextTier(cost)) { unresolved("context-tiered pricing"); continue; }
    if (!rateAsOf) { unresolved("missing or invalid last_updated"); continue; }
    const input = number(cost.input); const output = number(cost.output); const cache = cacheRates(provider, cost);
    if (input === null || output === null || cache === null) { unresolved("incomplete standard text pricing"); continue; }
    models.push({ id, rates: { inputPerMTokUSD: input, outputPerMTokUSD: output, ...cache }, rateAsOf, rateSourceUrl: SOURCE_URL, deprecated: model.status === "deprecated" });
  }
  return { provider, sourceUrl: SOURCE_URL, syncedAt: syncedAt.slice(0, 10), models, diagnostics };
}

export async function fetchModelsDev(timeoutMs = 15_000): Promise<unknown> {
  const response = await fetch(SOURCE_URL, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`models.dev: HTTP ${response.status}`);
  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > MAX_CATALOG_BYTES) throw new Error(`models.dev: response exceeds ${MAX_CATALOG_BYTES} bytes`);
  if (!response.body) throw new Error("models.dev: missing response body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_CATALOG_BYTES) { await reader.cancel(); throw new Error(`models.dev: response exceeds ${MAX_CATALOG_BYTES} bytes`); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; } catch { throw new Error("models.dev: invalid JSON"); }
}
