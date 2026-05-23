/**
 * Hermetic tests for the deterministic Workflow Graph projection.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

const tmpHome = mkdtempSync(join(tmpdir(), "obs-workflow-"));
mkdirSync(join(tmpHome, "logs/observability-v2"), { recursive: true });
process.env.OPENCLAW_HOME = tmpHome;

const { getDb, closeDb } = await import("../src/storage/db.ts");
const { getWorkflowGraph } = await import("../src/storage/workflow-repo.ts");

const db = getDb();
const now = Date.parse("2026-05-23T15:31:00.000Z");
const parentKey = "agent:demo:chat:group:oc_workflow";
const childKey = "agent:demo:subagent:child_source_refresh";
const unrelatedChildKey = "agent:demo:subagent:old_unrelated_child";
const parentRun = "run-parent-2410";
const childRun = "run-child-source";
const workStatusPath = join(tmpHome, "work_status.md");

function iso(offsetMs: number): string {
  return new Date(now + offsetMs).toISOString();
}

function resetDb(): void {
  db.prepare("DELETE FROM steps").run();
  db.prepare("DELETE FROM sessions").run();
}

function insertSession(key: string, sid: string, parent?: { key: string; sid: string }) {
  db.prepare(`INSERT INTO sessions
    (session_key, session_id, agent_id, channel, diag, label, kind, model,
     input_tokens, output_tokens, total_tokens, context_tokens, updated_at, age_ms,
     source, parent_session_key, parent_session_id)
    VALUES (?, ?, 'demo', 'chat-group', 'test', NULL, 'direct', 'gpt-5',
     0, 0, 0, 0, ?, 0, 'auth-only', ?, ?)
  `).run(key, sid, now, parent?.key || null, parent?.sid || null);
}

let seq = 0;
function insertStep(sessionKey: string, runId: string, opts: {
  id: string;
  offset: number;
  nodeType: string;
  role?: string;
  toolName?: string;
  input?: string;
  result?: string;
  status?: string;
}) {
  db.prepare(`INSERT INTO steps
    (step_id, session_key, run_id, seq, ts, ts_epoch_ms, role, node_type,
     tool_name, status, is_stuck, is_current, input_preview, result_preview)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
  `).run(
    opts.id, sessionKey, runId, seq++, iso(opts.offset), now + opts.offset,
    opts.role || "assistant", opts.nodeType, opts.toolName || null,
    opts.status || "ok", opts.input || null, opts.result || null,
  );
}

function seed(workStatus: string) {
  resetDb();
  seq = 0;
  writeFileSync(workStatusPath, workStatus);
  insertSession(parentKey, "sid-parent");
  insertSession(childKey, "sid-child", { key: parentKey, sid: "sid-parent" });
  insertSession(unrelatedChildKey, "sid-old-child", { key: parentKey, sid: "sid-parent" });

  insertStep(parentKey, parentRun, {
    id: "p-source",
    offset: 1_000,
    nodeType: "TOOL_CALL",
    toolName: "research_query",
    input: "outline arXiv 2410.14442",
  });
  insertStep(parentKey, parentRun, {
    id: "p-checkpoint",
    offset: 2_000,
    nodeType: "TOOL_CALL",
    toolName: "write",
    input: workStatusPath,
    result: "wrote source_collection_checkpoint",
  });
  insertStep(parentKey, parentRun, {
    id: "p-spawn",
    offset: 3_000,
    nodeType: "SUBAGENT_SPAWN",
    toolName: "sessions_spawn",
    input: '{"taskName":"source-refresh","mode":"run"}',
    result: JSON.stringify({ accepted: true, childSessionKey: childKey, runId: childRun, taskName: "source-refresh", mode: "run" }),
  });
  insertStep(parentKey, parentRun, {
    id: "p-yield",
    offset: 4_000,
    nodeType: "TOOL_CALL",
    toolName: "sessions_yield",
    input: "wait source-refresh",
  });
  insertStep(parentKey, parentRun, {
    id: "p-resume",
    offset: 8_000,
    nodeType: "TOOL_CALL",
    toolName: "read",
    input: "/tmp/source_refresh_2026-05-23.md",
  });

  insertStep(childKey, childRun, {
    id: "c-start",
    offset: 5_000,
    nodeType: "TOOL_CALL",
    toolName: "arxiv_search",
    input: "2410.14442",
  });
  insertStep(childKey, childRun, {
    id: "c-artifact",
    offset: 6_000,
    nodeType: "TOOL_CALL",
    toolName: "write",
    input: "/tmp/source_refresh_2026-05-23.md",
    result: "saved artifact",
  });
  insertStep(childKey, childRun, {
    id: "c-final",
    offset: 7_000,
    nodeType: "REPLY",
    role: "assistant",
    result: "source-refresh complete",
  });
  insertStep(unrelatedChildKey, "old-child-run", {
    id: "old-child-step",
    offset: -1_000_000,
    nodeType: "REPLY",
    role: "assistant",
    result: "old unrelated child final",
  });
}

console.log("\n=== Group 1: spawn/yield/child final + workflow-state gap ===");
seed(`<!-- openclaw-workflow:start -->
## runtime projection
flow_id: flow-empty
work_key: arxiv-2410
current_step: source_collection
waiting_children: none
<!-- openclaw-workflow:end -->
`);
{
  const graph = getWorkflowGraph(parentKey, parentRun);
  const types = graph.events.map(e => e.type);
  assert(types.includes("user_message"), "user_message node created");
  assert(types.includes("skill_or_source_step"), "source/skill step node created");
  assert(types.includes("checkpoint_write"), "checkpoint write node created");
  assert(types.includes("sessions_spawn_requested"), "sessions_spawn_requested node created");
  assert(types.includes("sessions_spawn_accepted"), "sessions_spawn_accepted node created");
  assert(types.includes("sessions_yield"), "sessions_yield node created");
  assert(types.includes("child_started"), "child_started node created");
  assert(types.includes("child_artifact_written"), "child artifact node created");
  assert(types.includes("child_final"), "child_final node created");
  assert(types.includes("parent_resumed"), "parent_resumed node created");
  assert(types.includes("workflow_state_snapshot"), "workflow snapshot node created");
  assert(types.includes("workflow_state_gap"), "empty child refs creates workflow_state_gap");
  assert(graph.lanes.some(l => l.id === `child:${childKey}`), "child lane uses exact childSessionKey");
  assert(!graph.lanes.some(l => l.id === `child:${unrelatedChildKey}`), "unspawned historical child is not pulled into current graph");
  assert(graph.edges.some(e => e.type === "spawn"), "spawn edge emitted");
  assert(graph.diagnostics.some(d => d.type === "workflow_state_child_refs_empty"), "workflow child reference diagnostic emitted");
  assert(graph.validation.status === "ok", "workflow graph self-validation passes");
  assert(graph.validation.checks.some(c => c.id === "provenance.step_id" && c.status === "ok"), "self-validation checks step provenance");
  assert(graph.validation.checks.some(c => c.id === "scope.run_id" && c.status === "ok"), "self-validation checks run scope");
  assert(["idle", "ok"].includes(graph.attention.status), "attention summary reports no active blocker after completed workflow");

  const accepted = graph.events.find(e => e.type === "sessions_spawn_accepted");
  assert(accepted?.provenance.childSessionKey === childKey, "accepted event includes childSessionKey provenance");
  assert(accepted?.provenance.child_run_id === childRun, "accepted event includes child run provenance");
  const snapshot = graph.events.find(e => e.type === "workflow_state_snapshot");
  assert(snapshot?.provenance.adapter_id === "openclaw-managed-workflow", "generic workflow adapter provenance emitted");
}

console.log("\n=== Group 2: workflow child binding ===");
seed(`<!-- openclaw-workflow:start -->
## runtime projection
flow_id: flow-bound
work_key: arxiv-2410
current_step: source_collection
waiting_children:
- childSessionKey: ${childKey}
- runId: ${childRun}
<!-- openclaw-workflow:end -->
`);
{
  const graph = getWorkflowGraph(parentKey, parentRun);
  const types = graph.events.map(e => e.type);
  assert(types.includes("workflow_state_child_bound"), "workflow child bound node created");
  assert(!graph.diagnostics.some(d => d.type === "workflow_state_child_refs_empty"), "no empty-child diagnostic when exact child bound");
  const bound = graph.events.find(e => e.type === "workflow_state_child_bound");
  assert(bound?.provenance.flow_id === "flow-bound", "bound event includes flow_id provenance");
}

console.log("\n=== Group 3: workflow adapter can be disabled ===");
seed(`<!-- openclaw-workflow:start -->
flow_id: disabled-flow
waiting_children:
- childSessionKey: ${childKey}
<!-- openclaw-workflow:end -->
`);
{
  process.env.OBS_WORKFLOW_ADAPTERS = "none";
  const graph = getWorkflowGraph(parentKey, parentRun);
  delete process.env.OBS_WORKFLOW_ADAPTERS;
  assert(!graph.events.some(e => e.type === "workflow_state_snapshot"), "disabled adapters skip managed workflow snapshot");
  assert(graph.diagnostics.some(d => d.type === "workflow_state_unavailable"), "disabled adapters emit generic workflow-state diagnostic");
}

console.log("\n=== Group 4: self-validation catches incomplete child visibility ===");
seed(`<!-- openclaw-workflow:start -->
## runtime projection
flow_id: flow-bound
work_key: arxiv-2410
current_step: source_collection
waiting_children:
- childSessionKey: ${childKey}
- runId: ${childRun}
<!-- openclaw-workflow:end -->
`);
db.prepare("DELETE FROM steps WHERE session_key = ?").run(childKey);
{
  const graph = getWorkflowGraph(parentKey, parentRun);
  assert(graph.validation.status === "warning", "self-validation warns when accepted child has no visible steps");
  assert(graph.validation.checks.some(c => c.id === "spawn.child_steps" && c.status === "warning"), "self-validation identifies missing child steps");
  assert(graph.diagnostics.some(d => d.type === "validation_spawn_child_steps"), "validation warning is surfaced as diagnostic");
  assert(["waiting", "stuck"].includes(graph.attention.status), "attention marks parent yielded without visible child return as waiting/stuck");
  assert(graph.attention.title.includes("Parent yielded"), "attention explains parent is waiting after yield");
}

console.log(`\n${passed} passed, ${failed} failed`);
closeDb();
rmSync(tmpHome, { recursive: true, force: true });
if (failed) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
