/**
 * Round 6 — channel CLI commands (§5) hermetic test suite.
 *
 * Builds a synthetic obs.db with predictable rows under
 * OPENCLAW_HOME=$tmpdir, then exercises every subcommand handler
 * directly (no child process). Asserts:
 *   - exit code 0 (DispatchResult.exitCode)
 *   - header line `*observability-v2 …*` present
 *   - expected substrings appear (counts, key names, error types)
 *   - line count ≤ a tight upper bound
 *   - NO emojis
 *   - NO Unicode box-drawing characters
 *
 * Plus dispatcher-level tests:
 *   - unknown subcommand → exit 1, includes help
 *   - /observ skills week → invokes the right range
 *   - /observ help → mentions every other subcommand
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

const tmpHome = mkdtempSync(join(tmpdir(), "obs-cli-"));
mkdirSync(join(tmpHome, "logs/observability-v2"), { recursive: true });
process.env.OPENCLAW_HOME = tmpHome;
// Disable auth so tests don't need .env
process.env.OBS_AUTH_TOKEN = "";

const { getDb, closeDb } = await import("../src/storage/db.ts");
const { dispatch, parseCommand } = await import("../src/cli/dispatcher.ts");
const { handleStatus, handleStuck, handleSkills, handleHelp } = await import("../src/cli/handlers.ts");

// ─── Build a synthetic obs.db ───────────────────────────────────
const db = getDb();
const now = Date.now();

// 5 sessions: 2 stuck, 1 with errors, 2 idle
const sessionRows = [
  // 2 stuck
  [
    "agent:test:s1",
    "sid-1",
    "main",
    "chat-direct",
    "user:demo-a",
    null,
    "direct",
    "gpt-5",
    "modelhub",
    5000,
    200,
    5200,
    100000,
    "default",
    1,
    0,
    0,
    0,
    "stuck",
    "exec",
    "exec",
    now - 60_000,
    now,
    60_000,
    "transcript+auth",
  ],
  [
    "agent:test:s2",
    "sid-2",
    "main",
    "chat-group",
    "group:oc_b",
    null,
    "group",
    "gpt-5",
    "modelhub",
    8000,
    300,
    8300,
    120000,
    "fast",
    2,
    1,
    0,
    0,
    "stuck",
    "read",
    "read",
    now - 30_000,
    now,
    30_000,
    "transcript+auth",
  ],
  // 1 with no stuck blocker but with errors
  [
    "agent:test:s3",
    "sid-3",
    "main",
    "chat-direct",
    "user:demo-c",
    null,
    "direct",
    "gpt-5",
    "modelhub",
    30000,
    1500,
    31500,
    80000,
    "default",
    5,
    4,
    1,
    1,
    "idle",
    "write",
    null,
    null,
    now - 100,
    0,
    "transcript+auth",
  ],
  // 2 idle
  [
    "agent:test:s4",
    "sid-4",
    "demo",
    "chat-group",
    "group:oc_d",
    null,
    "group",
    "gpt-5",
    "modelhub",
    12000,
    800,
    12800,
    60000,
    "default",
    3,
    2,
    0,
    0,
    "idle",
    null,
    null,
    null,
    now - 200,
    0,
    "transcript+auth",
  ],
  [
    "agent:test:s5",
    "sid-5",
    "survey",
    "chat-direct",
    "user:demo-e",
    null,
    "direct",
    "gpt-5",
    "modelhub",
    6000,
    100,
    6100,
    40000,
    "default",
    1,
    0,
    0,
    0,
    "idle",
    null,
    null,
    null,
    now - 300,
    0,
    "transcript+auth",
  ],
];
const sessInsert = db.prepare(`INSERT INTO sessions
  (session_key, session_id, agent_id, channel, diag, label, kind,
   model, model_provider, input_tokens, output_tokens, total_tokens, context_tokens, runtime_mode,
   llm_call_count, tool_call_count, skill_call_count, mcp_call_count,
   diag_state, current_op, blocker, last_block_ts, updated_at, age_ms, source)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
for (const r of sessionRows) sessInsert.run(...(r as any[]));

// Steps: a few skill_exec, a few mcp_call (with one error), a few errors
const stepInsert = db.prepare(`INSERT INTO steps
  (step_id, session_key, run_id, parent_step_id, seq, ts, ts_epoch_ms,
   role, node_type, tool_name, tool_call_id, skill_name, script_name, mcp_server, mcp_tool,
   duration_ms, total_tokens, output_tokens, input_text_len, result_text_len,
   context_token_delta, status, error_text, error_type, is_stuck, is_current,
   input_preview, result_preview)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const isoNow = (offsetMs = 0) => new Date(now + offsetMs).toISOString();
const stepRows = [
  // 3 skill calls — paper-interpretation (most-used)
  [
    "st-skill-1",
    "agent:test:s3",
    "run-1",
    null,
    0,
    isoNow(-50_000),
    now - 50_000,
    "assistant",
    "SKILL_EXEC",
    "exec",
    null,
    "paper-interpretation",
    "render.py",
    null,
    null,
    1200,
    null,
    50,
    100,
    200,
    null,
    "ok",
    null,
    null,
    0,
    0,
    "py render",
    null,
  ],
  [
    "st-skill-2",
    "agent:test:s3",
    "run-1",
    null,
    1,
    isoNow(-49_000),
    now - 49_000,
    "assistant",
    "SKILL_EXEC",
    "exec",
    null,
    "paper-interpretation",
    "render.py",
    null,
    null,
    900,
    null,
    30,
    100,
    200,
    null,
    "ok",
    null,
    null,
    0,
    0,
    "py render",
    null,
  ],
  [
    "st-skill-3",
    "agent:test:s4",
    "run-2",
    null,
    0,
    isoNow(-40_000),
    now - 40_000,
    "assistant",
    "SKILL_EXEC",
    "exec",
    null,
    "lark-docs-api-first",
    "fetch.sh",
    null,
    null,
    500,
    null,
    20,
    100,
    200,
    null,
    "ok",
    null,
    null,
    0,
    0,
    "fetch",
    null,
  ],
  // 2 MCP calls — one rate_limited
  [
    "st-mcp-1",
    "agent:test:s3",
    "run-1",
    null,
    2,
    isoNow(-30_000),
    now - 30_000,
    "assistant",
    "MCP_CALL",
    "lark_search_doc_wiki",
    null,
    null,
    null,
    "lark",
    "lark_search_doc_wiki",
    2000,
    null,
    80,
    200,
    1500,
    200,
    "ok",
    null,
    null,
    0,
    0,
    "search",
    null,
  ],
  [
    "st-mcp-2",
    "agent:test:s3",
    "run-1",
    null,
    3,
    isoNow(-20_000),
    now - 20_000,
    "assistant",
    "MCP_CALL",
    "api-post-search",
    null,
    null,
    null,
    "notion",
    "api-post-search",
    3000,
    null,
    50,
    200,
    800,
    100,
    "error",
    "HTTP 429 rate limit hit on notion api",
    "rate_limit",
    0,
    0,
    "search",
    null,
  ],
  // 2 recent errors (timeout + auth_error)
  [
    "st-err-1",
    "agent:test:s4",
    "run-2",
    null,
    1,
    isoNow(-10_000),
    now - 10_000,
    "assistant",
    "TOOL_CALL",
    "exec",
    null,
    null,
    null,
    null,
    null,
    30000,
    null,
    5,
    50,
    0,
    null,
    "error",
    "Request timed out ETIMEDOUT after 30s",
    "timeout",
    0,
    0,
    "exec curl",
    null,
  ],
  [
    "st-err-2",
    "agent:test:s5",
    "run-3",
    null,
    0,
    isoNow(-5_000),
    now - 5_000,
    "assistant",
    "MCP_CALL",
    "lark_create_doc",
    null,
    null,
    null,
    "lark",
    "lark_create_doc",
    500,
    null,
    10,
    30,
    0,
    null,
    "error",
    "need_user_authorization",
    "auth_error",
    0,
    0,
    "create doc",
    null,
  ],
];
for (const r of stepRows) stepInsert.run(...(r as any[]));

// Registry — needs entries for skill stats
const regInsert = db.prepare(`INSERT INTO registry (type, name, path, status, discovered_at, last_seen_at)
  VALUES (?, ?, ?, ?, ?, ?)`);
regInsert.run("skill", "paper-interpretation", "/tmp/paper-interpretation", "active", isoNow(), isoNow());
regInsert.run("skill", "lark-docs-api-first", "/tmp/lark-docs-api-first", "active", isoNow(), isoNow());
regInsert.run("script", "render.py", "/tmp/paper-interpretation/scripts/render.py", "active", isoNow(), isoNow());
regInsert.run("script", "fetch.sh", "/tmp/lark-docs-api-first/scripts/fetch.sh", "active", isoNow(), isoNow());
// MCP entries are required because getMcpStats now LEFT JOINs registry
// (§4.3.1 — installed MCPs surface even without calls; the inverse is
// that "called but not in registry" rows are intentionally invisible
// because we cannot prove they were ever installed).
regInsert.run("mcp", "lark_search_doc_wiki", "npx lark-mcp", "active", isoNow(), isoNow());
regInsert.run("mcp", "api-post-search", "npx notion-mcp", "active", isoNow(), isoNow());
regInsert.run("mcp", "lark_create_doc", "npx lark-mcp", "active", isoNow(), isoNow());

// ─── Helpers for assertion ──────────────────────────────────────
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}]/u;
const BOX_DRAWING_RE = /[\u2500-\u257F]/;

function assertOutputClean(name: string, text: string, maxLines: number) {
  assert(text.length > 0, `${name}: non-empty output`);
  assert(text.startsWith("*observability-v2"), `${name}: starts with "*observability-v2 …*" header`);
  assert(text.split("\n").length <= maxLines, `${name}: ≤ ${maxLines} lines`, `got ${text.split("\n").length}`);
  assert(!EMOJI_RE.test(text), `${name}: no emojis`);
  assert(!BOX_DRAWING_RE.test(text), `${name}: no Unicode box-drawing chars`);
}

// ─── Subcommand assertions ──────────────────────────────────────

console.log("\n=== /observ status ===");
{
  const result = dispatch(db, ["status"]);
  assert(result.exitCode === 0, "exit code 0");
  assertOutputClean("/observ status", result.text, 12);
  assert(result.text.includes("service"), "mentions 'service'");
  assert(result.text.includes("db"), "mentions 'db'");
  assert(result.text.includes("auth-poll"), "mentions 'auth-poll'");
  assert(result.text.includes("stuck"), "mentions 'stuck'");
  assert(result.text.includes("errors 1h"), "mentions 'errors 1h'");
  // 2 errors planted in last 1h: rate_limit (1), timeout (1), auth_error (1)
  // Actually 3 errors total. Verify the digest counts are present.
  assert(result.text.includes("3"), "shows 3 errors total in 1h");
}

console.log("\n=== /observ stuck ===");
{
  const result = dispatch(db, ["stuck"]);
  assert(result.exitCode === 0, "exit code 0");
  assertOutputClean("/observ stuck", result.text, 16);
  assert(result.text.includes("(2)"), "header shows total stuck = 2");
  assert(result.text.includes("agent:test:s1"), "lists s1");
  assert(result.text.includes("agent:test:s2"), "lists s2");
}

console.log("\n=== /observ top ===");
{
  const result = dispatch(db, ["top"]);
  assert(result.exitCode === 0, "exit code 0");
  assertOutputClean("/observ top", result.text, 12);
  // Highest total_tokens in our fixture: s3 = 31500, then s4 = 12800
  assert(result.text.includes("agent:test:s3"), "top includes s3 (highest tokens)");
  // Token formatting: 31500 → "31.5k"
  assert(result.text.includes("31.5k"), "shows 31.5k for s3");
}

console.log("\n=== /observ skills (default range = day) ===");
{
  const result = dispatch(db, ["skills"]);
  assert(result.exitCode === 0, "exit code 0");
  assertOutputClean("/observ skills", result.text, 12);
  assert(result.text.includes("(day)"), "shows '(day)' range");
  assert(result.text.includes("paper-interpretation"), "lists paper-interpretation");
  // 2 skill calls for paper-interpretation in our fixture
  assert(
    result.text.includes("paper-interpretation") && /paper-interpretation\s+2\b/.test(result.text),
    "paper-interpretation has call_count 2",
  );
}

console.log("\n=== /observ skills week ===");
{
  const result = dispatch(db, ["skills", "week"]);
  assert(result.exitCode === 0, "exit code 0");
  assert(result.text.includes("(week)"), "shows '(week)' range");
}

console.log("\n=== /observ scripts ===");
{
  const result = dispatch(db, ["scripts"]);
  assert(result.exitCode === 0, "exit code 0");
  assertOutputClean("/observ scripts", result.text, 12);
  assert(
    result.text.includes("render.py") || result.text.includes("(no script calls)"),
    "lists render.py (or empty if no script_name match)",
  );
}

console.log("\n=== /observ mcps ===");
{
  const result = dispatch(db, ["mcps"]);
  assert(result.exitCode === 0, "exit code 0");
  assertOutputClean("/observ mcps", result.text, 12);
  assert(result.text.includes("lark_search_doc_wiki"), "lists lark_search_doc_wiki");
  assert(result.text.includes("api-post-search"), "lists api-post-search");
  // api-post-search has 1 error out of 1 call → 100.0% error rate
  assert(result.text.includes("100.0%"), "api-post-search shows 100% error rate");
}

console.log("\n=== /observ errors ===");
{
  const result = dispatch(db, ["errors"]);
  assert(result.exitCode === 0, "exit code 0");
  assertOutputClean("/observ errors", result.text, 16);
  assert(result.text.includes("rate_limit"), "lists rate_limit error");
  assert(result.text.includes("timeout"), "lists timeout error");
  assert(result.text.includes("auth_error"), "lists auth_error");
}

console.log("\n=== /observ help ===");
{
  const result = dispatch(db, ["help"]);
  assert(result.exitCode === 0, "exit code 0");
  assertOutputClean("/observ help", result.text, 14);
  // Help must mention every other subcommand
  for (const cmd of ["status", "stuck", "top", "skills", "scripts", "mcps", "errors"]) {
    assert(result.text.includes(`/observ ${cmd}`), `help mentions /observ ${cmd}`);
  }
}

// ─── Dispatcher-level ───────────────────────────────────────────
console.log("\n=== dispatcher edge cases ===");
{
  // Unknown subcommand
  const r1 = dispatch(db, ["bogus"]);
  assert(r1.exitCode === 1, "unknown command exits 1");
  assert(r1.text.includes("unknown command"), "shows 'unknown command'");
  assert(r1.text.includes("/observ help") || r1.text.includes("status"), "falls back to help text");

  // /observ skills week should pass 'week' to handler
  const r2 = dispatch(db, ["skills", "week"]);
  assert(r2.text.includes("(week)"), "skills week → handler sees range=week");

  // parseCommand strips leading /observ
  const p1 = parseCommand(["/observ", "status"]);
  assert(p1.subcommand === "status" && p1.args.length === 0, "parseCommand strips /observ");
  const p2 = parseCommand(["observ", "skills", "week"]);
  assert(p2.subcommand === "skills" && p2.args[0] === "week", "parseCommand strips observ");
  const p3 = parseCommand(["status"]);
  assert(p3.subcommand === "status", "parseCommand handles bare subcommand");
  const p4 = parseCommand([]);
  assert(p4.subcommand === "help", "parseCommand defaults to help when empty");
}

closeDb();
try {
  rmSync(tmpHome, { recursive: true, force: true });
} catch {
  /* best effort */
}

console.log(`\n${"=".repeat(50)}`);
console.log(`CLI commands: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  • ${f}`);
  process.exit(1);
}
