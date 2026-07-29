/**
 * tests/transcript-drain.test.ts — Unit tests for transcript/drain.ts
 *
 * Most tests use a fake AnalyticsWriter (plain object with a recordLlmMessage
 * stub) so no SQLite DB is needed — these verify drain.ts's own logic
 * (offset tracking, cost computation, turn/session propagation).
 *
 * The dedup-collapse and divergent-usage tests below need a REAL
 * AnalyticsWriter against a temp SQLite DB instead, because the behavior
 * they verify — multiple JSONL lines sharing one harness_message_id
 * collapsing into a single row — happens in the store's
 * `ON CONFLICT (harness_id, harness_message_id) DO UPDATE` upsert, not in
 * drain.ts itself. A fake writer that just appends to an array would report
 * 3 calls for 3 lines regardless of whether the real dedup key logic works,
 * so it can't tell a passing dedup fix apart from a regressed one.
 *
 * Transcript files are written to os.tmpdir().
 *
 * Import paths use .js extensions (Node16 module resolution).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, unlink, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { AnalyticsWriter } from "@token-tally/store";
import { drainTranscript, drainSessionTranscripts } from "../src/transcript/drain.js";
import type { SessionState } from "../src/state/session-state.js";

// ---------------------------------------------------------------------------
// Helpers — fake writer (existing tests)
// ---------------------------------------------------------------------------

/**
 * Captured arguments from a fake writer's recordLlmMessage call.
 * We preserve the full payload so tests can assert specific fields.
 */
type LlmCall = Parameters<AnalyticsWriter["recordLlmMessage"]>[0];

/**
 * Build a minimal fake AnalyticsWriter that accumulates recordLlmMessage calls.
 * The real writer is not imported — using `as unknown as AnalyticsWriter` so
 * TypeScript accepts it in drainTranscript's signature.
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

/**
 * Build a minimal SessionState for testing. All IDs are stable strings so
 * assertions are deterministic.
 *
 * `transcriptOffsets` replaces the old single `transcriptPath`/
 * `transcriptOffset` pair — it's a map from absolute transcript file path to
 * lines-consumed-so-far, so a session can track the main transcript and any
 * number of subagent transcripts independently. A path with no entry is
 * treated as "never drained" (offset 0).
 */
function makeState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    centralSessionId: "central-session-1",
    harnessSessionId: "harness-session-1",
    turnIndex: 1,
    currentTurnId: "turn-id-1",
    currentHarnessTurnId: "harness-session-1:t1",
    transcriptOffsets: {},
    lastModelId: null,
    lastProvider: null,
    subscriptionId: null,
    activeTools: {},
    ...overrides,
  };
}

/** Serialise one transcript entry as JSONL (no trailing newline). */
function toLine(entry: object): string {
  return JSON.stringify(entry);
}

/** Write a transcript file containing the given lines (joined by \n). */
async function writeTmpTranscript(lines: string[]): Promise<string> {
  const path = join(tmpdir(), `drain-test-${randomUUID()}.jsonl`);
  await writeFile(path, lines.join("\n"), "utf8");
  return path;
}

/**
 * Build an assistant transcript entry keyed by transcript-line `uuid` only
 * (no `message.id`) — this is what most existing tests below use, and it
 * exercises the fallback path in extractAssistantUsage (message.id absent).
 */
