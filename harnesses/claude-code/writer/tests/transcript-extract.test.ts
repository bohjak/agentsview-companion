/**
 * Tests for transcript/extract.ts
 *
 * All fixtures are inline objects — no files needed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { extractAssistantUsage } from "../src/transcript/extract.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assistantEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "assistant",
    uuid: "test-uuid-001",
    timestamp: "2024-01-15T10:00:00.000Z",
    message: {
      model: "claude-opus-4-5",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 10,
      },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("assistant entry with type='assistant' returns usage", () => {
  const entry = assistantEntry({ type: "assistant", role: undefined });
  const result = extractAssistantUsage(entry);
  assert.ok(result !== null);
  assert.equal(result.harnessMessageId, "test-uuid-001");
  assert.equal(result.modelId, "claude-opus-4-5");
  assert.equal(result.inputTokens, 100);
  assert.equal(result.outputTokens, 50);
  assert.equal(result.cacheReadTokens, 20);
  assert.equal(result.cacheWriteTokens, 10);
  assert.equal(result.legacyCostUSD, null);
});

test("assistant entry with role='assistant' (alternate convention) returns usage", () => {
  const entry = {
    role: "assistant",
    uuid: "test-uuid-002",
    timestamp: "2024-01-15T10:00:00.000Z",
    message: {
      model: "claude-sonnet-4-5",
      usage: {
        input_tokens: 200,
        output_tokens: 80,
      },
    },
  };
  const result = extractAssistantUsage(entry);
  assert.ok(result !== null);
  assert.equal(result.harnessMessageId, "test-uuid-002");
  assert.equal(result.modelId, "claude-sonnet-4-5");
  assert.equal(result.inputTokens, 200);
  assert.equal(result.outputTokens, 80);
  assert.equal(result.cacheReadTokens, 0);
  assert.equal(result.cacheWriteTokens, 0);
});

test("user entry returns null", () => {
  const entry = { type: "user", uuid: "u1", message: { content: "hello" } };
  assert.equal(extractAssistantUsage(entry), null);
});

test("system entry returns null", () => {
  const entry = { type: "system", uuid: "s1" };
  assert.equal(extractAssistantUsage(entry), null);
});

test("entry without uuid returns null", () => {
  const entry = assistantEntry({ uuid: undefined });
  assert.equal(extractAssistantUsage(entry), null);
});

test("entry with empty uuid returns null", () => {
  const entry = assistantEntry({ uuid: "" });
  assert.equal(extractAssistantUsage(entry), null);
});

test("null entry returns null", () => {
  assert.equal(extractAssistantUsage(null), null);
});

test("non-object entry returns null", () => {
  assert.equal(extractAssistantUsage("string"), null);
  assert.equal(extractAssistantUsage(42), null);
  assert.equal(extractAssistantUsage(undefined), null);
});

test("legacy costUSD field is extracted", () => {
  const entry = assistantEntry({ costUSD: 0.00123 });
  const result = extractAssistantUsage(entry);
  assert.ok(result !== null);
  assert.ok(result.legacyCostUSD !== null);
  assert.ok(Math.abs((result.legacyCostUSD as number) - 0.00123) < 1e-9);
});

test("missing usage fields default to 0", () => {
  const entry = {
    type: "assistant",
    uuid: "uuid-no-usage",
    message: { model: "claude-opus-4-5" },
    // no usage block
  };
  const result = extractAssistantUsage(entry);
  assert.ok(result !== null);
  assert.equal(result.inputTokens, 0);
  assert.equal(result.outputTokens, 0);
  assert.equal(result.cacheReadTokens, 0);
  assert.equal(result.cacheWriteTokens, 0);
});

test("entry with no message block returns null model but valid usage zeros", () => {
  const entry = { type: "assistant", uuid: "uuid-no-msg" };
  const result = extractAssistantUsage(entry);
  assert.ok(result !== null);
  assert.equal(result.modelId, null);
  assert.equal(result.inputTokens, 0);
});

test("timestamp ISO string is parsed to unix ms", () => {
  const ts = "2024-06-01T12:00:00.000Z";
  const expected = new Date(ts).getTime();
  const entry = assistantEntry({ timestamp: ts });
  const result = extractAssistantUsage(entry);
  assert.ok(result !== null);
  assert.equal(result.ts, expected);
});

test("missing timestamp falls back to Date.now() (approximate)", () => {
  const before = Date.now();
  const entry = assistantEntry({ timestamp: undefined });
  const result = extractAssistantUsage(entry);
  const after = Date.now();
  assert.ok(result !== null);
  assert.ok(result.ts >= before && result.ts <= after, "ts should be close to now");
});

test("entry with both type and role set to assistant is accepted", () => {
  const entry = assistantEntry({ type: "assistant", role: "assistant" });
  const result = extractAssistantUsage(entry);
  assert.ok(result !== null);
});

// ---------------------------------------------------------------------------
// Dedup key: message.id vs. uuid (T1 fix)
//
// Claude Code writes one JSONL line per content block (thinking/text/
// tool_use) for a single assistant API response. Each line has a distinct
// uuid but shares the same Anthropic message.id. harnessMessageId must
// prefer message.id so the store's UNIQUE (harness_id, harness_message_id)
// upsert collapses those split lines into one row, falling back to uuid only
// when message.id is absent/empty.
// ---------------------------------------------------------------------------

test("message.id present alongside uuid — harnessMessageId prefers message.id", () => {
  const entry = assistantEntry({
    uuid: "line-uuid-001",
    message: {
      id: "msg_shared_api_response",
      model: "claude-opus-4-5",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 10,
      },
    },
  });
  const result = extractAssistantUsage(entry);
  assert.ok(result !== null);
  assert.equal(result.harnessMessageId, "msg_shared_api_response");
});

test("message.id absent — harnessMessageId falls back to uuid", () => {
  // Default assistantEntry() shape has no message.id field at all.
  const entry = assistantEntry({ uuid: "line-uuid-fallback" });
  const result = extractAssistantUsage(entry);
  assert.ok(result !== null);
  assert.equal(result.harnessMessageId, "line-uuid-fallback");
});

test("message.id present but empty string — harnessMessageId falls back to uuid", () => {
  const entry = assistantEntry({
    uuid: "line-uuid-empty-msgid",
    message: {
      id: "",
      model: "claude-opus-4-5",
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  });
  const result = extractAssistantUsage(entry);
  assert.ok(result !== null);
  assert.equal(result.harnessMessageId, "line-uuid-empty-msgid");
});

test("message.id present, uuid absent — returns non-null keyed by message.id", () => {
  // No uuid field at all — previously this hard-required uuid and would have
  // returned null, incorrectly dropping an entry that carries a usable id.
  const entry = {
    type: "assistant",
    timestamp: "2024-01-15T10:00:00.000Z",
    message: {
      id: "msg_no_uuid_case",
      model: "claude-opus-4-5",
      usage: {
        input_tokens: 30,
        output_tokens: 15,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  };
  const result = extractAssistantUsage(entry);
  assert.ok(result !== null);
  assert.equal(result.harnessMessageId, "msg_no_uuid_case");
  assert.equal(result.inputTokens, 30);
  assert.equal(result.outputTokens, 15);
});

test("neither message.id nor uuid present — returns null", () => {
  const entry = {
    type: "assistant",
    timestamp: "2024-01-15T10:00:00.000Z",
    message: {
      model: "claude-opus-4-5",
      usage: { input_tokens: 30, output_tokens: 15 },
    },
  };
  assert.equal(extractAssistantUsage(entry), null);
});

test("message.id and uuid both present as empty strings — returns null", () => {
  const entry = assistantEntry({
    uuid: "",
    message: {
      id: "",
      model: "claude-opus-4-5",
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  });
  assert.equal(extractAssistantUsage(entry), null);
});
