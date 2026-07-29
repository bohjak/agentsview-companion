/**
 * transcript/drain.ts — Incremental transcript drain helpers.
 *
 * Reads new assistant entries from Claude Code transcript JSONL files since
 * the last recorded offset, computes costs, and records them to the ToTally
 * store. Called by PostToolUse, Stop, SubagentStop, and SessionEnd handlers
 * to keep llm_messages rows current as the session progresses.
 *
 * A session can span more than one transcript file: the main transcript
 * plus, whenever a Task-tool subagent runs, sidecar files under
 * `<id>/subagents/agent-*.jsonl` (see transcript/subagents.ts). Each file
 * grows independently and is drained on its own schedule, so each needs its
 * own tracked read offset — that's what `SessionState.transcriptOffsets`
 * (keyed by absolute file path) is for.
 *
 * The caller is responsible for persisting the returned (updated) SessionState
 * back to disk via writeSessionState — drain.ts deliberately does not do this
 * itself so that callers can batch the state write with their own mutations.
 */

import type { AnalyticsWriter } from "@token-tally/store";
import { readTranscriptFrom } from "./reader.js";
import { extractAssistantUsage } from "./extract.js";
import { discoverSubagentTranscripts } from "./subagents.js";
import { computeCostMicros } from "../pricing/compute.js";
import type { SessionState } from "../state/session-state.js";

// ---------------------------------------------------------------------------
// Internal: single-file drain
// ---------------------------------------------------------------------------

/** Result of draining one transcript file. */
type FileDrainResult = {
  /** New offset to store for this file — number of lines now consumed. */
  nextLine: number;
  /**
   * Carried-forward lastModelId: unchanged from the value passed in unless
   * a usage entry in this file carried a non-null model id.
   */
  lastModelId: string | null;
  /**
   * Carried-forward lastProvider: set to "anthropic" whenever *any* usage
   * entry is found in this file (model id or not), otherwise unchanged —
   * matching the original single-file drain's behavior.
   */
  lastProvider: string | null;
};

/**
 * Drain one transcript file starting at `fromLine`, recording each assistant
 * usage entry found into the store.
 *
 * `state` is read-only here — used for `currentTurnId`, `subscriptionId`,
 * `centralSessionId`, and the current `lastModelId`/`lastProvider` to carry
 * forward. Callers own folding the returned offset back into
 * `state.transcriptOffsets[path]` and the carried-forward fields back into
 * `state`; when draining multiple files in sequence, pass the
 * previous file's carried-forward values back in via `state` so they keep
 * compounding correctly (see `drainSessionTranscripts`).
 */
