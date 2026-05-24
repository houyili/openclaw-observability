/**
 * Parser invariant tests — catches regressions on the risky pieces of
 * `transcript-parser.ts` that measured data correctness depends on.
 *
 * Scope:
 *   1. Run splitting on user messages
 *   2. MODEL_THINK duration = assistant.ts - prev_entry.ts
 *   3. FIFO tool-call / tool-result back-linking with parallel tool calls
 *   4. Tool-call duration = result.ts - call.ts
 *   5. context_token_delta = this.usage.input - prev.usage.input
 *   6. Per-tool token approximation = floor(usage.output / toolCalls.length)
 *   7. Idempotent parse (parse-twice = parse-once, referentially)
 *
 * Run:
 *   node --experimental-sqlite --experimental-strip-types --no-warnings \
 *     tests/parser-invariants.test.ts
 */

import { parseTranscript, type TranscriptEntry } from "../src/ingest/transcript-parser.ts";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, name: string, detail?: string) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
    failures.push(name);
  }
}

function ts(iso: string): string {
  return iso;
}

// ─── 1. Run splitting ───────────────────────────────────────────
console.log("\n=== Run splitting ===");
{
  const entries: TranscriptEntry[] = [
    {
      type: "message",
      id: "u1",
      parentId: "",
      timestamp: ts("2026-04-01T00:00:00Z"),
      message: { role: "user", content: [{ type: "text", text: "q1" }] },
    },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: ts("2026-04-01T00:00:05Z"),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "answer 1" }],
        usage: { input: 100, output: 10, totalTokens: 110 },
      },
    },
    {
      type: "message",
      id: "u2",
      parentId: "a1",
      timestamp: ts("2026-04-01T00:01:00Z"),
      message: { role: "user", content: [{ type: "text", text: "q2" }] },
    },
    {
      type: "message",
      id: "a2",
      parentId: "u2",
      timestamp: ts("2026-04-01T00:01:05Z"),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "answer 2" }],
        usage: { input: 200, output: 20, totalTokens: 220 },
      },
    },
  ];
  const runs = parseTranscript(entries, "key");
  assert(runs.length === 2, "two user messages → two runs");
  assert(runs[0].runId === "u1", "run 0 id = u1");
  assert(runs[1].runId === "u2", "run 1 id = u2");
  assert(runs[0].totalTokens === 110, "run 0 total tokens");
  assert(runs[1].totalTokens === 220, "run 1 total tokens");
}

// ─── 2. MODEL_THINK duration ────────────────────────────────────
console.log("\n=== MODEL_THINK duration ===");
{
  // User at 00:00:00, assistant at 00:00:07 → inference = 7s
  const entries: TranscriptEntry[] = [
    {
      type: "message",
      id: "u1",
      parentId: "",
      timestamp: ts("2026-04-01T00:00:00Z"),
      message: { role: "user", content: [{ type: "text", text: "hi" }] },
    },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: ts("2026-04-01T00:00:07Z"),
      message: {
        role: "assistant",
        content: [
          { type: "thinking" },
          { type: "toolCall", name: "read", id: "tc1", arguments: { file_path: "/tmp/a" } },
        ],
        usage: { input: 100, output: 50, totalTokens: 150 },
      },
    },
    {
      type: "message",
      id: "r1",
      parentId: "a1",
      timestamp: ts("2026-04-01T00:00:09Z"),
      message: { role: "toolResult", content: [{ type: "text", text: "ok" }] },
    },
  ];
  const runs = parseTranscript(entries, "key");
  const think = runs[0].steps.find((s) => s.nodeType === "MODEL_THINK");
  assert(think !== undefined, "MODEL_THINK present");
  assert(think?.durationMs === 7000, "MODEL_THINK duration = 7000ms", `got ${think?.durationMs}`);
}

