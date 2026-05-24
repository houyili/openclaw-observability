/**
 * Hermetic test for the Prometheus `/metrics` endpoint.
 *
 * Closes G16 in the v0.1.3 polish wave. Exercises `buildMetricsBody()`
 * directly (no HTTP server) under a temp $OPENCLAW_HOME and asserts:
 *
 *   1. Format compliance — trailing \n, paired HELP/TYPE, no CRLF, no NaN/Inf
 *   2. Versioned build_info matches package.json
 *   3. obs_sessions_total emits all 5 canonical states (zero fallback)
 *   4. obs_steps_total emits all 3 canonical statuses (zero fallback)
 *      and obs_steps_stuck_total agrees with WHERE is_stuck = 1
 *   5. obs_registry_entries_total reflects upsertRegistryEntries output
 *   6. Auth-poll fields: with no poll ever made, last_success_seconds = -1,
 *      last_success_age_seconds = -1, failures_total = 0, inflight = 0
 *   7. Determinism — two calls on identical state produce identical bodies
 *
 * Run:
 *   node --experimental-sqlite --experimental-strip-types --no-warnings \
 *     tests/metrics.test.ts
 */

import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

// ─── Hermetic OPENCLAW_HOME ─────────────────────────────────────
const tmpHome = mkdtempSync(join(tmpdir(), "obs-metrics-"));
mkdirSync(join(tmpHome, "logs/observability-v2"), { recursive: true });
process.env.OPENCLAW_HOME = tmpHome;
// Disable auth so /metrics access stays open for the route-level smoke check.
process.env.OBS_AUTH_TOKEN = "";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PKG_VERSION = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf-8")).version as string;

const { getDb, closeDb } = await import("../src/storage/db.ts");
const { buildMetricsBody } = await import("../src/api/routes-metrics.ts");
const { upsertRegistryEntries } = await import("../src/storage/registry-repo.ts");

// ─── 1. Empty DB — format + zero fallback ──────────────────────
console.log("\n=== 1. format + zero fallback (empty DB) ===");
const empty = buildMetricsBody();

assert(empty.endsWith("\n"), "body has a trailing newline");
assert(!empty.endsWith("\n\n"), "body has exactly one trailing newline");
assert(!empty.includes("\r"), "no CRLF line endings present");
assert(!/\bNaN\b/i.test(empty), "no NaN literal in body");
assert(!/\bInfinity\b/i.test(empty), "no Infinity literal in body");

