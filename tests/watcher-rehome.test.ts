/**
 * Targeted tests for transcript-watcher sessionIdToKeyMap TTL refresh
 * and raw-UUID re-homing logic.
 *
 * Background: subagents spawned after obs-v2 startup were invisible because
 * the session-id → session-key map was built once and never refreshed.
 * Steps ended up stored under a raw UUID session_key. The fix added:
 *   - 30s TTL on sessionIdToKeyMap (rebuilds from sessions.json)
 *   - Raw UUID detection in processFile (re-resolves + migrates steps)
 *
 * These tests exercise the fix in isolation using a temp OPENCLAW_HOME.
 *
 * Run:
 *   node --experimental-sqlite --experimental-strip-types --no-warnings \
 *     tests/watcher-rehome.test.ts
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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

// ─── Isolated OPENCLAW_HOME ────────────────────────────────────
const tmpHome = mkdtempSync(join(tmpdir(), "obs-watcher-rehome-"));
mkdirSync(join(tmpHome, "logs/observability-v2"), { recursive: true });
mkdirSync(join(tmpHome, "agents/main/sessions"), { recursive: true });
mkdirSync(join(tmpHome, "agents/researcher/sessions"), { recursive: true });
process.env.OPENCLAW_HOME = tmpHome;

// Import obs-v2 modules after setting OPENCLAW_HOME
const { parseTranscript } = await import("../src/ingest/transcript-parser.ts");
const { upsertSteps } = await import("../src/storage/steps-repo.ts");
const { getDb, closeDb } = await import("../src/storage/db.ts");
const { isCanonicalTranscriptFile } = await import("../src/ingest/transcript-files.ts");
const watcher = await import("../src/ingest/transcript-watcher.ts");
const { _resetSessionIdMapForTest } = watcher;

// ─── Test constants ────────────────────────────────────────────
const SUBAGENT_SESSION_ID = "b1f2c2fc-3e87-4b23-8347-04c121d2f83b";
const PROPER_SESSION_KEY = "agent:researcher:subagent:36e648ee-1005-4fed-a43c-f57433975001";

// Minimal synthetic transcript: 1 user msg → 1 assistant msg with a read tool call + result + reply.
// Each call gets a unique prefix so step_ids don't collide across test groups
// (ON CONFLICT(step_id) DO UPDATE doesn't update session_key).
let transcriptSeq = 0;
function buildSyntheticTranscript(): string {
  const p = `g${++transcriptSeq}`;  // unique prefix per call
  const entries = [
    {
      type: "message", id: `u-${p}-1`, parentId: "", timestamp: "2026-04-12T12:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "test query" }] },
    },
    {
      type: "message", id: `a-${p}-1`, parentId: `u-${p}-1`, timestamp: "2026-04-12T12:00:02.000Z",
      message: {
        role: "assistant",
        content: [{ type: "thinking" }, { type: "toolCall", name: "read", id: `tc-${p}-1`, arguments: { file_path: "/tmp/x.txt" } }],
        usage: { input: 500, output: 40, totalTokens: 540 },
      },
    },
    {
      type: "message", id: `r-${p}-1`, parentId: `a-${p}-1`, timestamp: "2026-04-12T12:00:04.000Z",
      message: { role: "toolResult", content: [{ type: "text", text: "file contents here" }] },
    },
    {
      type: "message", id: `a-${p}-2`, parentId: `r-${p}-1`, timestamp: "2026-04-12T12:00:06.000Z",
      message: {
        role: "assistant",
        content: [{ type: "thinking" }, { type: "text", text: "done" }],
        usage: { input: 800, output: 30, totalTokens: 830 },
      },
    },
  ];
  return entries.map(e => JSON.stringify(e)).join("\n") + "\n";
}


// ═══════════════════════════════════════════════════════════════
console.log("\n=== Group 1: Raw UUID detection regex ===");
// ═══════════════════════════════════════════════════════════════

{
  assert(isCanonicalTranscriptFile("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl") === true,
    "canonical transcript file accepted");
  assert(isCanonicalTranscriptFile("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.acp-stream.jsonl") === false,
    "ACP stream sidecar skipped");
  assert(isCanonicalTranscriptFile("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.checkpoint.1.jsonl") === false,
    "checkpoint sidecar skipped");
  assert(isCanonicalTranscriptFile("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.trajectory.jsonl") === false,
    "trajectory sidecar skipped");

  // The regex: /^[0-9a-f]{8}-[0-9a-f]{4}-/ without ":"
  const isRawUuid = (key: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(key) && !key.includes(":");

  assert(isRawUuid("b1f2c2fc-3e87-4b23-8347-04c121d2f83b") === true,
    "raw UUID is detected");
  assert(isRawUuid("36e648ee-1005-4fed-a43c-f57433975001") === true,
    "another raw UUID is detected");
  assert(isRawUuid("agent:main:cron:188f5830-305b-42ee-be30-cefd5a848e28") === false,
    "proper session_key with colons is NOT raw UUID");
  assert(isRawUuid("agent:researcher:subagent:36e648ee-1005-4fed") === false,
    "subagent key with colons is NOT raw UUID");
  assert(isRawUuid("") === false,
    "empty string is NOT raw UUID");
  assert(isRawUuid("not-a-uuid-at-all") === false,
    "non-UUID string is NOT raw UUID");
  // Edge case: uppercase hex should NOT match (UUIDs from sessions.json are lowercase)
  assert(isRawUuid("B1F2C2FC-3e87-4b23-8347-04c121d2f83b") === false,
    "uppercase hex prefix does NOT match");
}


// ═══════════════════════════════════════════════════════════════
console.log("\n=== Group 2: resolveSessionKey priority ===");
// ═══════════════════════════════════════════════════════════════

{
  const db = getDb();

  // Write a sessions.json that maps SUBAGENT_SESSION_ID → PROPER_SESSION_KEY
  const sessionsJsonPath = join(tmpHome, "agents/researcher/sessions/sessions.json");
  const sessionsData: Record<string, any> = {};
  sessionsData[PROPER_SESSION_KEY] = { sessionId: SUBAGENT_SESSION_ID };
  writeFileSync(sessionsJsonPath, JSON.stringify(sessionsData));

  // Access the internal module — we test the exported startTranscriptWatcher
  // indirectly, but first verify resolveSessionKey logic via processFile behavior.

  // Case 1: session ID found in sessions.json map → proper key returned
  // We test this indirectly: write a transcript file named by session ID,
  // start the watcher, and verify steps land under the proper key.
  const transcriptPath = join(tmpHome, "agents/researcher/sessions", `${SUBAGENT_SESSION_ID}.jsonl`);
  writeFileSync(transcriptPath, buildSyntheticTranscript());

  // Force map rebuild so it picks up the freshly written sessions.json
  _resetSessionIdMapForTest();

  // Start watcher — the first tick should parse the file and resolve via sessions.json
  const { stop } = watcher.startTranscriptWatcher({
    onRuns: (_key: string, runs: any[]) => {
      for (const run of runs) upsertSteps(run);
    },
  });
  const stepsUnderProperKey = (db.prepare(
    "SELECT COUNT(*) as n FROM steps WHERE session_key = ?"
  ).get(PROPER_SESSION_KEY) as any).n;

  assert(stepsUnderProperKey > 0,
    `steps stored under proper session_key (got ${stepsUnderProperKey})`,
    `expected >0, got ${stepsUnderProperKey}`);

  const stepsUnderRawUuid = (db.prepare(
    "SELECT COUNT(*) as n FROM steps WHERE session_key = ?"
  ).get(SUBAGENT_SESSION_ID) as any).n;

  assert(stepsUnderRawUuid === 0,
    "no steps stored under raw UUID key");

  // Check ingest_state also has the proper key
  const ingestRow = db.prepare(
    "SELECT session_key FROM ingest_state WHERE file_path = ?"
  ).get(transcriptPath) as any;

  assert(ingestRow?.session_key === PROPER_SESSION_KEY,
    "ingest_state has proper session_key",
    `got ${ingestRow?.session_key}`);

  stop();
}


// ═══════════════════════════════════════════════════════════════
console.log("\n=== Group 3: Raw UUID re-homing on map refresh ===");
// ═══════════════════════════════════════════════════════════════

// Simulate: a file was previously ingested with raw UUID key (map was stale),
// then the map is refreshed and the next tick re-homes the steps.

{
  const db = getDb();

  const LATE_SUBAGENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const LATE_PROPER_KEY = "agent:main:subagent:ffffffff-1111-2222-3333-444444444444";

  // Write a transcript file for the "late" subagent
  const latePath = join(tmpHome, "agents/main/sessions", `${LATE_SUBAGENT_ID}.jsonl`);
  writeFileSync(latePath, buildSyntheticTranscript());

  // Step 1: Start watcher WITHOUT the late subagent in sessions.json.
  // The map won't have this session ID, so it falls back to raw UUID.
  const mainSessionsPath = join(tmpHome, "agents/main/sessions/sessions.json");
  writeFileSync(mainSessionsPath, JSON.stringify({}));

  // Force map rebuild with empty sessions.json
  _resetSessionIdMapForTest();

  const { stop: stop1 } = watcher.startTranscriptWatcher({
    onRuns: (_key: string, runs: any[]) => {
      for (const run of runs) upsertSteps(run);
    },
  });

  // After first tick: steps should be under the raw UUID (fallback)
  const stepsRawBefore = (db.prepare(
    "SELECT COUNT(*) as n FROM steps WHERE session_key = ?"
  ).get(LATE_SUBAGENT_ID) as any).n;

  assert(stepsRawBefore > 0,
    `steps initially under raw UUID fallback (got ${stepsRawBefore})`);

  // The ingest_state should have the raw UUID as session_key
  const ingestBefore = db.prepare(
    "SELECT session_key FROM ingest_state WHERE file_path = ?"
  ).get(latePath) as any;
  assert(ingestBefore?.session_key === LATE_SUBAGENT_ID,
    "ingest_state initially has raw UUID",
    `got ${ingestBefore?.session_key}`);

  stop1();

  // Step 2: Now update sessions.json to include the late subagent mapping
  const updatedSessions: Record<string, any> = {};
  updatedSessions[LATE_PROPER_KEY] = { sessionId: LATE_SUBAGENT_ID };
  writeFileSync(mainSessionsPath, JSON.stringify(updatedSessions));

  // Append a byte to the transcript so the size cache detects a change
  writeFileSync(latePath, readFileSync(latePath, "utf-8") + "\n");

  // Force map rebuild to pick up the updated sessions.json
  _resetSessionIdMapForTest();

  // Start a new watcher — the tick should re-resolve and migrate
  const { stop: stop2 } = watcher.startTranscriptWatcher({
    onRuns: (_key: string, runs: any[]) => {
      for (const run of runs) upsertSteps(run);
    },
  });

  // After re-resolution: steps should be migrated to proper key
  const stepsProperAfter = (db.prepare(
    "SELECT COUNT(*) as n FROM steps WHERE session_key = ?"
  ).get(LATE_PROPER_KEY) as any).n;

  assert(stepsProperAfter > 0,
    `steps re-homed to proper key after map refresh (got ${stepsProperAfter})`);

  const stepsRawAfter = (db.prepare(
    "SELECT COUNT(*) as n FROM steps WHERE session_key = ?"
  ).get(LATE_SUBAGENT_ID) as any).n;

  assert(stepsRawAfter === 0,
    "no steps remain under raw UUID after re-homing");

  // Ingest state should be updated too
  const ingestAfter = db.prepare(
    "SELECT session_key FROM ingest_state WHERE file_path = ?"
  ).get(latePath) as any;

  assert(ingestAfter?.session_key === LATE_PROPER_KEY,
    "ingest_state updated to proper key",
    `got ${ingestAfter?.session_key}`);

  stop2();
}


// ═══════════════════════════════════════════════════════════════
console.log("\n=== Group 4: Proper key is NOT re-resolved ===");
// ═══════════════════════════════════════════════════════════════

// Once a file has a proper session_key (contains ":"), it should not be
// re-resolved on subsequent ticks even if the map changes.

{
  const db = getDb();

  // The transcript from Group 2 (SUBAGENT_SESSION_ID) already has PROPER_SESSION_KEY.
  // Verify it stays stable even after another watcher tick.

  const transcriptPath = join(tmpHome, "agents/researcher/sessions", `${SUBAGENT_SESSION_ID}.jsonl`);
  // Append a line to trigger reparse
  writeFileSync(transcriptPath, readFileSync(transcriptPath, "utf-8") + "\n");

  const { stop } = watcher.startTranscriptWatcher({
    onRuns: (_key: string, runs: any[]) => {
      for (const run of runs) upsertSteps(run);
    },
  });

  const ingestRow = db.prepare(
    "SELECT session_key FROM ingest_state WHERE file_path = ?"
  ).get(transcriptPath) as any;

  assert(ingestRow?.session_key === PROPER_SESSION_KEY,
    "proper session_key remains stable across ticks",
    `got ${ingestRow?.session_key}`);

  // Steps should still be under the proper key, not duplicated
  const stepCount = (db.prepare(
    "SELECT COUNT(*) as n FROM steps WHERE session_key = ?"
  ).get(PROPER_SESSION_KEY) as any).n;

  assert(stepCount > 0,
    `steps still under proper key (got ${stepCount})`);

  stop();
}


// ═══════════════════════════════════════════════════════════════
console.log("\n=== Group 5: extractSessionIdFromFile strips prefixes ===");
// ═══════════════════════════════════════════════════════════════

{
  // Test the filename → session ID extraction logic.
  // The function strips YYYYMMDD_HHMMSS_ and plain numeric prefixes.

  // We can't import the private function directly, but we can verify
  // behavior through the watcher by creating files with various naming patterns.

  // Pattern 1: plain UUID
  const uuid1 = "deadbeef-1234-5678-9abc-def012345678";
  const path1 = join(tmpHome, "agents/main/sessions", `${uuid1}.jsonl`);
  writeFileSync(path1, buildSyntheticTranscript());

  // Pattern 2: timestamp-prefixed UUID
  const uuid2 = "cafebabe-dead-beef-1234-567890abcdef";
  const path2 = join(tmpHome, "agents/main/sessions", `20260412_120000_${uuid2}.jsonl`);
  writeFileSync(path2, buildSyntheticTranscript());

  // Map both UUIDs to distinct keys
  const mainSessionsPath = join(tmpHome, "agents/main/sessions/sessions.json");
  const existingSessions = JSON.parse(readFileSync(mainSessionsPath, "utf-8"));
  existingSessions[`agent:main:session:${uuid1}`] = { sessionId: uuid1 };
  existingSessions[`agent:main:session:${uuid2}`] = { sessionId: uuid2 };
  writeFileSync(mainSessionsPath, JSON.stringify(existingSessions));

  // Force map rebuild to pick up new entries
  _resetSessionIdMapForTest();

  const db = getDb();
  const { stop } = watcher.startTranscriptWatcher({
    onRuns: (_key: string, runs: any[]) => {
      for (const run of runs) upsertSteps(run);
    },
  });

  // Verify both files resolved to their proper keys
  const ingest1 = db.prepare("SELECT session_key FROM ingest_state WHERE file_path = ?").get(path1) as any;
  assert(ingest1?.session_key === `agent:main:session:${uuid1}`,
    "plain UUID filename resolves correctly",
    `got ${ingest1?.session_key}`);

  const ingest2 = db.prepare("SELECT session_key FROM ingest_state WHERE file_path = ?").get(path2) as any;
  assert(ingest2?.session_key === `agent:main:session:${uuid2}`,
    "timestamp-prefixed UUID filename resolves correctly",
    `got ${ingest2?.session_key}`);

  stop();
}


// ═══════════════════════════════════════════════════════════════
console.log("\n=== Group 6: DB fallback when map has no entry ===");
// ═══════════════════════════════════════════════════════════════

{
  const db = getDb();

  // Insert a session row into the DB (simulating auth-poller having discovered it)
  const DB_ONLY_SESSION_ID = "11111111-2222-3333-4444-555555555555";
  const DB_ONLY_KEY = "agent:main:interactive:99999999-0000-1111-2222-333333333333";

  db.prepare(`
    INSERT OR IGNORE INTO sessions (session_key, session_id, agent_id)
    VALUES (?, ?, ?)
  `).run(DB_ONLY_KEY, DB_ONLY_SESSION_ID, "main");

  // Create a transcript for this session — NOT in any sessions.json
  const dbOnlyPath = join(tmpHome, "agents/main/sessions", `${DB_ONLY_SESSION_ID}.jsonl`);
  writeFileSync(dbOnlyPath, buildSyntheticTranscript());

  // Reset map so this session ID is looked up fresh (not in map → DB fallback)
  _resetSessionIdMapForTest();

  const { stop } = watcher.startTranscriptWatcher({
    onRuns: (_key: string, runs: any[]) => {
      for (const run of runs) upsertSteps(run);
    },
  });

  // Should resolve via DB fallback, not raw UUID
  const ingestRow = db.prepare("SELECT session_key FROM ingest_state WHERE file_path = ?").get(dbOnlyPath) as any;
  assert(ingestRow?.session_key === DB_ONLY_KEY,
    "falls back to DB lookup when map has no entry",
    `got ${ingestRow?.session_key}`);

  const stepsUnderDbKey = (db.prepare(
    "SELECT COUNT(*) as n FROM steps WHERE session_key = ?"
  ).get(DB_ONLY_KEY) as any).n;

  assert(stepsUnderDbKey > 0,
    `steps stored under DB-resolved key (got ${stepsUnderDbKey})`);

  stop();
}


// ═══════════════════════════════════════════════════════════════
console.log("\n=== Group 7: :run:UUID suffix is stripped from map keys ===");
// ═══════════════════════════════════════════════════════════════

{
  const db = getDb();

  // Some sessions.json entries have :run:UUID suffixes that should be stripped
  const RUN_SESSION_ID = "77777777-8888-9999-aaaa-bbbbbbbbbbbb";
  const KEY_WITH_RUN = "agent:main:cron:cccccccc-dddd-eeee-ffff-000000000000:run:11111111-2222-3333-4444-aaaaaaaaaaaa";
  const EXPECTED_BASE_KEY = "agent:main:cron:cccccccc-dddd-eeee-ffff-000000000000";

  // Write sessions.json with the :run: suffix
  const mainSessionsPath = join(tmpHome, "agents/main/sessions/sessions.json");
  const sessions = JSON.parse(readFileSync(mainSessionsPath, "utf-8"));
  sessions[KEY_WITH_RUN] = { sessionId: RUN_SESSION_ID };
  writeFileSync(mainSessionsPath, JSON.stringify(sessions));

  const runPath = join(tmpHome, "agents/main/sessions", `${RUN_SESSION_ID}.jsonl`);
  writeFileSync(runPath, buildSyntheticTranscript());

  // Reset map so it picks up the :run: suffixed entry
  _resetSessionIdMapForTest();

  const { stop } = watcher.startTranscriptWatcher({
    onRuns: (_key: string, runs: any[]) => {
      for (const run of runs) upsertSteps(run);
    },
  });

  const ingestRow = db.prepare("SELECT session_key FROM ingest_state WHERE file_path = ?").get(runPath) as any;
  assert(ingestRow?.session_key === EXPECTED_BASE_KEY,
    ":run:UUID suffix stripped from resolved key",
    `got ${ingestRow?.session_key}`);

  stop();
}


// ─── Cleanup ───────────────────────────────────────────────────
closeDb();
try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best effort */ }

// ─── Summary ───────────────────────────────────────────────────
console.log(`\n${"=".repeat(50)}`);
console.log(`Watcher rehome: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  • ${f}`);
  process.exit(1);
}
