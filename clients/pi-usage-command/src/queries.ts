export type UsageTab = "summary" | "models" | "repos" | "daily";
export type UsageSince = "today" | "7d" | "month" | "all";
export type UsageArgs = { json: boolean; tab: UsageTab; since: UsageSince };

export function parseUsageArgs(raw: string): UsageArgs {
  const args = raw.trim().split(/\s+/).filter(Boolean);
  const result: UsageArgs = { json: false, tab: "summary", since: "all" };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--json") {
      result.json = true;
      continue;
    }
    const [flag, inline] = arg.split("=", 2);
    if (flag !== "--tab" && flag !== "--since") throw new Error(`Unknown argument: ${arg}`);
    const value = inline ?? args[++i];
    if (flag === "--tab") {
      if (!["summary", "models", "repos", "daily"].includes(value ?? "")) {
        throw new Error("Use --tab=summary|models|repos|daily. Tools and PR tracking are no longer provided.");
      }
      result.tab = value as UsageTab;
    } else {
      if (!["today", "7d", "month", "all"].includes(value ?? "")) {
        throw new Error("Use --since=today|7d|month|all. AgentsView reports calendar days, not rolling 24-hour windows.");
      }
      result.since = value as UsageSince;
    }
  }
  return result;
}

function localDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function usageParams(since: UsageSince, now: Date): URLSearchParams {
  const params = new URLSearchParams({
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    include_automated: "true",
    include_one_shot: "true",
    no_default_range: "true",
    to: localDate(now),
  });
  if (since !== "all") {
    const start = new Date(now);
    start.setDate(start.getDate() - (since === "today" ? 0 : since === "7d" ? 6 : 29));
    params.set("from", localDate(start));
  }
  return params;
}
