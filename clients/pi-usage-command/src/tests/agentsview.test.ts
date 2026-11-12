import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { AgentsViewClient, localURL, parseReport, type UsageReply, type UsageReport } from "../agentsview.ts";
import { parseUsageArgs, usageParams } from "../queries.ts";
import { renderTab, tabData } from "../format.ts";
import { UsageTabsComponent } from "../usage-component.ts";
import extension from "../../index.ts";

function report(): UsageReport {
  const tokens = { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 20, cacheReadTokens: 30 };
  return {
    from: "2026-11-01", to: "2026-11-12",
    totals: { ...tokens, totalCost: { microdollars: 1_250_000 } },
    sessionCounts: { total: 2 },
    modelTotals: [{ ...tokens, model: "example-model", cost: { microdollars: 1_250_000 } }],
    projectTotals: [{ ...tokens, project: "example-project", project_key: "opaque:project", cost: { microdollars: 1_250_000 } }],
    agentTotals: [{ ...tokens, agent: "pi", cost: { microdollars: 1_250_000 } }],
    daily: [{ ...tokens, date: "2026-11-12", totalCost: { microdollars: 1_250_000 } }],
  };
}

function reply(): UsageReply {
  return { report: report(), notices: [] };
}

test("usage windows use local calendar dates across DST and all-time disables server defaults", () => {
  const previousTZ = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    const now = new Date("2026-11-03T02:00:00-05:00");
    assert.equal(usageParams("today", now).get("from"), "2026-11-03");
    assert.equal(usageParams("7d", now).get("from"), "2026-10-28");
    assert.equal(usageParams("month", now).get("from"), "2026-10-05");
    const all = usageParams("all", now);
    assert.equal(all.has("from"), false);
    assert.equal(all.get("no_default_range"), "true");
    assert.equal(all.get("timezone"), "America/New_York");
  } finally {
    if (previousTZ === undefined) delete process.env.TZ;
    else process.env.TZ = previousTZ;
  }
});

test("arguments reject removed metrics and rolling-hour windows rather than silently changing scope", () => {
  assert.deepEqual(parseUsageArgs("--json --tab models --since=7d"), { json: true, tab: "models", since: "7d" });
  assert.throws(() => parseUsageArgs("--tab=tools"), /no longer provided/);
  assert.throws(() => parseUsageArgs("--since=24h"), /calendar days/);
  assert.throws(() => parseUsageArgs("--since"), /Use --since/);
  assert.throws(() => parseUsageArgs("--unknown"), /Unknown argument/);
});

test("only explicit loopback endpoints are accepted", () => {
  for (const url of ["http://localhost:8080", "http://127.0.0.1", "https://[::1]/prefix"]) assert.ok(localURL(url));
  for (const url of ["http://example.com", "file:///tmp/usage", "http://127.0.0.1@example.com", "http://localhost?key=secret", "http://localhost/#fragment"]) {
    assert.throws(() => localURL(url));
  }
});

