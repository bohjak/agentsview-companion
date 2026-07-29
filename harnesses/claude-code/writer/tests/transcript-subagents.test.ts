/**
 * Tests for transcript/subagents.ts
 *
 * Uses Node's built-in test runner. Each test creates an isolated temp
 * directory tree (no shared fixtures) so tests never interfere with each
 * other or leave stray files behind.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSubagentTranscripts } from "../src/transcript/subagents.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a fresh temp "project" directory and hands the test a plausible
 * main transcript path inside it (`<projectDir>/<sessionId>.jsonl`). The
 * main transcript file itself is never created on disk — discovery only
 * derives the sibling `subagents/` directory from the *path*, it never
 * reads the main transcript, so tests don't need to create it.
 */
async function withMainTranscriptPath(
  sessionId: string,
  fn: (mainTranscriptPath: string, projectDir: string) => Promise<void>,
): Promise<void> {
  const projectDir = await mkdtemp(join(tmpdir(), "tt-subagents-test-"));
  const mainTranscriptPath = join(projectDir, `${sessionId}.jsonl`);
  try {
    await fn(mainTranscriptPath, projectDir);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("returns all agent-*.jsonl files in the sidecar subagents/ directory", async () => {
  const sessionId = "session-abc";
  await withMainTranscriptPath(sessionId, async (mainTranscriptPath, projectDir) => {
    const subagentsDir = join(projectDir, sessionId, "subagents");
    await mkdir(subagentsDir, { recursive: true });
    // Write out of order to prove the result is sorted, not creation-order.
    await writeFile(join(subagentsDir, "agent-b.jsonl"), "", "utf-8");
    await writeFile(join(subagentsDir, "agent-a.jsonl"), "", "utf-8");

    const found = await discoverSubagentTranscripts(mainTranscriptPath);

    assert.equal(found.length, 2, "should discover both subagent transcripts");
    assert.deepEqual(found, [
      join(subagentsDir, "agent-a.jsonl"),
      join(subagentsDir, "agent-b.jsonl"),
    ]);
  });
});

test("missing subagents/ directory returns [] without throwing", async () => {
  const sessionId = "session-no-subagents";
  await withMainTranscriptPath(sessionId, async (mainTranscriptPath) => {
    // Deliberately do NOT create the session subdir or subagents/ dir at
    // all — this is the common case (a session with no Task-tool calls).
    const found = await discoverSubagentTranscripts(mainTranscriptPath);
    assert.deepEqual(found, []);
  });
});

test("ignores non-agent-*.jsonl files in the subagents/ directory", async () => {
  const sessionId = "session-mixed";
  await withMainTranscriptPath(sessionId, async (mainTranscriptPath, projectDir) => {
    const subagentsDir = join(projectDir, sessionId, "subagents");
    await mkdir(subagentsDir, { recursive: true });
    await writeFile(join(subagentsDir, "agent-x.jsonl"), "", "utf-8");
    await writeFile(join(subagentsDir, "readme.md"), "", "utf-8");
    await writeFile(join(subagentsDir, "not-an-agent-file.txt"), "", "utf-8");
    // Ends in .jsonl but doesn't start with "agent-" — must be excluded too.
    await writeFile(join(subagentsDir, "other.jsonl"), "", "utf-8");

    const found = await discoverSubagentTranscripts(mainTranscriptPath);

    assert.deepEqual(found, [join(subagentsDir, "agent-x.jsonl")]);
  });
});

test("empty subagents/ directory returns []", async () => {
  const sessionId = "session-empty-subagents";
  await withMainTranscriptPath(sessionId, async (mainTranscriptPath, projectDir) => {
    const subagentsDir = join(projectDir, sessionId, "subagents");
    await mkdir(subagentsDir, { recursive: true });

    const found = await discoverSubagentTranscripts(mainTranscriptPath);
    assert.deepEqual(found, []);
  });
});