// ─── 3. Parallel tool calls + FIFO back-linking ─────────────────
console.log("\n=== Parallel tool calls ===");
{
  // Assistant issues 2 tool calls simultaneously, results come back in order.
  const entries: TranscriptEntry[] = [
    {
      type: "message",
      id: "u1",
      parentId: "",
      timestamp: ts("2026-04-01T00:00:00Z"),
      message: { role: "user", content: [{ type: "text", text: "parallel" }] },
    },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: ts("2026-04-01T00:00:05Z"),
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", name: "read", id: "tcA", arguments: { file_path: "/tmp/A" } },
          { type: "toolCall", name: "write", id: "tcB", arguments: { file_path: "/tmp/B" } },
        ],
        usage: { input: 100, output: 60, totalTokens: 160 },
      },
    },
    // First result arrives at +2s
    {
      type: "message",
      id: "rA",
      parentId: "a1",
      timestamp: ts("2026-04-01T00:00:07Z"),
      message: { role: "toolResult", content: [{ type: "text", text: "A ok" }] },
    },
    // Second result arrives at +3s
    {
      type: "message",
      id: "rB",
      parentId: "rA",
      timestamp: ts("2026-04-01T00:00:08Z"),
      message: { role: "toolResult", content: [{ type: "text", text: "B ok" }] },
    },
  ];
  const runs = parseTranscript(entries, "key");
  const calls = runs[0].steps.filter((s) => s.toolName === "read" || s.toolName === "write");
  assert(calls.length === 2, "both tool calls present");
  const readStep = calls.find((s) => s.toolName === "read");
  const writeStep = calls.find((s) => s.toolName === "write");
  assert(readStep?.status === "ok" && writeStep?.status === "ok", "both calls reach ok status after their results");
  // FIFO: read was issued first → matched with rA (first result) → duration 2000
  assert(
    readStep?.durationMs === 2000,
    "read duration (first-issued → first result) = 2000ms",
    `got ${readStep?.durationMs}`,
  );
  // write was issued second → matched with rB (second result) → duration 3000
  assert(
    writeStep?.durationMs === 3000,
    "write duration (second-issued → second result) = 3000ms",
    `got ${writeStep?.durationMs}`,
  );
  // Per-tool token approximation: 60 output / 2 calls = 30
  assert(readStep?.outputTokens === 30, "read per-tool tokens ≈ 30");
  assert(writeStep?.outputTokens === 30, "write per-tool tokens ≈ 30");
}

// ─── 4. Context token delta ─────────────────────────────────────
console.log("\n=== Context token delta ===");
{
  const entries: TranscriptEntry[] = [
    {
      type: "message",
      id: "u1",
      parentId: "",
      timestamp: ts("2026-04-01T00:00:00Z"),
      message: { role: "user", content: [{ type: "text", text: "q" }] },
    },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: ts("2026-04-01T00:00:05Z"),
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name: "mcp_fetch_doc", id: "tc1", arguments: { url: "https://x" } }],
        usage: { input: 1000, output: 20, totalTokens: 1020 },
      },
    },
    {
      type: "message",
      id: "r1",
      parentId: "a1",
      timestamp: ts("2026-04-01T00:00:07Z"),
      message: { role: "toolResult", content: [{ type: "text", text: "doc body" }] },
    },
    {
      type: "message",
      id: "a2",
      parentId: "r1",
      timestamp: ts("2026-04-01T00:00:10Z"),
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name: "mcp_second", id: "tc2", arguments: {} }],
        usage: { input: 3500, output: 30, totalTokens: 3530 },
      },
    },
  ];
  const runs = parseTranscript(entries, "key");
  // The 2nd assistant message's MCP tool call should carry delta = 3500 - 1000 = 2500
  const steps = runs[0].steps;
  const mcp2 = steps.find((s) => s.toolName === "mcp_second");
  assert(
    mcp2?.contextTokenDelta === 2500,
    "MCP_CALL on second assistant message gets contextTokenDelta = 2500",
    `got ${mcp2?.contextTokenDelta}`,
  );
  // First MCP call should NOT have a delta (no previous assistant usage)
  const mcp1 = steps.find((s) => s.toolName === "mcp_fetch_doc");
  assert(mcp1?.contextTokenDelta === undefined, "first MCP call has no delta (no prior input)");
}