test("daemon discovery skips bad and stale records and verifies server identity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "totally-discovery-"));
  try {
    await writeFile(join(dir, "daemon.invalid.json"), "{");
    await writeFile(join(dir, "daemon.malformed.json"), JSON.stringify({ service: "agentsview", network: "tcp", address: "127.0.0.1:8004", pid: 4, started_at: 123 }));
    for (const [pid, started] of [[3, "2026-11-12"], [2, "2026-11-11"], [1, "2026-11-10"]] as const) {
      await writeFile(join(dir, `daemon.${pid}.json`), JSON.stringify({ service: "agentsview", network: "tcp", address: `127.0.0.1:${8000 + pid}`, pid, started_at: started }));
    }
    const client = new AgentsViewClient({ dataDirectory: dir, serverURL: "", transport: async (url) => {
      const port = new URL(String(url)).port;
      if (port === "8003") throw new Error("connection refused");
      return Response.json({ ok: true, service: "agentsview", pid: port === "8002" ? 999 : 1 });
    } });
    assert.equal((await client.resolveServer()).port, "8001");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("usage preserves native counters and coverage while converting money only for display", async () => {
  const native = report();
  native.pricing = { cost_source: "computed", models: { missing: { resolutions: [{ cost_source: "computed" }] } } };
  native.planOnlySessions = 3;
  native.partlyCapturedSessions = 1;
  native.unsupportedUsage = { kind: "unknown" };
  const client = new AgentsViewClient({ serverURL: "http://localhost:8080/prefix", transport: async (url) => {
    const request = new URL(String(url));
    assert.equal(request.pathname, "/prefix/api/v1/usage/summary");
    assert.equal(request.searchParams.get("include_automated"), "true");
    assert.equal(request.searchParams.get("include_one_shot"), "true");
    return Response.json(native, { headers: { "X-Agentsview-Archive-Stale": "true" } });
  } });
  const result = await client.loadUsage("today");
  assert.deepEqual(result.report.totals, native.totals);
  const rendered = renderTab("summary", result);
  assert.match(rendered, /\$1\.2500/);
  assert.match(rendered, /Fresh tokens: 150/);
  assert.match(rendered, /Cached tokens: 50/);
  for (const notice of [/stale/, /estimates/, /Unpriced models: missing/, /3 plan-usage/, /1 sessions have incomplete/, /do not expose/]) assert.match(rendered, notice);
  assert.deepEqual(tabData("models", result).rows, native.modelTotals);
  native.modelTotals[0]!.model = "\u001b[31muntrusted-model";
  assert.doesNotMatch(renderTab("models", result), /\u001b/);
});

test("empty usage stays valid but missing totals fail instead of showing fabricated zeros", () => {
  const empty = report();
  empty.modelTotals = [];
  empty.projectTotals = [];
  empty.agentTotals = [];
  empty.daily = [];
  assert.ok(parseReport(empty));
  assert.match(renderTab("models", { report: empty, notices: [] }), /No usage/);
  assert.throws(() => parseReport({ ...empty, totals: {} }), /invalid usage counter/);
  assert.throws(() => parseReport({ ...empty, daily: [{}] }));
});

test("HTTP failures, malformed responses, and network failures propagate actionable errors", async () => {
  for (const [transport, expected] of [
    [async () => new Response("denied", { status: 401 }), /HTTP 401/],
    [async () => Response.json({}), /unsupported/],
    [async () => { throw new Error("offline"); }, /offline/],
  ] as const) {
    const client = new AgentsViewClient({ serverURL: "http://localhost", transport });
    await assert.rejects(client.loadUsage(), expected);
  }
});

test("real HTTP transport refuses redirects rather than following them", async () => {
  let redirectedRequests = 0;
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/api/")) {
      response.writeHead(302, { Location: "/redirected" }).end();
    } else {
      redirectedRequests++;
      response.end("unexpected");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await assert.rejects(new AgentsViewClient({ serverURL: `http://127.0.0.1:${address.port}` }).loadUsage());
    assert.equal(redirectedRequests, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("async TUI period changes do not show late responses under the wrong period", async () => {
  const resolvers = new Map<string, (value: UsageReply) => void>();
  let renders = 0;
  let closed = false;
  const component = new UsageTabsComponent({
    initialReport: reply(), initialTab: "summary", since: "all",
    theme: { fg: (_color, text) => text, bg: (_color, text) => text },
    loadReport: (since) => new Promise((resolve) => resolvers.set(since, resolve)),
    requestRender: () => { renders++; }, onClose: () => { closed = true; },
  });
  component.handleInput("s");
  component.handleInput("s");
  const oldReply = reply();
  oldReply.report.totals.totalCost.microdollars = 99_000_000;
  resolvers.get("today")!(oldReply);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(component.render(100).join("\n"), /Loading/);
  resolvers.get("7d")!(reply());
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(component.render(100).join("\n"), /\$1\.2500/);
  assert.doesNotMatch(component.render(100).join("\n"), /\$99/);
  component.handleInput("2");
  assert.match(component.render(100).join("\n"), /example-model/);
  assert.ok(component.render(20).every((line) => line.length <= 20));
  component.handleInput("q");
  assert.equal(closed, true);
  assert.ok(renders > 2);
});

test("extension registers only /usage and reports fetch errors through Pi", async () => {
  const commands = new Map<string, { handler(args: string, ctx: { ui: { notify(message: string, kind?: string): void } }): Promise<void> }>();
  extension({ registerCommand: (name, command) => commands.set(name, command) });
  assert.deepEqual([...commands.keys()], ["usage"]);
  const messages: string[] = [];
  await commands.get("usage")!.handler("--tab=prs", { ui: { notify: (message) => messages.push(message) } });
  assert.match(messages[0]!, /no longer provided/);
});
