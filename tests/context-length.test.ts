/**
 * Round 6 — Context Length view (§1.2 #16) hermetic test suite.
 *
 * Six layers, all driven by hand-derived synthetic transcripts so every
 * expected number is mechanically computable on a whiteboard:
 *
 *   1. Schema migration is idempotent
 *   2. Parser populates the 4 new fields exactly
 *   3. getContextBreakdown (coarse 5-bucket) per-turn + bucket totals
 *      + sanity invariant `baseline + Σ Δ == totalLatest`
 *   4. getContextTimeline per-turn rows + cumulative aggregates
 *   5. Death-loop heuristic detection (stuck vs healthy)
 *   6. HTTP API roundtrip via in-process startServer
 *
 * Hermetic via OPENCLAW_HOME=$tmpdir override (same pattern as
 * fixture-ingest.test.ts).
 */

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function assert(cond: boolean, name: string, detail?: string) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
    failures.push(name);
  }
}

// ─── Set up an isolated $OPENCLAW_HOME BEFORE any obs-v2 import ─
const tmpHome = mkdtempSync(join(tmpdir(), "obs-context-length-"));
mkdirSync(join(tmpHome, "logs/observability-v2"), { recursive: true });
process.env.OPENCLAW_HOME = tmpHome;
process.env.OBS_AUTH_TOKEN = ""; // disable auth for the in-process HTTP test

const { parseTranscript } = await import("../src/ingest/transcript-parser.ts");
const { upsertSteps } = await import("../src/storage/steps-repo.ts");
const { getDb, closeDb } = await import("../src/storage/db.ts");
const { getContextBreakdown, getContextTimeline } = await import("../src/storage/context-repo.ts");

// ─── Group 1: Schema migration is idempotent ────────────────────
console.log("\n=== Group 1: Schema migration ===");
{
  const db = getDb();
  const cols = db.prepare("PRAGMA table_info(steps)").all() as Array<{ name: string }>;
  const want = ["input_tokens", "cache_read_tokens", "thinking_text_len", "reply_text_len"];
  for (const w of want) {
    assert(cols.some((c) => c.name === w), `column ${w} present after migrate()`);
  }

  // Re-run migrate by closing + re-opening — must not throw
  closeDb();
  const db2 = getDb();
  const cols2 = db2.prepare("PRAGMA table_info(steps)").all() as Array<{ name: string }>;
  assert(cols2.length === cols.length, "second migrate() does not change column count");
}

// ─── Build a synthetic 4-turn run with KNOWN token math ─────────
//
// Turn 0: a0 — usage.input=10000  output=200  cacheRead=0   thinking=10
// Turn 1: a1 — usage.input=11500  output=180  cacheRead=10000 thinking=13
//   prompt₁ = in + cR = 11500 + 10000 = 21500
//   prevToolResults: 1 result of 1200 chars (300 tokens) from a0's read
//   tool call. a1's tool call is feishu_search_doc_wiki (MCP_CALL),
//   so the parser sets a1's tool_call row's context_token_delta =
//   a1.input - a0.input = 1500. getTurnMcpDelta(turn 1) sums
//   context_token_delta of MCP_CALL rows in a1's assistantRows = 1500.
//     priorOutput contribution: 200
//     toolResultsCharApprox: 1200/4 = 300
//     mcpDelta: 1500
//     Δctx = prompt₁ - prompt₀ = 21500 - 10000 = 11500
//     unaccounted = 11500 - 200 - 300 - 1500 = 9500
// Turn 2: a2 — usage.input=12300  output=80   cacheRead=11500 thinking=10
//   prompt₂ = 12300 + 11500 = 23800
//   prevToolResults: 1 result of 800 chars (200 tokens) from a1's MCP call
//   a2's tool call is `read` (TOOL_CALL, not MCP_CALL), no contextTokenDelta
//     priorOutput: 180
//     toolResults: 200
//     mcpDelta: 0
//     Δctx = 23800 - 21500 = 2300
//     unaccounted = 2300 - 180 - 200 - 0 = 1920
// Turn 3: a3 — MODEL_THINK + REPLY, input=12500 output=50 cacheRead=12300
//   prompt₃ = 12500 + 12300 = 24800
//   thinking=5 replyText=120. Both rows are folded into 1 turn by
//   groupTurns (Round 6 fix).
//     priorOutput: 80
//     toolResults: 0 (r2 was empty)
//     mcpDelta: 0
//     Δctx = 24800 - 23800 = 1000
//     unaccounted = 1000 - 80 - 0 - 0 = 920

