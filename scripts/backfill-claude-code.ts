#!/usr/bin/env tsx
/**
 * scripts/backfill-claude-code.ts — Re-derive `llm_messages` rows for every
 * `harness_id='claude-code'` session from source Claude Code transcripts.
 *
 * BACKGROUND
 *   Before the message-deduplication and subagent-ingestion fixes, the writer
 *   (a) deduped assistant usage
 *   by the transcript entry's own `uuid` instead of the stable Anthropic
 *   `message.id`, summing usage 2-4x per real API call across split
 *   content-block lines, and (b) never discovered Task-tool subagent
 *   transcripts at all, losing that usage entirely. The two errors partly
 *   offset, so historical `llm_messages` rows for claude-code are wrong in
 *   both directions and cannot be corrected in place — the DB never stored
 *   the real `message.id`, so there is nothing to repair with an UPDATE.
 *   This script re-derives them from the source transcripts still on disk.
 *
 * USAGE
 *   pnpm -w exec tsx scripts/backfill-claude-code.ts [options]
 *
 *   --apply                    Actually write changes. Default: dry run —
 *                               reports what would change without writing.
 *   --db-path <path>           Override the events.db path (default: the
 *                               normal XDG-resolved default database path).
 *   --claude-projects-dir <dir>
 *                               Override the Claude Code projects directory
 *                               searched for transcripts (default:
 *                               ~/.claude/projects).
 *   --session <harness_session_id>
 *                               Only process this session (repeatable).
 *                               Default: every harness_id='claude-code'
 *                               session in the DB.
 *   --help                      Show this help and exit.
 *
 * DESIGN NOTES
 *   - Reuses the real, now-fixed extraction/discovery/pricing logic from the
 *     claude-code writer (`extractAssistantUsage`, `readTranscriptFrom`,
 *     `discoverSubagentTranscripts`, `computeCostMicros`) and the real
 *     `AnalyticsWriter.recordLlmMessage()` upsert path from @token-tally/store
 *     for all writes, rather than hand-rolling extraction or INSERT SQL, so
 *     live and backfilled data can never drift apart. Imports are by
 *     relative path to each package's compiled `dist/` output because this
 *     script is not itself a pnpm workspace member, so the bare package names
 *     "@token-tally/store" / "@token-tally/claude-code-writer" do not
 *     resolve from here. This also exercises exactly what ships to users,
 *     rather than a separately-transpiled copy.
 *   - Per-session DELETE + re-insert are NOT wrapped in one literal SQL
 *     transaction spanning both steps. `AnalyticsWriter` manages its own
 *     private DB connection and does not expose a way to interleave a
 *     caller-supplied DELETE with its internal upsert inside one
 *     transaction without either (a) duplicating AnalyticsWriter's write
 *     logic by hand (exactly what this script exists to avoid), or
 *     (b) holding two open transactions across two separate connections to
 *     the same file at once, which risks a self-deadlock. Instead: the
 *     DELETE runs in its own transaction (via a raw connection, wrapped in
 *     withBusyRetry), then rows are re-inserted immediately afterward via
 *     the writer's real upsert path. This is still safe and idempotent:
 *     subscription attribution is resolved with a fallback that does not
 *     depend on the pre-delete rows still existing (see
 *     resolveHistoricalSubscriptionId), so an interrupted run followed by a
 *     re-run converges to the same correct end state rather than losing
 *     information. Only genuinely concurrent writes to the *same* session
 *     from a live (already-fixed) writer during the brief gap between this
 *     script's DELETE and its re-insert could theoretically race — expected
 *     to be rare in practice for sessions old enough to be backfilled, and
 *     self-healing on the next re-run regardless.
 *   - Turn attribution is best-effort nearest-turn-by-timestamp (see
 *     findNearestTurnId), not the live writer's turn-per-hook-event
 *     attribution — the plan calls this out as an accepted limitation for
 *     backfilled data.
 *   - Idempotent/resumable: safe to re-run. Each session's DELETE+re-insert
 *     is independent; a partial run followed by a re-run reprocesses
 *     already-fixed sessions harmlessly.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { access, readdir } from "node:fs/promises";
import { copyFileSync, existsSync } from "node:fs";

import {
  extractAssistantUsage,
} from "../harnesses/claude-code/writer/dist/src/transcript/extract.js";
import type { AssistantUsage } from "../harnesses/claude-code/writer/dist/src/transcript/extract.js";
import { readTranscriptFrom } from "../harnesses/claude-code/writer/dist/src/transcript/reader.js";
import { discoverSubagentTranscripts } from "../harnesses/claude-code/writer/dist/src/transcript/subagents.js";
import { computeCostMicros } from "../harnesses/claude-code/writer/dist/src/pricing/compute.js";

import {
  AnalyticsWriter,
  openWriterConnection,
  withBusyRetry,
  defaultDatabasePath,
} from "../store/dist/src/index.js";
import type { CostSource } from "../store/dist/src/index.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HARNESS_ID = "claude-code";

// Type of the raw connection returned by openWriterConnection — avoids
// needing a direct "better-sqlite3" type import (which would not resolve
// from this script's own directory; see the module doc comment above).
type RawDb = ReturnType<typeof openWriterConnection>["db"];

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

type CliOptions = {
  apply: boolean;
  dbPath: string;
  claudeProjectsDir: string;
  /** null = process every claude-code session found in the DB. */
  onlySessionIds: string[] | null;
  help: boolean;
};

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    apply: false,
    dbPath: defaultDatabasePath(),
    claudeProjectsDir: join(homedir(), ".claude", "projects"),
    onlySessionIds: null,
    help: false,
  };
  const onlySessionIds: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--apply":
        options.apply = true;
        break;
      case "--db-path":
        options.dbPath = requireValue(argv, ++i, "--db-path");
        break;
      case "--claude-projects-dir":
        options.claudeProjectsDir = requireValue(argv, ++i, "--claude-projects-dir");
        break;
      case "--session":
        onlySessionIds.push(requireValue(argv, ++i, "--session"));
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: "${arg}". Run with --help for usage.`);
    }
  }

  if (onlySessionIds.length > 0) {
    options.onlySessionIds = onlySessionIds;
  }
  return options;
}

function printHelp(): void {
  console.log(`Usage: pnpm -w exec tsx scripts/backfill-claude-code.ts [options]

