/**
 * session-state.ts — Per-session state persistence for the Claude Code writer.
 *
 * Because Claude Code hook handlers run as separate short-lived processes,
 * shared mutable state must be persisted to disk between invocations. Each
 * session gets a JSON file tracking the mapping to ToTally's internal IDs,
 * turn index, transcript read position, and in-flight tool calls.
 *
 * IO is delegated to @token-tally/harness-kit's generic state-io helpers,
 * which use pid-suffixed tmp files to avoid concurrent clobbering (m7 fix).
 */

import { readJsonState, writeJsonState, deleteJsonState } from "@token-tally/harness-kit";
import { sessionStateFile } from "./paths.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Persisted state for one active Claude Code session.
 *
 * Written after every hook invocation that modifies state and read at the
 * start of every subsequent hook invocation in the same session.
 */
export type SessionState = {
  /** ToTally-internal UUID for the sessions row. */
  centralSessionId: string;

  /** Claude Code's own session identifier (used as the state file name). */
  harnessSessionId: string;

  /** Monotonically incrementing turn counter within this session. */
  turnIndex: number;

  /** ToTally-internal UUID for the currently open turn, or null between turns. */
  currentTurnId: string | null;

  /** Synthesized harness turn ID for the current turn, or null between turns. */
  currentHarnessTurnId: string | null;

  /**
   * Number of lines consumed so far from each transcript JSONL file this
   * session has drained, keyed by the file's absolute path. A session can
   * have multiple entries here: one for the main transcript plus one per
   * discovered subagent (Task-tool) transcript under its sidecar
   * `<id>/subagents/agent-*.jsonl` directory. Each entry is used as
   * `fromLine` for its own file to avoid re-processing already-recorded
   * entries. A path with no entry yet (never drained) is treated as offset 0.
   *
   * Replaces the old single `transcriptPath`/`transcriptOffset` pair, which
   * could only track one file and could not represent subagent transcripts
   * at all. `readSessionState` transparently migrates state files written
   * in that old shape — see the migration logic below.
   */
  transcriptOffsets: Record<string, number>;

  /** Most recently observed model ID (carried across turns for context). */
  lastModelId: string | null;

  /** Most recently observed provider (carried across turns for context). */
  lastProvider: string | null;

  /**
   * ToTally subscriptions.id if this session is running under a flat-fee plan,
   * null otherwise.
   */
  subscriptionId: string | null;

  /**
   * Tool calls started (PreToolUse) but not yet completed (PostToolUse).
   * Keyed by the Claude Code tool_use_id.
   */
  activeTools: Record<string, { startedAt: number; toolName: string }>;
};

// ---------------------------------------------------------------------------
// Migration (old single-offset shape -> new per-file offsets map)
// ---------------------------------------------------------------------------

/**
 * On-disk shape as it may actually appear before migration.
 *
 * State files written before this change used a single
 * `transcriptPath: string | null` / `transcriptOffset: number` pair instead
 * of `transcriptOffsets`. Both legacy fields are optional here purely to
 * describe that older shape for migration purposes — `SessionState` itself
 * (the type used everywhere else) no longer has them.
 */
type PersistedSessionState = Omit<SessionState, "transcriptOffsets"> & {
  /** Present when the file already uses the new per-file offsets map. */
  transcriptOffsets?: Record<string, number>;
  /** Legacy field, present only in pre-migration state files. */
  transcriptPath?: string | null;
  /** Legacy field, present only in pre-migration state files. */
  transcriptOffset?: number;
};

/**
 * Upgrade a possibly-old-shape parsed state file into the current
 * `SessionState` shape.
 *
 * - New-shape files (already have `transcriptOffsets`) pass through
 *   unchanged, aside from dropping any stray legacy fields.
 * - Old-shape files (`transcriptOffsets` absent, `transcriptPath` a
 *   non-null string, `transcriptOffset` a number) are seeded with a single
 *   `{ [transcriptPath]: transcriptOffset }` entry — preserving the read
 *   position so the next drain does not re-scan (and re-count) the whole
 *   transcript from line 0.
 * - Old-shape files with `transcriptPath: null` (no drain had occurred yet)
 *   migrate to an empty map — there is nothing to seed.
 */
function migrateSessionState(raw: PersistedSessionState): SessionState {
  const { transcriptPath, transcriptOffset, transcriptOffsets, ...rest } = raw;

  const offsets: Record<string, number> =
    transcriptOffsets !== undefined
      ? transcriptOffsets
      : typeof transcriptPath === "string" &&
          transcriptPath.length > 0 &&
          typeof transcriptOffset === "number"
        ? { [transcriptPath]: transcriptOffset }
        : {};

  return { ...rest, transcriptOffsets: offsets };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Reads the state file for the given session ID.
 *
 * Returns null when:
 * - The file does not exist (ENOENT) — normal for the first hook of a session.
 * - The file exists but contains invalid JSON — logs a warning and returns null.
 *
 * Transparently migrates state files written in the old single
 * transcriptPath/transcriptOffset shape (see `migrateSessionState`) so
 * upgrading the writer never resets an in-progress session's read position.
 */
export async function readSessionState(
  sessionId: string,
): Promise<SessionState | null> {
  const raw = await readJsonState<PersistedSessionState>(
    sessionStateFile(sessionId),
    "[claude-code-writer]",
  );
  if (raw === null) return null;
  return migrateSessionState(raw);
}

// ---------------------------------------------------------------------------
// Write (atomic)
// ---------------------------------------------------------------------------

/**
 * Atomically writes `state` to the session state file.
 *
 * Uses a pid-suffixed tmp file and `fs.rename` so concurrent readers never
 * observe a partial write. Creates the state directory if needed.
 */
export async function writeSessionState(
  sessionId: string,
  state: SessionState,
): Promise<void> {
  return writeJsonState(sessionStateFile(sessionId), state);
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * Deletes the state file for the given session ID.
 * Silently ignores ENOENT; re-throws other errors.
 */
export async function deleteSessionState(sessionId: string): Promise<void> {
  return deleteJsonState(sessionStateFile(sessionId));
}
