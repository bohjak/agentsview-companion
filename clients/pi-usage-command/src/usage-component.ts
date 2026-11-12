import type { UsageSince, UsageTab } from "./queries.ts";
import type { UsageReply } from "./agentsview.ts";
import { renderTab } from "./format.ts";

type Theme = {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
};
type Options = {
  loadReport(since: UsageSince): Promise<UsageReply>;
  initialReport: UsageReply;
  initialTab: UsageTab;
  since: UsageSince;
  theme: Theme;
  requestRender(): void;
  onClose(): void;
};

const TABS: UsageTab[] = ["summary", "models", "repos", "daily"];
const PERIODS: UsageSince[] = ["today", "7d", "month", "all"];

export class UsageTabsComponent {
  private tab: UsageTab;
  private since: UsageSince;
  private readonly options: Options;
  private readonly reports = new Map<UsageSince, UsageReply>();
  private readonly errors = new Map<UsageSince, string>();
  private readonly pending = new Set<UsageSince>();
  private closed = false;

  constructor(options: Options) {
    this.options = options;
    this.tab = options.initialTab;
    this.since = options.since;
    this.reports.set(this.since, options.initialReport);
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (data === "q" || data === "Q" || data === "\u001b") {
      this.closed = true;
      this.options.onClose();
      return;
    }
    if (data === "\u001b[C" || data === "]") {
      this.tab = TABS[(TABS.indexOf(this.tab) + 1) % TABS.length]!;
    } else if (data === "\u001b[D" || data === "[") {
      this.tab = TABS[(TABS.indexOf(this.tab) + TABS.length - 1) % TABS.length]!;
    } else if (/^[1-4]$/.test(data)) {
      this.tab = TABS[Number(data) - 1]!;
    } else if (data.toLowerCase() === "s") {
      this.since = PERIODS[(PERIODS.indexOf(this.since) + 1) % PERIODS.length]!;
      this.loadPeriod();
    }
    this.options.requestRender();
  }

  private loadPeriod(): void {
    const since = this.since;
    if (this.reports.has(since) || this.pending.has(since)) return;
    this.pending.add(since);
    this.errors.delete(since);
    void this.options.loadReport(since).then(
      (reply) => { this.reports.set(since, reply); },
      (error: unknown) => { this.errors.set(since, String(error)); },
    ).finally(() => {
      this.pending.delete(since);
      if (!this.closed) this.options.requestRender();
    });
  }

  render(width: number): string[] {
    const theme = this.options.theme;
    const report = this.reports.get(this.since);
    const body = report ? renderTab(this.tab, report).split("\n")
      : [this.errors.get(this.since) ?? "Loading AgentsView usage…"];
    const labels = TABS.map((tab) => ` ${tab} `).join("");
    const lines = [
      labels,
      "─".repeat(Math.max(0, width)),
      ...body,
      "─".repeat(Math.max(0, width)),
      `←/→ tabs · 1-4 jump · s since (${this.since}) · q quit`,
    ];
    // Clip before applying theme escape sequences so narrow terminals stay bounded.
    return lines.map((line, i) => theme.fg(i === 0 ? "accent" : "text", line.slice(0, Math.max(0, width))));
  }
}