function assistantEntry(
  uuid: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  overrides: Record<string, unknown> = {},
): object {
  return {
    type: "assistant",
    uuid,
    timestamp: "2024-01-15T10:00:00.000Z",
    message: {
      model,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
    ...overrides,
  };
}

/**
 * Build an assistant transcript entry that carries BOTH a per-line `uuid`
 * (distinct per JSONL line) and a shared `message.id` (the Anthropic API
 * message id, identical across every content-block line belonging to the
 * same real API response). Used to simulate the split-line pattern Claude
 * Code actually writes: one JSONL line per content block (thinking/text/
 * tool_use), all sharing one message.id.
 */
function assistantEntryWithMessageId(
  uuid: string,
  messageId: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  overrides: Record<string, unknown> = {},
): object {
  return {
    type: "assistant",
    uuid,
    timestamp: "2024-01-15T10:00:00.000Z",
    message: {
      id: messageId,
      model,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers — real writer against a temp SQLite DB (dedup-collapse tests only)
// ---------------------------------------------------------------------------

/**
 * Open a real AnalyticsWriter against a fresh temp SQLite DB, seed the
 * "claude-code" harness and one session, run `fn`, then close the writer and
 * remove the temp dir. Returns whatever `fn` returns.
 *
 * This is the only way to observe the store's real
 * `ON CONFLICT (harness_id, harness_message_id) DO UPDATE` upsert behavior —
 * a fake writer can't distinguish "dedup key works" from "dedup key is
 * broken" because it just appends every call to an array.
 */
async function withRealWriter<T>(
  fn: (ctx: { writer: AnalyticsWriter; dbPath: string; centralSessionId: string }) => Promise<T>,
): Promise<T> {
  const tmpDir = await mkdtemp(join(tmpdir(), "tt-drain-real-"));
  const dbPath = join(tmpDir, "events.db");
  const writer = await AnalyticsWriter.open({ dbPath, harnessName: "claude-code" });
  try {
    await writer.recordHarness({ name: "claude-code", displayName: "Claude Code" });
    const session = await writer.recordSession({
      harnessId: "claude-code",
      harnessSessionId: `harness-session-${randomUUID()}`,
      startedAt: Date.now(),
    });
    return await fn({ writer, dbPath, centralSessionId: session.id });
  } finally {
    await writer.close();
    await rm(tmpDir, { recursive: true, force: true });
  }
}

/** Read all llm_messages rows for a given harness_message_id (read-only connection). */
function readMessageRows(
  dbPath: string,
  harnessMessageId: string,
): Array<{ input_tokens: number; output_tokens: number; session_id: string }> {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA query_only = 1");
  const rows = db
    .prepare(
      `SELECT input_tokens, output_tokens, session_id FROM llm_messages WHERE harness_message_id = ?`,
    )
    .all(harnessMessageId) as Array<{
    input_tokens: number;
    output_tokens: number;
    session_id: string;
  }>;
  db.close();
  return rows;
}

// ---------------------------------------------------------------------------
// Test 1 — Basic drain: known model, writer cost source
// ---------------------------------------------------------------------------

test("basic drain: known haiku model computes writer cost correctly", async () => {
  const entry = assistantEntry("msg-1", "claude-3-5-haiku-20241022", 100, 50);
  const path = await writeTmpTranscript([toLine(entry)]);

  try {
    const { writer, calls } = makeFakeWriter();
    const state = makeState();
    const updated = await drainTranscript(writer, state, path);

    // One call recorded.
    assert.equal(calls.length, 1, "should record exactly one llm_message");

    const call = calls[0]!;
    assert.equal(call.harnessMessageId, "msg-1");
    assert.equal(call.costSource, "writer");
    assert.equal(call.harnessId, "claude-code");
    assert.equal(call.provider, "anthropic");
    assert.equal(call.modelId, "claude-3-5-haiku-20241022");
    assert.equal(call.inputTokens, 100);
    assert.equal(call.outputTokens, 50);

    // haiku rates: input=0.8/MTok → round(100 × 0.8) = 80 micros
    //              output=4/MTok  → round(50  × 4)   = 200 micros
    assert.equal(call.costInputMicros, 80, "costInputMicros should be 80");
    assert.equal(call.costOutputMicros, 200, "costOutputMicros should be 200");
    assert.equal(call.costCacheReadMicros, 0);
    assert.equal(call.costCacheWriteMicros, 0);

    // Verify total = sum of breakdown (mirrors the DB CHECK constraint).
    const expectedTotal =
      (call.costInputMicros ?? 0) +
      (call.costOutputMicros ?? 0) +
      (call.costCacheReadMicros ?? 0) +
      (call.costCacheWriteMicros ?? 0);
    // (costTotalMicros is computed by the store, not the drain helper — just
    //  verify the four breakdown fields sum correctly here.)
    assert.equal(expectedTotal, 280, "breakdown fields should sum to 280");

    // State: offset should have advanced, model/provider updated.
    assert.ok(
      (updated.transcriptOffsets[path] ?? 0) > 0,
      "offset for this path should advance past 0",
    );
    assert.equal(updated.lastModelId, "claude-3-5-haiku-20241022");
    assert.equal(updated.lastProvider, "anthropic");
  } finally {
    await unlink(path).catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
// Test 2 — Legacy costUSD: harness-provided cost
// ---------------------------------------------------------------------------

test("legacy costUSD: attributes full cost to output when output_tokens > 0", async () => {
  const entry = assistantEntry("msg-legacy", "claude-3-5-haiku-20241022", 0, 200, {
    costUSD: 0.001,
  });
  const path = await writeTmpTranscript([toLine(entry)]);

  try {
    const { writer, calls } = makeFakeWriter();
    const updated = await drainTranscript(writer, makeState(), path);

    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.harnessMessageId, "msg-legacy");
    assert.equal(call.costSource, "harness", "legacy costUSD should set costSource to harness");
    // 0.001 USD × 1_000_000 = 1_000 micros, all attributed to output (output_tokens=200 > 0)
    assert.equal(call.costOutputMicros, 1000, "costOutputMicros should be 1000");
    assert.equal(call.costInputMicros, 0, "costInputMicros should be 0");
    assert.equal(call.costCacheReadMicros, 0);
    assert.equal(call.costCacheWriteMicros, 0);

    assert.ok((updated.transcriptOffsets[path] ?? 0) > 0);
  } finally {
    await unlink(path).catch(() => undefined);
  }
});

test("legacy costUSD: attributes full cost to input when output_tokens = 0", async () => {
  const entry = assistantEntry("msg-legacy-in", "claude-3-5-haiku-20241022", 50, 0, {
    costUSD: 0.00004,
  });
  const path = await writeTmpTranscript([toLine(entry)]);

  try {
    const { writer, calls } = makeFakeWriter();
    await drainTranscript(writer, makeState(), path);

    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.costSource, "harness");
    // 0.00004 × 1_000_000 = 40 micros, all to input (output_tokens=0)
    assert.equal(call.costInputMicros, 40);
    assert.equal(call.costOutputMicros, 0);
  } finally {
    await unlink(path).catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
// Test 3 — Subscription covered
// ---------------------------------------------------------------------------

test("subscription covered: writer cost is reclassified to subscription_covered", async () => {
  const entry = assistantEntry("msg-sub", "claude-3-5-haiku-20241022", 100, 50);
  const path = await writeTmpTranscript([toLine(entry)]);

  try {
    const { writer, calls } = makeFakeWriter();
    const state = makeState({ subscriptionId: "sub-123" });
    await drainTranscript(writer, state, path);

    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.costSource, "subscription_covered");
    assert.equal(call.subscriptionId, "sub-123");
    // Cost breakdown still holds the PAYG list-price equivalent.
    assert.equal(call.costInputMicros, 80);
    assert.equal(call.costOutputMicros, 200);
  } finally {
    await unlink(path).catch(() => undefined);
  }
});

test("subscription covered: legacy harness cost is NOT reclassified", async () => {
  // cost_source = "harness" should stay "harness" even under a subscription —
  // the harness provided the cost directly.
  const entry = assistantEntry("msg-sub-legacy", "claude-3-5-haiku-20241022", 0, 100, {
    costUSD: 0.001,
  });
  const path = await writeTmpTranscript([toLine(entry)]);

  try {
    const { writer, calls } = makeFakeWriter();
    const state = makeState({ subscriptionId: "sub-xyz" });
    await drainTranscript(writer, state, path);

    assert.equal(calls.length, 1);
    // "harness" cost source: the override only applies to "writer" source.
    assert.equal(calls[0]!.costSource, "harness");
    // m2 fix: subscriptionId must NOT be set on non-covered rows.
    assert.equal(
      calls[0]!.subscriptionId,
      undefined,
      "subscriptionId should be undefined for harness-cost rows",
    );
  } finally {
    await unlink(path).catch(() => undefined);
  }
});

test("m2: unknown-cost rows do not get subscriptionId even when session has one", async () => {
  // An unknown model produces costSource='unknown'; subscriptionId must be
  // undefined to avoid readers treating the row as 'free' subscription usage.
  const entry = assistantEntry("msg-unknown-sub", "claude-supernova-99", 500, 250);
  const path = await writeTmpTranscript([toLine(entry)]);

  try {
    const { writer, calls } = makeFakeWriter();
    const state = makeState({ subscriptionId: "sub-abc" });
    await drainTranscript(writer, state, path);

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.costSource, "unknown", "unknown model should give unknown costSource");
    assert.equal(
      calls[0]!.subscriptionId,
      undefined,
      "subscriptionId must not be set on unknown-cost rows",
    );
  } finally {
    await unlink(path).catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
// Test 4 — Unknown model: all costs zero, costSource = "unknown"
// ---------------------------------------------------------------------------

test("unknown model: costSource is unknown and all cost micros are 0", async () => {
  // Use a non-claude model ID — the prefix-strip fallback in lookupModelRates
  // would eventually reduce any "claude-*" ID to "claude" which then prefix-
  // matches every entry in the table. A completely foreign model ID is safe.
  const entry = assistantEntry("msg-unknown", "gpt-totally-unknown-9999", 1000, 500);
  const path = await writeTmpTranscript([toLine(entry)]);

  try {
    const { writer, calls } = makeFakeWriter();
    await drainTranscript(writer, makeState(), path);

    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.costSource, "unknown");
    assert.equal(call.costInputMicros, 0);
    assert.equal(call.costOutputMicros, 0);
    assert.equal(call.costCacheReadMicros, 0);
    assert.equal(call.costCacheWriteMicros, 0);
  } finally {
    await unlink(path).catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
// Test 5 — Incremental reading: drain only processes new lines
//
// The reader resets offset only when fromLine > totalLines (transcript
// rotation/truncation). Idempotency for already-recorded entries is the
// store's job via ON CONFLICT DO UPDATE on (harness_id, harness_message_id).
// This test verifies that when the transcript GROWS between drain calls, only
// the NEW entries are processed by the second call — the core incremental
// guarantee. A companion test covers the trailing-newline case (C1 fix).
// ---------------------------------------------------------------------------

test("incremental reading: second drain only processes new transcript entries", async () => {
  const entry1 = assistantEntry("msg-inc-1", "claude-3-5-haiku-20241022", 10, 5);
  const entry2 = assistantEntry("msg-inc-2", "claude-3-5-haiku-20241022", 20, 10);
  const path = join(tmpdir(), `drain-incremental-${randomUUID()}.jsonl`);

  try {
    // Write only entry1 (no trailing newline so totalLines = 1).
    await writeFile(path, toLine(entry1), "utf8");

    const { writer, calls } = makeFakeWriter();
    const state0 = makeState();

    // First drain: reads entry1, offset advances to totalLines (1).
    const state1 = await drainTranscript(writer, state0, path);
    assert.equal(calls.length, 1, "first drain should record msg-inc-1");
    assert.equal(calls[0]!.harnessMessageId, "msg-inc-1");
    assert.ok(
      (state1.transcriptOffsets[path] ?? 0) > 0,
      "offset should advance after first drain",
    );

    // Grow the transcript: add entry2 separated by a newline. Now totalLines=2
    // and state1's offset for this path (=1) < 2 so the reader won't reset.
    await writeFile(path, toLine(entry1) + "\n" + toLine(entry2), "utf8");

    // Second drain: starts at offset=1, reads only entry2.
    const state2 = await drainTranscript(writer, state1, path);
    assert.equal(calls.length, 2, "second drain should add msg-inc-2");
    assert.equal(calls[1]!.harnessMessageId, "msg-inc-2");
    assert.ok(
      (state2.transcriptOffsets[path] ?? 0) > (state1.transcriptOffsets[path] ?? 0),
      "offset should advance again",
    );
  } finally {
    await unlink(path).catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
// Test 6 — Non-assistant entries skipped
// ---------------------------------------------------------------------------

test("non-assistant entries are skipped; only assistant entries recorded", async () => {
  const userEntry = { type: "user", uuid: "user-1", content: "hello" };
  const systemEntry = { type: "system", content: "system prompt" };
  const assistantE = assistantEntry("msg-assistant-1", "claude-3-5-haiku-20241022", 50, 25);

  const path = await writeTmpTranscript([
    toLine(userEntry),
    toLine(systemEntry),
    toLine(assistantE),
  ]);

  try {
    const { writer, calls } = makeFakeWriter();
    await drainTranscript(writer, makeState(), path);

    assert.equal(calls.length, 1, "only the assistant entry should trigger a call");
    assert.equal(calls[0]!.harnessMessageId, "msg-assistant-1");
  } finally {
    await unlink(path).catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
// Test 7 — Empty transcript: no calls, offset stays at 0
// ---------------------------------------------------------------------------

test("empty transcript: no recordLlmMessage calls, lastModelId unchanged", async () => {
  const path = await writeTmpTranscript([]);

  try {
    const { writer, calls } = makeFakeWriter();
    const state = makeState();
    const updated = await drainTranscript(writer, state, path);

    assert.equal(calls.length, 0, "empty transcript should produce no calls");
    // The reader returns nextLine = totalLines even for empty content.
    // An empty string split by '\n' yields [""], the trailing-empty strip
    // then pops it → totalLines=0 → offset=0. What matters is no entries.
    assert.ok((updated.transcriptOffsets[path] ?? 0) >= 0, "offset should be non-negative");
    assert.equal(updated.lastModelId, null, "lastModelId unchanged when no entries");
  } finally {
    await unlink(path).catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
// Test 8 — Missing transcript file: no calls, no throw
// ---------------------------------------------------------------------------

test("missing transcript file: no calls and no throw", async () => {
  const path = join(tmpdir(), `drain-nonexistent-${randomUUID()}.jsonl`);
  const { writer, calls } = makeFakeWriter();
  const state = makeState();

  const updated = await drainTranscript(writer, state, path);
  assert.equal(calls.length, 0, "missing file should produce no calls");
  assert.equal(updated.transcriptOffsets[path] ?? 0, 0, "offset should remain 0 for missing file");
});

// ---------------------------------------------------------------------------
// Test 9 — State propagation: sessionId/turnId passed through to store
// ---------------------------------------------------------------------------

test("state sessionId and turnId are forwarded to recordLlmMessage", async () => {
  const entry = assistantEntry("msg-ids", "claude-3-5-haiku-20241022", 10, 5);
  const path = await writeTmpTranscript([toLine(entry)]);

  try {
    const { writer, calls } = makeFakeWriter();
    const state = makeState({
      centralSessionId: "session-abc",
      currentTurnId: "turn-xyz",
    });
    await drainTranscript(writer, state, path);

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.sessionId, "session-abc");
    assert.equal(calls[0]!.turnId, "turn-xyz");
  } finally {
    await unlink(path).catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
// Test 10 — Null currentTurnId: turnId omitted (undefined) from payload
// ---------------------------------------------------------------------------

test("null currentTurnId is passed as undefined to recordLlmMessage", async () => {
  const entry = assistantEntry("msg-no-turn", "claude-3-5-haiku-20241022", 10, 5);
  const path = await writeTmpTranscript([toLine(entry)]);

  try {
    const { writer, calls } = makeFakeWriter();
    const state = makeState({ currentTurnId: null });
    await drainTranscript(writer, state, path);

    assert.equal(calls.length, 1);
    assert.equal(
      calls[0]!.turnId,
      undefined,
      "null currentTurnId should be passed as undefined",
    );
  } finally {
    await unlink(path).catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
// C1 regression (drain): trailing-newline incremental growth doesn't skip
// ---------------------------------------------------------------------------

test("C1 regression: trailing-newline file growth doesn't skip first new entry", async () => {
  const entry1 = assistantEntry("msg-tnl-1", "claude-3-5-haiku-20241022", 10, 5);
  const entry2 = assistantEntry("msg-tnl-2", "claude-3-5-haiku-20241022", 20, 10);
  const path = join(tmpdir(), `drain-trailing-newline-${randomUUID()}.jsonl`);

  try {
    // Write entry1 WITH a trailing newline (real-world Claude Code transcript format).
    await writeFile(path, toLine(entry1) + "\n", "utf8");

    const { writer, calls } = makeFakeWriter();
    const state0 = makeState();

    const state1 = await drainTranscript(writer, state0, path);
    assert.equal(calls.length, 1, "first drain should read msg-tnl-1");
    assert.equal(calls[0]!.harnessMessageId, "msg-tnl-1");
    // With the C1 fix, offset should be 1 (real line count), not 2 (phantom).
    assert.equal(
      state1.transcriptOffsets[path],
      1,
      "offset should be 1 after first trailing-newline drain",
    );

    // Grow transcript: append entry2 with trailing newline.
    await writeFile(path, toLine(entry1) + "\n" + toLine(entry2) + "\n", "utf8");

    const state2 = await drainTranscript(writer, state1, path);
    assert.equal(calls.length, 2, "second drain must capture msg-tnl-2, not skip it");
    assert.equal(calls[1]!.harnessMessageId, "msg-tnl-2", "second entry must be msg-tnl-2");
    assert.equal(state2.transcriptOffsets[path], 2);
  } finally {
    await unlink(path).catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
// M6 (updated for per-file offsets): a never-before-seen path starts at
// offset 0 and does not disturb another path's already-tracked offset.
//
// Originally this test verified an explicit "reset transcriptOffset to 0
// when transcriptPath changes" branch, back when SessionState tracked a
// single transcriptPath/transcriptOffset pair. Under the new
// transcriptOffsets map (keyed by path), that reset is no longer a special
// case to implement — a path with no map entry simply defaults to offset 0,
// and every other path's entry is left untouched. This test now verifies
// that per-path isolation, which is the property the original M6 fix cared
// about (a main/subagent path flip-flop must not corrupt either file's
// read position).
// ---------------------------------------------------------------------------

test("M6: draining a new path starts at 0 without disturbing another tracked path's offset", async () => {
  const entry = assistantEntry("msg-path-1", "claude-3-5-haiku-20241022", 10, 5);
  const path1 = await writeTmpTranscript([toLine(entry)]);
  const entry2 = assistantEntry("msg-path-2", "claude-3-5-haiku-20241022", 20, 10);
  const path2 = await writeTmpTranscript([toLine(entry2)]);

  try {
    const { writer, calls } = makeFakeWriter();
    // State already has an advanced offset recorded for path1 (as if it had
    // been drained many times before), but no entry yet for path2.
    const state = makeState({ transcriptOffsets: { [path1]: 999 } });

    // Drain a DIFFERENT, never-before-seen path — it must read from the
    // beginning (offset defaults to 0), and path1's entry must be untouched.
    const updated = await drainTranscript(writer, state, path2);
    assert.equal(calls.length, 1, "new path should read from the beginning");
    assert.equal(calls[0]!.harnessMessageId, "msg-path-2");
    assert.equal(
      updated.transcriptOffsets[path1],
      999,
      "path1's offset must be untouched by draining a different path",
    );
    assert.ok(
      (updated.transcriptOffsets[path2] ?? 0) > 0,
      "path2's offset should advance after being drained for the first time",
    );
  } finally {
    await unlink(path1).catch(() => undefined);
    await unlink(path2).catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
// Dedup collapse — a single message.id split across 3 JSONL lines (the
// thinking/text/tool_use content-block pattern Claude Code actually writes
// for one real API response) must collapse into ONE llm_messages row, not
// three. This is root cause 1 from the fix plan: deduping by the transcript
// entry's own uuid (unique per line) instead of message.id (shared across
// the lines) previously summed usage 2-4x per real API call.
//
// Requires a real writer/DB — see the doc comment on withRealWriter above.
// ---------------------------------------------------------------------------

test("dedup collapse: 3 lines sharing one message.id collapse into one row with non-tripled totals", async () => {
  await withRealWriter(async ({ writer, dbPath, centralSessionId }) => {
    const messageId = `msg_dedup_${randomUUID()}`;
    const model = "claude-3-5-haiku-20241022";

    // Three JSONL lines — distinct uuids (thinking/text/tool_use blocks),
    // identical message.id and identical usage, exactly as Claude Code
    // writes them for a single real API response.
    const lines = [
      assistantEntryWithMessageId("uuid-thinking", messageId, model, 500, 200),
      assistantEntryWithMessageId("uuid-text", messageId, model, 500, 200),
      assistantEntryWithMessageId("uuid-tooluse", messageId, model, 500, 200),
    ];
    const path = await writeTmpTranscript(lines.map(toLine));

    try {
      // currentTurnId must be null here (not the default "turn-id-1") — the
      // real writer enforces the turns FK, and this test never creates a
      // turns row. Turn attribution isn't what this test is verifying.
      const state = makeState({ centralSessionId, currentTurnId: null });
      await drainTranscript(writer, state, path);

      const rows = readMessageRows(dbPath, messageId);
      assert.equal(
        rows.length,
        1,
        "3 split-content-block lines with the same message.id must collapse into exactly 1 row",
      );
      assert.equal(
        rows[0]!.input_tokens,
        500,
        "input_tokens must equal the single response's usage, not 3x (1500)",
      );
      assert.equal(
        rows[0]!.output_tokens,
        200,
        "output_tokens must equal the single response's usage, not 3x (600)",
      );
      assert.equal(rows[0]!.session_id, centralSessionId);
    } finally {
      await unlink(path).catch(() => undefined);
    }
  });
});

// ---------------------------------------------------------------------------
// Divergent-usage final-wins invariant — real subagent transcripts do NOT
// always repeat an identical usage object across a message.id's split
// lines; usage snapshots can GROW across lines (e.g. output_tokens: 6 on one
// line, 176 on a later line for the same message.id). The store's upsert is
// last-write-wins (`ON CONFLICT ... DO UPDATE`), and drain.ts processes
// transcript lines in file order, so the stored row must converge on the
// FINAL line's usage — the complete/cumulative snapshot — not the first, not
// a sum, and not a max taken out of file order. This is intentional
// behavior, not a bug to "fix" by special-casing extract.ts or drain.ts.
// ---------------------------------------------------------------------------

test("divergent-usage final-wins: growing usage across split lines converges on the final line", async () => {
  await withRealWriter(async ({ writer, dbPath, centralSessionId }) => {
    const messageId = `msg_divergent_${randomUUID()}`;
    const model = "claude-3-5-haiku-20241022";

    // Usage snapshots grow across lines for the same message.id, mirroring
    // real subagent transcripts (see plan: agent-a252061c...jsonl,
    // msg_011JQYv8... output_tokens 6 then 176).
    const lines = [
      assistantEntryWithMessageId("uuid-partial-1", messageId, model, 10, 6),
      assistantEntryWithMessageId("uuid-partial-2", messageId, model, 10, 176),
    ];
    const path = await writeTmpTranscript(lines.map(toLine));

    try {
      // See dedup-collapse test above for why currentTurnId must be null here.
      const state = makeState({ centralSessionId, currentTurnId: null });
      await drainTranscript(writer, state, path);

      const rows = readMessageRows(dbPath, messageId);
      assert.equal(rows.length, 1, "divergent-usage lines must still collapse into one row");
      assert.equal(
        rows[0]!.output_tokens,
        176,
        "stored output_tokens must match the FINAL line's usage (last-write-wins), not the first (6)",
      );
    } finally {
      await unlink(path).catch(() => undefined);
    }
  });
});

// ---------------------------------------------------------------------------
// Subagent sidecar directory — drainSessionTranscripts must drain BOTH the
// main transcript and every discovered subagent transcript
// (`.../<id>/subagents/agent-*.jsonl`), attributing all resulting rows to
// the same session. This is root cause 2 from the fix plan: subagent
// transcripts were never read at all.
//
// Uses the fake writer (not a real DB) because this test's concern is
// *discovery + draining of both files*, not the store's dedup upsert — that
// invariant is already covered by the two tests above.
// ---------------------------------------------------------------------------

test("subagent sidecar: drainSessionTranscripts drains both main and subagent files into the same session", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "tt-drain-sidecar-"));
  try {
    const sessionId = `session-${randomUUID()}`;
    const mainPath = join(projectDir, `${sessionId}.jsonl`);
    const subagentsDir = join(projectDir, sessionId, "subagents");
    await mkdir(subagentsDir, { recursive: true });
    const subagentPath = join(subagentsDir, "agent-a.jsonl");

    const mainEntry = assistantEntry("main-msg-1", "claude-3-5-haiku-20241022", 80, 40);
    const subEntry = assistantEntry("sub-msg-1", "claude-3-5-haiku-20241022", 200, 100);
    await writeFile(mainPath, toLine(mainEntry) + "\n", "utf8");
    await writeFile(subagentPath, toLine(subEntry) + "\n", "utf8");

    const { writer, calls } = makeFakeWriter();
    const state = makeState({ centralSessionId: "session-sidecar-test" });

    const updated = await drainSessionTranscripts(writer, state, mainPath);

    assert.equal(calls.length, 2, "both the main and subagent entries should be recorded");
    const messageIds = calls.map((c) => c.harnessMessageId).sort();
    assert.deepEqual(
      messageIds,
      ["main-msg-1", "sub-msg-1"].sort(),
      "both main and subagent messages must be present",
    );
    for (const call of calls) {
      assert.equal(
        call.sessionId,
        "session-sidecar-test",
        "both files' entries must be attributed to the same session",
      );
    }

    // Each file's offset is tracked independently in the map.
    assert.ok(
      (updated.transcriptOffsets[mainPath] ?? 0) > 0,
      "main transcript's offset should advance",
    );
    assert.ok(
      (updated.transcriptOffsets[subagentPath] ?? 0) > 0,
      "subagent transcript's offset should advance",
    );
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
