/**
 * hooks/subagent-stop.ts — Handler for the Claude Code "SubagentStop" event.
 *
 * Fires when a subagent (a nested agent spawned by the main agent) finishes.
 * The parent agent is still active, so this handler deliberately does NOT
 * close the open turn — only the main "Stop" event does that.
 *
 * Responsibilities:
 *   1. Drain any new transcript entries — both the main transcript and any
 *      subagent sidecar transcripts (`drainSessionTranscripts` discovers
 *      and drains all of them from the main transcript path).
 *   2. Persist the updated offsets back to state.
 */

import type { AnalyticsWriter } from "@token-tally/store";
import type { HookPayload } from "./types.js";
import {
  readSessionState,
  writeSessionState,
  type SessionState,
} from "../state/session-state.js";
import { drainSessionTranscripts } from "../transcript/drain.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the session's main transcript path for draining purposes.
 *
 * The `SubagentStop` hook payload's `transcript_path` field is not reliable
 * as "the main transcript" — it may instead point at the subagent's own
 * sidecar file (`.../<id>/subagents/agent-*.jsonl`). Since
 * `drainSessionTranscripts` performs subagent discovery itself starting
 * from the *main* transcript path, passing a subagent path here would
 * cause discovery to look for a (nonexistent) `subagents/` directory
 * nested under the subagent file itself.
 *
 * Instead, anchor on whatever main transcript path is already recorded in
 * session state (from an earlier PostToolUse/Stop/UserPromptSubmit drain
 * this session) — `state.transcriptOffsets` is keyed by absolute file path,
 * and any key that is not itself under a `/subagents/` directory is the
 * main transcript. Only fall back to the (possibly wrong) payload path when
 * state has no such entry yet, e.g. the very first hook of a session.
 */
function resolveMainTranscriptPath(
  state: SessionState,
  payloadTranscriptPath: string,
): string {
  for (const path of Object.keys(state.transcriptOffsets)) {
    if (!path.includes("/subagents/")) {
      return path;
    }
  }
  return payloadTranscriptPath;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handle a "SubagentStop" hook event.
 *
 * A null state means the writer missed SessionStart. Log and return — we
 * cannot drain a transcript we have no offset for without risking duplicate
 * llm_messages rows (the next drain would start from 0 and re-record
 * everything).
 */
export async function handle(
  writer: AnalyticsWriter,
  payload: Extract<HookPayload, { hook_event_name: "SubagentStop" }>,
): Promise<void> {
  let state = await readSessionState(payload.session_id);
  if (state === null) {
    console.warn(
      "[claude-code-writer] SubagentStop: no state found for session",
      payload.session_id,
      "— skipping (writer may have missed SessionStart)",
    );
    return;
  }

  // ── 1. Drain transcript(s) ─────────────────────────────────────────────────
  // The subagent may have produced additional assistant messages. Drain them
  // now so they are recorded promptly (rather than waiting for the next
  // PostToolUse or Stop on the parent agent). Anchor on the session's known
  // main transcript path (not payload.transcript_path, which may point at
  // the subagent's own sidecar file) so drainSessionTranscripts' subagent
  // discovery looks in the right place.
  const mainTranscriptPath = resolveMainTranscriptPath(
    state,
    payload.transcript_path,
  );
  state = await drainSessionTranscripts(writer, state, mainTranscriptPath);

  // ── 2. Persist updated offsets ───────────────────────────────────────────
  // Do NOT touch currentTurnId or currentHarnessTurnId — the parent turn is
  // still open and will be closed by the subsequent Stop event.
  await writeSessionState(payload.session_id, state);
}