// ─── 5. Idempotent parse ────────────────────────────────────────
console.log("\n=== Idempotent parse ===");
{
  const entries: TranscriptEntry[] = [
    {
      type: "message",
      id: "u1",
      parentId: "",
      timestamp: ts("2026-04-01T00:00:00Z"),
      message: { role: "user", content: [{ type: "text", text: "q" }] },
    },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: ts("2026-04-01T00:00:05Z"),
      message: {
        role: "assistant",
        content: [
          { type: "thinking" },
          { type: "toolCall", name: "read", id: "tc1", arguments: { file_path: "/tmp/a" } },
        ],
        usage: { input: 100, output: 50, totalTokens: 150 },
      },
    },
    {
      type: "message",
      id: "r1",
      parentId: "a1",
      timestamp: ts("2026-04-01T00:00:07Z"),
      message: { role: "toolResult", content: [{ type: "text", text: "ok" }] },
    },
  ];
  const first = parseTranscript(entries, "key");
  const second = parseTranscript(entries, "key");
  assert(JSON.stringify(first) === JSON.stringify(second), "parseTranscript is pure — same input → same output");
  // Step count stable
  assert(first[0].steps.length === second[0].steps.length, "step count stable across runs");
}

// ─── 6. Error status propagation ────────────────────────────────
console.log("\n=== Error propagation ===");
{
  const entries: TranscriptEntry[] = [
    {
      type: "message",
      id: "u1",
      parentId: "",
      timestamp: ts("2026-04-01T00:00:00Z"),
      message: { role: "user", content: [{ type: "text", text: "q" }] },
    },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: ts("2026-04-01T00:00:05Z"),
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name: "api-post-search", id: "tc1", arguments: { q: "x" } }],
        usage: { input: 100, output: 50, totalTokens: 150 },
      },
    },
    {
      type: "message",
      id: "r1",
      parentId: "a1",
      timestamp: ts("2026-04-01T00:00:07Z"),
      message: { role: "toolResult", content: [{ type: "text", text: '{"error":"HTTP 429 Too Many Requests"}' }] },
    },
  ];
  const runs = parseTranscript(entries, "key");
  const call = runs[0].steps.find((s) => s.toolName === "api-post-search");
  assert(call?.status === "error", "MCP tool call inherits error status from result");
  assert(call?.errorType === "rate_limit", "error type classified as rate_limit", `got ${call?.errorType}`);
}

// ─── 7. Step ordering + uniqueness within a run ─────────────────
console.log("\n=== Step ordering + uniqueness ===");
{
  // A 4-tool-call run with mixed result timing — exercises seq density
  // and step_id uniqueness.
  const entries: TranscriptEntry[] = [
    {
      type: "message",
      id: "u1",
      parentId: "",
      timestamp: ts("2026-04-01T00:00:00Z"),
      message: { role: "user", content: [{ type: "text", text: "do four things" }] },
    },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: ts("2026-04-01T00:00:03Z"),
      message: {
        role: "assistant",
        content: [
          { type: "thinking" },
          { type: "toolCall", name: "read", id: "tcA", arguments: { file_path: "/tmp/A" } },
          { type: "toolCall", name: "read", id: "tcB", arguments: { file_path: "/tmp/B" } },
          { type: "toolCall", name: "read", id: "tcC", arguments: { file_path: "/tmp/C" } },
          { type: "toolCall", name: "read", id: "tcD", arguments: { file_path: "/tmp/D" } },
        ],
        usage: { input: 100, output: 80, totalTokens: 180 },
      },
    },
    {
      type: "message",
      id: "rA",
      parentId: "a1",
      timestamp: ts("2026-04-01T00:00:04Z"),
      message: { role: "toolResult", content: [{ type: "text", text: "A" }] },
    },
    {
      type: "message",
      id: "rB",
      parentId: "rA",
      timestamp: ts("2026-04-01T00:00:05Z"),
      message: { role: "toolResult", content: [{ type: "text", text: "B" }] },
    },
    {
      type: "message",
      id: "rC",
      parentId: "rB",
      timestamp: ts("2026-04-01T00:00:06Z"),
      message: { role: "toolResult", content: [{ type: "text", text: "C" }] },
    },
    {
      type: "message",
      id: "rD",
      parentId: "rC",
      timestamp: ts("2026-04-01T00:00:07Z"),
      message: { role: "toolResult", content: [{ type: "text", text: "D" }] },
    },
  ];
  const run = parseTranscript(entries, "key")[0];

  // 7a: seq is dense and increasing (0..n-1)
  const seqs = run.steps.map((s) => s.seq);
  const seqOk = seqs.every((v, i) => v === i);
  assert(seqOk, "seq is dense 0..n-1 across the run", `got ${JSON.stringify(seqs)}`);

  // 7b: step_ids are globally unique within the run
  const ids = run.steps.map((s) => s.stepId);
  const idSet = new Set(ids);
  assert(idSet.size === ids.length, "step_ids are unique within a run", `${ids.length} steps, ${idSet.size} unique`);

  // 7c: ts_epoch_ms is non-decreasing in seq order
  let mono = true;
  for (let i = 1; i < run.steps.length; i++) {
    if (run.steps[i].tsEpochMs < run.steps[i - 1].tsEpochMs) {
      mono = false;
      break;
    }
  }
  assert(mono, "ts_epoch_ms is non-decreasing in seq order");

  // 7d: every duration is non-negative
  const allNonNeg = run.steps.every((s) => (s.durationMs ?? 0) >= 0);
  assert(allNonNeg, "all step durations are non-negative");

  // 7e: per-tool token approximation sums to assistant.output_tokens (within
  // rounding). Each of 4 tool calls gets floor(80/4) = 20.
  const toolSum = run.steps.filter((s) => s.toolName === "read").reduce((n, s) => n + (s.outputTokens ?? 0), 0);
  assert(
    toolSum === 80,
    "sum of per-tool output_tokens equals assistant.usage.output (no rounding loss for 80/4)",
    `got ${toolSum}`,
  );

  // 7f: 4 calls × FIFO matching → durations 1s,2s,3s,4s respectively
  const calls = run.steps.filter((s) => s.toolName === "read");
  const durs = calls.map((s) => s.durationMs);
  assert(
    JSON.stringify(durs) === JSON.stringify([1000, 2000, 3000, 4000]),
    "FIFO assigns durations in issuance order: 1s/2s/3s/4s",
    `got ${JSON.stringify(durs)}`,
  );
}