const sessionKey = "agent:test:context";
const fixtureEntries: any[] = [
  // turn-starting user
  { type: "message", id: "u1", parentId: "", timestamp: "2026-04-11T00:00:00.000Z",
    message: { role: "user", content: [{ type: "text", text: "go" }] } },
  // a0 — first assistant with thinking + 1 tool call (read)
  { type: "message", id: "a0", parentId: "u1", timestamp: "2026-04-11T00:00:01.000Z",
    message: { role: "assistant", content: [
      { type: "thinking", text: "thinking-a0" }, // 11 chars (we'll make it 10 below)
      { type: "toolCall", name: "read", id: "tc0", arguments: { file_path: "/tmp/x" } },
    ], usage: { input: 10000, output: 200, cacheRead: 0, totalTokens: 10200 } } },
  // tool result from a0 — 1200 chars
  { type: "message", id: "r0", parentId: "a0", timestamp: "2026-04-11T00:00:02.000Z",
    message: { role: "toolResult", content: [{ type: "text", text: "x".repeat(1200) }] } },
  // a1 — assistant with thinking + 1 MCP tool call (feishu_search_doc_wiki)
  { type: "message", id: "a1", parentId: "r0", timestamp: "2026-04-11T00:00:03.000Z",
    message: { role: "assistant", content: [
      { type: "thinking", text: "thinking-a1!!" },  // 13 chars
      { type: "toolCall", name: "feishu_search_doc_wiki", id: "tc1", arguments: { q: "x" } },
    ], usage: { input: 11500, output: 180, cacheRead: 10000, totalTokens: 11680 } } },
  // tool result from a1's MCP call — 800 chars
  { type: "message", id: "r1", parentId: "a1", timestamp: "2026-04-11T00:00:04.000Z",
    message: { role: "toolResult", content: [{ type: "text", text: "y".repeat(800) }] } },
  // a2 — assistant with another tool call
  { type: "message", id: "a2", parentId: "r1", timestamp: "2026-04-11T00:00:05.000Z",
    message: { role: "assistant", content: [
      { type: "thinking", text: "thinkingA2" }, // 10 chars
      { type: "toolCall", name: "read", id: "tc2", arguments: { file_path: "/tmp/y" } },
    ], usage: { input: 12300, output: 80, cacheRead: 11500, totalTokens: 12380 } } },
  // tool result from a2 — 0 chars (empty)
  { type: "message", id: "r2", parentId: "a2", timestamp: "2026-04-11T00:00:06.000Z",
    message: { role: "toolResult", content: [{ type: "text", text: "" }] } },
  // a3 — REPLY assistant, thinking + 120-char text
  { type: "message", id: "a3", parentId: "r2", timestamp: "2026-04-11T00:00:07.000Z",
    message: { role: "assistant", content: [
      { type: "thinking", text: "think" }, // 5 chars
      { type: "text", text: "z".repeat(120) },
    ], usage: { input: 12500, output: 50, cacheRead: 12300, totalTokens: 12550 } } },
];

// ─── Group 2: Parser populates new fields correctly ─────────────
console.log("\n=== Group 2: Parser populates new fields ===");
const parsedRuns = parseTranscript(fixtureEntries, sessionKey);
assert(parsedRuns.length === 1, "1 run produced from synthetic transcript");
const run = parsedRuns[0];

// MODEL_THINK on a0 carries usage.input
const a0Think = run.steps.find((s: any) => s.stepId === "a0");
assert(a0Think?.inputTokens === 10000, "a0 MODEL_THINK.inputTokens == 10000");
assert(a0Think?.cacheReadTokens === 0, "a0 cacheReadTokens == 0");
assert(a0Think?.thinkingTextLen === 11, "a0 thinkingTextLen == 11", `got ${a0Think?.thinkingTextLen}`);

