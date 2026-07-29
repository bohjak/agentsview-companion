/**
 * transcript/subagents.ts — Discover Task-tool subagent transcript files.
 *
 * Claude Code writes each subagent's (Task tool) own conversation to a
 * sibling JSONL file rather than inlining it into the main transcript:
 *
 *   <project-dir>/<session-id>.jsonl                    (main transcript)
 *   <project-dir>/<session-id>/subagents/agent-*.jsonl  (subagent transcripts)
 *
 * This module only *discovers* the subagent file paths given the main
 * transcript's path — it does not read or parse them. Reading and per-file
 * offset tracking for each discovered file is drain.ts's responsibility,
 * since every file needs its own independently-tracked read offset.
 */

import { readdir } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

// Track directories we've already warned about so a persistently-broken
// subagents/ directory (e.g. a permissions issue) doesn't spam the console
// on every hook invocation for the life of a long session.
const warnedDirs = new Set<string>();

/**
 * Given the absolute path to a Claude Code main transcript
 * (`.../<session-id>.jsonl`), return the absolute paths of every subagent
 * transcript file discovered in its sidecar `subagents/` directory
 * (`.../<session-id>/subagents/agent-*.jsonl`).
 *
 * Returns `[]` (never throws) when:
 * - the session has no `subagents/` directory yet (the common case — most
 *   sessions never spawn a Task-tool subagent; this is an ENOENT), or
 * - the directory can't be read for any other reason (a warning is logged
 *   once per directory in that case, since it's unexpected).
 *
 * Results are sorted by filename for deterministic drain ordering across
 * repeated calls within the same session.
 */
export async function discoverSubagentTranscripts(
  mainTranscriptPath: string,
): Promise<string[]> {
  // Derive "<session-id>" from ".../<session-id>.jsonl", then the sidecar
  // directory ".../<session-id>/subagents". extname/basename gracefully
  // handle a path with no ".jsonl" suffix too (extname returns "", and
  // basename(path, "") returns the full basename unchanged), so this does
  // not need special-casing for unexpected transcript path shapes.
  const ext = extname(mainTranscriptPath);
  const sessionId = basename(mainTranscriptPath, ext);
  const subagentsDir = join(dirname(mainTranscriptPath), sessionId, "subagents");

  let filenames: string[];
  try {
    filenames = await readdir(subagentsDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "ENOENT" && !warnedDirs.has(subagentsDir)) {
      warnedDirs.add(subagentsDir);
      console.warn(
        `[claude-code-writer] subagents: could not read ${subagentsDir} — skipping (${String(err)})`,
      );
    }
    return [];
  }

  return filenames
    .filter((name) => name.startsWith("agent-") && name.endsWith(".jsonl"))
    .sort()
    .map((name) => join(subagentsDir, name));
}