// ─── 8. Per-tool token rounding behavior ────────────────────────
console.log("\n=== Per-tool token rounding ===");
{
  // 7 output tokens / 3 tool calls → Math.round(7/3) = 2 each → sum = 6
  // (off by 1 from the original 7). Documents the known approximation.
  const entries: TranscriptEntry[] = [
    {
      type: "message",
      id: "u1",
      parentId: "",
      timestamp: ts("2026-04-01T00:00:00Z"),
      message: { role: "user", content: [{ type: "text", text: "three" }] },
    },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: ts("2026-04-01T00:00:03Z"),
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", name: "read", id: "tcA", arguments: {} },
          { type: "toolCall", name: "read", id: "tcB", arguments: {} },
          { type: "toolCall", name: "read", id: "tcC", arguments: {} },
        ],
        usage: { input: 100, output: 7, totalTokens: 107 },
      },
    },
  ];
  const steps = parseTranscript(entries, "key")[0].steps;
  const tokens = steps.filter((s) => s.toolName === "read").map((s) => s.outputTokens);
  // Math.round(7/3) = 2 → all three get 2 → sum = 6
  assert(
    tokens.every((t) => t === 2),
    "round(7/3) = 2 — every parallel call gets the same approximation",
    `got ${JSON.stringify(tokens)}`,
  );
  // Document the known drift: per-step sum is allowed to differ from
  // assistant.usage.output by up to (toolCalls.length - 1) tokens.
  const sum = tokens.reduce((a, b) => (a ?? 0) + (b ?? 0), 0);
  const drift = Math.abs((sum ?? 0) - 7);
  assert(drift <= 2, "rounding drift bounded by toolCalls.length - 1", `drift=${drift}`);
}

// ─── 9. Empty assistant (no thinking, no tools, no text) ────────
console.log("\n=== Edge case: empty assistant message ===");
{
  // An assistant message with literally nothing actionable should not crash
  // the parser and should not emit phantom steps.
  const entries: TranscriptEntry[] = [
    {
      type: "message",
      id: "u1",
      parentId: "",
      timestamp: ts("2026-04-01T00:00:00Z"),
      message: { role: "user", content: [{ type: "text", text: "ping" }] },
    },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: ts("2026-04-01T00:00:01Z"),
      message: { role: "assistant", content: [], usage: { input: 50, output: 0, totalTokens: 50 } },
    },
  ];
  const run = parseTranscript(entries, "key")[0];
  assert(run.steps.length === 0, "empty assistant message produces zero steps", `got ${run.steps.length}`);
  assert(run.totalTokens === 50, "totalTokens still tracks usage even with no steps");
}

