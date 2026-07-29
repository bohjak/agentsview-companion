/**
 * Tests for src/state/paths.ts and src/state/session-state.ts.
 *
 * Each test uses an isolated temp directory via XDG_STATE_HOME override so
 * tests never touch the real state directory and don't interfere with each
 * other.
 *
 * Imports use .js extensions because this file is compiled to dist/ and run
 * as ESM from the dist tree.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm, mkdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { AnalyticsWriter } from "@token-tally/store";

import {
  readSessionState,
  writeSessionState,
  deleteSessionState,
  type SessionState,
} from "../src/state/session-state.js";
import { claudeCodeStateDir, sessionStateFile } from "../src/state/paths.js";
import { drainSessionTranscripts } from "../src/transcript/drain.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal valid SessionState for testing. */
function makeState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    centralSessionId: randomUUID(),
    harnessSessionId: randomUUID(),
    turnIndex: 0,
    currentTurnId: null,
    currentHarnessTurnId: null,
    transcriptOffsets: {},
    lastModelId: null,
    lastProvider: null,
    subscriptionId: null,
    activeTools: {},
    ...overrides,
  };
}

/**
 * Run a test with a temporary XDG_STATE_HOME so state files land in a
 * throwaway directory and are cleaned up afterwards.
 */
async function withTempStateHome(
  fn: (tempDir: string) => Promise<void>,
): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), "tt-test-"));
  const prev = process.env["XDG_STATE_HOME"];
  process.env["XDG_STATE_HOME"] = tempDir;
  try {
    await fn(tempDir);
  } finally {
    if (prev === undefined) {
      delete process.env["XDG_STATE_HOME"];
    } else {
      process.env["XDG_STATE_HOME"] = prev;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("write and read back a state object (round-trip)", async () => {
  await withTempStateHome(async () => {
    const sessionId = randomUUID();
    const original = makeState({
      centralSessionId: "central-123",
      harnessSessionId: sessionId,
      turnIndex: 3,
      currentTurnId: "turn-uuid",
      currentHarnessTurnId: `${sessionId}:t3`,
      transcriptOffsets: { "/tmp/fake-transcript.jsonl": 42 },
      lastModelId: "claude-sonnet-4-5",
      lastProvider: "anthropic",
      subscriptionId: "sub-abc",
      activeTools: {
        "tool-1": { startedAt: 1700000000000, toolName: "Bash" },
      },
    });

    await writeSessionState(sessionId, original);
    const read = await readSessionState(sessionId);

    assert.deepStrictEqual(read, original);
  });
});

test("delete state file, subsequent read returns null", async () => {
  await withTempStateHome(async () => {
    const sessionId = randomUUID();
    const state = makeState({ harnessSessionId: sessionId });

    await writeSessionState(sessionId, state);
    assert.notEqual(await readSessionState(sessionId), null);

    await deleteSessionState(sessionId);
    assert.equal(await readSessionState(sessionId), null);
  });
});

test("read from non-existent path returns null without throwing", async () => {
  await withTempStateHome(async () => {
    const result = await readSessionState("nonexistent-session-id-" + randomUUID());
    assert.equal(result, null);
  });
});

test("deleteSessionState on missing file is a no-op (no throw)", async () => {
  await withTempStateHome(async () => {
    // Should not throw
    await deleteSessionState("missing-session-" + randomUUID());
  });
});

test("claudeCodeStateDir respects XDG_STATE_HOME env var", async () => {
  const prev = process.env["XDG_STATE_HOME"];
  const customBase = "/tmp/custom-xdg-state-" + randomUUID();
  process.env["XDG_STATE_HOME"] = customBase;
  try {
    const dir = claudeCodeStateDir();
    assert.ok(
      dir.startsWith(customBase),
      `Expected dir to start with ${customBase}, got ${dir}`,
    );
    assert.ok(
      dir.includes("token-tally"),
      `Expected dir to include 'token-tally', got ${dir}`,
    );
    assert.ok(
      dir.includes("claude-code"),
      `Expected dir to include 'claude-code', got ${dir}`,
    );
  } finally {
    if (prev === undefined) {
      delete process.env["XDG_STATE_HOME"];
    } else {
      process.env["XDG_STATE_HOME"] = prev;
    }
  }
});

test("writeSessionState creates intermediate directories automatically", async () => {
  await withTempStateHome(async () => {
    // The state dir doesn't exist yet — write should create it
    const sessionId = randomUUID();
    const state = makeState({ harnessSessionId: sessionId });

    // Should not throw even though the directory tree doesn't exist yet
    await writeSessionState(sessionId, state);

    const read = await readSessionState(sessionId);
    assert.ok(read !== null);
    assert.equal(read.harnessSessionId, state.harnessSessionId);
  });
});

// ---------------------------------------------------------------------------
// Old-shape migration (single transcriptPath/transcriptOffset -> map)
//
// These tests exercise `readSessionState`'s migration of state files written
// before the transcriptOffsets map existed. They write a raw JSON payload
// directly to the on-disk state file path (bypassing writeSessionState,
// which always serializes the *current* shape) to simulate a file left over
// from a pre-upgrade writer version.
//
// The end-to-end case — an old-shape state file feeding into
// drainSessionTranscripts and resuming from the migrated offset without
// re-recording already-drained lines — is covered by the dedicated test at
// the bottom of this file ("old-shape state migrates and drain resumes...").
// ---------------------------------------------------------------------------

/**
 * Write a raw JSON payload directly to the on-disk state file for
 * `sessionId`, simulating a state file produced by an older writer version.
 * Creates the state directory first since writeSessionState normally does
 * that step for us.
 */
async function writeRawStateFile(
  sessionId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const path = sessionStateFile(sessionId);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(payload), "utf8");
}

test("readSessionState migrates old-shape state (non-null transcriptPath) into transcriptOffsets map", async () => {
  await withTempStateHome(async () => {
    const sessionId = randomUUID();
    const oldTranscriptPath = "/fake/project/dir/" + sessionId + ".jsonl";

    // Old shape: single transcriptPath/transcriptOffset pair, no
    // transcriptOffsets field at all — exactly what a pre-migration writer
    // would have written.
    await writeRawStateFile(sessionId, {
      centralSessionId: "central-" + sessionId,
      harnessSessionId: sessionId,
      turnIndex: 5,
      currentTurnId: null,
      currentHarnessTurnId: null,
      transcriptPath: oldTranscriptPath,
      transcriptOffset: 123,
      lastModelId: "claude-sonnet-4-5",
      lastProvider: "anthropic",
      subscriptionId: null,
      activeTools: {},
    });

    const migrated = await readSessionState(sessionId);
    assert.ok(migrated !== null, "expected a migrated state, not null");
    assert.deepStrictEqual(
      migrated.transcriptOffsets,
      { [oldTranscriptPath]: 123 },
      "old transcriptPath/transcriptOffset pair should be seeded into the map",
    );
    // The legacy fields must not leak through onto the migrated object.
    assert.equal(
      (migrated as unknown as Record<string, unknown>)["transcriptPath"],
      undefined,
      "migrated state should not retain the legacy transcriptPath field",
    );
    assert.equal(
      (migrated as unknown as Record<string, unknown>)["transcriptOffset"],
      undefined,
      "migrated state should not retain the legacy transcriptOffset field",
    );
    // Everything else should pass through untouched.
    assert.equal(migrated.turnIndex, 5);
    assert.equal(migrated.lastModelId, "claude-sonnet-4-5");
  });
});

test("readSessionState migrates old-shape state with null transcriptPath into an empty map", async () => {
  await withTempStateHome(async () => {
    const sessionId = randomUUID();

    // Old shape, but no drain had occurred yet (transcriptPath: null is the
    // documented "initial state" sentinel in the pre-migration type) — there
    // is nothing to seed.
    await writeRawStateFile(sessionId, {
      centralSessionId: "central-" + sessionId,
      harnessSessionId: sessionId,
      turnIndex: 0,
      currentTurnId: null,
      currentHarnessTurnId: null,
      transcriptPath: null,
      transcriptOffset: 0,
      lastModelId: null,
      lastProvider: null,
      subscriptionId: null,
      activeTools: {},
    });

    const migrated = await readSessionState(sessionId);
    assert.ok(migrated !== null);
    assert.deepStrictEqual(migrated.transcriptOffsets, {});
  });
});

test("readSessionState passes new-shape state through unchanged", async () => {
  await withTempStateHome(async () => {
    const sessionId = randomUUID();
    const state = makeState({
      harnessSessionId: sessionId,
      transcriptOffsets: { "/a.jsonl": 1, "/b/subagents/agent-a.jsonl": 9 },
    });

    await writeSessionState(sessionId, state);
    const read = await readSessionState(sessionId);

    assert.deepStrictEqual(read, state);
  });
});

// ---------------------------------------------------------------------------
// Old-shape migration -> drainSessionTranscripts end-to-end resume
//
// The migration tests above only check that `readSessionState` reshapes the
// on-disk JSON correctly. This test carries a migrated state all the way
// into `drainSessionTranscripts` (transcript/drain.ts) to prove the migrated
// offset is actually honored: lines already consumed under the pre-migration
// writer must not be re-recorded, and only lines appended since must be.
// This is the guarantee that matters in production — a writer upgrade must
// never cause a full transcript rescan (which, pre-dedup-fix, would have
// re-summed already-recorded usage).
// ---------------------------------------------------------------------------

/**
 * Captured `recordLlmMessage` call arguments from a fake `AnalyticsWriter`.
 */
type LlmCall = Parameters<AnalyticsWriter["recordLlmMessage"]>[0];

/**
 * Minimal fake `AnalyticsWriter` that records `recordLlmMessage` calls in
 * memory instead of touching SQLite — mirrors the pattern used in
 * tests/transcript-drain.test.ts, duplicated locally since these test files
 * don't share a helpers module.
 */
function makeFakeWriter(): { writer: AnalyticsWriter; calls: LlmCall[] } {
  const calls: LlmCall[] = [];
  const writer = {
    recordLlmMessage: async (payload: LlmCall) => {
      calls.push(payload);
      return { id: randomUUID() };
    },
  } as unknown as AnalyticsWriter;
  return { writer, calls };
}

/** Serialise one transcript entry as a single JSONL line (no trailing newline). */
function toLine(entry: object): string {
  return JSON.stringify(entry);
}

/** Build a minimal assistant transcript entry keyed by `uuid`. */
function assistantEntry(
  uuid: string,
  inputTokens: number,
  outputTokens: number,
): object {
  return {
    type: "assistant",
    uuid,
    timestamp: "2024-01-15T10:00:00.000Z",
    message: {
      model: "claude-3-5-haiku-20241022",
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  };
}

test("old-shape state migrates and drain resumes from the migrated offset (no duplicate rows, new lines picked up)", async () => {
  await withTempStateHome(async () => {
    const sessionId = randomUUID();

    // Two-line transcript on disk (the state file's mtime/offset is what the
    // pre-upgrade writer would have tracked after consuming only the first
    // line — entry2 was appended after that writer last ran).
    const entry1 = assistantEntry("msg-already-consumed", 10, 5);
    const entry2 = assistantEntry("msg-new-since-upgrade", 20, 10);
    const transcriptPath = join(tmpdir(), `t10-migration-drain-${sessionId}.jsonl`);
    await writeFile(transcriptPath, toLine(entry1) + "\n" + toLine(entry2) + "\n", "utf8");

    try {
      // Old-shape state file: transcriptOffset=1 means "line 0 (entry1) has
      // already been drained" under the pre-migration single-offset model.
      await writeRawStateFile(sessionId, {
        centralSessionId: "central-" + sessionId,
        harnessSessionId: sessionId,
        turnIndex: 1,
        currentTurnId: "turn-1",
        currentHarnessTurnId: sessionId + ":t1",
        transcriptPath,
        transcriptOffset: 1,
        lastModelId: null,
        lastProvider: null,
        subscriptionId: null,
        activeTools: {},
      });

      const migrated = await readSessionState(sessionId);
      assert.ok(migrated !== null, "expected a migrated state, not null");
      assert.deepStrictEqual(
        migrated.transcriptOffsets,
        { [transcriptPath]: 1 },
        "migration should seed the offsets map from the old single pair",
      );

      const { writer, calls } = makeFakeWriter();
      const drained = await drainSessionTranscripts(writer, migrated, transcriptPath);

      // Only entry2 should be recorded — entry1 was already consumed at
      // offset 1 under the old shape and must not be re-recorded.
      assert.equal(
        calls.length,
        1,
        "only the line appended since the migrated offset should be drained",
      );
      assert.equal(calls[0]!.harnessMessageId, "msg-new-since-upgrade");
      assert.equal(calls[0]!.sessionId, migrated.centralSessionId);

      // Offset should now cover both lines (total line count in the file).
      assert.equal(
        drained.transcriptOffsets[transcriptPath],
        2,
        "offset for the main transcript should advance to the full line count",
      );
    } finally {
      await unlink(transcriptPath).catch(() => undefined);
    }
  });
});