async function drainOneFile(
  writer: AnalyticsWriter,
  state: SessionState,
  path: string,
  fromLine: number,
): Promise<FileDrainResult> {
  const { entries, nextLine, wasReset } = await readTranscriptFrom(path, fromLine);

  // M1: Only attribute entries to the current turn when we are doing a genuine
  // incremental read (wasReset=false). On a rotation-reset rescan the returned
  // entries already exist in the store; with the store COALESCE guard on
  // turn_id, passing undefined preserves their existing turn attribution.
  const effectiveTurnId = wasReset ? null : state.currentTurnId;

  let lastModelId = state.lastModelId;
  let lastProvider = state.lastProvider;

  for (const entry of entries) {
    const usage = extractAssistantUsage(entry);
    if (usage === null) continue;

    // ── Cost computation ──────────────────────────────────────────────────
    let costInputMicros: number;
    let costOutputMicros: number;
    let costCacheReadMicros: number;
    let costCacheWriteMicros: number;
    let costSource: "harness" | "writer" | "subscription_covered" | "unknown";

    if (usage.legacyCostUSD !== null) {
      // Legacy path: harness provided a pre-computed dollar cost.
      // Attribute the full amount to output if there are output tokens,
      // otherwise to input — satisfying the CHECK (total == sum) constraint.
      const totalMicros = Math.round(usage.legacyCostUSD * 1_000_000);
      costInputMicros = usage.outputTokens > 0 ? 0 : totalMicros;
      costOutputMicros = usage.outputTokens > 0 ? totalMicros : 0;
      costCacheReadMicros = 0;
      costCacheWriteMicros = 0;
      costSource = "harness";
    } else {
      // Normal path: compute from token counts using the pricing table.
      const breakdown = computeCostMicros(usage);
      costInputMicros = breakdown.costInputMicros;
      costOutputMicros = breakdown.costOutputMicros;
      costCacheReadMicros = breakdown.costCacheReadMicros;
      costCacheWriteMicros = breakdown.costCacheWriteMicros;
      costSource = breakdown.costSource;
    }

    // Subscription override: when the session is subscription-covered and we
    // computed the cost ourselves (writer), reclass cost_source accordingly.
    if (state.subscriptionId !== null && costSource === "writer") {
      costSource = "subscription_covered";
    }

    // ── Store write ───────────────────────────────────────────────────────
    await writer.recordLlmMessage({
      sessionId: state.centralSessionId,
      // M1: use effectiveTurnId so rotation-rescanned historical entries do
      // not get their turn attribution overwritten by the current turn.
      turnId: effectiveTurnId ?? undefined,
      harnessId: "claude-code",
      harnessMessageId: usage.harnessMessageId,
      ts: usage.ts,
      provider: "anthropic",
      modelId: usage.modelId ?? undefined,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      costInputMicros,
      costOutputMicros,
      costCacheReadMicros,
      costCacheWriteMicros,
      costCurrency: "USD",
      costSource,
      // m2: subscriptionId is only valid when this row is actually covered;
      // do not set it for 'harness' or 'unknown' rows.
      subscriptionId: costSource === "subscription_covered"
        ? (state.subscriptionId ?? undefined)
        : undefined,
    });

    // ── Update running state ──────────────────────────────────────────────
    if (usage.modelId !== null) {
      lastModelId = usage.modelId;
    }
    lastProvider = "anthropic";
  }

  return { nextLine, lastModelId, lastProvider };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Drain new transcript entries into the store from a single file.
 *
 * Reads assistant entries from `transcriptPath` starting at this file's
 * tracked offset in `state.transcriptOffsets` (0 if this path has never been
 * drained before), records each as an `llm_messages` row, then returns the
 * updated state with that file's offset — plus `lastModelId` and
 * `lastProvider` — refreshed. Does NOT write the state file — callers must
 * call `writeSessionState` themselves.
 *
 * Prefer `drainSessionTranscripts` in hook handlers — it drains the main
 * transcript *and* any discovered subagent transcripts in one call. This
 * single-file variant remains for callers that only ever need to drain one
 * already-known file.
 *
 * @param writer         Open AnalyticsWriter (caller owns open/close).
 * @param state          Current session state — read-only, not mutated in place.
 * @param transcriptPath Absolute path to the Claude Code JSONL transcript.
 * @returns              Updated copy of `state` with this file's offset in
 *                       `transcriptOffsets`, plus `lastModelId` and
 *                       `lastProvider`, refreshed.
 */
export async function drainTranscript(
  writer: AnalyticsWriter,
  state: SessionState,
  transcriptPath: string,
): Promise<SessionState> {
  // Shallow-copy state (and its nested maps) so callers see a new object,
  // not silent mutation of the one they passed in.
  const updated: SessionState = {
    ...state,
    activeTools: { ...state.activeTools },
    transcriptOffsets: { ...state.transcriptOffsets },
  };

  // A path with no entry yet (never drained) starts at offset 0. This
  // replaces the old "path changed -> reset to 0" logic (M6): each path now
  // tracks its own independent cursor in the map, so there is nothing to
  // reset when the caller switches which file it's draining.
  const fromLine = updated.transcriptOffsets[transcriptPath] ?? 0;
  const result = await drainOneFile(writer, updated, transcriptPath, fromLine);

  updated.transcriptOffsets[transcriptPath] = result.nextLine;
  updated.lastModelId = result.lastModelId;
  updated.lastProvider = result.lastProvider;

  return updated;
}

/**
 * Drain new entries from the main transcript *and* every discovered
 * subagent transcript into the store.
 *
 * Given the main transcript's path, this calls `discoverSubagentTranscripts`
 * to find any sidecar `<id>/subagents/agent-*.jsonl` files and drains each
 * of them too, each against its own tracked offset in
 * `state.transcriptOffsets`. This is the entry point hook handlers should
 * use going forward — draining only the main file silently misses all
 * Task-tool subagent usage.
 *
 * Files are drained in a fixed order (main transcript first, then subagent
 * files sorted by filename, per `discoverSubagentTranscripts`) so that
 * `lastModelId`/`lastProvider` carry forward deterministically across files
 * within a single call.
 *
 * @param writer             Open AnalyticsWriter (caller owns open/close).
 * @param state              Current session state — read-only, not mutated
 *                           in place.
 * @param mainTranscriptPath Absolute path to the Claude Code JSONL main
 *                           transcript for this session.
 * @returns                  Updated copy of `state` with every drained
 *                           file's offset in `transcriptOffsets`, plus
 *                           `lastModelId` and `lastProvider`, refreshed.
 */
export async function drainSessionTranscripts(
  writer: AnalyticsWriter,
  state: SessionState,
  mainTranscriptPath: string,
): Promise<SessionState> {
  const updated: SessionState = {
    ...state,
    activeTools: { ...state.activeTools },
    transcriptOffsets: { ...state.transcriptOffsets },
  };

  const subagentPaths = await discoverSubagentTranscripts(mainTranscriptPath);
  const allPaths = [mainTranscriptPath, ...subagentPaths];

  for (const path of allPaths) {
    const fromLine = updated.transcriptOffsets[path] ?? 0;
    const result = await drainOneFile(writer, updated, path, fromLine);
    updated.transcriptOffsets[path] = result.nextLine;
    // Assign unconditionally: drainOneFile already carries forward the
    // previous value when this file had no relevant usage entries, so this
    // never clobbers a later value with an earlier file's stale one.
    updated.lastModelId = result.lastModelId;
    updated.lastProvider = result.lastProvider;
  }

  return updated;
}