// HELP/TYPE pairing — every metric name appearing as `# HELP <name>` must also
// appear as `# TYPE <name>` exactly once.
const helpNames = new Set(Array.from(empty.matchAll(/^# HELP (\S+)/gm), (m) => m[1]));
const typeNames = new Set(Array.from(empty.matchAll(/^# TYPE (\S+)/gm), (m) => m[1]));
assert(helpNames.size > 0, "at least one HELP line present");
assert(helpNames.size === typeNames.size, "HELP and TYPE counts match");
let pairingOk = true;
for (const n of helpNames) {
  if (!typeNames.has(n)) {
    pairingOk = false;
    break;
  }
}
assert(pairingOk, "every HELP has a matching TYPE", `helpNames=${[...helpNames].join(",")}`);

// All expected metric names present.
const expectedMetrics = [
  "obs_build_info",
  "obs_sessions_total",
  "obs_steps_total",
  "obs_steps_stuck_total",
  "obs_registry_entries_total",
  "obs_auth_poll_last_success_seconds",
  "obs_auth_poll_last_success_age_seconds",
  "obs_auth_poll_failures_total",
  "obs_auth_poll_inflight",
];
for (const name of expectedMetrics) {
  assert(helpNames.has(name), `HELP block present for ${name}`);
}

// ─── 2. obs_build_info {version} matches package.json ───────────
console.log("\n=== 2. obs_build_info matches package.json version ===");
const buildInfoMatches = empty.match(/^obs_build_info\{version="([^"]+)"\} 1$/gm);
assert(Array.isArray(buildInfoMatches) && buildInfoMatches.length === 1, "obs_build_info appears exactly once");
const versionLabel = empty.match(/^obs_build_info\{version="([^"]+)"\} 1$/m)?.[1];
assert(versionLabel === PKG_VERSION, `version label = package.json version (${PKG_VERSION})`, `got: ${versionLabel}`);

// ─── 3. obs_sessions_total — five canonical states with 0 fallback ──
console.log("\n=== 3. sessions states (zero fallback when DB empty) ===");
for (const state of ["processing", "waiting", "idle", "stuck", "unknown"]) {
  const re = new RegExp(`^obs_sessions_total\\{state="${state}"\\} 0$`, "m");
  assert(re.test(empty), `obs_sessions_total{state="${state}"} = 0 with empty DB`);
}

// Insert 2 stuck + 1 idle + 1 NULL (→unknown) session
const db = getDb();
const insertSession = db.prepare(`INSERT INTO sessions
  (session_key, session_id, agent_id, channel, diag, label, kind,
   model, model_provider, input_tokens, output_tokens, total_tokens, context_tokens, runtime_mode,
   llm_call_count, tool_call_count, skill_call_count, mcp_call_count,
   diag_state, current_op, blocker, last_block_ts, updated_at, age_ms, source)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const baseRow = (key: string, sid: string, state: string | null) => [
  key,
  sid,
  "main",
  "chat-direct",
  "user:demo",
  null,
  "direct",
  "gpt-5",
  "modelhub",
  100,
  10,
  110,
  500,
  "default",
  0,
  0,
  0,
  0,
  state,
  null,
  null,
  null,
  Date.now(),
  0,
  "transcript+auth",
];
insertSession.run(...(baseRow("agent:m:s1", "sid-1", "stuck") as any[]));
insertSession.run(...(baseRow("agent:m:s2", "sid-2", "stuck") as any[]));
insertSession.run(...(baseRow("agent:m:s3", "sid-3", "idle") as any[]));
insertSession.run(...(baseRow("agent:m:s4", "sid-4", null) as any[]));

const afterSess = buildMetricsBody();
assert(/^obs_sessions_total\{state="stuck"\} 2$/m.test(afterSess), "stuck session count = 2 after insert");
assert(/^obs_sessions_total\{state="idle"\} 1$/m.test(afterSess), "idle session count = 1 after insert");
assert(/^obs_sessions_total\{state="unknown"\} 1$/m.test(afterSess), "NULL diag_state rolls into unknown = 1");
assert(/^obs_sessions_total\{state="processing"\} 0$/m.test(afterSess), "processing still emits 0 (zero fallback)");

// ─── 4. obs_steps_total + obs_steps_stuck_total ────────────────
console.log("\n=== 4. steps statuses + stuck count ===");
for (const status of ["ok", "error", "running"]) {
  const re = new RegExp(`^obs_steps_total\\{status="${status}"\\} 0$`, "m");
  assert(re.test(empty), `obs_steps_total{status="${status}"} = 0 with empty DB`);
}
assert(/^obs_steps_stuck_total 0$/m.test(empty), "obs_steps_stuck_total = 0 with empty DB");

const insertStep = db.prepare(`INSERT INTO steps
  (step_id, session_key, run_id, parent_step_id, seq, ts, ts_epoch_ms,
   role, node_type, tool_name, status, is_stuck)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const now = Date.now();
const isoNow = new Date(now).toISOString();
insertStep.run("st-1", "agent:m:s1", "r1", null, 0, isoNow, now, "assistant", "TOOL_CALL", "exec", "ok", 0);
insertStep.run("st-2", "agent:m:s1", "r1", null, 1, isoNow, now, "assistant", "TOOL_CALL", "exec", "ok", 0);
insertStep.run("st-3", "agent:m:s1", "r1", null, 2, isoNow, now, "assistant", "TOOL_CALL", "exec", "ok", 1);
insertStep.run("st-4", "agent:m:s1", "r1", null, 3, isoNow, now, "assistant", "TOOL_CALL", "exec", "error", 0);

const afterSteps = buildMetricsBody();
assert(/^obs_steps_total\{status="ok"\} 3$/m.test(afterSteps), "ok step count = 3");
assert(/^obs_steps_total\{status="error"\} 1$/m.test(afterSteps), "error step count = 1");
assert(/^obs_steps_total\{status="running"\} 0$/m.test(afterSteps), "running fallback still emits 0");

const stuckRow = db.prepare("SELECT COUNT(*) AS c FROM steps WHERE is_stuck = 1").get() as { c: number };
const stuckMatch = afterSteps.match(/^obs_steps_stuck_total (\d+)$/m);
assert(
  stuckMatch != null && Number(stuckMatch[1]) === Number(stuckRow.c),
  `obs_steps_stuck_total matches SQL is_stuck count (${stuckRow.c})`,
);

// ─── 5. obs_registry_entries_total ─────────────────────────────
console.log("\n=== 5. registry entries (driven by upsertRegistryEntries) ===");
upsertRegistryEntries([
  { type: "mcp", name: "exa", path: "https://example.test", discoveredAt: isoNow },
  { type: "mcp", name: "notion", path: "npx", discoveredAt: isoNow },
  { type: "skill", name: "demo-skill", path: "/tmp/demo-skill", discoveredAt: isoNow },
  { type: "script", name: "demo.sh", path: "/tmp/demo.sh", discoveredAt: isoNow },
] as any);

const afterReg = buildMetricsBody();
assert(
  /^obs_registry_entries_total\{type="mcp",status="active"\} 2$/m.test(afterReg),
  "registry counts mcp/active = 2",
);
assert(
  /^obs_registry_entries_total\{type="skill",status="active"\} 1$/m.test(afterReg),
  "registry counts skill/active = 1",
);
assert(
  /^obs_registry_entries_total\{type="script",status="active"\} 1$/m.test(afterReg),
  "registry counts script/active = 1",
);
// Phantom-zero check: the body should NOT contain registry rows for combos
// that don't exist (e.g. mcp/removed when nothing has ever been removed).
assert(
  !/obs_registry_entries_total\{type="mcp",status="removed"\}/.test(afterReg),
  "no phantom zero row for mcp/removed when registry has never seen it",
);

// ─── 6. Auth-poll metrics — no poll ever called ────────────────
console.log("\n=== 6. auth-poll metrics with no poll ever performed ===");
// The test never calls pollAuthSessionsAsync, so lastSuccessAt is null.
// Sentinel choice (documented here for grep-ability): -1 means "never seen".
assert(/^obs_auth_poll_last_success_seconds -1$/m.test(empty), 'last_success_seconds = -1 sentinel ("never seen")');
assert(
  /^obs_auth_poll_last_success_age_seconds -1$/m.test(empty),
  'last_success_age_seconds = -1 sentinel ("never seen")',
);
assert(/^obs_auth_poll_failures_total 0$/m.test(empty), "failures_total starts at 0");
assert(/^obs_auth_poll_inflight 0$/m.test(empty), "inflight = 0 with no poll");

// ─── 7. Determinism / idempotency ──────────────────────────────
console.log("\n=== 7. determinism on identical DB state ===");
// Two consecutive calls on the same DB state should produce byte-identical
// bodies for everything except the auth-poll *age* line, which depends on
// Date.now(). Since lastSuccessAt is still null here the sentinel is constant
// across calls, so the whole body must be byte-equal.
const a = buildMetricsBody();
const b = buildMetricsBody();
assert(a === b, "buildMetricsBody() is deterministic when lastSuccessAt is null");

closeDb();

console.log(`\nMetrics endpoint: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