// ─── 10. Assistant with thinking but no tools and no text ───────
console.log("\n=== Edge case: thinking-only assistant ===");
{
  const entries: TranscriptEntry[] = [
    {
      type: "message",
      id: "u1",
      parentId: "",
      timestamp: ts("2026-04-01T00:00:00Z"),
      message: { role: "user", content: [{ type: "text", text: "ponder" }] },
    },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: ts("2026-04-01T00:00:05Z"),
      message: {
        role: "assistant",
        content: [{ type: "thinking" }],
        usage: { input: 100, output: 30, totalTokens: 130 },
      },
    },
  ];
  const run = parseTranscript(entries, "key")[0];
  // hasThinking || toolCalls.length > 0 → true → MODEL_THINK is created
  // hasText && toolCalls.length === 0 → false (no text) → no REPLY
  assert(run.steps.length === 1, "thinking-only emits exactly one MODEL_THINK step", `got ${run.steps.length}`);
  assert(run.steps[0].nodeType === "MODEL_THINK", "the lone step is MODEL_THINK");
}

// ─── 11. Truncated transcript (entries before any user message) ─
console.log("\n=== Edge case: orphan entries before first user ===");
{
  // Common case for the watcher when it picks up a transcript mid-stream
  // and the incremental boundary lands inside a run. Round 2 made the
  // watcher always full-reparse, but the parser's defensive drop-before-
  // user behavior is still required and must not crash.
  const entries: TranscriptEntry[] = [
    // No user message — these are orphaned
    {
      type: "message",
      id: "a-orphan",
      parentId: "?",
      timestamp: ts("2026-04-01T00:00:01Z"),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "stray" }],
        usage: { input: 10, output: 5, totalTokens: 15 },
      },
    },
    {
      type: "message",
      id: "r-orphan",
      parentId: "a-orphan",
      timestamp: ts("2026-04-01T00:00:02Z"),
      message: { role: "toolResult", content: [{ type: "text", text: "stray result" }] },
    },
    // Now a real user message — a run finally starts
    {
      type: "message",
      id: "u1",
      parentId: "",
      timestamp: ts("2026-04-01T00:00:10Z"),
      message: { role: "user", content: [{ type: "text", text: "real query" }] },
    },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: ts("2026-04-01T00:00:12Z"),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "real answer" }],
        usage: { input: 20, output: 8, totalTokens: 28 },
      },
    },
  ];
  const runs = parseTranscript(entries, "key");
  assert(
    runs.length === 1,
    "orphaned entries do not create a run; only the real user starts one",
    `got ${runs.length}`,
  );
  assert(runs[0].runId === "u1", "the only run is rooted at the real user message");
  // Run should contain only the real assistant message's REPLY (no tool, no
  // thinking → just REPLY)
  assert(runs[0].steps.length === 1, "real run has 1 step (REPLY)", `got ${runs[0].steps.length}`);
  assert(runs[0].steps[0].nodeType === "REPLY", "the only step is REPLY");
}

