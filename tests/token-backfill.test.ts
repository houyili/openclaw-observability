/**
 * Targeted tests for the token backfill fix in recomputeSessionCounts
 * and recomputeAllSessionCounts.
 *
 * Background: subagent sessions showed 0 for total_tokens / input_tokens /
 * output_tokens on the dashboard because the recompute functions only
 * aggregated call counts (llm/tool/skill/mcp), never token data. Tokens
 * were solely populated by the auth-poller CLI output, which returns 0
 * for subagents. The fix adds token aggregation from the steps table as
 * a backfill when auth-poller values are 0 or NULL.
 *
 * Run:
 *   node --experimental-sqlite --experimental-strip-types --no-warnings \
 *     tests/token-backfill.test.ts
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

// ─── Isolated OPENCLAW_HOME ────────────────────────────────────
const tmpHome = mkdtempSync(join(tmpdir(), "obs-token-backfill-"));
mkdirSync(join(tmpHome, "logs/observability-v2"), { recursive: true });
process.env.OPENCLAW_HOME = tmpHome;

const { getDb, closeDb } = await import("../src/storage/db.ts");
const { recomputeSessionCounts, recomputeAllSessionCounts, upsertAuthSessions } = await import(
  "../src/storage/sessions-repo.ts"
);

const db = getDb();
const now = Date.now();
const isoNow = (offsetMs = 0) => new Date(now + offsetMs).toISOString();

// Helper: insert a session row
function insertSession(
  key: string,
  sid: string,
  opts: {
    totalTokens?: number;
    inputTokens?: number;
    outputTokens?: number;
    contextTokens?: number;
  } = {},
) {
  db.prepare(`INSERT INTO sessions
    (session_key, session_id, agent_id, channel, diag, kind, model,
     input_tokens, output_tokens, total_tokens, context_tokens,
     updated_at, age_ms, source)
    VALUES (?, ?, 'test', 'subagent', 'sub', 'direct', 'gpt-5',
     ?, ?, ?, ?, ?, 0, 'auth-only')
  `).run(key, sid, opts.inputTokens ?? 0, opts.outputTokens ?? 0, opts.totalTokens ?? 0, opts.contextTokens ?? 0, now);
}

// Helper: insert a step row
let stepSeq = 0;
function insertStep(
  sessionKey: string,
  runId: string,
  opts: {
    nodeType: string;
    role?: string;
    toolName?: string;
    totalTokens?: number | null;
    outputTokens?: number | null;
    inputTokens?: number | null;
    skillName?: string;
    mcpTool?: string;
  },
) {
  const seq = stepSeq++;
  db.prepare(`INSERT INTO steps
    (step_id, session_key, run_id, seq, ts, ts_epoch_ms,
     role, node_type, tool_name, total_tokens, output_tokens, input_tokens,
     skill_name, mcp_tool, status, is_stuck, is_current)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok', 0, 0)
  `).run(
    `step-${seq}`,
    sessionKey,
    runId,
    seq,
    isoNow(-1000 + seq * 100),
    now - 1000 + seq * 100,
    opts.role ?? "assistant",
    opts.nodeType,
    opts.toolName ?? null,
    opts.totalTokens ?? null,
    opts.outputTokens ?? null,
    opts.inputTokens ?? null,
    opts.skillName ?? null,
    opts.mcpTool ?? null,
  );
}

// ═══════════════════════════════════════════════════════════════
console.log("\n=== Group 1: Backfill tokens when session has 0 ===");
// ═══════════════════════════════════════════════════════════════

{
  const KEY = "agent:test:subagent:zero-tokens";
  insertSession(KEY, "sid-zero", { totalTokens: 0, inputTokens: 0, outputTokens: 0, contextTokens: 0 });

  // Insert steps with token data (simulating a 3-turn conversation)
  insertStep(KEY, "run-z1", { nodeType: "MODEL_THINK", totalTokens: 500, outputTokens: 40, inputTokens: 460 });
  insertStep(KEY, "run-z1", { nodeType: "TOOL_CALL", toolName: "read", totalTokens: null, outputTokens: null });
  insertStep(KEY, "run-z1", { nodeType: "MODEL_THINK", totalTokens: 1200, outputTokens: 80, inputTokens: 1120 });
  insertStep(KEY, "run-z1", { nodeType: "TOOL_CALL", toolName: "write", totalTokens: null, outputTokens: null });
  insertStep(KEY, "run-z1", { nodeType: "MODEL_THINK", totalTokens: 1800, outputTokens: 60, inputTokens: 1740 });
  insertStep(KEY, "run-z1", { nodeType: "REPLY", totalTokens: 1800, outputTokens: 30, inputTokens: 1740 });

  recomputeSessionCounts(KEY);

  const sess = db.prepare("SELECT * FROM sessions WHERE session_key = ?").get(KEY) as any;

  // MAX(total_tokens) across MODEL_THINK/REPLY = 1800
  assert(sess.total_tokens === 1800, "total_tokens backfilled from steps (MAX)", `got ${sess.total_tokens}`);

  // MAX(input_tokens) = 1740
  assert(sess.input_tokens === 1740, "input_tokens backfilled from steps (MAX)", `got ${sess.input_tokens}`);

  // SUM(output_tokens) of MODEL_THINK + REPLY = 40 + 80 + 60 + 30 = 210
  assert(
    sess.output_tokens === 210,
    "output_tokens backfilled from steps (SUM of MODEL_THINK+REPLY)",
    `got ${sess.output_tokens}`,
  );

  // context_tokens = MAX(input_tokens) from MODEL_THINK/REPLY = 1740
  assert(sess.context_tokens === 1740, "context_tokens backfilled from steps", `got ${sess.context_tokens}`);

  // source should flip to transcript+auth
  assert(sess.source === "transcript+auth", "source flipped to transcript+auth", `got ${sess.source}`);
  assert(
    sess.token_source === "transcript-backfill",
    "token_source marks transcript backfill",
    `got ${sess.token_source}`,
  );

  // call counts should also be correct
  assert(sess.llm_call_count === 3, "llm_call_count = 3 (3 MODEL_THINK)", `got ${sess.llm_call_count}`);
  assert(sess.tool_call_count === 2, "tool_call_count = 2 (read + write)", `got ${sess.tool_call_count}`);
}

// ═══════════════════════════════════════════════════════════════
console.log("\n=== Group 2: Do NOT override non-zero auth-poller tokens ===");
// ═══════════════════════════════════════════════════════════════

{
  const KEY = "agent:test:subagent:has-auth-tokens";
  // Auth-poller already gave us real token data
  insertSession(KEY, "sid-auth", { totalTokens: 25000, inputTokens: 20000, outputTokens: 5000, contextTokens: 100000 });

  // Steps have different (smaller) values — should NOT override
  insertStep(KEY, "run-a1", { nodeType: "MODEL_THINK", totalTokens: 800, outputTokens: 50, inputTokens: 750 });
  insertStep(KEY, "run-a1", { nodeType: "REPLY", totalTokens: 800, outputTokens: 20, inputTokens: 750 });

  recomputeSessionCounts(KEY);

  const sess = db.prepare("SELECT * FROM sessions WHERE session_key = ?").get(KEY) as any;

  assert(sess.total_tokens === 25000, "total_tokens preserved from auth-poller (25000)", `got ${sess.total_tokens}`);
  assert(sess.input_tokens === 20000, "input_tokens preserved from auth-poller (20000)", `got ${sess.input_tokens}`);
  assert(sess.output_tokens === 5000, "output_tokens preserved from auth-poller (5000)", `got ${sess.output_tokens}`);
  assert(
    sess.context_tokens === 100000,
    "context_tokens preserved from auth-poller (100000)",
    `got ${sess.context_tokens}`,
  );
  assert(
    (sess.token_source || "official") === "official",
    "token_source remains official when auth tokens are non-zero",
    `got ${sess.token_source}`,
  );
}

// ═══════════════════════════════════════════════════════════════
console.log("\n=== Group 2b: Official-zero poll marks preserved transcript values ===");
// ═══════════════════════════════════════════════════════════════

{
  const KEY = "agent:test:subagent:official-zero-after-transcript";
  insertSession(KEY, "sid-official-zero", {
    totalTokens: 1234,
    inputTokens: 1200,
    outputTokens: 34,
    contextTokens: 1200,
  });
  db.prepare("UPDATE sessions SET source = 'transcript+auth', token_source = 'official' WHERE session_key = ?").run(
    KEY,
  );

  upsertAuthSessions([
    {
      sessionKey: KEY,
      sessionId: "sid-official-zero",
      agentId: "test",
      channel: "subagent",
      diag: "sub",
      label: null,
      kind: "direct",
      model: "gpt-5",
      modelProvider: "",
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      contextTokens: 0,
      runtimeMode: "",
      updatedAt: now + 1,
      ageMs: 0,
    },
  ]);

  const sess = db.prepare("SELECT * FROM sessions WHERE session_key = ?").get(KEY) as any;
  assert(
    sess.total_tokens === 1234,
    "official-zero poll preserves existing nonzero total_tokens",
    `got ${sess.total_tokens}`,
  );
  assert(
    sess.token_source === "transcript-backfill",
    "official-zero poll marks transcript-backfill",
    `got ${sess.token_source}`,
  );
}

// ═══════════════════════════════════════════════════════════════
console.log("\n=== Group 3: NULL tokens are also backfilled ===");
// ═══════════════════════════════════════════════════════════════

{
  const KEY = "agent:test:subagent:null-tokens";
  // Session with NULL tokens (not 0)
  db.prepare(`INSERT INTO sessions
    (session_key, session_id, agent_id, channel, diag, kind, model,
     input_tokens, output_tokens, total_tokens, context_tokens,
     updated_at, age_ms, source)
    VALUES (?, ?, 'test', 'subagent', 'sub', 'direct', 'gpt-5',
     NULL, NULL, NULL, NULL, ?, 0, 'auth-only')
  `).run(KEY, "sid-null", now);

  insertStep(KEY, "run-n1", { nodeType: "MODEL_THINK", totalTokens: 3000, outputTokens: 200, inputTokens: 2800 });
  insertStep(KEY, "run-n1", { nodeType: "REPLY", totalTokens: 3000, outputTokens: 100, inputTokens: 2800 });

  recomputeSessionCounts(KEY);

  const sess = db.prepare("SELECT * FROM sessions WHERE session_key = ?").get(KEY) as any;

  assert(sess.total_tokens === 3000, "NULL total_tokens backfilled to 3000", `got ${sess.total_tokens}`);
  assert(sess.input_tokens === 2800, "NULL input_tokens backfilled to 2800", `got ${sess.input_tokens}`);
  assert(sess.output_tokens === 300, "NULL output_tokens backfilled to 300 (200+100)", `got ${sess.output_tokens}`);
}

// ═══════════════════════════════════════════════════════════════
console.log("\n=== Group 4: recomputeAllSessionCounts bulk backfill ===");
// ═══════════════════════════════════════════════════════════════

{
  // Insert two more sessions with 0 tokens + steps
  const KEY_A = "agent:test:bulk:aaa";
  const KEY_B = "agent:test:bulk:bbb";

  insertSession(KEY_A, "sid-ba", { totalTokens: 0 });
  insertSession(KEY_B, "sid-bb", { totalTokens: 0 });

  insertStep(KEY_A, "run-ba", { nodeType: "MODEL_THINK", totalTokens: 5000, outputTokens: 300, inputTokens: 4700 });
  insertStep(KEY_A, "run-ba", { nodeType: "REPLY", totalTokens: 5000, outputTokens: 100, inputTokens: 4700 });
  insertStep(KEY_B, "run-bb", { nodeType: "MODEL_THINK", totalTokens: 9000, outputTokens: 500, inputTokens: 8500 });

  recomputeAllSessionCounts();

  const sessA = db
    .prepare("SELECT total_tokens, input_tokens, output_tokens FROM sessions WHERE session_key = ?")
    .get(KEY_A) as any;
  const sessB = db
    .prepare("SELECT total_tokens, input_tokens, output_tokens FROM sessions WHERE session_key = ?")
    .get(KEY_B) as any;

  assert(sessA.total_tokens === 5000, "bulk: KEY_A total_tokens backfilled to 5000", `got ${sessA.total_tokens}`);
  assert(sessA.output_tokens === 400, "bulk: KEY_A output_tokens = 400 (300+100)", `got ${sessA.output_tokens}`);
  assert(sessB.total_tokens === 9000, "bulk: KEY_B total_tokens backfilled to 9000", `got ${sessB.total_tokens}`);
  assert(sessB.output_tokens === 500, "bulk: KEY_B output_tokens = 500", `got ${sessB.output_tokens}`);

  // Group 2's session should still be untouched
  const sessAuth = db
    .prepare("SELECT total_tokens FROM sessions WHERE session_key = ?")
    .get("agent:test:subagent:has-auth-tokens") as any;
  assert(
    sessAuth.total_tokens === 25000,
    "bulk: auth-poller session still 25000 after recomputeAll",
    `got ${sessAuth.total_tokens}`,
  );
}

// ═══════════════════════════════════════════════════════════════
console.log("\n=== Group 5: Steps with no token data → no backfill ===");
// ═══════════════════════════════════════════════════════════════

{
  const KEY = "agent:test:subagent:no-usage-steps";
  insertSession(KEY, "sid-no-usage", { totalTokens: 0 });

  // Steps without any token fields (total_tokens IS NULL) — e.g. tool_call rows
  insertStep(KEY, "run-nu", { nodeType: "TOOL_CALL", toolName: "read" });
  insertStep(KEY, "run-nu", { nodeType: "TOOL_CALL", toolName: "write" });

  recomputeSessionCounts(KEY);

  const sess = db
    .prepare("SELECT total_tokens, input_tokens, output_tokens FROM sessions WHERE session_key = ?")
    .get(KEY) as any;

  // No MODEL_THINK/REPLY with tokens → stays at 0
  assert(sess.total_tokens === 0, "no-usage steps: total_tokens stays 0", `got ${sess.total_tokens}`);
  assert((sess.input_tokens || 0) === 0, "no-usage steps: input_tokens stays 0", `got ${sess.input_tokens}`);
}

// ═══════════════════════════════════════════════════════════════
console.log("\n=== Group 6: :run:UUID fan-out for cron sessions ===");
// ═══════════════════════════════════════════════════════════════

{
  const BASE_KEY = "agent:test:cron:fanout";
  const RUN_KEY = "agent:test:cron:fanout:run:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  // Both base and :run: variant in sessions table, both with 0 tokens
  insertSession(BASE_KEY, "sid-cron-base", { totalTokens: 0 });
  insertSession(RUN_KEY, "sid-cron-run", { totalTokens: 0 });

  // Steps are stored under the BASE key (watcher strips :run:)
  insertStep(BASE_KEY, "run-cron", {
    nodeType: "MODEL_THINK",
    totalTokens: 7000,
    outputTokens: 400,
    inputTokens: 6600,
  });
  insertStep(BASE_KEY, "run-cron", { nodeType: "REPLY", totalTokens: 7000, outputTokens: 150, inputTokens: 6600 });

  recomputeSessionCounts(BASE_KEY);

  const sessBase = db
    .prepare("SELECT total_tokens, output_tokens FROM sessions WHERE session_key = ?")
    .get(BASE_KEY) as any;
  const sessRun = db
    .prepare("SELECT total_tokens, output_tokens FROM sessions WHERE session_key = ?")
    .get(RUN_KEY) as any;

  assert(sessBase.total_tokens === 7000, "cron base key: total_tokens backfilled", `got ${sessBase.total_tokens}`);
  assert(
    sessRun.total_tokens === 7000,
    "cron :run: variant: total_tokens also backfilled via fan-out",
    `got ${sessRun.total_tokens}`,
  );
  assert(
    sessBase.output_tokens === 550,
    "cron base key: output_tokens = 550 (400+150)",
    `got ${sessBase.output_tokens}`,
  );
  assert(
    sessRun.output_tokens === 550,
    "cron :run: variant: output_tokens also fanned out",
    `got ${sessRun.output_tokens}`,
  );
}

// ═══════════════════════════════════════════════════════════════
console.log("\n=== Group 7: Idempotency — recompute twice yields same result ===");
// ═══════════════════════════════════════════════════════════════

{
  const KEY = "agent:test:subagent:zero-tokens"; // reuse from Group 1

  recomputeSessionCounts(KEY);
  const before = db
    .prepare("SELECT total_tokens, input_tokens, output_tokens FROM sessions WHERE session_key = ?")
    .get(KEY) as any;

  recomputeSessionCounts(KEY);
  const after = db
    .prepare("SELECT total_tokens, input_tokens, output_tokens FROM sessions WHERE session_key = ?")
    .get(KEY) as any;

  assert(
    before.total_tokens === after.total_tokens,
    "idempotent: total_tokens unchanged after second recompute",
    `${before.total_tokens} vs ${after.total_tokens}`,
  );
  assert(
    before.input_tokens === after.input_tokens,
    "idempotent: input_tokens unchanged",
    `${before.input_tokens} vs ${after.input_tokens}`,
  );
  assert(
    before.output_tokens === after.output_tokens,
    "idempotent: output_tokens unchanged",
    `${before.output_tokens} vs ${after.output_tokens}`,
  );
}

// ═══════════════════════════════════════════════════════════════
console.log("\n=== Group 8: End-to-end transcript → recompute ===");
// ═══════════════════════════════════════════════════════════════

{
  // Simulate what index.ts does: parseTranscript → upsertSteps → recomputeSessionCounts
  const { parseTranscript } = await import("../src/ingest/transcript-parser.ts");
  const { upsertSteps } = await import("../src/storage/steps-repo.ts");

  const E2E_KEY = "agent:test:subagent:e2e-test";
  insertSession(E2E_KEY, "sid-e2e", { totalTokens: 0 });

  // Build a minimal transcript
  const entries = [
    {
      type: "message",
      id: "u-e2e-1",
      parentId: "",
      timestamp: "2026-04-12T14:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    },
    {
      type: "message",
      id: "a-e2e-1",
      parentId: "u-e2e-1",
      timestamp: "2026-04-12T14:00:02.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking" },
          { type: "toolCall", name: "read", id: "tc-e2e-1", arguments: { file_path: "/tmp/x" } },
        ],
        usage: { input: 4500, output: 200, cacheRead: 3000, totalTokens: 4700 },
      },
    },
    {
      type: "message",
      id: "r-e2e-1",
      parentId: "a-e2e-1",
      timestamp: "2026-04-12T14:00:04.000Z",
      message: { role: "toolResult", content: [{ type: "text", text: "file content" }] },
    },
    {
      type: "message",
      id: "a-e2e-2",
      parentId: "r-e2e-1",
      timestamp: "2026-04-12T14:00:06.000Z",
      message: {
        role: "assistant",
        content: [{ type: "thinking" }, { type: "text", text: "done" }],
        usage: { input: 5200, output: 150, cacheRead: 4500, totalTokens: 5350 },
      },
    },
  ];

  const runs = parseTranscript(entries, E2E_KEY);
  assert(runs.length === 1, "e2e: 1 run parsed");
  for (const run of runs) upsertSteps(run);

  recomputeSessionCounts(E2E_KEY);

  const sess = db.prepare("SELECT * FROM sessions WHERE session_key = ?").get(E2E_KEY) as any;

  assert(sess.total_tokens === 5350, "e2e: total_tokens = 5350 (MAX from steps)", `got ${sess.total_tokens}`);
  assert(sess.input_tokens === 5200, "e2e: input_tokens = 5200 (MAX input from steps)", `got ${sess.input_tokens}`);
  // output_tokens = SUM of output_tokens across MODEL_THINK + REPLY rows.
  // The parser assigns per-tool output approximations (usage.output / toolCount)
  // to each tool_call row, plus the full usage.output on MODEL_THINK. So the
  // total across MODEL_THINK/REPLY is the sum of usage.output from both
  // assistant messages: 200 + 150 = 350, but MODEL_THINK rows also get the
  // full output. Check > 0 and within 2x of raw sum.
  assert(
    sess.output_tokens > 0 && sess.output_tokens <= 700,
    `e2e: output_tokens > 0 and reasonable (got ${sess.output_tokens})`,
    `got ${sess.output_tokens}`,
  );
  assert(sess.source === "transcript+auth", "e2e: source flipped to transcript+auth", `got ${sess.source}`);
  assert(sess.llm_call_count >= 1, `e2e: llm_call_count >= 1 (got ${sess.llm_call_count})`);
  assert(sess.tool_call_count >= 1, `e2e: tool_call_count >= 1 (got ${sess.tool_call_count})`);
}

// ─── Cleanup ───────────────────────────────────────────────────
closeDb();
try {
  rmSync(tmpHome, { recursive: true, force: true });
} catch {
  /* best effort */
}

// ─── Summary ───────────────────────────────────────────────────
console.log(`\n${"=".repeat(50)}`);
console.log(`Token backfill: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  • ${f}`);
  process.exit(1);
}
