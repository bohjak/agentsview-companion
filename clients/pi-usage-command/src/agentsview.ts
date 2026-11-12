import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { usageParams, type UsageSince } from "./queries.ts";

type Money = { microdollars: number };
export type Tokens = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
};
export type UsageReport = {
  from: string;
  to: string;
  totals: Tokens & { totalCost: Money };
  sessionCounts: { total: number };
  modelTotals: Array<Tokens & { model: string; cost: Money }>;
  projectTotals: Array<Tokens & { project: string; project_key: string; cost: Money }>;
  agentTotals: Array<Tokens & { agent: string; cost: Money }>;
  daily: Array<Tokens & { date: string; totalCost: Money }>;
  pricing?: {
    cost_source: string;
    models: Record<string, { resolutions: Array<{ cost_source: string; matched_pattern?: string }> }>;
  };
  unsupportedUsage?: unknown;
  planOnlySessions?: number;
  partlyCapturedSessions?: number;
};
export type UsageReply = { report: UsageReport; notices: string[] };
type Transport = typeof fetch;
type RuntimeRecord = {
  service: string;
  network: string;
  address: string;
  pid: number;
  started_at?: string;
  metadata?: { read_only?: string };
};

export function localURL(value: string): URL {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash) {
    throw new Error("AgentsView URL must be an HTTP(S) loopback URL without credentials, query, or fragment.");
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("AgentsView returned an unsupported usage response.");
  }
  return value as Record<string, unknown>;
}

function counter(value: unknown): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error("AgentsView returned an invalid usage counter.");
  }
}

function validateTokens(value: unknown, costKey: string): void {
  const row = object(value);
  for (const key of ["inputTokens", "outputTokens", "cacheCreationTokens", "cacheReadTokens"]) counter(row[key]);
  counter(object(row[costKey]).microdollars);
}

export function parseReport(value: unknown): UsageReport {
  const report = object(value);
  if (typeof report.from !== "string" || typeof report.to !== "string") {
    throw new Error("AgentsView returned an unsupported usage range.");
  }
  validateTokens(report.totals, "totalCost");
  counter(object(report.sessionCounts).total);
  for (const [key, label, cost] of [
    ["modelTotals", "model", "cost"],
    ["projectTotals", "project", "cost"],
    ["agentTotals", "agent", "cost"],
    ["daily", "date", "totalCost"],
  ] as const) {
    if (!Array.isArray(report[key])) throw new Error(`AgentsView returned invalid ${key}.`);
    for (const row of report[key]) {
      validateTokens(row, cost);
      if (typeof object(row)[label] !== "string") throw new Error(`AgentsView returned an invalid ${label}.`);
    }
  }
  return report as UsageReport;
}

export function reportNotices(report: UsageReport, stale: boolean): string[] {
  const notices: string[] = [];
  if (stale) notices.push("AgentsView is catching up; usage may be stale.");
  if (["computed", "mixed"].includes(report.pricing?.cost_source ?? "")) {
    notices.push("Costs include AgentsView catalog estimates.");
  }
  const unpriced = Object.entries(report.pricing?.models ?? {})
    .filter(([, model]) => model.resolutions.some((r) => r.cost_source === "computed" && !r.matched_pattern))
    .map(([name]) => name);
  if (unpriced.length) notices.push(`Unpriced models: ${unpriced.join(", ")}`);
  if (report.planOnlySessions) notices.push(`${report.planOnlySessions} plan-usage sessions excluded from token/cost totals.`);
  if (report.partlyCapturedSessions) notices.push(`${report.partlyCapturedSessions} sessions have incomplete token capture.`);
  if (report.unsupportedUsage) notices.push("Some sessions do not expose token usage to AgentsView.");
  return notices;
}

export class AgentsViewClient {
  private readonly dataDirectory: string;
  private readonly serverURL: string;
  private readonly transport: Transport;

  constructor(options: { dataDirectory?: string; serverURL?: string; transport?: Transport } = {}) {
    this.dataDirectory = options.dataDirectory ?? process.env.AGENTSVIEW_DATA_DIR ?? join(homedir(), ".agentsview");
    this.serverURL = options.serverURL ?? process.env.AGENTSVIEW_URL ?? "";
    this.transport = options.transport ?? fetch;
  }

  private async get(base: URL, path: string, params?: URLSearchParams, timeout = 60_000): Promise<Response> {
    const url = new URL(path, base);
    if (params) url.search = params.toString();
    const response = await this.transport(url, {
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) throw new Error(`AgentsView returned HTTP ${response.status}.`);
    return response;
  }

  async resolveServer(): Promise<URL> {
    if (this.serverURL.trim()) return localURL(this.serverURL.trim());
    const files = await readdir(this.dataDirectory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const records: RuntimeRecord[] = [];
    for (const file of files.filter((name) => /^daemon\..+\.json$/.test(name))) {
      try {
        const record = JSON.parse(await readFile(join(this.dataDirectory, file), "utf8")) as RuntimeRecord;
        if (record.service === "agentsview" && record.network === "tcp" &&
            typeof record.address === "string" && Number.isInteger(record.pid) && record.pid > 0 &&
            (record.started_at === undefined || typeof record.started_at === "string") &&
            record.metadata?.read_only !== "true") records.push(record);
      } catch {
        // Daemon records may be replaced while discovery is reading them.
      }
    }
    records.sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""));
    for (const record of records) {
      try {
        const url = localURL(`http://${record.address}`);
        const ping = await (await this.get(url, "api/ping", undefined, 2_000)).json() as Record<string, unknown>;
        if (ping.ok === true && ping.service === "agentsview" && ping.pid === record.pid) return url;
      } catch {
        // A stale record is not evidence that a daemon is still listening.
      }
    }
    throw new Error("AgentsView is not running. Run 'agentsview daemon start' or set AGENTSVIEW_URL to its local URL.");
  }

  async loadUsage(since: UsageSince = "all", now = new Date()): Promise<UsageReply> {
    const base = await this.resolveServer();
    const response = await this.get(base, "api/v1/usage/summary", usageParams(since, now));
    const report = parseReport(await response.json());
    return { report, notices: reportNotices(report, response.headers.get("X-Agentsview-Archive-Stale") === "true") };
  }
}