// ─── 12. Round 6 — new ParsedStep fields populated correctly ────
console.log("\n=== Round 6: input_tokens / cache_read / thinking / reply text ===");
{
  // Hand-crafted transcript: 1 user, 2 assistant turns. The first
  // assistant has thinking + tool call; the second has thinking + text reply.
  const entries: TranscriptEntry[] = [
    {
      type: "message",
      id: "u1",
      parentId: "",
      timestamp: ts("2026-04-11T00:00:00Z"),
      message: { role: "user", content: [{ type: "text", text: "go" }] },
    },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: ts("2026-04-11T00:00:05Z"),
      message: {
        role: "assistant",
        content: [
          { type: "thinking", text: "let me read the file first" }, // 26 chars
          { type: "toolCall", name: "read", id: "tcA", arguments: { file_path: "/tmp/x" } },
        ],
        usage: { input: 1500, output: 80, cacheRead: 1200, totalTokens: 2780 },
      },
    },
    {
      type: "message",
      id: "rA",
      parentId: "a1",
      timestamp: ts("2026-04-11T00:00:07Z"),
      message: { role: "toolResult", content: [{ type: "text", text: "file body" }] },
    },
    {
      type: "message",
      id: "a2",
      parentId: "rA",
      timestamp: ts("2026-04-11T00:00:10Z"),
      message: {
        role: "assistant",
        content: [
          { type: "thinking", text: "ok the answer is" }, // 16 chars
          { type: "text", text: "Here is your answer in 19 chars." }, // 32 chars
        ],
        usage: { input: 1700, output: 30, cacheRead: 1500, totalTokens: 3230 },
      },
    },
  ];
  const run = parseTranscript(entries, "key")[0];

  // 12a — MODEL_THINK on a1 carries usage.input
  const think1 = run.steps.find((s) => s.nodeType === "MODEL_THINK" && s.stepId === "a1");
  assert(
    think1?.inputTokens === 1500,
    "MODEL_THINK.inputTokens == usage.input on first assistant",
    `got ${think1?.inputTokens}`,
  );

  // 12b — MODEL_THINK on a1 carries usage.cacheRead
  assert(
    think1?.cacheReadTokens === 1200,
    "MODEL_THINK.cacheReadTokens == usage.cacheRead",
    `got ${think1?.cacheReadTokens}`,
  );

  // 12c — thinking_text_len matches the sum of thinking block char lengths
  assert(
    think1?.thinkingTextLen === 26,
    "MODEL_THINK.thinkingTextLen == thinking block chars (26)",
    `got ${think1?.thinkingTextLen}`,
  );

  // 12d — tool_call rows do NOT carry input_tokens (per-tool input is not knowable)
  const toolCallRow = run.steps.find((s) => s.toolName === "read");
  assert(
    toolCallRow?.inputTokens === undefined,
    "tool_call rows do not carry inputTokens (per-tool input is not knowable from API)",
  );

  // 12e — REPLY row carries usage.input + cacheRead
  const reply = run.steps.find((s) => s.nodeType === "REPLY");
  assert(reply?.inputTokens === 1700, "REPLY.inputTokens == second assistant usage.input", `got ${reply?.inputTokens}`);
  assert(
    reply?.cacheReadTokens === 1500,
    "REPLY.cacheReadTokens == second assistant usage.cacheRead",
    `got ${reply?.cacheReadTokens}`,
  );

  // 12f — REPLY.replyTextLen captures FULL text length (not the 200-char preview)
  assert(
    reply?.replyTextLen === 32,
    "REPLY.replyTextLen == full text content length (32)",
    `got ${reply?.replyTextLen}`,
  );

  // 12g — REPLY does NOT carry thinkingTextLen when its MODEL_THINK
  // companion already captured the same chars (avoids double-counting
  // in cumulative aggregates).
  assert(
    reply?.thinkingTextLen === undefined,
    "REPLY.thinkingTextLen is undefined when MODEL_THINK companion exists",
    `got ${reply?.thinkingTextLen}`,
  );

  // 12h — A text-only assistant (no thinking) produces ONLY a REPLY
  // (no MODEL_THINK companion). The REPLY captures inputTokens and
  // is the sole anchor for that turn.
  const textOnlyEntries: TranscriptEntry[] = [
    {
      type: "message",
      id: "u9",
      parentId: "",
      timestamp: ts("2026-04-11T01:00:00Z"),
      message: { role: "user", content: [{ type: "text", text: "ping" }] },
    },
    {
      type: "message",
      id: "a9",
      parentId: "u9",
      timestamp: ts("2026-04-11T01:00:01Z"),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "pong" }],
        usage: { input: 500, output: 5, cacheRead: 100, totalTokens: 605 },
      },
    },
  ];
  const textOnlyRun = parseTranscript(textOnlyEntries, "k");
  assert(
    textOnlyRun[0].steps.length === 1,
    "text-only assistant produces 1 step (REPLY only, no MODEL_THINK)",
    `got ${textOnlyRun[0].steps.length}`,
  );
  assert(textOnlyRun[0].steps[0].nodeType === "REPLY", "the only step is REPLY");
  assert(textOnlyRun[0].steps[0].inputTokens === 500, "text-only REPLY carries usage.input");
  assert(textOnlyRun[0].steps[0].replyTextLen === 4, "text-only REPLY carries replyTextLen=4 ('pong')");
}

// ─── Summary ────────────────────────────────────────────────────
console.log(`\n${"=".repeat(50)}`);
console.log(`Parser invariants: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  • ${f}`);
  process.exit(1);
}
