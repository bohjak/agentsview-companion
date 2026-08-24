import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readSourceYaml } from "./source-yaml.ts";
import type { GeneratedRates, PricingSource } from "./types.ts";
import { activeModels, validateSources } from "./validate.ts";

export const STALE_DAYS = 180;
export function isCatalogStale(syncedAt: string): boolean {
  const timestamp = Date.parse(syncedAt);
  return !Number.isFinite(timestamp) || Date.now() - timestamp > STALE_DAYS * 86_400_000;
}

export function loadSources(sourcesDir: string): PricingSource[] {
  const files = readdirSync(sourcesDir).filter((file) => /\.ya?ml$/.test(file)).sort();
  if (!files.length) throw new Error(`No YAML source files in ${sourcesDir}`);
  const sources = files.map((file) => readSourceYaml(join(sourcesDir, file)));
  validateSources(sources);
  return sources;
}

export function generateRates(sources: PricingSource[], generatedAt = new Date().toISOString()): GeneratedRates {
  validateSources(sources);
  const models = sources.flatMap((source) => activeModels(source).map((model) => ({ ...model, aliases: [...model.aliases], provider: source.provider })))
    .sort((a, b) => a.id.localeCompare(b.id, "en", { sensitivity: "base" }));
  return { generatedAt, sources: sources.map(({ provider, asOf, sourceUrl, syncSourceUrl, syncedAt }) => ({ provider, asOf, sourceUrl, syncSourceUrl, syncedAt })), models };
}

export function generatedComparable(generated: GeneratedRates): string {
  const { sources, models } = generated;
  return JSON.stringify({ sources, models });
}

export function runGenerator(repoRoot: string, checkMode: boolean): void {
  const sources = loadSources(join(repoRoot, "pricing-sources"));
  const stale = sources.filter((source) => isCatalogStale(source.syncedAt));
  for (const source of stale) console.warn(`[generate-pricing] WARNING: ${source.provider} catalog syncedAt=${source.syncedAt} is older than ${STALE_DAYS} days; run sync:pricing.`);
  const generated = generateRates(sources);
  const outPath = join(repoRoot, "store", "src", "pricing", "rates.json");
  if (checkMode) {
    let existing: GeneratedRates;
    try { existing = JSON.parse(readFileSync(outPath, "utf8")) as GeneratedRates; } catch { throw new Error(`--check: cannot read ${outPath}; run pnpm exec tsx scripts/generate-pricing.ts`); }
    if (generatedComparable(existing) !== generatedComparable(generated)) throw new Error("--check: rates.json is out of sync; run pnpm exec tsx scripts/generate-pricing.ts");
    if (stale.length) throw new Error("--check: one or more catalog sync dates are stale; run sync:pricing");
    console.log("[generate-pricing] --check: rates.json is up to date.");
    return;
  }
  const json = `${JSON.stringify(generated, null, 2)}\n`;
  for (const output of [outPath, join(repoRoot, "store", "dist", "src", "pricing", "rates.json")]) {
    mkdirSync(resolve(output, ".."), { recursive: true }); writeFileSync(output, json, "utf8"); console.log(`[generate-pricing] Written: ${output}`);
  }
}