const a1Think = run.steps.find((s: any) => s.stepId === "a1");
assert(a1Think?.inputTokens === 11500, "a1 MODEL_THINK.inputTokens == 11500");
assert(a1Think?.cacheReadTokens === 10000, "a1 cacheReadTokens == 10000");

const reply = run.steps.find((s: any) => s.nodeType === "REPLY");
assert(reply?.inputTokens === 12500, "REPLY inputTokens == 12500");
assert(reply?.replyTextLen === 120, "REPLY replyTextLen == 120");

// Tool call rows have NULL inputTokens
const tc0 = run.steps.find((s: any) => s.toolName === "read" && s.stepId.startsWith("a0:"));
assert(tc0?.inputTokens === undefined, "tool_call row has no inputTokens");

// ─── Persist to DB and exercise the storage repo ────────────────
upsertSteps(run);
const stepCount = (getDb().prepare("SELECT COUNT(*) as n FROM steps").get() as any).n;
assert(stepCount > 0, `steps written to DB (${stepCount} rows)`);

// Verify the new columns made it to disk
const a0Row = getDb().prepare("SELECT input_tokens, cache_read_tokens, thinking_text_len FROM steps WHERE step_id = 'a0'").get() as any;
assert(a0Row?.input_tokens === 10000, "a0 row in DB has input_tokens=10000");
assert(a0Row?.cache_read_tokens === 0, "a0 row in DB has cache_read_tokens=0");
assert(a0Row?.thinking_text_len === 11, "a0 row in DB has thinking_text_len=11");

