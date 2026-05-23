/**
 * Hermetic tests for Prompt Check + hook reminder audit.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

const tmpHome = mkdtempSync(join(tmpdir(), "obs-prompt-check-"));
mkdirSync(join(tmpHome, "logs/observability-v2"), { recursive: true });
mkdirSync(join(tmpHome, "logs/hooks"), { recursive: true });
process.env.OPENCLAW_HOME = tmpHome;

const { getDb, closeDb } = await import("../src/storage/db.ts");
const { loadPromptRules, getPromptCheck } = await import("../src/storage/prompt-check-repo.ts");
const { ingestHookReminderFile } = await import("../src/ingest/hook-reminder-reader.ts");
const { upsertAuthSessions } = await import("../src/storage/sessions-repo.ts");

const db = getDb();
const parentKey = "agent:demo:chat:direct:prompt-parent";
const childKey = "agent:demo:subagent:prompt-child";
const parentSid = "prompt-parent-sid";
const childSid = "prompt-child-sid";
const runId = "run-prompt-1";
const childRun = "run-child-1";
const now = Date.parse("2026-05-23T12:00:00Z");

function insertStep(args: {
  id: string;
  key?: string;
  sid?: string;
  run?: string;
  seq: number;
  offset: number;
  role?: string;
  nodeType: string;
  toolName?: string | null;
  input?: string | null;
  result?: string | null;
}) {
  db.prepare(`
    INSERT INTO steps (
      step_id, session_key, session_id, run_id, seq, ts, ts_epoch_ms,
      role, node_type, tool_name, status, is_stuck, is_current,
      input_preview, result_preview
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok', 0, 0, ?, ?)
  `).run(
    args.id,
    args.key || parentKey,
    args.sid || parentSid,
    args.run || runId,
    args.seq,
    new Date(now + args.offset).toISOString(),
    now + args.offset,
    args.role || "assistant",
    args.nodeType,
    args.toolName || null,
    args.input || null,
    args.result || null,
  );
}

console.log("\n=== Group 1: prompt rule loader ===");
{
  const rulesPath = join(tmpHome, "rules.json");
  writeFileSync(rulesPath, JSON.stringify({
    rules: [
      { ruleId: "enabled-default", title: "Enabled default" },
      { ruleId: "enabled-error", title: "Enabled error", severity: "error", sourceFiles: ["docs/workflow-graph.md"] },
      { ruleId: "disabled", title: "Disabled", enabled: false },
    ],
  }));
  const rules = loadPromptRules(rulesPath);
  assert(rules.length === 2, "disabled rules are skipped", `got ${rules.length}`);
  assert(rules[0].severity === "warning", "missing severity defaults to warning");
  assert(rules[1].severity === "error", "explicit severity preserved");
}

console.log("\n=== Group 2: hook reminder ingest ===");
const hookPath = join(tmpHome, "logs/hooks/reminders.jsonl");
{
  writeFileSync(hookPath, [
    JSON.stringify({ ts: new Date(now + 3_000).toISOString(), sessionKey: parentKey, sessionId: parentSid, runId, relatedStepId: "yield", hookId: "research-checkpoint-before-yield", event: "reminder_shown", severity: "warning", message: "checkpoint before yield" }),
    JSON.stringify({ ts: new Date(now + 4_000).toISOString(), sessionKey: parentKey, hookId: "loose-hook", event: "reminder_shown", severity: "warning", message: "missing binding" }),
    "not-json",
  ].join("\n") + "\n");
  assert(ingestHookReminderFile(hookPath) === 2, "two valid hook events ingested");
  assert(ingestHookReminderFile(hookPath) === 2, "re-ingest parses same valid events");
  const count = (db.prepare("SELECT COUNT(*) as n FROM hook_events").get() as any).n;
  assert(count === 2, "hook event ingest is idempotent by event_id", `got ${count}`);
}

console.log("\n=== Group 3: prompt projection rules + hooks ===");
{
  upsertAuthSessions([
    { sessionKey: parentKey, sessionId: parentSid, agentId: "demo", channel: "chat-direct", diag: "prompt-parent", kind: "direct", label: null, model: "test", modelProvider: "openai", inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, runtimeMode: "default", updatedAt: now, ageMs: 0 },
    { sessionKey: childKey, sessionId: childSid, agentId: "demo", channel: "subagent", diag: "prompt-child", kind: "subagent", label: null, model: "test", modelProvider: "openai", inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, runtimeMode: "default", updatedAt: now, ageMs: 0 },
  ]);
  insertStep({ id: "skill-read", seq: 0, offset: 0, nodeType: "TOOL_CALL", toolName: "read", input: "/tmp/openclaw-workflow/SKILL.md" });
  insertStep({ id: "source-op", seq: 1, offset: 1_000, nodeType: "MCP_CALL", toolName: "research_query", input: "paper:token-superposition" });
  insertStep({ id: "spawn", seq: 2, offset: 2_000, nodeType: "SUBAGENT_SPAWN", toolName: "sessions_spawn", result: JSON.stringify({ childSessionKey: childKey, runId: childRun }) });
  insertStep({ id: "checkpoint", seq: 3, offset: 2_500, nodeType: "TOOL_CALL", toolName: "write", input: "/tmp/source_collection_checkpoint.md" });
  insertStep({ id: "yield", seq: 4, offset: 3_000, nodeType: "TOOL_CALL", toolName: "sessions_yield" });
  insertStep({ id: "child-start", key: childKey, sid: childSid, run: childRun, seq: 0, offset: 3_500, nodeType: "MODEL_THINK" });
  insertStep({ id: "child-reply:reply", key: childKey, sid: childSid, run: childRun, seq: 1, offset: 4_000, nodeType: "REPLY", result: "done" });

  const check = getPromptCheck(parentKey, runId, parentSid);
  assert(check.status === "warning", "prompt check status includes unbound hook warning", `got ${check.status}`);
  assert(check.promptSources.some(s => s.kind === "rule" && s.exists), "prompt rule source is reported");
  assert(check.rules.length >= 5, "demo rule pack evaluated");
  assert(check.rules.every(r => r.status === "ok"), "all transcript-backed rules pass in positive fixture");
  assert(check.hooks.length === 2, "hook events attached to session");
  assert(check.hooks.some(h => h.status === "bound"), "bound hook event preserved");
  assert(check.hooks.some(h => h.status === "unbound"), "missing run/step hook is marked unbound");
  assert(check.diagnostics.some(d => d.type === "unbound_hook_event"), "unbound hook diagnostic emitted");
}

console.log("\n=== Group 4: prompt projection catches missing evidence ===");
{
  const badKey = "agent:demo:chat:direct:prompt-bad";
  const badSid = "prompt-bad-sid";
  const badRun = "run-bad";
  upsertAuthSessions([{ sessionKey: badKey, sessionId: badSid, agentId: "demo", channel: "chat-direct", diag: "prompt-bad", kind: "direct", label: null, model: "test", modelProvider: "openai", inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, runtimeMode: "default", updatedAt: now, ageMs: 0 }]);
  insertStep({ id: "bad-source", key: badKey, sid: badSid, run: badRun, seq: 0, offset: 0, nodeType: "MCP_CALL", toolName: "research_query", input: "paper:x" });
  insertStep({ id: "bad-spawn", key: badKey, sid: badSid, run: badRun, seq: 1, offset: 1_000, nodeType: "SUBAGENT_SPAWN", toolName: "sessions_spawn", result: "{}" });
  insertStep({ id: "bad-yield", key: badKey, sid: badSid, run: badRun, seq: 2, offset: 2_000, nodeType: "TOOL_CALL", toolName: "sessions_yield" });
  const check = getPromptCheck(badKey, badRun, badSid);
  assert(check.status === "warning", "bad fixture produces warning status");
  assert(check.rules.some(r => r.ruleId === "read_source_skill_before_source_ops" && r.status === "warning"), "missing source skill read is detected");
  assert(check.rules.some(r => r.ruleId === "checkpoint_before_sessions_yield" && r.status === "warning"), "missing checkpoint before yield is detected");
  assert(check.rules.some(r => r.ruleId === "spawn_accept_must_have_child_key_run_id" && r.status === "warning"), "missing spawn accepted fields is detected");
}

console.log(`\n${passed} passed, ${failed} failed`);
closeDb();
rmSync(tmpHome, { recursive: true, force: true });
if (failed) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
