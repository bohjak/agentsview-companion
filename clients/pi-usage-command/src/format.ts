import type { UsageTab } from "./queries.ts";
import type { Tokens, UsageReply } from "./agentsview.ts";

function usd(microdollars: number): string {
  return `$${(microdollars / 1_000_000).toFixed(4)}`;
}

function tokens(value: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function tokenColumns(row: Tokens): string {
  return `${tokens(row.inputTokens + row.outputTokens).padStart(9)} ${tokens(row.cacheCreationTokens + row.cacheReadTokens).padStart(9)}`;
}

export function tabData(tab: UsageTab, reply: UsageReply): Record<string, unknown> {
  const { report, notices } = reply;
  const common = { from: report.from, to: report.to, notices, pricing: report.pricing };
  switch (tab) {
    case "summary": return { ...common, totals: report.totals, sessionCounts: report.sessionCounts, agentTotals: report.agentTotals };
    case "models": return { ...common, rows: report.modelTotals };
    case "repos": return { ...common, rows: report.projectTotals };
    case "daily": return { ...common, rows: report.daily };
  }
}

export function renderTab(tab: UsageTab, reply: UsageReply): string {
  const { report, notices } = reply;
  const lines = [`ToTally · AgentsView · ${report.from || "all time"} → ${report.to}`, ""];
  if (tab === "summary") {
    lines.push(
      `Cost: ${usd(report.totals.totalCost.microdollars)}    Sessions: ${report.sessionCounts.total}`,
      `Fresh tokens: ${tokens(report.totals.inputTokens + report.totals.outputTokens)}`,
      `Cached tokens: ${tokens(report.totals.cacheCreationTokens + report.totals.cacheReadTokens)}`,
      `Sources: ${report.agentTotals.map((row) => row.agent).join(", ") || "none"}`,
    );
  } else {
    lines.push(`${(tab === "models" ? "Model" : tab === "repos" ? "Project" : "Date").padEnd(30)} ${"Cost USD".padStart(12)} ${"Fresh".padStart(9)} ${"Cached".padStart(9)}`);
    lines.push("─".repeat(65));
    const rows = tab === "models"
      ? report.modelTotals.map((row) => ({ label: row.model, cost: row.cost.microdollars, row }))
      : tab === "repos"
        ? report.projectTotals.map((row) => ({ label: row.project, cost: row.cost.microdollars, row }))
        : report.daily.map((row) => ({ label: row.date, cost: row.totalCost.microdollars, row }));
    rows.sort(tab === "daily" ? (a, b) => a.label.localeCompare(b.label) : (a, b) => b.cost - a.cost);
    for (const { label, cost, row } of rows) {
      lines.push(`${label.slice(0, 30).padEnd(30)} ${usd(cost).padStart(12)} ${tokenColumns(row)}`);
    }
    if (!rows.length) lines.push("No usage for this period.");
    if (tab === "daily" && rows.length) {
      const max = Math.max(...rows.map((row) => row.cost));
      const bars = "▁▂▃▄▅▆▇█";
      lines.push("", rows.map(({ cost }) => bars[max > 0 ? Math.round(cost / max * 7) : 0]).join(""));
    }
  }
  if (notices.length) lines.push("", ...notices.map((notice) => `⚠ ${notice}`));
  return lines.map((line) => line.replace(/[\u0000-\u001f\u007f-\u009f]/g, "")).join("\n");
}