// ─── Group 3: getContextBreakdown (coarse 5-bucket) ─────────────
console.log("\n=== Group 3: getContextBreakdown ===");
const breakdown = getContextBreakdown(sessionKey, "u1");
assert(breakdown != null, "getContextBreakdown returns a result");
if (breakdown) {
  assert(breakdown.totalLatest === 24800, "totalLatest == 24800 (last prompt = in + cR = 12500 + 12300)",
    `got ${breakdown.totalLatest}`);
  assert(breakdown.frameworkBaseline === 10000, "frameworkBaseline == 10000 (in₀ + cR₀ = 10000 + 0)",
    `got ${breakdown.frameworkBaseline}`);
  assert(breakdown.turns.length === 4, "4 turns in breakdown",
    `got ${breakdown.turns.length}`);

  // Turn 0: baseline, no contributors
  assert(breakdown.turns[0].deltaFromPrev === null, "turn 0 deltaFromPrev is null");
  assert(breakdown.turns[0].contributors === null, "turn 0 contributors is null");
  assert(breakdown.turns[0].inputTokens === 10000, "turn 0 inputTokens == 10000");

  // Turn 1: Δctx = prompt₁ - prompt₀ = 21500 - 10000 = 11500
  // priorOutput=200, toolResults=300, mcpDelta=1500
  // unaccounted = 11500 - 200 - 300 - 1500 = 9500
  const t1 = breakdown.turns[1];
  assert(t1.deltaFromPrev === 11500, "turn 1 deltaFromPrev == 11500 (Δprompt)", `got ${t1.deltaFromPrev}`);
  assert(t1.contributors?.priorOutput === 200, "turn 1 priorOutput == 200");
  assert(t1.contributors?.toolResultsCharApprox === 300, "turn 1 toolResultsCharApprox == 300");
  assert(t1.contributors?.mcpDelta === 1500,
    "turn 1 mcpDelta == 1500 (MCP_CALL row carries context_token_delta)",
    `got ${t1.contributors?.mcpDelta}`);
  assert(t1.contributors?.unaccounted === 9500,
    "turn 1 unaccounted == 11500 - 200 - 300 - 1500 = 9500",
    `got ${t1.contributors?.unaccounted}`);

  // Turn 2: Δctx = 23800 - 21500 = 2300
  // priorOutput=180, toolResults=200, mcpDelta=0
  // unaccounted = 2300 - 180 - 200 - 0 = 1920
  const t2 = breakdown.turns[2];
  assert(t2.deltaFromPrev === 2300, "turn 2 deltaFromPrev == 2300", `got ${t2.deltaFromPrev}`);
  assert(t2.contributors?.priorOutput === 180, "turn 2 priorOutput == 180");
  assert(t2.contributors?.toolResultsCharApprox === 200, "turn 2 toolResultsCharApprox == 200");
  assert(t2.contributors?.mcpDelta === 0, "turn 2 mcpDelta == 0 (a2's tool is read, not MCP)");
  assert(t2.contributors?.unaccounted === 1920,
    "turn 2 unaccounted == 2300 - 180 - 200 - 0 = 1920",
    `got ${t2.contributors?.unaccounted}`);

  // Turn 3: Δctx = 24800 - 23800 = 1000
  // priorOutput=80, toolResults=0, mcpDelta=0
  // unaccounted = 1000 - 80 - 0 - 0 = 920
  const t3 = breakdown.turns[3];
  assert(t3.deltaFromPrev === 1000, "turn 3 deltaFromPrev == 1000", `got ${t3.deltaFromPrev}`);
  assert(t3.contributors?.priorOutput === 80, "turn 3 priorOutput == 80");
  assert(t3.contributors?.toolResultsCharApprox === 0, "turn 3 toolResultsCharApprox == 0 (empty result)");
  assert(t3.contributors?.unaccounted === 920, "turn 3 unaccounted == 920",
    `got ${t3.contributors?.unaccounted}`);

  // Sanity invariant: baseline + Σ Δ == totalLatest
  const sumDelta = breakdown.turns.slice(1)
    .reduce((s, t) => s + (t.deltaFromPrev || 0), 0);
  assert(breakdown.frameworkBaseline + sumDelta === breakdown.totalLatest,
    "sanity: baseline + Σ Δ == totalLatest",
    `${breakdown.frameworkBaseline} + ${sumDelta} != ${breakdown.totalLatest}`);

  // Bucket totals (sum across turns 1..3 since turn 0 is the baseline)
  // assistantOutputs = 200 + 180 + 80 = 460  (priorOutput at each Δ)
  // toolResults = 300 + 200 + 0 = 500
  // mcpDeltas = 1500 + 0 + 0 = 1500
  // unaccounted = 9500 + 1920 + 920 = 12340
  assert(breakdown.buckets.assistantOutputsCumulative === 460,
    "buckets.assistantOutputsCumulative == 460",
    `got ${breakdown.buckets.assistantOutputsCumulative}`);
  assert(breakdown.buckets.toolResultsCumulative === 500,
    "buckets.toolResultsCumulative == 500",
    `got ${breakdown.buckets.toolResultsCumulative}`);
  assert(breakdown.buckets.mcpDeltasCumulative === 1500,
    "buckets.mcpDeltasCumulative == 1500",
    `got ${breakdown.buckets.mcpDeltasCumulative}`);
  assert(breakdown.buckets.unaccountedCumulative === 12340,
    "buckets.unaccountedCumulative == 9500 + 1920 + 920 = 12340",
    `got ${breakdown.buckets.unaccountedCumulative}`);
}

