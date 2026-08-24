import { readFileSync } from "node:fs";
import type { PricingModel, PricingSource, RateComponent, SyncStatus } from "./types.ts";

type PartialModel = Partial<PricingModel> & {
  aliases: string[];
  fields: Set<string>;
};

function scalar(raw: string): string | null {
  const value = raw.trim();
  if (value === "null") return null;
  if (value.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed !== "string") throw new Error("not a string");
      return parsed;
    } catch { throw new Error(`invalid quoted scalar ${raw}`); }
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'")) throw new Error(`invalid quoted scalar ${raw}`);
    return value.slice(1, -1);
  }
  if (/[:#\\[\\]{}&,*!|>'"%@`]/.test(value) || /\s{2,}/.test(value)) throw new Error(`unsafe unquoted scalar ${raw}`);
  return value;
}

function validIdentifier(value: string): boolean {
  return value.length > 0 && !/[\u0000-\u001f\u007f]/.test(value);
}

function component(raw: string, filename: string, line: number): RateComponent {
  const value = scalar(raw);
  if (value === null) return null;
  if (value === "") throw new Error(`${filename}:${line}: rate component cannot be empty`);
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${filename}:${line}: expected finite number, got ${raw}`);
  return number;
}

function assignModel(model: PartialModel, key: string, raw: string, filename: string, line: number): void {
  if (model.fields.has(key)) throw new Error(`${filename}:${line}: duplicate model field ${key}`);
  model.fields.add(key);

  if (key === "id" || key === "rateSourceUrl" || key === "syncStatus") {
    const value = scalar(raw);
    if (value === null) throw new Error(`${filename}:${line}: ${key} cannot be null`);
    model[key] = value as never;
    return;
  }
  if (key === "rateAsOf") {
    model.rateAsOf = scalar(raw);
    return;
  }
  if (key === "inputPerMTokUSD" || key === "outputPerMTokUSD" || key === "cacheReadPerMTokUSD" || key === "cacheWritePerMTokUSD") {
    model[key] = component(raw, filename, line) as never;
    return;
  }
  throw new Error(`${filename}:${line}: unknown model field ${key}`);
}

function finalise(model: PartialModel, source: Pick<PricingSource, "sourceUrl" | "asOf">, filename: string): PricingModel {
  const missing = ["id", "inputPerMTokUSD", "outputPerMTokUSD", "cacheReadPerMTokUSD", "cacheWritePerMTokUSD"]
    .filter((key) => model[key as keyof PartialModel] === undefined);
  if (missing.length > 0) throw new Error(`${filename}: model ${model.id ?? "<unknown>"} missing ${missing.join(", ")}`);
  if (!validIdentifier(model.id!)) throw new Error(`${filename}: invalid model id`);
  return {
    id: model.id!, aliases: model.aliases,
    inputPerMTokUSD: model.inputPerMTokUSD!, outputPerMTokUSD: model.outputPerMTokUSD!,
    cacheReadPerMTokUSD: model.cacheReadPerMTokUSD!, cacheWritePerMTokUSD: model.cacheWritePerMTokUSD!,
    rateSourceUrl: model.rateSourceUrl ?? source.sourceUrl,
    rateAsOf: model.rateAsOf === undefined ? source.asOf : model.rateAsOf,
    syncStatus: (model.syncStatus ?? "historical") as SyncStatus,
  };
}

/** Parse the intentionally small YAML subset used by pricing-sources. */
export function parseSourceYaml(content: string, filename: string): PricingSource {
  const top: Record<string, string> = {};
  const topFields = new Set(["provider", "asOf", "sourceUrl", "syncSourceUrl", "syncedAt", "models"]);
  const models: PricingModel[] = [];
  let model: PartialModel | null = null;
  let aliases = false;
  let sawModels = false;
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]!;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    if (indent === 0) {
      const split = trimmed.indexOf(":");
      if (split < 1) throw new Error(`${filename}:${index + 1}: expected top-level key`);
      const key = trimmed.slice(0, split);
      if (!topFields.has(key)) throw new Error(`${filename}:${index + 1}: unknown top-level field ${key}`);
      if (key === "models") {
        if (sawModels) throw new Error(`${filename}:${index + 1}: duplicate top-level field models`);
        if (trimmed.slice(split + 1).trim()) throw new Error(`${filename}:${index + 1}: models must not have a scalar value`);
        sawModels = true;
        continue;
      }
      if (top[key] !== undefined) throw new Error(`${filename}:${index + 1}: duplicate top-level field ${key}`);
      const value = scalar(trimmed.slice(split + 1));
      if (value === null) throw new Error(`${filename}:${index + 1}: top-level ${key} cannot be null`);
      top[key] = value;
      continue;
    }
    if (indent === 2 && trimmed.startsWith("- ")) {
      if (model) models.push(finalise(model, { sourceUrl: top.sourceUrl ?? "", asOf: top.asOf ?? "" }, filename));
      if (!sawModels) throw new Error(`${filename}:${index + 1}: model entry before models field`);
      model = { aliases: [], fields: new Set<string>() };
      aliases = false;
      const rest = trimmed.slice(2);
      const split = rest.indexOf(":");
      if (split < 1 || rest.slice(0, split) !== "id") throw new Error(`${filename}:${index + 1}: model entry must start with id`);
      assignModel(model, "id", rest.slice(split + 1), filename, index + 1);
      continue;
    }
    if (!model) throw new Error(`${filename}:${index + 1}: invalid indentation before models`);
    if (indent === 4) {
      const split = trimmed.indexOf(":"); if (split < 1) throw new Error(`${filename}:${index + 1}: expected model field`);
      const key = trimmed.slice(0, split);
      aliases = key === "aliases";
      if (aliases) {
        if (model.fields.has(key)) throw new Error(`${filename}:${index + 1}: duplicate model field aliases`);
        model.fields.add(key);
        if (trimmed.slice(split + 1).trim()) throw new Error(`${filename}:${index + 1}: aliases must be a sequence`);
      } else {
        assignModel(model, key, trimmed.slice(split + 1), filename, index + 1);
      }
      continue;
    }
    if (indent === 6 && aliases && trimmed.startsWith("- ")) {
      const alias = scalar(trimmed.slice(2));
      if (alias === null || !validIdentifier(alias)) throw new Error(`${filename}:${index + 1}: invalid alias`);
      model.aliases.push(alias);
      continue;
    }
    throw new Error(`${filename}:${index + 1}: invalid indentation or YAML structure`);
  }
  if (model) models.push(finalise(model, { sourceUrl: top.sourceUrl ?? "", asOf: top.asOf ?? "" }, filename));
  for (const required of ["provider", "asOf", "sourceUrl"]) if (!top[required]) throw new Error(`${filename}: missing ${required}`);
  if (!sawModels) throw new Error(`${filename}: missing models`);
  return { provider: top.provider!, asOf: top.asOf!, sourceUrl: top.sourceUrl!, syncSourceUrl: top.syncSourceUrl ?? top.sourceUrl!, syncedAt: top.syncedAt ?? top.asOf!, models };
}

export function readSourceYaml(path: string): PricingSource { return parseSourceYaml(readFileSync(path, "utf8"), path); }

function quote(value: string): string { return JSON.stringify(value); }
function renderComponent(value: RateComponent): string { return value === null ? "null" : String(value); }
function renderDate(value: string | null): string { return value === null ? "null" : quote(value); }

/** Keep the human-maintained header and render deterministic metadata/models. */
export function renderSourceYaml(source: PricingSource, previous = ""): string {
  const headerLines: string[] = [];
  for (const line of previous.split("\n")) {
    if (line.startsWith("#") || (line === "" && headerLines.length > 0)) {
      headerLines.push(line);
      continue;
    }
    break;
  }
  const header = headerLines.join("\n").trimEnd();
  const prefix = header ? `${header}\n\n` : "";
  const models = [...source.models].sort((a, b) => a.id.localeCompare(b.id));
  const body = [
    `provider: ${source.provider}`, `asOf: ${quote(source.asOf)}`, `sourceUrl: ${quote(source.sourceUrl)}`,
    `syncSourceUrl: ${quote(source.syncSourceUrl)}`, `syncedAt: ${quote(source.syncedAt)}`, "", "models:",
    ...models.flatMap((model) => [
      `  - id: ${quote(model.id)}`,
      ...(model.aliases.length ? ["    aliases:", ...[...model.aliases].sort().map((alias) => `      - ${quote(alias)}`)] : []),
      `    inputPerMTokUSD: ${renderComponent(model.inputPerMTokUSD)}`,
      `    outputPerMTokUSD: ${renderComponent(model.outputPerMTokUSD)}`,
      `    cacheReadPerMTokUSD: ${renderComponent(model.cacheReadPerMTokUSD)}`,
      `    cacheWritePerMTokUSD: ${renderComponent(model.cacheWritePerMTokUSD)}`,
      `    rateSourceUrl: ${quote(model.rateSourceUrl)}`,
      `    rateAsOf: ${renderDate(model.rateAsOf)}`,
      `    syncStatus: ${model.syncStatus}`,
      "",
    ]),
  ];
  return `${prefix}${body.join("\n").replace(/\n+$/, "")}\n`;
}
