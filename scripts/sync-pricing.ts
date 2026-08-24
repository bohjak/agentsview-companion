#!/usr/bin/env tsx
import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadSources, runGenerator } from "./pricing/generate.ts";
import { parseSourceYaml, renderSourceYaml } from "./pricing/source-yaml.ts";
import { mergeProvider, validateOverrides } from "./pricing/sync.ts";
import type { SyncOverrides } from "./pricing/types.ts";
import { SUPPORTED_PROVIDERS, loadCatalogs, type SupportedProvider } from "./pricing/upstream.ts";
import { validateSources } from "./pricing/validate.ts";

type Options = { dryRun: boolean; provider: SupportedProvider | null; catalogFile: string | null };
function usage(): never { throw new Error("Usage: sync-pricing [--dry-run] [--provider anthropic|google|openai|xai] [--catalog-file path]"); }
function parseArgs(argv: string[]): Options {
  const options: Options = { dryRun: false, provider: null, catalogFile: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--provider") { const value = argv[++index]; if (!SUPPORTED_PROVIDERS.includes(value as SupportedProvider)) usage(); options.provider = value as SupportedProvider; }
    else if (arg === "--catalog-file") { const value = argv[++index]; if (!value) usage(); options.catalogFile = value; }
    else usage();
  }
  return options;
}
function overrides(repoRoot: string): SyncOverrides {
  const file = join(repoRoot, "pricing-sources", "sync-overrides.json"); if (!existsSync(file)) return {};
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("sync-overrides.json must be an object");
  const config = parsed as SyncOverrides;
  validateOverrides(config);
  return config;
}
function printSummary(provider: string, summary: ReturnType<typeof mergeProvider>["summary"]): void {
  for (const [name, values] of Object.entries(summary)) {
    const sorted = [...values].sort();
    console.log(`[sync-pricing] ${provider}: ${name}=${sorted.length}${sorted.length ? `: ${sorted.join(", ")}` : ""}`);
  }
}
function replaceAtomically(changes: Array<{ path: string; text: string }>, afterReplace: () => void): void {
  type Backup = { path: string; backup: string | null };
  const backups: Backup[] = [];
  const temps: string[] = [];
  let retainBackups = false;
  const runtimePaths = [
    join(process.cwd(), "store", "src", "pricing", "rates.json"),
    join(process.cwd(), "store", "dist", "src", "pricing", "rates.json"),
  ];

  try {
    for (const path of [...changes.map((change) => change.path), ...runtimePaths]) {
      if (!existsSync(path)) {
        backups.push({ path, backup: null });
        continue;
      }
      const backup = `${path}.${process.pid}.bak`;
      copyFileSync(path, backup);
      backups.push({ path, backup });
    }
    for (const change of changes) {
      const temp = `${change.path}.${process.pid}.tmp`;
      writeFileSync(temp, change.text, "utf8");
      temps.push(temp);
    }
    for (const change of changes) renameSync(`${change.path}.${process.pid}.tmp`, change.path);
    afterReplace();
  } catch (error) {
    const rollbackFailures: string[] = [];
    for (const entry of backups) {
      try {
        if (entry.backup === null) rmSync(entry.path, { force: true });
        else copyFileSync(entry.backup, entry.path);
      } catch (rollbackError) {
        rollbackFailures.push(`${entry.path}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
    }
    const original = error instanceof Error ? error.message : String(error);
    if (rollbackFailures.length > 0) {
      retainBackups = true;
      const recoveryPaths = backups.flatMap((entry) => entry.backup ?? []);
      throw new Error(
        `source replacement or generation failed: ${original}; rollback INCOMPLETE: ` +
          `${rollbackFailures.join("; ")}; recovery backups retained: ${recoveryPaths.join(", ")}`,
      );
    }
    throw new Error(`source replacement or generation failed; rollback completed: ${original}`);
  } finally {
    for (const temp of temps) rmSync(temp, { force: true });
    if (!retainBackups) {
      for (const entry of backups) if (entry.backup !== null) rmSync(entry.backup, { force: true });
    }
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2)); const repoRoot = process.cwd();
  const selected = options.provider ? [options.provider] : [...SUPPORTED_PROVIDERS];
  const fixture = options.catalogFile ? JSON.parse(readFileSync(resolve(options.catalogFile), "utf8")) as unknown : null;
  const catalogs = await loadCatalogs(selected, fixture); const sourceSet = loadSources(join(repoRoot, "pricing-sources")); const sourceByProvider = new Map(sourceSet.map((source) => [source.provider, source])); const config = overrides(repoRoot);
  const changed = new Map<string, ReturnType<typeof mergeProvider>["source"]>();
  for (const catalog of catalogs) {
    if (catalog.diagnostics.length) throw new Error(`${catalog.provider}: catalog diagnostics: ${catalog.diagnostics.sort().join("; ")}`);
    const source = sourceByProvider.get(catalog.provider); if (!source) throw new Error(`no source YAML for ${catalog.provider}`);
    const merged = mergeProvider(source, catalog, config); changed.set(catalog.provider, merged.source); printSummary(catalog.provider, merged.summary);
  }
  const allSources = sourceSet.map((source) => changed.get(source.provider) ?? source); validateSources(allSources);
  const replacements = allSources.flatMap((source) => {
    if (!changed.has(source.provider)) return [];
    const path = join(repoRoot, "pricing-sources", `${source.provider}.yaml`); const text = renderSourceYaml(source, readFileSync(path, "utf8"));
    return readFileSync(path, "utf8") === text ? [] : [{ path, text }];
  });
  // Validate exactly what will be staged, not only the in-memory objects.
  const staged = sourceSet.map((source) => {
    const replacement = replacements.find((item) => item.path.endsWith(`/${source.provider}.yaml`));
    return replacement ? parseSourceYaml(replacement.text, replacement.path) : source;
  });
  validateSources(staged);
  if (options.dryRun) { console.log(`[sync-pricing] dry run: ${replacements.length} source file(s) would change.`); return; }
  replaceAtomically(replacements, () => runGenerator(repoRoot, false));
  console.log(`[sync-pricing] updated ${replacements.length} source file(s).`);
}

main().catch((error: unknown) => { console.error(`[sync-pricing] ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
