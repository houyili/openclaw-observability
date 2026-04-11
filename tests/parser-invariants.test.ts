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
  if (condition) { passed++; console.log(`  ✅ ${name}`); }
  else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
    failures.push(name);
  }
}

function ts(iso: string): string { return iso; }

// ─── 1. Run splitting ───────────────────────────────────────────
console.log("\n=== Run splitting ===");
{
  const entries: TranscriptEntry[] = [
    { type: "message", id: "u1", parentId: "", timestamp: ts("2026-04-01T00:00:00Z"),
      message: { role: "user", content: [{ type: "text", text: "q1" }] } },
    { type: "message", id: "a1", parentId: "u1", timestamp: ts("2026-04-01T00:00:05Z"),
      message: { role: "assistant", content: [{ type: "text", text: "answer 1" }],
                 usage: { input: 100, output: 10, totalTokens: 110 } } },
    { type: "message", id: "u2", parentId: "a1", timestamp: ts("2026-04-01T00:01:00Z"),
      message: { role: "user", content: [{ type: "text", text: "q2" }] } },
    { type: "message", id: "a2", parentId: "u2", timestamp: ts("2026-04-01T00:01:05Z"),
      message: { role: "assistant", content: [{ type: "text", text: "answer 2" }],
                 usage: { input: 200, output: 20, totalTokens: 220 } } },
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
    { type: "message", id: "u1", parentId: "", timestamp: ts("2026-04-01T00:00:00Z"),
      message: { role: "user", content: [{ type: "text", text: "hi" }] } },
    { type: "message", id: "a1", parentId: "u1", timestamp: ts("2026-04-01T00:00:07Z"),
      message: { role: "assistant", content: [
        { type: "thinking" },
        { type: "toolCall", name: "read", id: "tc1", arguments: { file_path: "/tmp/a" } },
      ], usage: { input: 100, output: 50, totalTokens: 150 } } },
    { type: "message", id: "r1", parentId: "a1", timestamp: ts("2026-04-01T00:00:09Z"),
      message: { role: "toolResult", content: [{ type: "text", text: "ok" }] } },
  ];
  const runs = parseTranscript(entries, "key");
  const think = runs[0].steps.find(s => s.nodeType === "MODEL_THINK");
  assert(think !== undefined, "MODEL_THINK present");
  assert(think?.durationMs === 7000, "MODEL_THINK duration = 7000ms",
    `got ${think?.durationMs}`);
}

// ─── 3. Parallel tool calls + FIFO back-linking ─────────────────
console.log("\n=== Parallel tool calls ===");
{
  // Assistant issues 2 tool calls simultaneously, results come back in order.
  const entries: TranscriptEntry[] = [
    { type: "message", id: "u1", parentId: "", timestamp: ts("2026-04-01T00:00:00Z"),
      message: { role: "user", content: [{ type: "text", text: "parallel" }] } },
    { type: "message", id: "a1", parentId: "u1", timestamp: ts("2026-04-01T00:00:05Z"),
      message: { role: "assistant", content: [
        { type: "toolCall", name: "read",  id: "tcA", arguments: { file_path: "/tmp/A" } },
        { type: "toolCall", name: "write", id: "tcB", arguments: { file_path: "/tmp/B" } },
      ], usage: { input: 100, output: 60, totalTokens: 160 } } },
    // First result arrives at +2s
    { type: "message", id: "rA", parentId: "a1", timestamp: ts("2026-04-01T00:00:07Z"),
      message: { role: "toolResult", content: [{ type: "text", text: "A ok" }] } },
    // Second result arrives at +3s
    { type: "message", id: "rB", parentId: "rA", timestamp: ts("2026-04-01T00:00:08Z"),
      message: { role: "toolResult", content: [{ type: "text", text: "B ok" }] } },
  ];
  const runs = parseTranscript(entries, "key");
  const calls = runs[0].steps.filter(s => s.toolName === "read" || s.toolName === "write");
  assert(calls.length === 2, "both tool calls present");
  const readStep = calls.find(s => s.toolName === "read");
  const writeStep = calls.find(s => s.toolName === "write");
  assert(readStep?.status === "ok" && writeStep?.status === "ok",
    "both calls reach ok status after their results");
  // FIFO: read was issued first → matched with rA (first result) → duration 2000
  assert(readStep?.durationMs === 2000, "read duration (first-issued → first result) = 2000ms",
    `got ${readStep?.durationMs}`);
  // write was issued second → matched with rB (second result) → duration 3000
  assert(writeStep?.durationMs === 3000, "write duration (second-issued → second result) = 3000ms",
    `got ${writeStep?.durationMs}`);
  // Per-tool token approximation: 60 output / 2 calls = 30
  assert(readStep?.outputTokens === 30, "read per-tool tokens ≈ 30");
  assert(writeStep?.outputTokens === 30, "write per-tool tokens ≈ 30");
}

