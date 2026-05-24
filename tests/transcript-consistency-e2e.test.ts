/**
 * Hermetic local E2E: transcript JSONL → watcher ingest → SQLite →
 * trace/context/workflow projections.
 *
 * This suite is intentionally fixture-driven and local-only. It proves that
 * observable rows and projections can be traced back to canonical transcript
 * entries without relying on the user's live obs.db or live sessions.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

function eq(actual: unknown, expected: unknown, name: string) {
  assert(Object.is(actual, expected), name, `expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
}

const tmpHome = mkdtempSync(join(tmpdir(), "obs-transcript-e2e-"));
mkdirSync(join(tmpHome, "logs/observability-v2"), { recursive: true });
mkdirSync(join(tmpHome, "logs/hooks"), { recursive: true });
mkdirSync(join(tmpHome, "agents/demo/sessions"), { recursive: true });
process.env.OPENCLAW_HOME = tmpHome;

const parentKey = "agent:demo:chat:direct:local-parent";
const childKey = "agent:demo:subagent:local-child";
const unrelatedChildKey = "agent:demo:subagent:sidecar-should-not-appear";
const parentSid = "11111111-1111-4111-8111-111111111111";
const childSid = "22222222-2222-4222-8222-222222222222";
const parentRun1 = "u-parent-1";
const parentRun2 = "u-parent-2";
const childRun = "u-child-source";
const workStatusPath = join(tmpHome, "workspace/paper/work_status.md");
const checkpointPath = join(tmpHome, "workspace/paper/source_collection_checkpoint.md");
const childArtifactPath = join(tmpHome, "workspace/paper/source_refresh_2026-05-23.md");
const hookRemindersPath = join(tmpHome, "logs/hooks/reminders.jsonl");
mkdirSync(join(tmpHome, "workspace/paper"), { recursive: true });
writeFileSync(workStatusPath, "plain work status without a managed workflow projection\n");
writeFileSync(checkpointPath, "checkpoint\n");
writeFileSync(childArtifactPath, "child source refresh\n");

type Entry = {
  type: string;
  id: string;
  parentId: string;
  timestamp: string;
  message?: {
    role: string;
    content: any[];
    usage?: { input: number; output: number; cacheRead?: number; totalTokens: number };
  };
};

const parentEntries: Entry[] = [
  {
    type: "message",
    id: parentRun1,
    parentId: "",
    timestamp: "2026-05-23T10:00:00.000Z",
    message: { role: "user", content: [{ type: "text", text: "first request" }] },
  },
  {
    type: "message",
    id: "a-parent-1",
    parentId: parentRun1,
    timestamp: "2026-05-23T10:00:05.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", text: "read and write checkpoint" },
        { type: "toolCall", name: "read", id: "tc-read", arguments: { file_path: "/tmp/local-input.md" } },
        {
          type: "toolCall",
          name: "write",
          id: "tc-write",
          arguments: { file_path: checkpointPath, content: "checkpoint" },
        },
      ],
      usage: { input: 1000, output: 80, cacheRead: 200, totalTokens: 1280 },
    },
  },
  {
    type: "message",
    id: "r-parent-read",
    parentId: "a-parent-1",
    timestamp: "2026-05-23T10:00:07.000Z",
    message: { role: "toolResult", content: [{ type: "text", text: "read ok" }] },
  },
  {
    type: "message",
    id: "r-parent-write",
    parentId: "r-parent-read",
    timestamp: "2026-05-23T10:00:08.500Z",
    message: { role: "toolResult", content: [{ type: "text", text: `wrote ${checkpointPath}` }] },
  },
  {
    type: "message",
    id: "a-parent-2",
    parentId: "r-parent-write",
    timestamp: "2026-05-23T10:00:12.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", text: "wrap first run" },
        { type: "text", text: "first run complete" },
      ],
      usage: { input: 1600, output: 40, cacheRead: 400, totalTokens: 2040 },
    },
  },

  {
    type: "message",
    id: parentRun2,
    parentId: "a-parent-2",
    timestamp: "2026-05-23T10:01:00.000Z",
    message: { role: "user", content: [{ type: "text", text: "spawn source refresh" }] },
  },
  {
    type: "message",
    id: "a-parent-3",
    parentId: parentRun2,
    timestamp: "2026-05-23T10:01:05.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", text: "spawn a child" },
        { type: "toolCall", name: "sessions_spawn", id: "tc-spawn", arguments: { taskName: "source-refresh" } },
      ],
      usage: { input: 5000, output: 120, cacheRead: 3000, totalTokens: 8120 },
    },
  },
  {
    type: "message",
    id: "r-spawn",
    parentId: "a-parent-3",
    timestamp: "2026-05-23T10:01:06.000Z",
    message: {
      role: "toolResult",
      content: [
        {
          type: "text",
          text: JSON.stringify({
            accepted: true,
            childSessionKey: childKey,
            runId: childRun,
            taskName: "source-refresh",
            mode: "run",
          }),
        },
      ],
    },
  },
  {
    type: "message",
    id: "a-parent-4",
    parentId: "r-spawn",
    timestamp: "2026-05-23T10:01:10.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", text: "record workflow state" },
        {
          type: "toolCall",
          name: "write",
          id: "tc-work-status",
          arguments: { file_path: workStatusPath, content: "no managed block" },
        },
      ],
      usage: { input: 5800, output: 90, cacheRead: 3500, totalTokens: 9390 },
    },
  },
  {
    type: "message",
    id: "r-work-status",
    parentId: "a-parent-4",
    timestamp: "2026-05-23T10:01:10.100Z",
    message: { role: "toolResult", content: [{ type: "text", text: `updated ${workStatusPath}` }] },
  },
  {
    type: "message",
    id: "a-parent-5",
    parentId: "r-work-status",
    timestamp: "2026-05-23T10:01:20.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", text: "yield until child returns" },
        { type: "toolCall", name: "sessions_yield", id: "tc-yield", arguments: { reason: "wait for source-refresh" } },
      ],
      usage: { input: 6400, output: 50, cacheRead: 4000, totalTokens: 10450 },
    },
  },
  {
    type: "message",
    id: "r-yield",
    parentId: "a-parent-5",
    timestamp: "2026-05-23T10:01:20.050Z",
    message: { role: "toolResult", content: [{ type: "text", text: "parent yielded" }] },
  },
];

const childEntries: Entry[] = [
  {
    type: "message",
    id: childRun,
    parentId: "",
    timestamp: "2026-05-23T10:01:06.500Z",
    message: { role: "user", content: [{ type: "text", text: "source refresh task" }] },
  },
  {
    type: "message",
    id: "a-child-1",
    parentId: childRun,
    timestamp: "2026-05-23T10:01:25.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", text: "collect child sources" },
        {
          type: "toolCall",
          name: "write",
          id: "tc-child-write",
          arguments: { file_path: childArtifactPath, content: "sources" },
        },
      ],
      usage: { input: 2100, output: 70, cacheRead: 500, totalTokens: 2670 },
    },
  },
  {
    type: "message",
    id: "r-child-write",
    parentId: "a-child-1",
    timestamp: "2026-05-23T10:01:27.000Z",
    message: { role: "toolResult", content: [{ type: "text", text: `saved ${childArtifactPath}` }] },
  },
  {
    type: "message",
    id: "a-child-2",
    parentId: "r-child-write",
    timestamp: "2026-05-23T10:01:30.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", text: "summarize child work" },
        { type: "text", text: "child final complete" },
      ],
      usage: { input: 2600, output: 60, cacheRead: 700, totalTokens: 3360 },
    },
  },
];

function writeJsonl(path: string, entries: Entry[]) {
  writeFileSync(path, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
}

writeFileSync(
  join(tmpHome, "agents/demo/sessions/sessions.json"),
  JSON.stringify({
    [parentKey]: { sessionId: parentSid, label: "local parent" },
    [childKey]: { sessionId: childSid, label: "local child", spawnedBy: parentKey },
  }),
);
writeJsonl(join(tmpHome, "agents/demo/sessions", `${parentSid}.jsonl`), parentEntries);
writeJsonl(join(tmpHome, "agents/demo/sessions", `${childSid}.jsonl`), childEntries);
writeJsonl(join(tmpHome, "agents/demo/sessions", `${parentSid}.acp-stream.jsonl`), [
  {
    type: "message",
    id: "sidecar-user",
    parentId: "",
    timestamp: "2026-05-23T10:09:00.000Z",
    message: { role: "user", content: [{ type: "text", text: "sidecar" }] },
  },
  {
    type: "message",
    id: "sidecar-assistant",
    parentId: "sidecar-user",
    timestamp: "2026-05-23T10:09:01.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "must not ingest" }],
      usage: { input: 1, output: 1, totalTokens: 2 },
    },
  },
]);
writeJsonl(join(tmpHome, "agents/demo/sessions", `${parentSid}.checkpoint.1.jsonl`), []);
writeJsonl(join(tmpHome, "agents/demo/sessions", `${parentSid}.trajectory.jsonl`), []);
writeFileSync(
  hookRemindersPath,
  `${[
    JSON.stringify({
      ts: "2026-05-23T10:01:19.900Z",
      sessionKey: parentKey,
      sessionId: parentSid,
      runId: parentRun2,
      relatedStepId: "a-parent-5:tc-yield",
      hookId: "research-checkpoint-before-yield",
      event: "reminder_shown",
      severity: "warning",
      message: "Write checkpoint before sessions_yield",
    }),
    JSON.stringify({
      ts: "2026-05-23T10:01:19.950Z",
      sessionKey: parentKey,
      sessionId: parentSid,
      runId: "unrelated-run",
      relatedStepId: "unrelated-step",
      hookId: "research-checkpoint-before-yield",
      event: "reminder_shown",
      severity: "warning",
      message: "This hook belongs to a different run",
    }),
  ].join("\n")}\n`,
);

const { startTranscriptWatcher, _resetSessionIdMapForTest } = await import("../src/ingest/transcript-watcher.ts");
const { ingestHookReminderFile } = await import("../src/ingest/hook-reminder-reader.ts");
const { readSessionStoreExtras } = await import("../src/ingest/auth-poller.ts");
const { upsertAuthSessions } = await import("../src/storage/sessions-repo.ts");
const { recomputeSessionCounts, recomputeAllSessionOps, updateSessionLabel, updateSessionParent } = await import(
  "../src/storage/sessions-repo.ts"
);
const { upsertSteps, getTraceSpans, getRunList, getLatestRun } = await import("../src/storage/steps-repo.ts");
const { getContextBoth } = await import("../src/storage/context-repo.ts");
const { getWorkflowGraph } = await import("../src/storage/workflow-repo.ts");
const { getPromptCheck } = await import("../src/storage/prompt-check-repo.ts");
const { getDb, closeDb } = await import("../src/storage/db.ts");
const { handleSessionsRoutes } = await import("../src/api/routes-sessions.ts");

type ExpectedStep = {
  step_id: string;
  parent_step_id: string;
  session_key: string;
  session_id: string;
  run_id: string;
  seq: number;
  ts_epoch_ms: number;
  role: string;
  node_type: string;
  tool_name: string | null;
  tool_call_id: string | null;
  duration_ms: number | null;
  total_tokens: number | null;
  output_tokens: number | null;
  input_tokens: number | null;
  cache_read_tokens: number | null;
  input_text_len: number | null;
  result_text_len: number | null;
  thinking_text_len: number | null;
  reply_text_len: number | null;
  status: string;
  is_current: number;
  is_stuck: number;
};

function classifyForOracle(toolName: string): string {
  if (toolName === "sessions_spawn" || toolName === "sessions_send") return "SUBAGENT_SPAWN";
  if (toolName === "sessions_yield") return "TOOL_CALL";
  if (toolName === "read" || toolName === "write" || toolName === "edit") return "TOOL_CALL";
  return "MCP_CALL";
}

function deriveTranscriptOracle(entries: Entry[], sessionKey: string, sessionId: string): ExpectedStep[] {
  const all: ExpectedStep[] = [];
  let current: ExpectedStep[] = [];
  let runId = "";
  let seq = 0;

  function finalize(startTs: number) {
    if (current.length === 0) return;
    let prevEntryTs = startTs;
    const pending = new Map<string, ExpectedStep>();
    for (const step of current) {
      if (step.node_type === "MODEL_THINK" || step.node_type === "REPLY")
        step.duration_ms = step.ts_epoch_ms - prevEntryTs;
      else if (step.role === "toolResult") step.duration_ms = 0;
      else step.duration_ms = 0;

      if (step.role === "toolResult" || step.node_type === "MODEL_THINK" || step.node_type === "REPLY") {
        prevEntryTs = step.ts_epoch_ms;
      }
      if (step.tool_call_id && step.status === "running") pending.set(step.tool_call_id, step);
      if (step.role === "toolResult") {
        const first = pending.keys().next().value;
        if (first !== undefined) {
          const call = pending.get(first)!;
          call.status = step.status;
          call.is_current = 0;
          call.duration_ms = step.ts_epoch_ms - call.ts_epoch_ms;
          call.result_text_len = step.result_text_len;
          pending.delete(first);
        }
      }
    }
    all.push(...current);
  }

  let runStartTs = 0;
  for (const entry of entries) {
    const msg = entry.message;
    if (entry.type !== "message" || !msg) continue;
    if (msg.role === "user") {
      finalize(runStartTs);
      runId = entry.id;
      runStartTs = Date.parse(entry.timestamp);
      current = [];
      seq = 0;
      continue;
    }
    if (!runId) continue;
    const tsEpochMs = Date.parse(entry.timestamp);
    if (msg.role === "assistant") {
      const content = Array.isArray(msg.content) ? msg.content : [];
      const toolCalls = content.filter((c) => c.type === "toolCall" || c.type === "tool_use");
      const hasThinking = content.some((c) => c.type === "thinking");
      const hasText = content.some((c) => c.type === "text" && c.text?.trim());
      const thinkingTextLen = content
        .filter((c) => c.type === "thinking")
        .reduce((n, c) => n + (typeof c.text === "string" ? c.text.length : 0), 0);
      const replyTextLen = content
        .filter((c) => c.type === "text")
        .reduce((n, c) => n + (typeof c.text === "string" ? c.text.length : 0), 0);
      if (hasThinking || toolCalls.length > 0) {
        current.push({
          step_id: entry.id,
          parent_step_id: entry.parentId,
          session_key: sessionKey,
          session_id: sessionId,
          run_id: runId,
          seq: seq++,
          ts_epoch_ms: tsEpochMs,
          role: "assistant",
          node_type: "MODEL_THINK",
          tool_name: null,
          tool_call_id: null,
          duration_ms: null,
          total_tokens: msg.usage?.totalTokens ?? null,
          output_tokens: msg.usage?.output ?? null,
          input_tokens: msg.usage?.input ?? null,
          cache_read_tokens: msg.usage?.cacheRead ?? null,
          input_text_len: null,
          result_text_len: null,
          thinking_text_len: thinkingTextLen || null,
          reply_text_len: null,
          status: "ok",
          is_current: 0,
          is_stuck: 0,
        });
      }
      for (const tc of toolCalls) {
        const name = tc.name || tc.toolName || "";
        const id = tc.id || tc.toolCallId || "";
        const input = tc.arguments || tc.input || tc.params || {};
        current.push({
          step_id: `${entry.id}:${id}`,
          parent_step_id: entry.id,
          session_key: sessionKey,
          session_id: sessionId,
          run_id: runId,
          seq: seq++,
          ts_epoch_ms: tsEpochMs,
          role: "assistant",
          node_type: classifyForOracle(name),
          tool_name: name,
          tool_call_id: id,
          duration_ms: null,
          total_tokens: null,
          output_tokens: toolCalls.length > 0 && msg.usage ? Math.round(msg.usage.output / toolCalls.length) : null,
          input_tokens: null,
          cache_read_tokens: null,
          input_text_len: JSON.stringify(input).length,
          result_text_len: null,
          thinking_text_len: null,
          reply_text_len: null,
          status: "running",
          is_current: 1,
          is_stuck: 0,
        });
      }
      if (hasText && toolCalls.length === 0) {
        current.push({
          step_id: `${entry.id}:reply`,
          parent_step_id: entry.parentId,
          session_key: sessionKey,
          session_id: sessionId,
          run_id: runId,
          seq: seq++,
          ts_epoch_ms: tsEpochMs,
          role: "assistant",
          node_type: "REPLY",
          tool_name: null,
          tool_call_id: null,
          duration_ms: null,
          total_tokens: msg.usage?.totalTokens ?? null,
          output_tokens: msg.usage?.output ?? null,
          input_tokens: msg.usage?.input ?? null,
          cache_read_tokens: msg.usage?.cacheRead ?? null,
          input_text_len: null,
          result_text_len: null,
          thinking_text_len: hasThinking ? null : thinkingTextLen || null,
          reply_text_len: replyTextLen || null,
          status: "ok",
          is_current: 0,
          is_stuck: 0,
        });
      }
    }
    if (msg.role === "toolResult") {
      const resultLen = Array.isArray(msg.content) ? msg.content.reduce((n, c) => n + (c.text?.length || 0), 0) : 0;
      current.push({
        step_id: entry.id,
        parent_step_id: entry.parentId,
        session_key: sessionKey,
        session_id: sessionId,
        run_id: runId,
        seq: seq++,
        ts_epoch_ms: tsEpochMs,
        role: "toolResult",
        node_type: "TOOL_CALL",
        tool_name: null,
        tool_call_id: null,
        duration_ms: null,
        total_tokens: null,
        output_tokens: null,
        input_tokens: null,
        cache_read_tokens: null,
        input_text_len: null,
        result_text_len: resultLen,
        thinking_text_len: null,
        reply_text_len: null,
        status: "ok",
        is_current: 0,
        is_stuck: 0,
      });
    }
  }
  finalize(runStartTs);
  return all;
}

function runWatcherOnce() {
  _resetSessionIdMapForTest();
  const watcher = startTranscriptWatcher({
    onRuns(sessionKey, runs) {
      for (const run of runs) upsertSteps(run);
      recomputeSessionCounts(sessionKey);
    },
  });
  watcher.stop();
}

function callTraceRoute(key: string, query: Record<string, string>) {
  let payload: any = null;
  let status = 200;
  handleSessionsRoutes.trace(key, query, {} as any, (res, data, code = 200) => {
    void res;
    payload = data;
    status = code;
  });
  return { payload, status };
}

function callContextRoute(key: string, query: Record<string, string>) {
  let payload: any = null;
  let status = 200;
  handleSessionsRoutes.context(key, query, {} as any, (res, data, code = 200) => {
    void res;
    payload = data;
    status = code;
  });
  return { payload, status };
}

function callWorkflowRoute(key: string, query: Record<string, string>) {
  let payload: any = null;
  let status = 200;
  handleSessionsRoutes.workflow(key, query, {} as any, (res, data, code = 200) => {
    void res;
    payload = data;
    status = code;
  });
  return { payload, status };
}

function callPromptCheckRoute(key: string, query: Record<string, string>) {
  let payload: any = null;
  let status = 200;
  handleSessionsRoutes.promptCheck(key, query, {} as any, (res, data, code = 200) => {
    void res;
    payload = data;
    status = code;
  });
  return { payload, status };
}

console.log("\n=== Setup: auth/session store + watcher ingest ===");
upsertAuthSessions([
  {
    sessionKey: parentKey,
    sessionId: parentSid,
    agentId: "demo",
    channel: "chat-direct",
    diag: "direct:local-parent",
    kind: "direct",
    label: null,
    model: "gpt-test",
    modelProvider: "openai",
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    contextTokens: 0,
    runtimeMode: "default",
    updatedAt: 0,
    ageMs: 0,
  },
  {
    sessionKey: childKey,
    sessionId: childSid,
    agentId: "demo",
    channel: "subagent",
    diag: "subagent:local-child",
    kind: "subagent",
    label: null,
    model: "gpt-test",
    modelProvider: "openai",
    inputTokens: 9999,
    outputTokens: 888,
    totalTokens: 12345,
    contextTokens: 9999,
    runtimeMode: "default",
    updatedAt: 0,
    ageMs: 0,
  },
]);
for (const [key, extra] of readSessionStoreExtras()) {
  if (extra.label) updateSessionLabel(key, extra.label);
  if (extra.parentSessionKey) updateSessionParent(key, extra.parentSessionKey, extra.parentSessionId);
}
runWatcherOnce();
ingestHookReminderFile(hookRemindersPath);
recomputeAllSessionOps();

const db = getDb();
const parentExpected = deriveTranscriptOracle(parentEntries, parentKey, parentSid);
const childExpected = deriveTranscriptOracle(childEntries, childKey, childSid);
const expected = [...parentExpected, ...childExpected];

console.log("\n=== Group 1: canonical files only + exact step parity ===");
{
  const ingestRows = db
    .prepare("SELECT file_path, session_key, session_id FROM ingest_state ORDER BY file_path")
    .all() as any[];
  eq(ingestRows.length, 2, "only canonical parent+child transcript files entered ingest_state");
  assert(
    ingestRows.every((r) => !/acp-stream|checkpoint|trajectory/.test(r.file_path)),
    "sidecar transcript files are skipped",
  );

  const rows = db
    .prepare(`
    SELECT step_id, parent_step_id, session_key, session_id, run_id, seq, ts_epoch_ms,
           role, node_type, tool_name, tool_call_id, duration_ms, total_tokens,
           output_tokens, input_tokens, cache_read_tokens, input_text_len,
           result_text_len, thinking_text_len, reply_text_len, status, is_current, is_stuck
    FROM steps ORDER BY session_id, run_id, seq
  `)
    .all() as any[];
  eq(rows.length, expected.length, "DB step count equals transcript oracle");
  const byId = new Map(rows.map((r) => [r.step_id, r]));
  for (const e of expected) {
    const row = byId.get(e.step_id) as any;
    assert(row != null, `step ${e.step_id} exists in DB`);
    if (!row) continue;
    for (const field of Object.keys(e) as Array<keyof ExpectedStep>) {
      eq(row[field], e[field], `step ${e.step_id}.${String(field)} matches transcript`);
    }
  }
  assert(!byId.has("sidecar-assistant:reply"), "sidecar assistant reply was not ingested");
  assert(
    rows.every(
      (r) =>
        (r.session_key === parentKey && r.session_id === parentSid) ||
        (r.session_key === childKey && r.session_id === childSid),
    ),
    "no step crossed session_key/session_id boundary",
  );
}

console.log("\n=== Group 2: session aggregates + token contract ===");
{
  const parent = db
    .prepare("SELECT * FROM sessions WHERE session_key = ? AND session_id = ?")
    .get(parentKey, parentSid) as any;
  const child = db
    .prepare("SELECT * FROM sessions WHERE session_key = ? AND session_id = ?")
    .get(childKey, childSid) as any;
  eq(parent.source, "transcript+auth", "parent source upgraded after transcript ingest");
  eq(parent.token_source, "transcript-backfill", "official-zero parent uses transcript backfill");
  eq(parent.total_tokens, 10450, "parent total_tokens comes from latest transcript usage");
  eq(parent.input_tokens, 6400, "parent input_tokens comes from latest transcript usage");
  eq(parent.context_tokens, 6400, "parent context_tokens comes from latest transcript input");
  eq(parent.llm_call_count, 5, "parent llm_call_count matches transcript MODEL_THINK rows");
  eq(parent.tool_call_count, 5, "parent tool_call_count matches assistant tool rows");
  eq(parent.diag_state, "idle", "parent has no stale processing state after recompute");
  eq(parent.blocker, null, "parent has no stale blocker without a current stuck step");

  eq(child.token_source, "official", "official nonzero child keeps authoritative token source");
  eq(child.total_tokens, 12345, "official nonzero child total_tokens is not overwritten by transcript");
  eq(child.parent_session_id, parentSid, "child parent_session_id resolved from local sessions.json");
}

console.log("\n=== Group 3: run selector + trace API projection ===");
{
  const runs = getRunList(parentKey, parentSid);
  eq(runs.length, 2, "parent session has exactly two transcript runs");
  eq(runs[0].run_id, parentRun2, "latest run selector uses latest user-message run");
  eq(getLatestRun(parentKey, parentSid)?.run_id, parentRun2, "latest run is scoped by session_id");

  const trace = callTraceRoute(parentKey, { runId: parentRun2, sessionId: parentSid });
  eq(trace.status, 200, "trace route returns 200");
  const dbRun2 = getTraceSpans(parentKey, parentRun2, parentSid);
  const nonToolResult = dbRun2.filter((r: any) => r.role !== "toolResult");
  eq(trace.payload.spans.length, nonToolResult.length, "trace API hides toolResult rows only");
  eq(
    trace.payload.spans.map((s: any) => s.id).join(","),
    nonToolResult.map((s: any) => s.step_id).join(","),
    "trace span ids preserve DB step provenance",
  );
}

console.log("\n=== Group 4: context projection matches transcript usage ===");
{
  const ctx = getContextBoth(parentKey, parentRun2, parentSid);
  assert(ctx != null, "context projection returns parent run2");
  if (ctx) {
    eq(ctx.timeline.cumulative.totalTurns, 3, "context has one turn per assistant message in parent run2");
    eq(ctx.timeline.cumulative.peakInputTokens, 10400, "context peak input+cacheRead matches transcript");
    eq(ctx.timeline.cumulative.finalInputTokens, 10400, "context final input+cacheRead matches transcript");
    eq(ctx.timeline.turns[0].inputTokens, 5000, "turn 1 input_tokens from transcript usage");
    eq(ctx.timeline.turns[0].cacheReadTokens, 3000, "turn 1 cacheRead from transcript usage");
    eq(ctx.timeline.turns[1].deltaIn, 1300, "turn 2 deltaIn derived from transcript usage");
    eq(ctx.breakdown.totalLatest, 10400, "breakdown latest prompt tokens matches transcript");
  }
  const ctxApi = callContextRoute(parentKey, { runId: parentRun2, sessionId: parentSid });
  eq(ctxApi.status, 200, "context API route returns 200");
  eq(ctxApi.payload.timeline.cumulative.peakInputTokens, 10400, "context API peak input matches transcript");
  eq(ctxApi.payload.timeline.turns[1].deltaIn, 1300, "context API deltaIn matches transcript");
}

console.log("\n=== Group 5: workflow graph projection + stuck attention ===");
{
  const graph = getWorkflowGraph(parentKey, parentRun2, parentSid);
  const types = graph.events.map((e) => e.type);
  assert(types.includes("sessions_spawn_requested"), "workflow includes spawn request");
  assert(types.includes("sessions_spawn_accepted"), "workflow includes accepted childSessionKey/runId");
  assert(types.includes("sessions_yield"), "workflow includes sessions_yield");
  assert(types.includes("child_started"), "workflow includes exact child start");
  assert(types.includes("child_artifact_written"), "workflow includes child artifact write");
  assert(types.includes("child_final"), "workflow includes child final");
  assert(
    types.includes("workflow_state_gap"),
    "workflow renders Workflow State/workflow-state gap instead of guessing",
  );
  assert(!types.includes("workflow_state_child_bound"), "workflow does not fabricate Workflow State child binding");
  assert(
    graph.lanes.some((l) => l.id === `child:${childKey}`),
    "child lane comes from exact accepted childSessionKey",
  );
  assert(!graph.lanes.some((l) => l.id === `child:${unrelatedChildKey}`), "unrelated/sidecar child does not appear");
  assert(
    graph.diagnostics.some((d) => d.type === "workflow_state_unavailable"),
    "workflow gap diagnostic is emitted",
  );
  assert(
    graph.validation.checks.every((c) => c.status !== "error"),
    "workflow self-validation has no error checks",
  );
  eq(graph.attention.status, "stuck", "workflow attention marks yielded parent as stuck");
  assert(graph.attention.title.includes("Parent yielded"), "workflow attention points to yield/child merge");
  eq(graph.attention.childSessionKey, childKey, "workflow attention names exact child session key");

  const workflowApi = callWorkflowRoute(parentKey, { runId: parentRun2, sessionId: parentSid });
  eq(workflowApi.status, 200, "workflow API route returns 200");
  assert(
    workflowApi.payload.events.some((e: any) => e.type === "sessions_spawn_accepted"),
    "workflow API includes accepted child event",
  );
  eq(workflowApi.payload.attention.childSessionKey, childKey, "workflow API attention preserves child session key");
}

console.log("\n=== Group 6: prompt check + hook reminder consistency ===");
{
  const prompt = getPromptCheck(parentKey, parentRun2, parentSid);
  const checkpointRule = prompt.rules.find((r) => r.ruleId === "checkpoint_before_sessions_yield");
  assert(checkpointRule != null, "prompt check evaluates checkpoint-before-yield rule");
  eq(checkpointRule?.status, "ok", "checkpoint-before-yield matches transcript evidence");
  assert(
    (checkpointRule?.evidenceStepIds || []).includes("a-parent-5:tc-yield"),
    "checkpoint rule provenance includes yield step",
  );
  eq(prompt.hooks.length, 1, "prompt check only attaches hook events from the selected run");
  eq(prompt.hooks[0]?.hookId, "research-checkpoint-before-yield", "bound hook reminder is visible");
  eq(prompt.hooks[0]?.status, "bound", "hook reminder has session/run/step binding");
  eq(prompt.hooks[0]?.relatedStepId, "a-parent-5:tc-yield", "hook reminder keeps related step provenance");
  assert(!prompt.hooks.some((h) => h.runId === "unrelated-run"), "hook reminder from another run is not attached");

  const promptApi = callPromptCheckRoute(parentKey, { runId: parentRun2, sessionId: parentSid });
  eq(promptApi.status, 200, "prompt-check API route returns 200");
  eq(promptApi.payload.hooks.length, 1, "prompt-check API only exposes selected-run hook");
  assert(
    promptApi.payload.rules.some((r: any) => r.ruleId === "checkpoint_before_sessions_yield" && r.status === "ok"),
    "prompt-check API rule result matches transcript",
  );
}

console.log("\n=== Group 7: idempotent local E2E replay ===");
{
  const beforeSteps = (db.prepare("SELECT COUNT(*) as n FROM steps").get() as any).n;
  const beforeHooks = (db.prepare("SELECT COUNT(*) as n FROM hook_events").get() as any).n;
  const beforeEvents = getWorkflowGraph(parentKey, parentRun2, parentSid).events.length;
  runWatcherOnce();
  ingestHookReminderFile(hookRemindersPath);
  recomputeAllSessionOps();
  const afterSteps = (db.prepare("SELECT COUNT(*) as n FROM steps").get() as any).n;
  const afterHooks = (db.prepare("SELECT COUNT(*) as n FROM hook_events").get() as any).n;
  const afterEvents = getWorkflowGraph(parentKey, parentRun2, parentSid).events.length;
  eq(afterSteps, beforeSteps, "re-ingesting same local transcripts does not duplicate steps");
  eq(afterHooks, beforeHooks, "re-ingesting same hook reminders does not duplicate hook events");
  eq(afterEvents, beforeEvents, "workflow projection remains stable after idempotent replay");
}

console.log(`\n${passed} passed, ${failed} failed`);
closeDb();
rmSync(tmpHome, { recursive: true, force: true });
if (failed) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
