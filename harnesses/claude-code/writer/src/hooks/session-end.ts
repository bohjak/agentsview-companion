/**
 * hooks/session-end.ts — SessionEnd hook handler.
 *
 * Fires once when a Claude Code session terminates (normal exit, /clear, or
 * process kill with SIGTERM). Responsibilities:
 *   1. Drain any remaining transcript entries (main + subagent sidecars)
 *      into llm_messages.
 *   2. Close the sessions row by setting ended_at.
 *   3. Delete the on-disk session state file (no longer needed).
 *
 * Recovery path: if no state file exists (e.g. the writer was installed
 * mid-session) we synthesise a minimal state from scratch so that at least
 * the session row exists and the full transcript is drained from the beginning.
 */

import type { AnalyticsWriter } from "@token-tally/store";
import type { HookPayload } from "./types.js";
import {
  readSessionState,
  writeSessionState,
  deleteSessionState,
  type SessionState,
} from "../state/session-state.js";
import { drainSessionTranscripts } from "../transcript/drain.js";
import { INTEGRATION_VERSION } from "../version.js";

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handle a SessionEnd hook event.
 *
 * @param writer  Open AnalyticsWriter — caller owns open/close lifecycle.
 * @param payload Narrowed SessionEnd payload from Claude Code.
 */
export async function handle(
  writer: AnalyticsWriter,
  payload: Extract<HookPayload, { hook_event_name: "SessionEnd" }>,
): Promise<void> {
  // ── 1. Load or synthesise state ──────────────────────────────────────────
  let state = await readSessionState(payload.session_id);

  if (state === null) {
    // Install-mid-session: we never saw the SessionStart for this session.
    // Create a minimal sessions row so later queries can find it, then drain
    // the transcript from the beginning so no llm_messages are lost.
    console.warn(
      "[claude-code-writer] SessionEnd: no state file found for session " +
        payload.session_id +
        " — synthesising from scratch and draining full transcript",
    );

    // Register the harness first so the FK constraint on sessions.harness_id
    // passes. Without this, recordSession fails on a fresh/purged DB.
    await writer.recordHarness({
      name: "claude-code",
      displayName: "Claude Code",
      version: process.env["CLAUDE_CODE_VERSION"] ?? "unknown",
      integrationVersion: INTEGRATION_VERSION,
    });

    const sessionResult = await writer.recordSession({
      harnessId: "claude-code",
      harnessSessionId: payload.session_id,
      cwd: payload.cwd,
      startedAt: Date.now(),
    });

    state = {
      centralSessionId: sessionResult.id,
      harnessSessionId: payload.session_id,
      turnIndex: 0,
      currentTurnId: null,
      currentHarnessTurnId: null,
      transcriptOffsets: {}, // no entries yet — read from the very beginning
      lastModelId: null,
      lastProvider: null,
      subscriptionId: null,
      activeTools: {},
    } satisfies SessionState;
  }

  // ── 2. Drain remaining transcript entries ────────────────────────────────
  // drainSessionTranscripts returns an updated copy (main transcript plus
  // any discovered subagent sidecars). The drain helper deliberately does
  // not persist state; we write the updated offsets below before deleting
  // the state file.
  const updatedState = await drainSessionTranscripts(
    writer,
    state,
    payload.transcript_path,
  );

  // Persist updated offsets before deleting, so a crash between drain and
  // delete does not cause duplicate records on any hypothetical retry.
  await writeSessionState(payload.session_id, updatedState);

  // ── 3. Close the session row ─────────────────────────────────────────────
  // Pass startedAt: 0 so the NULLIF guard in the upsert SQL preserves the
  // original start time written by SessionStart. Only endedAt is new here.
  await writer.recordSession({
    harnessId: "claude-code",
    harnessSessionId: payload.session_id,
    cwd: payload.cwd,
    startedAt: 0, // sentinel: NULLIF(0) → null → COALESCE picks stored value
    endedAt: Date.now(),
  });

  // ── 4. Clean up state file ───────────────────────────────────────────────
  await deleteSessionState(payload.session_id);
}
