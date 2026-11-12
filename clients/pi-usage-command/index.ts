import { writeSync } from "node:fs";
import { AgentsViewClient } from "./src/agentsview.ts";
import { parseUsageArgs } from "./src/queries.ts";
import { renderTab, tabData } from "./src/format.ts";
import { UsageTabsComponent } from "./src/usage-component.ts";

type Theme = { fg(color: string, text: string): string; bg(color: string, text: string): string };
type Context = {
  hasUI?: boolean;
  ui: {
    notify(message: string, kind?: string): void;
    custom?<T>(factory: (
      tui: { requestRender(): void },
      theme: Theme,
      keys: unknown,
      done: (value: T) => void,
    ) => UsageTabsComponent): Promise<T>;
  };
};
type ExtensionAPI = {
  registerCommand(name: string, command: {
    description: string;
    handler(args: string, ctx: Context): Promise<void>;
  }): void;
};

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("usage", {
    description: "AgentsView usage. --json [--tab=summary|models|repos|daily] [--since=today|7d|month|all]",
    handler: async (rawArgs, ctx) => {
      const notify = (message: string, kind = "info") => {
        // Pi redirects console.log and makes notify a no-op in print mode.
        if (ctx.hasUI === false) writeSync(1, `${message}\n`);
        else ctx.ui.notify(message, kind);
      };
      try {
        const args = parseUsageArgs(rawArgs);
        const client = new AgentsViewClient();
        const report = await client.loadUsage(args.since);
        if (args.json) {
          notify(JSON.stringify(tabData(args.tab, report), null, 2));
        } else if (ctx.hasUI !== false && ctx.ui.custom) {
          await ctx.ui.custom((tui, theme, _keys, done) => new UsageTabsComponent({
            loadReport: (since) => client.loadUsage(since),
            initialReport: report,
            initialTab: args.tab,
            since: args.since,
            theme,
            requestRender: () => tui.requestRender(),
            onClose: () => done(undefined),
          }));
        } else {
          notify(renderTab(args.tab, report));
        }
      } catch (error) {
        notify(`[agentsview-companion:usage] ${String(error)}`, "error");
      }
    },
  });
}