Re-derives llm_messages rows for every harness_id='claude-code' session from
its source Claude Code transcripts on disk, using the same message.id dedup
key and subagent transcript discovery the live writer now uses. Safe to
re-run — see the module doc comment in this file for the full design.

Options:
  --apply                      Actually write changes. Default: dry run.
  --db-path <path>             Override the events.db path.
  --claude-projects-dir <dir>  Override the Claude Code projects directory
                                (default: ~/.claude/projects).
  --session <harness_session_id>
                                Only process this session (repeatable).
  --help, -h                    Show this help and exit.
`);
}

// ---------------------------------------------------------------------------
// Backup (--apply only)
// ---------------------------------------------------------------------------

/** UTC compact timestamp, e.g. "20260702T134501Z" — matches the existing
 * manual backup naming convention used elsewhere in this repo
 * (events.db.before-pi-session-backfill-<ts>). */
function formatBackupTimestamp(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

/**
 * Best-effort timestamped backup of dbPath and its WAL/SHM companion files
 * (if present) before any destructive operation. Not a guaranteed atomic
 * snapshot under concurrent live writers — see module doc comment — but
 * matches the existing manual-backup convention and provides a real safety
 * net for the overwhelmingly common case of no concurrent writer at the
 * exact instant of copy.
 *
 * Returns the list of backup file paths written. Returns [] if dbPath does
 * not exist (nothing to back up).
 */
function backupDatabase(dbPath: string): string[] {
  const ts = formatBackupTimestamp(new Date());
  const written: string[] = [];
  for (const suffix of ["", "-wal", "-shm"]) {
    const src = `${dbPath}${suffix}`;
    if (!existsSync(src)) continue;
    const dest = `${dbPath}.before-claude-code-dedup-backfill-${ts}${suffix}`;
    copyFileSync(src, dest);
    written.push(dest);
  }
  return written;
}

// ---------------------------------------------------------------------------
// Transcript discovery
// ---------------------------------------------------------------------------

/**
 * Search every project directory under `projectsDir` for
 * `<harnessSessionId>.jsonl`. Claude Code sessions don't record their own
 * transcript path in the DB (session_file is never set by this writer), so
 * this is the only way to locate a historical session's transcript.
 *
 * Returns null (never throws) when the projects directory itself is missing
 * or no project directory contains a matching file.
 */
async function findMainTranscriptPath(
  projectsDir: string,
  harnessSessionId: string,
): Promise<string | null> {
  let projectDirs: string[];
  try {
    projectDirs = await readdir(projectsDir);
  } catch {
    return null;
  }

  for (const dir of projectDirs) {
    const candidate = join(projectsDir, dir, `${harnessSessionId}.jsonl`);
    try {
      await access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Read every assistant usage entry from the main transcript and every
 * discovered subagent transcript, in file order (main first, then subagent
 * files sorted by filename — matching drainSessionTranscripts' order).
 *
 * Reuses readTranscriptFrom (the same malformed-line handling, trailing-
 * newline handling, etc. as live drain) and extractAssistantUsage (the
 * fixed message.id-preferring dedup key) rather than re-deriving file
 * parsing here.
 */
async function deriveUsageEntries(mainTranscriptPath: string): Promise<AssistantUsage[]> {
  const subagentPaths = await discoverSubagentTranscripts(mainTranscriptPath);
  const allPaths = [mainTranscriptPath, ...subagentPaths];

  const usages: AssistantUsage[] = [];
  for (const path of allPaths) {
    const { entries } = await readTranscriptFrom(path, 0);
    for (const entry of entries) {
      const usage = extractAssistantUsage(entry);
      if (usage !== null) usages.push(usage);
    }
  }
  return usages;
}

// ---------------------------------------------------------------------------
// DB reads
// ---------------------------------------------------------------------------

type SessionRow = { id: string; harnessSessionId: string; startedAt: number };

function fetchClaudeCodeSessions(db: RawDb, harnessId: string): SessionRow[] {
  return db
    .prepare(
      `SELECT id, harness_session_id AS harnessSessionId, started_at AS startedAt
       FROM sessions WHERE harness_id = ? ORDER BY started_at ASC`,
    )
    .all(harnessId) as SessionRow[];
}

type TurnRow = { id: string; startedAt: number; endedAt: number | null };

function fetchTurns(db: RawDb, sessionId: string): TurnRow[] {
  return db
    .prepare(
      `SELECT id, started_at AS startedAt, ended_at AS endedAt
       FROM turns WHERE session_id = ? ORDER BY started_at ASC`,
    )
    .all(sessionId) as TurnRow[];
}

/**
 * Best-effort nearest-turn match by timestamp, per the plan's accepted
 * limitation for backfilled data (turn-level breakdowns may be coarser than
 * live-ingested rows; token/cost aggregates are unaffected either way).
 *
 * Prefers a turn whose [startedAt, endedAt] window contains ts; falls back
 * to the turn with the closest startedAt. Returns undefined when the
 * session has no turns at all.
 */
function findNearestTurnId(ts: number, turns: TurnRow[]): string | undefined {
  if (turns.length === 0) return undefined;

  for (const turn of turns) {
    const end = turn.endedAt ?? Number.POSITIVE_INFINITY;
    if (ts >= turn.startedAt && ts <= end) return turn.id;
  }

  let nearest = turns[0]!;
  let nearestDiff = Math.abs(ts - nearest.startedAt);
  for (const turn of turns) {
    const diff = Math.abs(ts - turn.startedAt);
    if (diff < nearestDiff) {
      nearest = turn;
      nearestDiff = diff;
    }
  }
  return nearest.id;
}

type SessionStats = { count: number; tokens: number; costMicros: number };

function fetchExistingSessionStats(db: RawDb, sessionId: string): SessionStats {
  return db
    .prepare(
      `SELECT COUNT(*) AS count,
              COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0) AS tokens,
              COALESCE(SUM(cost_total_micros), 0) AS costMicros
       FROM llm_messages WHERE session_id = ?`,
    )
    .get(sessionId) as SessionStats;
}

/**
 * Resolve the subscription (if any) that historically covered this session,
 * so re-derived rows preserve `subscription_covered` cost_source instead of
 * silently flipping to `writer` (required per the plan's review amendment).
 *
 * Primary source: the distinct non-null subscription_id already on this
 * session's existing rows (most precise — sessions map to one subscription
 * period in practice). Falls back to matching `subscriptions` periods
 * against a representative timestamp when no existing rows carry one (or
 * when they disagree, which would be unexpected) — this fallback does NOT
 * depend on the pre-delete rows still existing, which is what makes this
 * script safe to resume after an interruption between DELETE and re-insert.
 */
function resolveHistoricalSubscriptionId(
  db: RawDb,
  harnessId: string,
  sessionId: string,
  fallbackTs: number,
): string | null {
  const existing = db
    .prepare(
      `SELECT DISTINCT subscription_id AS id FROM llm_messages
       WHERE session_id = ? AND subscription_id IS NOT NULL`,
    )
    .all(sessionId) as { id: string }[];

  if (existing.length === 1) return existing[0]!.id;
  if (existing.length > 1) {
    console.warn(
      `[backfill-claude-code] session ${sessionId}: existing rows disagree on subscription_id ` +
        `(${existing.map((e) => e.id).join(", ")}); falling back to period-matching by timestamp.`,
    );
  }

  const periods = db
    .prepare(
      `SELECT id, period_start AS periodStart, period_end AS periodEnd
       FROM subscriptions WHERE harness_id = ?`,
    )
    .all(harnessId) as { id: string; periodStart: number; periodEnd: number }[];

  const match = periods.find((p) => fallbackTs >= p.periodStart && fallbackTs <= p.periodEnd);
  return match?.id ?? null;
}

// ---------------------------------------------------------------------------
// Cost computation — mirrors drain.ts's drainOneFile exactly
// ---------------------------------------------------------------------------
//
// KEPT IN SYNC BY HAND with the cost-computation block in
// harnesses/claude-code/writer/src/transcript/drain.ts (drainOneFile). If
// that logic changes, this must change identically, or live and backfilled
// data will drift apart — the exact problem this script exists to fix.

type CostFields = {
  costInputMicros: number;
  costOutputMicros: number;
  costCacheReadMicros: number;
  costCacheWriteMicros: number;
  costSource: CostSource;
};

function computeCostFields(usage: AssistantUsage, subscriptionId: string | null): CostFields {
  let costInputMicros: number;
  let costOutputMicros: number;
  let costCacheReadMicros: number;
  let costCacheWriteMicros: number;
  let costSource: CostSource;

  if (usage.legacyCostUSD !== null) {
    // Legacy path: harness provided a pre-computed dollar cost. Attribute
    // the full amount to output if there are output tokens, otherwise to
    // input — satisfying the CHECK (total == sum) constraint.
    const totalMicros = Math.round(usage.legacyCostUSD * 1_000_000);
    costInputMicros = usage.outputTokens > 0 ? 0 : totalMicros;
    costOutputMicros = usage.outputTokens > 0 ? totalMicros : 0;
    costCacheReadMicros = 0;
    costCacheWriteMicros = 0;
    costSource = "harness";
  } else {
    const breakdown = computeCostMicros(usage);
    costInputMicros = breakdown.costInputMicros;
    costOutputMicros = breakdown.costOutputMicros;
    costCacheReadMicros = breakdown.costCacheReadMicros;
    costCacheWriteMicros = breakdown.costCacheWriteMicros;
    costSource = breakdown.costSource;
  }

  if (subscriptionId !== null && costSource === "writer") {
    costSource = "subscription_covered";
  }

  return { costInputMicros, costOutputMicros, costCacheReadMicros, costCacheWriteMicros, costSource };
}

// ---------------------------------------------------------------------------
// Per-session processing
// ---------------------------------------------------------------------------

type SessionReport =
  | {
      status: "skipped-missing-transcript";
      harnessSessionId: string;
      before: SessionStats;
    }
  | {
      status: "processed";
      harnessSessionId: string;
      before: SessionStats;
      after: SessionStats;
      applied: boolean;
    };

async function processSession(
  rawDb: RawDb,
  writer: AnalyticsWriter | null,
  session: SessionRow,
  options: CliOptions,
): Promise<SessionReport> {
  const before = fetchExistingSessionStats(rawDb, session.id);

  const mainPath = await findMainTranscriptPath(options.claudeProjectsDir, session.harnessSessionId);
  if (mainPath === null) {
    // Transcript no longer on disk: leave existing rows untouched. Do not
    // delete real (if imprecise) history we can't reconstruct.
    return { status: "skipped-missing-transcript", harnessSessionId: session.harnessSessionId, before };
  }

  const turns = fetchTurns(rawDb, session.id);
  const usages = await deriveUsageEntries(mainPath);
  const fallbackTs = usages[0]?.ts ?? session.startedAt;
  const subscriptionId = resolveHistoricalSubscriptionId(rawDb, HARNESS_ID, session.id, fallbackTs);

  // Project the deduped (final-line-wins) end state for the report,
  // regardless of --apply. A Map keyed by harnessMessageId with insertion
  // in file order reproduces exactly what the store's
  // ON CONFLICT (harness_id, harness_message_id) DO UPDATE upsert converges
  // to when rows are applied in the same order below.
  const deduped = new Map<string, { usage: AssistantUsage; cost: CostFields }>();
  for (const usage of usages) {
    deduped.set(usage.harnessMessageId, { usage, cost: computeCostFields(usage, subscriptionId) });
  }
  const after: SessionStats = { count: 0, tokens: 0, costMicros: 0 };
  for (const { usage, cost } of deduped.values()) {
    after.count += 1;
    after.tokens += usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
    after.costMicros +=
      cost.costInputMicros + cost.costOutputMicros + cost.costCacheReadMicros + cost.costCacheWriteMicros;
  }

  if (options.apply) {
    if (writer === null) {
      throw new Error("internal error: --apply set but no writer was opened");
    }

    // Delete first, in its own transaction. If the transcript read above had
    // failed, we would never reach here, so existing rows are never deleted
    // without a re-derived replacement ready to insert.
    withBusyRetry(() => {
      rawDb.transaction(() => {
        rawDb.prepare(`DELETE FROM llm_messages WHERE session_id = ?`).run(session.id);
      })();
    });

    // Re-insert in file order (not the deduped map) so the upsert's
    // ON CONFLICT DO UPDATE converges on the final line exactly as live
    // drain does — duplicate harnessMessageIds here are expected and
    // harmless, not double-counted.
    for (const usage of usages) {
      const turnId = findNearestTurnId(usage.ts, turns);
      const cost = computeCostFields(usage, subscriptionId);
      await writer.recordLlmMessage({
        sessionId: session.id,
        turnId,
        harnessId: HARNESS_ID,
        harnessMessageId: usage.harnessMessageId,
        ts: usage.ts,
        provider: "anthropic",
        modelId: usage.modelId ?? undefined,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        costInputMicros: cost.costInputMicros,
        costOutputMicros: cost.costOutputMicros,
        costCacheReadMicros: cost.costCacheReadMicros,
        costCacheWriteMicros: cost.costCacheWriteMicros,
        costCurrency: "USD",
        costSource: cost.costSource,
        subscriptionId: cost.costSource === "subscription_covered" ? (subscriptionId ?? undefined) : undefined,
      });
    }
  }

  return {
    status: "processed",
    harnessSessionId: session.harnessSessionId,
    before,
    after,
    applied: options.apply,
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function formatUsd(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(6)}`;
}

