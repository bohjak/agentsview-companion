/**
 * transcript/extract.ts — Extract assistant usage data from a raw transcript entry.
 *
 * Returns null for any entry that is not an assistant message or lacks both
 * a message.id and a uuid required for idempotent store writes.
 */

export interface AssistantUsage {
  /**
   * Idempotency key for the store's UNIQUE (harness_id, harness_message_id)
   * upsert. Prefers the Anthropic API's message.id — which is stable across
   * the multiple JSONL lines Claude Code writes per content block
   * (thinking/text/tool_use) for a single assistant API response — falling
   * back to the transcript entry's own uuid only when message.id is absent
   * (older transcript formats, or non-assistant entries). Using message.id
   * lets the store's ON CONFLICT DO UPDATE correctly collapse those
   * split-line entries into a single row instead of summing usage 2-4x per
   * real API call.
   */
  harnessMessageId: string;
  /** Model identifier, e.g. "claude-opus-4-5". Null when absent. */
  modelId: string | null;
  /** Input (prompt) tokens. */
  inputTokens: number;
  /** Output (completion) tokens. */
  outputTokens: number;
  /** Cache read tokens (cache_read_input_tokens). */
  cacheReadTokens: number;
  /** Cache write tokens (cache_creation_input_tokens). */
  cacheWriteTokens: number;
  /**
   * Legacy costUSD field from older Claude Code versions.
   * Present only when the entry carries a pre-computed dollar cost.
   * Null otherwise — callers should fall back to pricing table computation.
   */
  legacyCostUSD: number | null;
  /** Unix milliseconds; falls back to Date.now() when the entry has no timestamp. */
  ts: number;
}

/**
 * Extract assistant LLM usage from a raw transcript entry.
 *
 * Returns null when:
 * - entry is not an object
 * - entry is neither type=assistant nor role=assistant
 * - entry has neither a usable message.id nor a usable uuid (can't form an
 *   idempotent message ID)
 */
export function extractAssistantUsage(entry: unknown): AssistantUsage | null {
  if (entry === null || typeof entry !== "object") return null;

  const e = entry as Record<string, unknown>;

  // Claude Code uses both conventions across versions.
  const isAssistant = e["type"] === "assistant" || e["role"] === "assistant";
  if (!isAssistant) return null;

  // Navigate the message block defensively. Parsed before the id lookup below
  // because message.id lives inside it and takes priority over uuid.
  const msg =
    e["message"] !== null && typeof e["message"] === "object"
      ? (e["message"] as Record<string, unknown>)
      : null;

  // Dedup key: prefer the Anthropic API's message.id (shared identically by
  // every JSONL line/content-block belonging to the same API response) over
  // the transcript entry's own uuid (unique per line, which is what caused
  // usage to be summed 2-4x per real API call before this fix). Fall back to
  // uuid only when message.id is absent/empty (older transcript formats, or
  // non-assistant entries that slipped past the isAssistant check above).
  const rawMessageId = msg !== null ? msg["id"] : undefined;
  const messageId =
    typeof rawMessageId === "string" && rawMessageId.trim() !== "" ? rawMessageId : null;

  const rawUuid = e["uuid"];
  const uuid = typeof rawUuid === "string" && rawUuid.trim() !== "" ? rawUuid : null;

  const harnessMessageId = messageId ?? uuid;
  // An entry needs at least one of message.id / uuid to form an idempotent
  // store key. (Previously this function hard-required uuid; that would
  // incorrectly drop entries that carry only message.id.)
  if (harnessMessageId === null) return null;

  // Parse timestamp: ISO string, Unix seconds, or Unix ms.
  let ts = Date.now();
  const rawTs = e["timestamp"];
  if (rawTs !== undefined && rawTs !== null) {
    const parsed = new Date(rawTs as string | number).getTime();
    if (!Number.isNaN(parsed)) {
      ts = parsed;
    }
  }

  const modelId =
    msg !== null && typeof msg["model"] === "string" && msg["model"].trim() !== ""
      ? msg["model"]
      : null;

  const usage =
    msg !== null && msg["usage"] !== null && typeof msg["usage"] === "object"
      ? (msg["usage"] as Record<string, unknown>)
      : null;

  const toInt = (v: unknown): number => {
    if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, Math.floor(v));
    return 0;
  };

  const inputTokens = toInt(usage?.["input_tokens"]);
  const outputTokens = toInt(usage?.["output_tokens"]);
  const cacheReadTokens = toInt(usage?.["cache_read_input_tokens"]);
  const cacheWriteTokens = toInt(usage?.["cache_creation_input_tokens"]);

  // Legacy costUSD field.
  const legacyCostUSD =
    typeof e["costUSD"] === "number" && Number.isFinite(e["costUSD"])
      ? e["costUSD"]
      : null;

  return {
    harnessMessageId,
    modelId,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    legacyCostUSD,
    ts,
  };
}