// ─── Group 4: getContextTimeline (fine-grained) ─────────────────
console.log("\n=== Group 4: getContextTimeline ===");
const timeline = getContextTimeline(sessionKey, "u1");
assert(timeline != null, "getContextTimeline returns a result");
if (timeline) {
  assert(timeline.turns.length === 4, "4 turns in timeline");

  // Per-turn cumulative checks
  const tt = timeline.turns;
  assert(tt[0].deltaIn === null, "turn 0 deltaIn == null");
  assert(tt[1].deltaIn === 11500, "turn 1 deltaIn == 11500 (Δprompt = 21500 - 10000)",
    `got ${tt[1].deltaIn}`);
  assert(tt[2].deltaIn === 2300, "turn 2 deltaIn == 2300 (Δprompt = 23800 - 21500)",
    `got ${tt[2].deltaIn}`);
  assert(tt[3].deltaIn === 1000, "turn 3 deltaIn == 1000 (Δprompt = 24800 - 23800)",
    `got ${tt[3].deltaIn}`);

  // primaryTool detection
  assert(tt[0].primaryTool === "read", "turn 0 primaryTool == read");
  assert(tt[1].primaryTool === "feishu_search_doc_wiki", "turn 1 primaryTool == feishu_search_doc_wiki");
  assert(tt[3].primaryTool === null, "turn 3 (REPLY) primaryTool == null");

  // prevToolResultChars on turn 1 (the result from a0's read = 1200 chars)
  assert(tt[1].prevToolResultChars === 1200, "turn 1 prevToolResultChars == 1200");
  // prevToolResultChars on turn 2 (the result from a1's MCP call = 800 chars)
  assert(tt[2].prevToolResultChars === 800, "turn 2 prevToolResultChars == 800");

  // thinkingChars
  assert(tt[0].thinkingChars === 11, "turn 0 thinkingChars == 11");
  assert(tt[1].thinkingChars === 13, "turn 1 thinkingChars == 13");
  assert(tt[3].thinkingChars === 5, "turn 3 thinkingChars == 5");

  // replyTextChars
  assert(tt[3].replyTextChars === 120, "turn 3 replyTextChars == 120");
  assert(tt[0].replyTextChars === 0, "turn 0 replyTextChars == 0 (no text content)");

  // Cumulative aggregates — totalOutputTokens sums output_tokens across
  // EVERY assistant row, which intentionally double-counts the per-tool
  // approximation: each tool_call row's output_tokens equals the parent
  // assistant's output_tokens (when N=1). For our 4-turn fixture:
  //   a0  MODEL_THINK     : 200
  //   a0  read tool_call  : 200  (parent.output / 1)
  //   a1  MODEL_THINK     : 180
  //   a1  MCP  tool_call  : 180
  //   a2  MODEL_THINK     :  80
  //   a2  read tool_call  :  80
  //   a3  MODEL_THINK     :  50
  //   a3  REPLY child     :  50
  //   ─────────────────────────
  //   TOTAL                1020
  assert(timeline.cumulative.totalOutputTokens === 1020,
    "cumulative.totalOutputTokens == 1020 (parent + per-tool double, intentional)",
    `got ${timeline.cumulative.totalOutputTokens}`);

  // peak input (in + cR): max of 10000, 21500, 23800, 24800 = 24800
  assert(timeline.cumulative.peakInputTokens === 24800,
    "cumulative.peakInputTokens == 24800 (prompt-based)",
    `got ${timeline.cumulative.peakInputTokens}`);
  assert(timeline.cumulative.finalInputTokens === 24800,
    "cumulative.finalInputTokens == 24800 (prompt-based)",
    `got ${timeline.cumulative.finalInputTokens}`);

  // total reply text chars across the run = 120
  assert(timeline.cumulative.totalReplyTextChars === 120,
    "cumulative.totalReplyTextChars == 120");

  // total thinking chars = 11 + 13 + 10 + 5 = 39
  assert(timeline.cumulative.totalThinkingChars === 39,
    "cumulative.totalThinkingChars == 39",
    `got ${timeline.cumulative.totalThinkingChars}`);

  // total tool result chars = 1200 + 800 + 0 = 2000
  assert(timeline.cumulative.totalToolResultChars === 2000,
    "cumulative.totalToolResultChars == 2000");

  // cache hit rate: cR_total / prompt_total
  // cR_total = 0 + 10000 + 11500 + 12300 = 33800
  // prompt_total = (10000+0) + (11500+10000) + (12300+11500) + (12500+12300) = 80100
  // hit = 33800 / 80100 ≈ 0.4220
  const expectedHit = 33800 / 80100;
  assert(
    timeline.cumulative.cacheHitRate != null &&
      Math.abs(timeline.cumulative.cacheHitRate - expectedHit) < 1e-6,
    `cumulative.cacheHitRate ≈ ${expectedHit.toFixed(4)}`,
    `got ${timeline.cumulative.cacheHitRate}`,
  );

  // Top spikes — sorted by deltaIn DESC: turn 1 (11500), turn 2 (2300), turn 3 (1000)
  assert(timeline.topSpikes.length === 3, "3 spikes (turns with positive deltaIn)");
  assert(timeline.topSpikes[0].seq === tt[1].seq && timeline.topSpikes[0].deltaIn === 11500,
    "top spike #1 is turn 1 with +11500");
  assert(timeline.topSpikes[1].seq === tt[2].seq && timeline.topSpikes[1].deltaIn === 2300,
    "top spike #2 is turn 2 with +2300");
}