function printSessionReport(r: SessionReport): void {
  if (r.status === "skipped-missing-transcript") {
    console.log(
      `  [skipped: transcript missing] ${r.harnessSessionId} — left as-is ` +
        `(${r.before.count} rows, ${r.before.tokens} tokens, ${formatUsd(r.before.costMicros)} unchanged)`,
    );
    return;
  }
  const verb = r.applied ? "applied" : "would apply";
  console.log(
    `  [${verb}] ${r.harnessSessionId} — ` +
      `before: ${r.before.count} rows / ${r.before.tokens} tokens / ${formatUsd(r.before.costMicros)}  ` +
      `→  after: ${r.after.count} rows / ${r.after.tokens} tokens / ${formatUsd(r.after.costMicros)}`,
  );
}

function printTotals(reports: SessionReport[], applied: boolean): void {
  const processed = reports.filter(
    (r): r is Extract<SessionReport, { status: "processed" }> => r.status === "processed",
  );
  const skipped = reports.filter((r) => r.status === "skipped-missing-transcript");

  const zero: SessionStats = { count: 0, tokens: 0, costMicros: 0 };
  const totalBefore = processed.reduce(
    (acc, r) => ({
      count: acc.count + r.before.count,
      tokens: acc.tokens + r.before.tokens,
      costMicros: acc.costMicros + r.before.costMicros,
    }),
    zero,
  );
  const totalAfter = processed.reduce(
    (acc, r) => ({
      count: acc.count + r.after.count,
      tokens: acc.tokens + r.after.tokens,
      costMicros: acc.costMicros + r.after.costMicros,
    }),
    zero,
  );

  console.log(`\n${"─".repeat(60)}`);
  console.log(
    `Totals across ${processed.length} processed session(s)${applied ? "" : " (projected — dry run)"}:`,
  );
  console.log(`  before: ${totalBefore.count} rows, ${totalBefore.tokens} tokens, ${formatUsd(totalBefore.costMicros)}`);
  console.log(`  after:  ${totalAfter.count} rows, ${totalAfter.tokens} tokens, ${formatUsd(totalAfter.costMicros)}`);
  console.log(`  sessions skipped (transcript missing): ${skipped.length}`);
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  console.log(
    `token-tally backfill-claude-code${options.apply ? "" : " [DRY RUN — no changes written]"}`,
  );
  console.log(`  DB: ${options.dbPath}`);
  console.log(`  Claude projects dir: ${options.claudeProjectsDir}`);

  if (options.apply) {
    const backupPaths = backupDatabase(options.dbPath);
    if (backupPaths.length === 0) {
      throw new Error(
        `--apply requested but no database file was found at ${options.dbPath} to back up; aborting.`,
      );
    }
    console.log(`  Backup written: ${backupPaths.join(", ")}`);
  }

  const { db: rawDb, compatibility } = openWriterConnection(options.dbPath);
  try {
    if (compatibility.status !== "ok") {
      throw new Error(
        `Database schema is not in a usable state for backfill (status: ${compatibility.status}). ` +
          `Open any writer once first (e.g. run a normal Claude Code hook, or \`token-tally doctor\`) ` +
          `so pending migrations apply, then re-run this script.`,
      );
    }

    let sessions = fetchClaudeCodeSessions(rawDb, HARNESS_ID);
    if (options.onlySessionIds !== null) {
      const wanted = new Set(options.onlySessionIds);
      sessions = sessions.filter((s) => wanted.has(s.harnessSessionId));
    }
    console.log(`  Sessions found (harness_id='${HARNESS_ID}'): ${sessions.length}\n`);

    let writer: AnalyticsWriter | null = null;
    if (options.apply) {
      writer = await AnalyticsWriter.open({ dbPath: options.dbPath, harnessName: "claude-code-backfill" });
      if (!writer.status.writable) {
        throw new Error(
          `AnalyticsWriter could not open a writable DB connection ` +
            `(reason: ${writer.status.reason ?? "unknown"}); aborting apply.`,
        );
      }
    }

    const reports: SessionReport[] = [];
    for (const session of sessions) {
      const report = await processSession(rawDb, writer, session, options);
      reports.push(report);
      printSessionReport(report);
    }

    if (writer !== null) {
      await writer.close();
    }

    printTotals(reports, options.apply);
  } finally {
    rawDb.close();
  }
}

main().catch((err: unknown) => {
  console.error(`[backfill-claude-code] ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
