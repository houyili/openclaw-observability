/**
 * Hermetic tests for session_id-scoped detail queries.
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

const tmpHome = mkdtempSync(join(tmpdir(), "obs-session-id-scope-"));
mkdirSync(join(tmpHome, "logs/observability-v2"), { recursive: true });
process.env.OPENCLAW_HOME = tmpHome;

const { getDb, closeDb } = await import("../src/storage/db.ts");
const { getRunList, getTraceSpans, getLatestRun } = await import("../src/storage/steps-repo.ts");

const db = getDb();
const key = "agent:demo:chat:direct:local-same-key";
const sidA = "sid-a-00000000";
const sidB = "sid-b-00000000";
const sidMissing = "sid-missing-0000";
const now = Date.parse("2026-05-23T10:00:00Z");

function insertStep(id: string, sessionId: string, runId: string, offset: number, toolName: string) {
  db.prepare(`INSERT INTO steps
    (step_id, session_key, session_id, run_id, seq, ts, ts_epoch_ms,
     role, node_type, tool_name, status, is_stuck, is_current)
    VALUES (?, ?, ?, ?, 0, ?, ?, 'assistant', 'TOOL_CALL', ?, 'ok', 0, 0)
  `).run(id, key, sessionId, runId, new Date(now + offset).toISOString(), now + offset, toolName);
}

console.log("\n=== Group 1: same session_key, different session_id ===");
insertStep("a-step", sidA, "run-a", 1_000, "read_a");
insertStep("b-step", sidB, "run-b", 2_000, "read_b");

{
  const allRuns = getRunList(key);
  assert(allRuns.length === 2, "session_key scope still sees both runs", `got ${allRuns.length}`);

  const aRuns = getRunList(key, sidA);
  const bRuns = getRunList(key, sidB);
  assert(aRuns.length === 1 && aRuns[0].run_id === "run-a", "sidA scope sees only run-a");
  assert(bRuns.length === 1 && bRuns[0].run_id === "run-b", "sidB scope sees only run-b");

  const aSpans = getTraceSpans(key, undefined, sidA);
  const bSpans = getTraceSpans(key, undefined, sidB);
  assert(aSpans.length === 1 && aSpans[0].tool_name === "read_a", "sidA trace resolves latest run inside sidA only");
  assert(bSpans.length === 1 && bSpans[0].tool_name === "read_b", "sidB trace resolves latest run inside sidB only");

  const latestA = getLatestRun(key, sidA);
  const latestB = getLatestRun(key, sidB);
  assert(latestA?.run_id === "run-a", "getLatestRun sidA returns run-a");
  assert(latestB?.run_id === "run-b", "getLatestRun sidB returns run-b");
}

console.log("\n=== Group 2: session_id scope does not fall back to key history ===");
db.prepare(`INSERT INTO steps
  (step_id, session_key, session_id, run_id, seq, ts, ts_epoch_ms,
   role, node_type, tool_name, status, is_stuck, is_current)
  VALUES ('legacy-step', ?, NULL, 'run-legacy', 0, ?, ?, 'assistant', 'TOOL_CALL', 'legacy_read', 'ok', 0, 0)
`).run(key, new Date(now + 3_000).toISOString(), now + 3_000);

{
  const missingRuns = getRunList(key, sidMissing);
  assert(missingRuns.length === 0, "missing session_id returns no runs instead of key-level history", `got ${missingRuns.length}`);

  const missingLatest = getLatestRun(key, sidMissing);
  assert(missingLatest === null, "missing session_id latest run is null");

  const missingTrace = getTraceSpans(key, undefined, sidMissing);
  assert(missingTrace.length === 0, "missing session_id trace is empty instead of latest key-level run", `got ${missingTrace.length}`);

  const legacyViaMissing = getTraceSpans(key, "run-legacy", sidMissing);
  assert(legacyViaMissing.length === 0, "explicit runId still respects session_id boundary", `got ${legacyViaMissing.length}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
closeDb();
rmSync(tmpHome, { recursive: true, force: true });
if (failed) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