// ─── Group 5: Death-loop heuristic detection ────────────────────
console.log("\n=== Group 5: Loop heuristic ===");
{
  // Build a SECOND synthetic transcript with 12 consecutive read-only
  // turns, all hitting cache, all reading the same file, no writes.
  const loopEntries: any[] = [
    { type: "message", id: "uL", parentId: "", timestamp: "2026-04-11T01:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "loop" }] } },
  ];
  // 12 turns of read on the same file with high cache hit rate
  for (let i = 0; i < 12; i++) {
    const ts1 = `2026-04-11T01:00:${String(10 + i).padStart(2, "0")}.000Z`;
    const ts2 = `2026-04-11T01:00:${String(10 + i).padStart(2, "0")}.500Z`;
    loopEntries.push(
      { type: "message", id: `aL${i}`, parentId: i === 0 ? "uL" : `rL${i - 1}`, timestamp: ts1,
        message: { role: "assistant", content: [
          { type: "thinking", text: "still reading" },
          { type: "toolCall", name: "read", id: `tcL${i}`, arguments: { file_path: "/tmp/loop.py" } },
        ], usage: {
          input: 5000 + i * 50,           // grows ~50/turn → drift well under 5%
          output: 30,
          cacheRead: 50000 + i * 200,     // big cache → ~91% hit rate per turn
          totalTokens: 5050 + i * 50,
        } } },
      { type: "message", id: `rL${i}`, parentId: `aL${i}`, timestamp: ts2,
        message: { role: "toolResult", content: [{ type: "text", text: "loop body" }] } },
    );
  }
  const loopRun = parseTranscript(loopEntries, "agent:test:loop")[0];
  upsertSteps(loopRun);

  const loopTimeline = getContextTimeline("agent:test:loop", "uL");
  assert(loopTimeline != null, "loop timeline exists");
  if (loopTimeline) {
    assert(loopTimeline.loopFlags.consecutiveNoWriteTurns >= 12,
      "loop: consecutiveNoWriteTurns >= 12",
      `got ${loopTimeline.loopFlags.consecutiveNoWriteTurns}`);
    assert(loopTimeline.loopFlags.suspectedLoopWindows.length >= 1,
      "loop: at least one suspectedLoopWindow",
      `got ${loopTimeline.loopFlags.suspectedLoopWindows.length}`);
    assert(loopTimeline.loopFlags.suspectedLoopWindows[0].turns >= 8,
      "loop: window covers >= 8 turns");
    assert(loopTimeline.loopFlags.healthVerdict === "stuck",
      "loop: healthVerdict == 'stuck'",
      `got ${loopTimeline.loopFlags.healthVerdict}`);
    assert(
      loopTimeline.loopFlags.repeatedFileReads.some((r: any) => r.filePath.includes("loop.py")),
      "loop: repeatedFileReads contains the hot file",
    );
  }

  // Healthy contrast: the original 4-turn run should be 'healthy'
  const healthy = getContextTimeline(sessionKey, "u1");
  assert(healthy?.loopFlags.healthVerdict === "healthy",
    "healthy 4-turn run reports healthy verdict");
}

// ─── Group 6: HTTP route handler shape ──────────────────────────
//
// Calls handleSessionsRoutes.context() directly with a mock res +
// sendJson — avoids binding to port 18902 (which the live obs-v2 owns)
// and tests exactly the same code path the HTTP layer hits.
console.log("\n=== Group 6: HTTP route handler ===");
{
  const { handleSessionsRoutes } = await import("../src/api/routes-sessions.ts");

  let payload: any = null;
  let status: number | undefined = undefined;
  const sendJson = (_res: any, data: any, s?: number) => { payload = data; status = s; };
  handleSessionsRoutes.context(sessionKey, { runId: "u1" }, {} as any, sendJson);

  assert(status === undefined || status === 200, "context handler returns 200 (no explicit status)");
  assert(payload != null, "context handler called sendJson with a payload");
  if (payload) {
    assert(payload.breakdown != null, "payload has breakdown");
    assert(payload.timeline != null, "payload has timeline");
    assert(payload.breakdown.totalLatest === 24800,
      "handler breakdown.totalLatest matches storage repo (24800)",
      `got ${payload.breakdown?.totalLatest}`);
    assert(payload.timeline.cumulative.peakInputTokens === 24800,
      "handler timeline.cumulative.peakInputTokens matches storage repo (24800)",
      `got ${payload.timeline?.cumulative?.peakInputTokens}`);
    assert(payload.runId === "u1", "handler runId matches the requested run");
  }

  // 404 path
  let payload404: any = null;
  let status404: number | undefined = undefined;
  const sendJson404 = (_res: any, data: any, s?: number) => { payload404 = data; status404 = s; };
  handleSessionsRoutes.context("agent:nonexistent:foo", { runId: "doesnotexist" }, {} as any, sendJson404);
  assert(status404 === 404, "unknown session/run returns 404",
    `got status ${status404}`);
  assert(payload404?.error != null, "404 payload carries an error message");
}

// ─── Group 7: Cache-aware Δctx correctness ─────────────────────
// Builds a transcript where cache toggling makes the old Δ(input-only)
// go wildly negative, but Δ(in+cR) = Δ(prompt) stays correctly positive
// and monotonic. This verifies the fix for the user-reported "fake
// negative deltas" bug.
console.log("\n=== Group 7: Cache-aware Δctx ===");
{
  const cacheEntries: any[] = [
    { type: "message", id: "uC", parentId: "", timestamp: "2026-04-12T00:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "start" }] } },
    // Turn 0: cold cache — all 20000 tokens are uncached
    { type: "message", id: "cA0", parentId: "uC", timestamp: "2026-04-12T00:00:01.000Z",
      message: { role: "assistant", content: [
        { type: "toolCall", name: "read", id: "cTC0", arguments: { file_path: "/tmp/a" } },
      ], usage: { input: 20000, output: 300, cacheRead: 0, totalTokens: 20300 } } },
    { type: "message", id: "cR0", parentId: "cA0", timestamp: "2026-04-12T00:00:02.000Z",
      message: { role: "toolResult", content: [{ type: "text", text: "a".repeat(2000) }] } },
    // Turn 1: cache HOT — 20000 tokens now cached, only 800 new uncached
    // Old Δin = 800 - 20000 = −19200 (!!!). Prompt Δ = 20800 - 20000 = 800. ✅
    { type: "message", id: "cA1", parentId: "cR0", timestamp: "2026-04-12T00:00:03.000Z",
      message: { role: "assistant", content: [
        { type: "toolCall", name: "read", id: "cTC1", arguments: { file_path: "/tmp/b" } },
      ], usage: { input: 800, output: 200, cacheRead: 20000, totalTokens: 21000 } } },
    { type: "message", id: "cR1", parentId: "cA1", timestamp: "2026-04-12T00:00:04.000Z",
      message: { role: "toolResult", content: [{ type: "text", text: "b".repeat(1600) }] } },
    // Turn 2: cache still hot, grew slightly.
    // Old Δin = 1200 - 800 = +400. Prompt Δ = 22000 - 20800 = 1200. ✅
    { type: "message", id: "cA2", parentId: "cR1", timestamp: "2026-04-12T00:00:05.000Z",
      message: { role: "assistant", content: [
        { type: "toolCall", name: "exec", id: "cTC2", arguments: { command: "ls" } },
      ], usage: { input: 1200, output: 150, cacheRead: 20800, totalTokens: 22150 } } },
    { type: "message", id: "cR2", parentId: "cA2", timestamp: "2026-04-12T00:00:06.000Z",
      message: { role: "toolResult", content: [{ type: "text", text: "c".repeat(400) }] } },
    // Turn 3: cache COLD (evicted, e.g. 5-min TTL expired or different prefix).
    // All 22400 are uncached again.
    // Old Δin = 22400 - 1200 = +21200 (spike!). Prompt Δ = 22400 - 22000 = 400. ✅
    { type: "message", id: "cA3", parentId: "cR2", timestamp: "2026-04-12T00:00:07.000Z",
      message: { role: "assistant", content: [
        { type: "text", text: "done" },
      ], usage: { input: 22400, output: 40, cacheRead: 0, totalTokens: 22440 } } },
  ];

  const cacheRun = parseTranscript(cacheEntries, "agent:test:cache")[0];
  upsertSteps(cacheRun);

  const bd = getContextBreakdown("agent:test:cache", "uC");
  assert(bd != null, "cache breakdown exists");
  if (bd) {
    // Prompt values: turn0=20000, turn1=20800, turn2=22000, turn3=22400
    assert(bd.frameworkBaseline === 20000, "cache: baseline == 20000",
      `got ${bd.frameworkBaseline}`);
    assert(bd.totalLatest === 22400, "cache: totalLatest == 22400",
      `got ${bd.totalLatest}`);
    assert(bd.turns.length === 4, "cache: 4 turns");

    // Δctx for each turn (all positive — no fake negatives!)
    assert(bd.turns[1].deltaFromPrev === 800,
      "cache: turn 1 Δctx == 800 (NOT −19200)",
      `got ${bd.turns[1].deltaFromPrev}`);
    assert(bd.turns[2].deltaFromPrev === 1200,
      "cache: turn 2 Δctx == 1200",
      `got ${bd.turns[2].deltaFromPrev}`);
    assert(bd.turns[3].deltaFromPrev === 400,
      "cache: turn 3 Δctx == 400 (NOT +21200 spike)",
      `got ${bd.turns[3].deltaFromPrev}`);

    // All deltas are positive — monotonic prompt growth
    for (let i = 1; i < bd.turns.length; i++) {
      assert((bd.turns[i].deltaFromPrev ?? 0) >= 0,
        `cache: turn ${i} Δctx ≥ 0 (no fake negatives)`,
        `got ${bd.turns[i].deltaFromPrev}`);
    }

    // Sanity invariant
    const sum = bd.turns.slice(1).reduce((s, t) => s + (t.deltaFromPrev || 0), 0);
    assert(bd.frameworkBaseline + sum === bd.totalLatest,
      "cache: baseline + Σ Δ == totalLatest",
      `${bd.frameworkBaseline} + ${sum} = ${bd.frameworkBaseline + sum}, expected ${bd.totalLatest}`);
  }

  const tl = getContextTimeline("agent:test:cache", "uC");
  assert(tl != null, "cache timeline exists");
  if (tl) {
    // No spikes > 5000 in Δctx (max delta = 1200)
    assert(tl.topSpikes.every((s: any) => s.deltaIn <= 5000),
      "cache: no fake spikes from cache-cold/hot transitions");

    // peakInputTokens = max prompt = 22400
    assert(tl.cumulative.peakInputTokens === 22400,
      "cache: peakInputTokens == 22400 (prompt-based)",
      `got ${tl.cumulative.peakInputTokens}`);

    // Cache hit rate: cR = 0+20000+20800+0 = 40800
    // prompt = 20000+20800+22000+22400 = 85200
    // rate = 40800/85200 ≈ 0.4789
    const expectRate = 40800 / 85200;
    assert(tl.cumulative.cacheHitRate != null &&
      Math.abs(tl.cumulative.cacheHitRate - expectRate) < 1e-6,
      `cache: cacheHitRate ≈ ${expectRate.toFixed(4)}`,
      `got ${tl.cumulative.cacheHitRate}`);
  }
}

// Cleanup
closeDb();
try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best effort */ }

console.log(`\n${"=".repeat(50)}`);
console.log(`Context length: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  • ${f}`);
  process.exit(1);
}