// ─── 4. Context token delta ─────────────────────────────────────
console.log("\n=== Context token delta ===");
{
  const entries: TranscriptEntry[] = [
    { type: "message", id: "u1", parentId: "", timestamp: ts("2026-04-01T00:00:00Z"),
      message: { role: "user", content: [{ type: "text", text: "q" }] } },
    { type: "message", id: "a1", parentId: "u1", timestamp: ts("2026-04-01T00:00:05Z"),
      message: { role: "assistant", content: [
        { type: "toolCall", name: "mcp_fetch_doc", id: "tc1", arguments: { url: "https://x" } },
      ], usage: { input: 1000, output: 20, totalTokens: 1020 } } },
    { type: "message", id: "r1", parentId: "a1", timestamp: ts("2026-04-01T00:00:07Z"),
      message: { role: "toolResult", content: [{ type: "text", text: "doc body" }] } },
    { type: "message", id: "a2", parentId: "r1", timestamp: ts("2026-04-01T00:00:10Z"),
      message: { role: "assistant", content: [
        { type: "toolCall", name: "mcp_second", id: "tc2", arguments: {} },
      ], usage: { input: 3500, output: 30, totalTokens: 3530 } } },
  ];
  const runs = parseTranscript(entries, "key");
  // The 2nd assistant message's MCP tool call should carry delta = 3500 - 1000 = 2500
  const steps = runs[0].steps;
  const mcp2 = steps.find(s => s.toolName === "mcp_second");
  assert(mcp2?.contextTokenDelta === 2500,
    "MCP_CALL on second assistant message gets contextTokenDelta = 2500",
    `got ${mcp2?.contextTokenDelta}`);
  // First MCP call should NOT have a delta (no previous assistant usage)
  const mcp1 = steps.find(s => s.toolName === "mcp_fetch_doc");
  assert(mcp1?.contextTokenDelta === undefined,
    "first MCP call has no delta (no prior input)");
}

// ─── 5. Idempotent parse ────────────────────────────────────────
console.log("\n=== Idempotent parse ===");
{
  const entries: TranscriptEntry[] = [
    { type: "message", id: "u1", parentId: "", timestamp: ts("2026-04-01T00:00:00Z"),
      message: { role: "user", content: [{ type: "text", text: "q" }] } },
    { type: "message", id: "a1", parentId: "u1", timestamp: ts("2026-04-01T00:00:05Z"),
      message: { role: "assistant", content: [
        { type: "thinking" },
        { type: "toolCall", name: "read", id: "tc1", arguments: { file_path: "/tmp/a" } },
      ], usage: { input: 100, output: 50, totalTokens: 150 } } },
    { type: "message", id: "r1", parentId: "a1", timestamp: ts("2026-04-01T00:00:07Z"),
      message: { role: "toolResult", content: [{ type: "text", text: "ok" }] } },
  ];
  const first = parseTranscript(entries, "key");
  const second = parseTranscript(entries, "key");
  assert(JSON.stringify(first) === JSON.stringify(second),
    "parseTranscript is pure — same input → same output");
  // Step count stable
  assert(first[0].steps.length === second[0].steps.length, "step count stable across runs");
}

// ─── 6. Error status propagation ────────────────────────────────
console.log("\n=== Error propagation ===");
{
  const entries: TranscriptEntry[] = [
    { type: "message", id: "u1", parentId: "", timestamp: ts("2026-04-01T00:00:00Z"),
      message: { role: "user", content: [{ type: "text", text: "q" }] } },
    { type: "message", id: "a1", parentId: "u1", timestamp: ts("2026-04-01T00:00:05Z"),
      message: { role: "assistant", content: [
        { type: "toolCall", name: "api-post-search", id: "tc1", arguments: { q: "x" } },
      ], usage: { input: 100, output: 50, totalTokens: 150 } } },
    { type: "message", id: "r1", parentId: "a1", timestamp: ts("2026-04-01T00:00:07Z"),
      message: { role: "toolResult", content: [
        { type: "text", text: '{"error":"HTTP 429 Too Many Requests"}' },
      ] } },
  ];
  const runs = parseTranscript(entries, "key");
  const call = runs[0].steps.find(s => s.toolName === "api-post-search");
  assert(call?.status === "error", "MCP tool call inherits error status from result");
  assert(call?.errorType === "rate_limit", "error type classified as rate_limit",
    `got ${call?.errorType}`);
}

// ─── Summary ────────────────────────────────────────────────────
console.log(`\n${"=".repeat(50)}`);
console.log(`Parser invariants: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  • ${f}`);
  process.exit(1);
}
