/**
 * P2-3 — hermetic ingest test (fixture mode).
 *
 * Goal: prove the parse → upsert → query chain on a CLEAN machine that has
 * no live `~/.openclaw/agents/*.jsonl` and no running obs-v2 service. This
 * is the test suite a CI runner / external contributor can run after
 * `git clone` without any setup.
 *
 * What this test exercises end-to-end:
 *
 *   1. Read a hand-crafted transcript fixture under
 *      `tests/fixtures/transcripts/synthetic-session.jsonl`
 *   2. Run it through the real `parseTranscript` from `transcript-parser.ts`
 *   3. Open a brand-new SQLite DB at a temp path, run `migrate()` from
 *      `db.ts`, and `upsertSteps()` the parsed runs
 *   4. Replay the file a second time and assert idempotency:
 *      - same number of step rows after the second upsert
 *      - same per-run-id step counts
 *   5. Cross-check with hand-derived expected counts (parser correctness
 *      against a checked-in fixture, not just internal self-consistency)
 *
 * To keep the test hermetic, we override `process.env.OPENCLAW_HOME`
 * BEFORE the first import so `CONFIG.DB_PATH` resolves to the temp dir.
 *
 * Run:
 *   node --experimental-sqlite --experimental-strip-types --no-warnings \
 *     tests/fixture-ingest.test.ts
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, "..");

let passed = 0;
let failed = 0;
const failures: string[] = [];
function assert(cond: boolean, name: string, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
    failures.push(name);
  }
}

// ─── Set up an isolated $OPENCLAW_HOME BEFORE any obs-v2 import ─
const tmpHome = mkdtempSync(join(tmpdir(), "obs-fixture-"));
mkdirSync(join(tmpHome, "logs/observability-v2"), { recursive: true });
mkdirSync(join(tmpHome, "agents/main/sessions"), { recursive: true });
process.env.OPENCLAW_HOME = tmpHome;

// Now it is safe to import obs-v2 modules — they pick up the override.
const { parseTranscript } = await import("../src/ingest/transcript-parser.ts");
const { upsertSteps } = await import("../src/storage/steps-repo.ts");
const { getDb, closeDb } = await import("../src/storage/db.ts");

// ─── Load the synthetic transcript ──────────────────────────────
console.log("\n=== Fixture ingest ===");

const fixturePath = join(REPO_ROOT, "tests/fixtures/transcripts/synthetic-session.jsonl");
const raw = readFileSync(fixturePath, "utf-8");
const entries: any[] = [];
for (const line of raw.split("\n")) {
  if (!line.trim()) continue;
  entries.push(JSON.parse(line));
}
assert(entries.length > 0, `read fixture (${entries.length} entries)`);

// ─── Parse ──────────────────────────────────────────────────────
const sessionKey = "agent:main:fixture:synthetic";
const runs = parseTranscript(entries, sessionKey);

// Two user messages → two runs
assert(runs.length === 2, "two runs parsed", `got ${runs.length}`);

// Run 1 layout (parser stores each toolResult entry as its OWN row,
// even though the back-linking pass also folds the result into the
// matching tool-call row):
//
//   MODEL_THINK (a-fix-1)
//   read         (tool call, role=assistant)
//   write        (tool call, role=assistant)
//   TOOL_CALL    (r-fix-A, role=toolResult, placeholder type)
//   TOOL_CALL    (r-fix-B, role=toolResult)
//   MODEL_THINK  (a-fix-2 has thinking)
//   REPLY        (a-fix-2 has text)
// = 7 steps
const run1 = runs[0];
const run1Names = run1.steps.map((s: any) => `${s.role}:${s.toolName || s.nodeType}`);
assert(run1.steps.length === 7, `run 1 has 7 steps`, `got ${run1.steps.length}: ${JSON.stringify(run1Names)}`);

// Parallel tool back-linking — read should match the FIRST result, write the second
const readStep = run1.steps.find((s: any) => s.toolName === "read");
const writeStep = run1.steps.find((s: any) => s.toolName === "write");
assert(readStep != null && writeStep != null, "both parallel tool calls present");
// read at 10:00:03, result at 10:00:05 → 2000ms
assert(readStep?.durationMs === 2000, "read duration = 2000ms", `got ${readStep?.durationMs}`);
// write at 10:00:03, result at 10:00:06.5 → 3500ms
assert(writeStep?.durationMs === 3500, "write duration = 3500ms", `got ${writeStep?.durationMs}`);
// Both tool calls' status flipped to ok by their respective results
assert(readStep?.status === "ok", "read status promoted to ok");
assert(writeStep?.status === "ok", "write status promoted to ok");
// Per-tool token approximation: 80 / 2 = 40
assert(readStep?.outputTokens === 40, "read per-tool tokens = 40");
assert(writeStep?.outputTokens === 40, "write per-tool tokens = 40");

// Run 2 layout:
//
//   MODEL_THINK            (a-fix-3 has thinking)
//   lark_search_doc_wiki (mcp call)
//   TOOL_CALL              (r-fix-C as toolResult)
//   MODEL_THINK            (a-fix-4 has thinking)
//   REPLY                  (a-fix-4 has text)
// = 5 steps
const run2 = runs[1];
const run2Names = run2.steps.map((s: any) => `${s.role}:${s.toolName || s.nodeType}`);
assert(run2.steps.length === 5, `run 2 has 5 steps`, `got ${run2.steps.length}: ${JSON.stringify(run2Names)}`);

// MCP tool detection
const mcpStep = run2.steps.find((s: any) => s.nodeType === "MCP_CALL");
assert(mcpStep != null, "lark_search_doc_wiki classified as MCP_CALL");
assert(mcpStep?.mcpTool === "lark_search_doc_wiki", "mcpTool name preserved");
assert(mcpStep?.mcpServer === "lark", "mcpServer = 'lark'");
// contextTokenDelta is intentionally undefined here: a-fix-3 is the FIRST
// assistant message of run 2, so there is no `prevAssistantInputTokens`
// from within the same run. The cross-run delta is checked in
// parser-invariants.test.ts §"Context token delta".
assert(mcpStep?.contextTokenDelta === undefined, "MCP_CALL on first assistant of a run has no contextTokenDelta");

// Total tokens per run = last assistant's totalTokens
assert(run1.totalTokens === 340, "run 1 totalTokens = 340", `got ${run1.totalTokens}`);
assert(run2.totalTokens === 1260, "run 2 totalTokens = 1260", `got ${run2.totalTokens}`);

// ─── Upsert into the temp DB ────────────────────────────────────
console.log("\n=== Upsert + idempotency ===");

const db = getDb();
upsertSteps(run1);
upsertSteps(run2);

const stepsAfterFirst = (db.prepare("SELECT COUNT(*) as n FROM steps").get() as any).n;
assert(stepsAfterFirst === 12, "12 step rows after first upsert", `got ${stepsAfterFirst}`);

// Re-upsert the same runs — `ON CONFLICT(step_id) DO UPDATE` must not duplicate
upsertSteps(run1);
upsertSteps(run2);
const stepsAfterSecond = (db.prepare("SELECT COUNT(*) as n FROM steps").get() as any).n;
assert(stepsAfterSecond === 12, "still 12 rows after re-upsert (idempotent)", `got ${stepsAfterSecond}`);

// Per-run-id counts
const run1Rows = (db.prepare("SELECT COUNT(*) as n FROM steps WHERE run_id = ?").get("u-fix-1") as any).n;
const run2Rows = (db.prepare("SELECT COUNT(*) as n FROM steps WHERE run_id = ?").get("u-fix-2") as any).n;
assert(run1Rows === 7, "run 1 has 7 rows in DB", `got ${run1Rows}`);
assert(run2Rows === 5, "run 2 has 5 rows in DB", `got ${run2Rows}`);

// Schema-level sanity: indices exist and the ORDER BY ts_epoch_ms DESC seek
// uses the Round 1 composite index, not a full scan.
const plan = db
  .prepare("EXPLAIN QUERY PLAN SELECT * FROM steps WHERE session_key = ? ORDER BY ts_epoch_ms DESC LIMIT 1")
  .all(sessionKey) as any[];
const planText = plan.map((r) => r.detail || "").join(" | ");
assert(/USING INDEX idx_steps_session_ts/.test(planText), "latest-step query plan uses idx_steps_session_ts", planText);

// Tear down — close the DB and wipe the temp directory.
closeDb();
try {
  rmSync(tmpHome, { recursive: true, force: true });
} catch {
  /* best effort */
}

// ─── Summary ────────────────────────────────────────────────────
console.log(`\n${"=".repeat(50)}`);
console.log(`Fixture ingest: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  • ${f}`);
  process.exit(1);
}
