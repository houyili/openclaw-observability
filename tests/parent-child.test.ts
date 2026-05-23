/**
 * Tests for the parent-child session relationship feature (Round 7).
 *
 * Validates:
 *   1. Schema migration: parent_session_key column + index
 *   2. updateSessionParent: sets parent, idempotent (only sets when NULL)
 *   3. getChildCounts: correct counts, 0 for no children
 *   4. getChildSessions: returns correct children in order
 *   5. readSessionStoreExtras: extracts spawnedBy from sessions.json
 *   6. Chain relationship: A → B → C (parent and child simultaneously)
 *   7. API response shape: parentSessionKey + childCount present
 *
 * Run:
 *   node --experimental-sqlite --experimental-strip-types --no-warnings \
 *     tests/parent-child.test.ts
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function assert(cond: boolean, name: string, detail?: string) {
  if (cond) { passed++; console.log(`  \u2705 ${name}`); }
  else {
    failed++;
    console.log(`  \u274c ${name}${detail ? ` \u2014 ${detail}` : ""}`);
    failures.push(name);
  }
}

// ─── Isolated OPENCLAW_HOME ────────────────────────────────────
const tmpHome = mkdtempSync(join(tmpdir(), "obs-parent-child-"));
mkdirSync(join(tmpHome, "logs/observability-v2"), { recursive: true });
mkdirSync(join(tmpHome, "agents/demo/sessions"), { recursive: true });
mkdirSync(join(tmpHome, "agents/main/sessions"), { recursive: true });
process.env.OPENCLAW_HOME = tmpHome;

const { getDb, closeDb } = await import("../src/storage/db.ts");
const {
  updateSessionParent,
  getChildCounts,
  getChildSessions,
  getParentInfoBatch,
  getAllSessions,
} = await import("../src/storage/sessions-repo.ts");
const { readSessionStoreExtras } = await import("../src/ingest/auth-poller.ts");

const db = getDb();
const now = Date.now();

// Helper: insert a session row
function insertSession(key: string, sid: string, opts: {
  agentId?: string; channel?: string;
  parentSessionKey?: string; parentSessionId?: string;
  updatedAt?: number;
} = {}) {
  db.prepare(`INSERT INTO sessions
    (session_key, session_id, agent_id, channel, diag, kind, model,
     input_tokens, output_tokens, total_tokens, context_tokens,
     updated_at, age_ms, source, parent_session_key, parent_session_id)
    VALUES (?, ?, ?, ?, 'test', 'direct', 'gpt-5',
     0, 0, 0, 0, ?, 0, 'auth-only', ?, ?)
  `).run(
    key, sid,
    opts.agentId ?? "test",
    opts.channel ?? "subagent",
    opts.updatedAt ?? now,
    opts.parentSessionKey ?? null,
    opts.parentSessionId ?? null,
  );
}

// ================================================================
console.log("\n=== Group 1: Schema migration ===");
// ================================================================
{
  // parent_session_key column should exist
  const cols = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
  assert(
    cols.some(c => c.name === "parent_session_key"),
    "parent_session_key column exists in sessions table",
  );

  // Index should exist
  const indexes = db.prepare("PRAGMA index_list(sessions)").all() as Array<{ name: string }>;
  assert(
    indexes.some(idx => idx.name === "idx_sessions_parent"),
    "idx_sessions_parent index exists",
  );

  // Column is nullable (can insert without it)
  db.prepare(`INSERT INTO sessions
    (session_key, session_id, agent_id, channel, diag, kind, model,
     input_tokens, output_tokens, total_tokens, context_tokens,
     updated_at, age_ms, source)
    VALUES ('test:nullable', 'sid-n', 'test', 'direct', 't', 'direct', 'gpt-5',
     0, 0, 0, 0, ?, 0, 'auth-only')
  `).run(now);
  const row = db.prepare("SELECT parent_session_key FROM sessions WHERE session_key = 'test:nullable'").get() as any;
  assert(row.parent_session_key === null, "parent_session_key defaults to NULL");

  // Cleanup
  db.prepare("DELETE FROM sessions WHERE session_key = 'test:nullable'").run();
}

// ================================================================
console.log("\n=== Group 2: updateSessionParent ===");
// ================================================================
{
  const parentKey = "agent:demo:chat:direct:local-parent1";
  const childKey = "agent:demo:subagent:child-aaa";
  insertSession(childKey, "sid-c1");
  insertSession(parentKey, "sid-p1", { channel: "chat-direct" });

  // Set parent (with session_id)
  updateSessionParent(childKey, parentKey, "sid-p1");
  const row1 = db.prepare("SELECT parent_session_key, parent_session_id FROM sessions WHERE session_key = ?").get(childKey) as any;
  assert(row1.parent_session_key === parentKey, "updateSessionParent sets parent_session_key correctly");
  assert(row1.parent_session_id === "sid-p1", "updateSessionParent sets parent_session_id correctly");

  // Idempotent: calling again with a DIFFERENT parent should NOT overwrite key
  const otherParent = "agent:main:cron:other-parent";
  updateSessionParent(childKey, otherParent, "sid-other");
  const row2 = db.prepare("SELECT parent_session_key, parent_session_id FROM sessions WHERE session_key = ?").get(childKey) as any;
  assert(
    row2.parent_session_key === parentKey,
    "updateSessionParent does NOT overwrite existing parent key",
    `expected ${parentKey}, got ${row2.parent_session_key}`,
  );

  // Session not in DB: should be a no-op (no error)
  let noError = true;
  try { updateSessionParent("nonexistent:key", parentKey, "sid-p1"); } catch { noError = false; }
  assert(noError, "updateSessionParent on missing session is a no-op (no error)");
}

// ================================================================
console.log("\n=== Group 3: getChildCounts ===");
// ================================================================
{
  // Clear and set up fresh data
  db.prepare("DELETE FROM sessions").run();

  const parent1 = "agent:main:chat:group:parent-g1";
  const parent2 = "agent:main:cron:parent-c1";
  const noChildren = "agent:main:chat:direct:no-kids";

  insertSession(parent1, "sid-p1", { channel: "chat-group" });
  insertSession(parent2, "sid-p2", { channel: "cron" });
  insertSession(noChildren, "sid-nc", { channel: "chat-direct" });

  // 3 children for parent1 (linked by parent_session_id = "sid-p1")
  insertSession("agent:main:subagent:ch1", "sid-ch1", { parentSessionKey: parent1, parentSessionId: "sid-p1" });
  insertSession("agent:main:subagent:ch2", "sid-ch2", { parentSessionKey: parent1, parentSessionId: "sid-p1" });
  insertSession("agent:main:subagent:ch3", "sid-ch3", { parentSessionKey: parent1, parentSessionId: "sid-p1" });

  // 1 child for parent2 (linked by parent_session_id = "sid-p2")
  insertSession("agent:main:subagent:ch4", "sid-ch4", { parentSessionKey: parent2, parentSessionId: "sid-p2" });

  // getChildCounts now takes session_ids, not session_keys
  const counts = getChildCounts(["sid-p1", "sid-p2", "sid-nc"]);
  assert(counts.get("sid-p1") === 3, "parent1 (sid-p1) has 3 children", `got ${counts.get("sid-p1")}`);
  assert(counts.get("sid-p2") === 1, "parent2 (sid-p2) has 1 child", `got ${counts.get("sid-p2")}`);
  assert(!counts.has("sid-nc") || counts.get("sid-nc") === 0, "noChildren has 0 children");

  // Empty input
  const emptyResult = getChildCounts([]);
  assert(emptyResult.size === 0, "getChildCounts([]) returns empty map");
}

// ================================================================
console.log("\n=== Group 4: getChildSessions ===");
// ================================================================
{
  // Use parent1 from Group 3 (still in DB) — query by session_id
  const children = getChildSessions("sid-p1");
  assert(children.length === 3, "getChildSessions returns 3 children", `got ${children.length}`);

  // All children should have correct parent session_id
  const allCorrectParent = children.every(c => c.parent_session_id === "sid-p1");
  assert(allCorrectParent, "all children point to correct parent session_id");

  // Children are ordered by updated_at DESC
  const times = children.map(c => c.updated_at);
  const isSorted = times.every((t, i) => i === 0 || t <= times[i - 1]);
  assert(isSorted, "children ordered by updated_at DESC");

  // No children for non-parent session_id
  const none = getChildSessions("nonexistent-sid");
  assert(none.length === 0, "getChildSessions for non-parent returns empty array");
}

// ================================================================
console.log("\n=== Group 5: readSessionStoreExtras extracts spawnedBy ===");
// ================================================================
{
  // Write a fake sessions.json for demo agent
  const sessionsJson = {
    "agent:demo:subagent:sub-x1": {
      sessionId: "sid-x1",
      label: "research sub 1",
      spawnedBy: "agent:demo:chat:group:oc_fakechat1",
    },
    "agent:demo:chat:group:oc_fakechat1": {
      sessionId: "sid-gc1",
      label: "main chat group",
      // no spawnedBy — top-level session
    },
    "agent:demo:subagent:sub-x2": {
      sessionId: "sid-x2",
      // no label, has spawnedBy
      spawnedBy: "agent:demo:chat:group:oc_fakechat1",
    },
  };
  writeFileSync(
    join(tmpHome, "agents/demo/sessions/sessions.json"),
    JSON.stringify(sessionsJson),
  );
  // Write empty for main agent
  writeFileSync(
    join(tmpHome, "agents/main/sessions/sessions.json"),
    JSON.stringify({}),
  );

  const extras = readSessionStoreExtras();

  // sub-x1: has both label and spawnedBy → parentSessionId resolved from parent's sessionId
  const ex1 = extras.get("agent:demo:subagent:sub-x1");
  assert(ex1 !== undefined, "sub-x1 found in extras");
  assert(ex1?.label === "research sub 1", "sub-x1 label correct");
  assert(ex1?.sessionId === "sid-x1", "sub-x1 own sessionId extracted");
  assert(
    ex1?.parentSessionKey === "agent:demo:chat:group:oc_fakechat1",
    "sub-x1 spawnedBy (key) extracted correctly",
  );
  assert(
    ex1?.parentSessionId === "sid-gc1",
    "sub-x1 parentSessionId resolved from parent entry",
    `got ${ex1?.parentSessionId}`,
  );

  // top-level session: no spawnedBy
  const ex2 = extras.get("agent:demo:chat:group:oc_fakechat1");
  assert(ex2 !== undefined, "group session found in extras");
  assert(ex2?.parentSessionKey === null, "group session has no parent key");
  assert(ex2?.parentSessionId === null, "group session has no parent session_id");

  // sub-x2: no label, has spawnedBy → parentSessionId also resolved
  const ex3 = extras.get("agent:demo:subagent:sub-x2");
  assert(ex3?.label === null, "sub-x2 label is null");
  assert(ex3?.parentSessionId === "sid-gc1", "sub-x2 parentSessionId resolved");
}

// ================================================================
console.log("\n=== Group 6: Chain relationship A -> B -> C ===");
// ================================================================
{
  db.prepare("DELETE FROM sessions").run();

  const a = "agent:main:chat:group:chain-root";
  const b = "agent:main:subagent:chain-mid";
  const c = "agent:main:subagent:chain-leaf";

  insertSession(a, "sid-a", { channel: "chat-group" });
  insertSession(b, "sid-b", { parentSessionKey: a, parentSessionId: "sid-a" });
  insertSession(c, "sid-c", { parentSessionKey: b, parentSessionId: "sid-b" });

  // A has 1 child (B), B has 1 child (C), C has 0 — queried by session_id
  const counts = getChildCounts(["sid-a", "sid-b", "sid-c"]);
  assert(counts.get("sid-a") === 1, "chain: A has 1 direct child", `got ${counts.get("sid-a")}`);
  assert(counts.get("sid-b") === 1, "chain: B has 1 direct child", `got ${counts.get("sid-b")}`);
  assert(!counts.has("sid-c") || counts.get("sid-c") === 0, "chain: C has 0 children");

  // B is simultaneously a child and a parent
  const bRow = db.prepare("SELECT parent_session_id FROM sessions WHERE session_key = ?").get(b) as any;
  assert(bRow.parent_session_id === "sid-a", "chain: B's parent is A (by session_id)");
  const bChildren = getChildSessions("sid-b");
  assert(bChildren.length === 1 && bChildren[0].session_key === c, "chain: B's child is C");
}

// ================================================================
console.log("\n=== Group 7: cron :run:UUID parent matching ===");
// ================================================================
{
  db.prepare("DELETE FROM sessions").run();

  // Cron base session and a :run: variant
  const cronBase = "agent:main:cron:cron-uuid-1";
  const cronRun = "agent:main:cron:cron-uuid-1:run:run-uuid-1";
  insertSession(cronBase, "sid-cb", { channel: "cron" });
  insertSession(cronRun, "sid-cr", { channel: "cron" });

  // Sub spawned by the cron base session (linked by parent_session_id)
  insertSession("agent:main:subagent:cron-sub-1", "sid-cs1", { parentSessionKey: cronBase, parentSessionId: "sid-cb" });

  // getChildCounts by session_id
  const counts = getChildCounts(["sid-cb", "sid-cr"]);
  assert(counts.get("sid-cb") === 1, "cron base session has 1 child", `got ${counts.get("sid-cb")}`);
  assert(!counts.has("sid-cr") || counts.get("sid-cr") === 0, "cron :run: session has 0 children");
}

// ================================================================
console.log("\n=== Group 8: updateSessionParent only writes when NULL ===");
// ================================================================
{
  db.prepare("DELETE FROM sessions").run();

  const key = "agent:test:subagent:guard-test";
  const parent1 = "agent:test:parent:first";
  const parent2 = "agent:test:parent:second";

  // Insert with no parent
  insertSession(key, "sid-g1");

  // First write succeeds
  updateSessionParent(key, parent1, "sid-parent1");
  let row = db.prepare("SELECT parent_session_key, parent_session_id FROM sessions WHERE session_key = ?").get(key) as any;
  assert(row.parent_session_key === parent1, "guard: first write sets parent key");
  assert(row.parent_session_id === "sid-parent1", "guard: first write sets parent session_id");

  // Second write with different parent is a no-op (key already set)
  updateSessionParent(key, parent2, "sid-parent2");
  row = db.prepare("SELECT parent_session_key, parent_session_id FROM sessions WHERE session_key = ?").get(key) as any;
  assert(row.parent_session_key === parent1, "guard: second write does NOT change parent key");

  // Force-clear parent via raw SQL, then write again
  db.prepare("UPDATE sessions SET parent_session_key = NULL, parent_session_id = NULL WHERE session_key = ?").run(key);
  updateSessionParent(key, parent2, "sid-parent2");
  row = db.prepare("SELECT parent_session_key, parent_session_id FROM sessions WHERE session_key = ?").get(key) as any;
  assert(row.parent_session_key === parent2, "guard: write succeeds after clearing to NULL");
  assert(row.parent_session_id === "sid-parent2", "guard: session_id also set after clear");
}

// ================================================================
console.log("\n=== Group 9: getParentInfoBatch ===");
// ================================================================
{
  db.prepare("DELETE FROM sessions").run();

  const parent1 = "agent:main:chat:group:info-parent1";
  const parent2 = "agent:demo:cron:info-parent2";
  insertSession(parent1, "sid-ip1", { channel: "chat-group", agentId: "main" });
  // Set label on parent1
  db.prepare("UPDATE sessions SET label = 'My Research Group', diag = 'group:oc_abc123' WHERE session_key = ?").run(parent1);

  insertSession(parent2, "sid-ip2", { channel: "cron", agentId: "demo" });
  db.prepare("UPDATE sessions SET diag = 'cron:deadbeef' WHERE session_key = ?").run(parent2);

  // getParentInfoBatch now takes session_ids
  const info = getParentInfoBatch(["sid-ip1", "sid-ip2", "nonexistent-sid"]);

  assert(info.size === 2, "getParentInfoBatch returns 2 results (ignores nonexistent)");

  const p1 = info.get("sid-ip1");
  assert(p1?.label === "My Research Group", "parent1 label is correct");
  assert(p1?.diag === "group:oc_abc123", "parent1 diag is correct");
  assert(p1?.agentId === "main", "parent1 agentId is correct");

  const p2 = info.get("sid-ip2");
  assert(p2?.label === null, "parent2 label is null (not set)");
  assert(p2?.diag === "cron:deadbeef", "parent2 diag is correct");
  assert(p2?.agentId === "demo", "parent2 agentId is correct");

  // Empty input
  const empty = getParentInfoBatch([]);
  assert(empty.size === 0, "getParentInfoBatch([]) returns empty map");
}

// ================================================================
console.log("\n=== Group 10: getAllSessions with parentKey filter ===");
// ================================================================
{
  db.prepare("DELETE FROM sessions").run();

  const parent = "agent:main:chat:group:filter-parent";
  insertSession(parent, "sid-fp", { channel: "chat-group", agentId: "main" });
  insertSession("agent:main:subagent:filter-c1", "sid-fc1", { parentSessionKey: parent, agentId: "main" });
  insertSession("agent:main:subagent:filter-c2", "sid-fc2", { parentSessionKey: parent, agentId: "main" });
  insertSession("agent:main:subagent:other-child", "sid-oc", {
    parentSessionKey: "agent:main:cron:other-parent", agentId: "main",
  });

  // Filter by parentKey
  const result = getAllSessions({ parentKey: parent });
  assert(result.total === 2, "parentKey filter returns 2 children", `got ${result.total}`);
  assert(
    result.sessions.every(s => s.parent_session_key === parent),
    "all filtered sessions have correct parent",
  );

  // parentKey filter combined with other filters
  const result2 = getAllSessions({ parentKey: "nonexistent:parent" });
  assert(result2.total === 0, "parentKey filter with no matches returns 0");

  // No parentKey filter — returns all
  const resultAll = getAllSessions({});
  assert(resultAll.total === 4, "no parentKey filter returns all 4 sessions", `got ${resultAll.total}`);
}

// ================================================================
// Cleanup & summary
// ================================================================
closeDb();
try { rmSync(tmpHome, { recursive: true }); } catch { /* best-effort */ }

console.log(`\n${"=".repeat(50)}`);
console.log(`Parent-child: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log("Failures:");
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failed > 0 ? 1 : 0);
