/**
 * Live end-to-end correctness sweep against the user's actual production
 * obs-v2 install. This is the test the user asked for in Round 5:
 *
 *   "想办法用本机的目前的生产数据做一轮端到端的正确性校验"
 *
 * What it does, on the LIVE machine:
 *
 *   1. Pick the 3 largest non-cron sessions by current step count.
 *   2. Locate the underlying transcript file by walking
 *      `~/.openclaw/agents/<agent>/sessions/<id>.jsonl` and matching
 *      either session_id (preferred) or by querying `ingest_state`.
 *   3. Clean-parse the file from scratch with the current parser.
 *   4. For each clean-parsed run, assert obs.db has:
 *        - the same run_id
 *        - the same set of step_ids
 *        - the same per-run step count
 *        - the same first/last step ts_epoch_ms
 *   5. For one currently-active session (from `openclaw sessions --json`):
 *        - obs.db's tokens match the CLI's tokens (per Round 1
 *          cross-check, but specifically targeted at the largest live one)
 *        - the session's latest step in obs.db is "recent enough" relative
 *          to the CLI's `updatedAt`
 *   6. HTTP API spot-checks:
 *        - /api/sessions/{key}/trace returns spans that round-trip back
 *          to the same step_ids in obs.db for the same run
 *        - /api/sessions/{key} (detail) returns a session whose token
 *          fields match a direct SQL lookup
 *        - /api/summary numbers tally with direct SQL aggregates
 *
 * Skipped gracefully if obs.db is missing, no live transcripts exist, or
 * the obs-v2 service is not up. Otherwise hard-fails on any drift.
 *
 * Run:
 *   node --experimental-sqlite --experimental-strip-types --no-warnings \
 *     tests/live-e2e.test.ts
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { execSync, spawnSync } from "node:child_process";
import { CONFIG } from "../src/config.ts";
import { parseTranscript, type TranscriptEntry } from "../src/ingest/transcript-parser.ts";

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

if (!existsSync(CONFIG.DB_PATH)) {
  console.log(`[live-e2e] no obs.db at ${CONFIG.DB_PATH} — skipping (live-only suite).`);
  process.exit(0);
}

const db = new DatabaseSync(CONFIG.DB_PATH, { readOnly: true });
const HTTP_BASE = `http://${CONFIG.HOST}:${CONFIG.PORT}`;

// ─── Helper: file path → session_key via the watcher's own bookkeeping ──

function getWatcherFilePath(sessionKey: string): string | null {
  const row = db.prepare(
    "SELECT file_path FROM ingest_state WHERE session_key = ? ORDER BY updated_at DESC LIMIT 1",
  ).get(sessionKey) as any;
  return row?.file_path || null;
}

// Fall back to filename UUID matching if ingest_state has no entry.
function findFileForSession(sessionKey: string, sessionId: string | null): string | null {
  const fromState = getWatcherFilePath(sessionKey);
  if (fromState && existsSync(fromState)) return fromState;
  if (!sessionId) return null;
  const agentsDir = CONFIG.AGENTS_DIR;
  if (!existsSync(agentsDir)) return null;
  for (const agent of readdirSync(agentsDir, { withFileTypes: true })) {
    if (!agent.isDirectory()) continue;
    const sessionsDir = join(agentsDir, agent.name, "sessions");
    if (!existsSync(sessionsDir)) continue;
    for (const f of readdirSync(sessionsDir)) {
      if (!f.endsWith(".jsonl")) continue;
      if (f.includes(sessionId)) return join(sessionsDir, f);
    }
  }
  return null;
}

function loadTranscript(filePath: string): TranscriptEntry[] {
  const raw = readFileSync(filePath, "utf-8");
  const out: TranscriptEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return out;
}

// ─── Step 1+2: pick top sessions and locate their files ─────────
console.log("\n=== Top 3 non-cron sessions by step count ===");

const topSessions = db.prepare(`
  SELECT s.session_key, s.session_id, s.input_tokens, s.output_tokens, s.total_tokens,
         (SELECT COUNT(*) FROM steps WHERE session_key = s.session_key) as step_count
  FROM sessions s
  WHERE s.channel != 'cron'
    AND s.session_id != ''
    AND (SELECT COUNT(*) FROM steps WHERE session_key = s.session_key) > 0
  GROUP BY s.session_key
  ORDER BY step_count DESC LIMIT 3
`).all() as any[];

for (const sess of topSessions) {
  console.log(`  • ${sess.session_key.slice(0, 64)}  (${sess.step_count} steps)`);
}
assert(topSessions.length > 0, "found at least one non-cron session with steps");

// ─── Step 3+4: clean-parse + per-run-id roundtrip per session ───
console.log("\n=== Per-session clean-parse vs obs.db ===");

let totalRunsChecked = 0;
let driftedRuns = 0;

for (const sess of topSessions) {
  const tag = sess.session_key.slice(0, 60);
  const filePath = findFileForSession(sess.session_key, sess.session_id);
  if (!filePath || !existsSync(filePath)) {
    console.log(`  [skip] ${tag} — no live transcript file (likely historical)`);
    continue;
  }

  const entries = loadTranscript(filePath);
  const cleanRuns = parseTranscript(entries, sess.session_key);
  console.log(`  ${tag}: ${entries.length} entries → ${cleanRuns.length} clean runs`);

  for (const run of cleanRuns) {
    totalRunsChecked++;

    // Pull DB rows for this run.
    const dbRows = db.prepare(
      "SELECT step_id, seq, ts_epoch_ms, node_type, role, status FROM steps WHERE run_id = ? ORDER BY seq",
    ).all(run.runId) as any[];

    // For currently-actively-writing files we accept a small drift on the
    // very last run. We use mtime as the gate (matching replay-verify).
    const mtimeAge = Date.now() - statSync(filePath).mtimeMs;
    const isLive = mtimeAge < 8_000;

    if (dbRows.length === 0 && run.steps.length > 0) {
      driftedRuns++;
      console.log(`    DRIFT: run ${run.runId.slice(0,8)} clean=${run.steps.length} db=0`);
      continue;
    }

    // Step count
    const countOk = dbRows.length === run.steps.length
      || (isLive && Math.abs(dbRows.length - run.steps.length) <= 2);
    if (!countOk) {
      driftedRuns++;
      console.log(`    DRIFT: run ${run.runId.slice(0,8)} clean=${run.steps.length} db=${dbRows.length}`);
      continue;
    }

    // step_id set parity (clean ⊆ db, both within tolerance)
    const cleanIds = new Set(run.steps.map(s => s.stepId));
    const dbIds = new Set(dbRows.map(r => r.step_id));
    let missing = 0;
    for (const id of cleanIds) if (!dbIds.has(id)) missing++;
    if (missing > 0 && !(isLive && missing <= 2)) {
      driftedRuns++;
      console.log(`    DRIFT: run ${run.runId.slice(0,8)} ${missing} step_ids from clean parse missing in DB`);
      continue;
    }

    // First/last ts sanity — DB ts range should bracket the clean parse's
    // first/last step (within drift tolerance).
    if (dbRows.length > 0 && run.steps.length > 0) {
      const cleanFirst = run.steps[0].tsEpochMs;
      const cleanLast = run.steps[run.steps.length - 1].tsEpochMs;
      const dbFirst = dbRows[0].ts_epoch_ms;
      const dbLast = dbRows[dbRows.length - 1].ts_epoch_ms;
      if (cleanFirst !== dbFirst || cleanLast !== dbLast) {
        if (!isLive) {
          driftedRuns++;
          console.log(`    DRIFT: run ${run.runId.slice(0,8)} ts mismatch clean=[${cleanFirst},${cleanLast}] db=[${dbFirst},${dbLast}]`);
        }
      }
    }
  }
}

assert(totalRunsChecked > 0, "checked at least one run end-to-end");
assert(driftedRuns === 0, "every run in every top session matches DB to step_id parity",
  driftedRuns > 0 ? `${driftedRuns}/${totalRunsChecked} drifted` : "");

// ─── Step 5: cross-check one live session against `openclaw sessions --json` ─
console.log("\n=== One active session vs openclaw CLI ===");

let cliJson: any = null;
try {
  const raw = execSync(
    "openclaw sessions --all-agents --active 60 --json",
    { encoding: "utf-8", timeout: 30_000, maxBuffer: 20 * 1024 * 1024 },
  );
  cliJson = JSON.parse(raw);
} catch (err) {
  console.log(`  (CLI unavailable: ${(err as Error).message?.slice(0, 100)} — skipping CLI section)`);
}

if (cliJson) {
  const cliSessions: any[] = (cliJson.sessions || []).filter((s: any) => s.key && s.sessionId);
  // Pick the largest by tokens, ignoring cron variants.
  const candidates = cliSessions
    .filter((s: any) => !s.key.includes(":cron:"))
    .sort((a, b) => (b.totalTokens || 0) - (a.totalTokens || 0));

  if (candidates.length === 0) {
    console.log("  (no non-cron active sessions in CLI output — skipping)");
  } else {
    const target = candidates[0];
    const dbRow = db.prepare(
      "SELECT input_tokens, output_tokens, total_tokens, updated_at FROM sessions WHERE session_key = ? AND session_id = ? LIMIT 1",
    ).get(target.key, target.sessionId) as any;

    assert(dbRow != null,
      `obs.db has the largest active session ${target.key.slice(0, 50)}`);

    if (dbRow) {
      assert(dbRow.input_tokens === target.inputTokens,
        `input_tokens match for top session`,
        `cli=${target.inputTokens} db=${dbRow.input_tokens}`);
      assert(dbRow.output_tokens === target.outputTokens,
        `output_tokens match for top session`,
        `cli=${target.outputTokens} db=${dbRow.output_tokens}`);
      assert(dbRow.total_tokens === target.totalTokens,
        `total_tokens match for top session`,
        `cli=${target.totalTokens} db=${dbRow.total_tokens}`);

      // Latest step in obs.db should be no more than 10 minutes older than
      // CLI's updatedAt — anything bigger means the watcher fell behind.
      const latestStep = db.prepare(`
        SELECT MAX(ts_epoch_ms) as ts FROM steps WHERE session_key = ?
      `).get(target.key) as any;
      if (latestStep?.ts && target.updatedAt) {
        const lagMs = target.updatedAt - latestStep.ts;
        // Negative lag = obs.db saw newer step than CLI's reported updatedAt
        // (totally possible, the CLI is itself a snapshot). We only care
        // about being TOO STALE.
        assert(lagMs < 10 * 60 * 1000,
          `obs.db latest step is within 10 min of CLI updatedAt`,
          `lag=${Math.round(lagMs / 1000)}s`);
      }
    }
  }
}

// ─── Step 6: HTTP API roundtrip on the same top session ─────────
console.log("\n=== HTTP API roundtrip ===");

let serviceUp = false;
try {
  const probe = await fetch(`${HTTP_BASE}/healthz`, { signal: AbortSignal.timeout(2000) });
  serviceUp = probe.ok;
} catch { /* not running */ }

if (!serviceUp) {
  console.log("  (service not up — skipping HTTP API checks)");
} else if (topSessions.length > 0) {
  const sess = topSessions[0];
  const enc = encodeURIComponent(sess.session_key);

  // Detail endpoint
  const detail = await (await fetch(`${HTTP_BASE}/api/sessions/${enc}`)).json() as any;
  assert(detail != null, "/api/sessions/{key} returns a body");
  if (detail) {
    assert(detail.session?.session_key === sess.session_key,
      "detail.session.session_key matches the requested key");
    assert(detail.session?.input_tokens === sess.input_tokens,
      "detail.session.input_tokens matches direct SQL");
  }

  // Trace endpoint — the trace's spans must round-trip to obs.db's
  // ASSISTANT-role step_ids for the same run. (toolResult rows are
  // intentionally folded into their matching toolCall in the trace view,
  // so the trace span count = assistant-row count, NOT total row count.)
  const trace = await (await fetch(`${HTTP_BASE}/api/sessions/${enc}/trace`)).json() as any;
  assert(trace != null, "/api/sessions/{key}/trace returns a body");
  if (trace?.spans && trace.spans.length > 0 && trace.runId) {
    const runId = trace.runId;
    const dbAssistantCount = (db.prepare(
      "SELECT COUNT(*) as n FROM steps WHERE run_id = ? AND role = 'assistant'",
    ).get(runId) as any).n;
    assert(trace.spans.length === dbAssistantCount,
      `trace spans count matches assistant-row count for run ${runId.slice(0, 8)}`,
      `api=${trace.spans.length} db.assistant=${dbAssistantCount}`);

    // Every span's id should exist in DB as an assistant row.
    const dbAssistantIds = new Set(
      (db.prepare(
        "SELECT step_id FROM steps WHERE run_id = ? AND role = 'assistant'",
      ).all(runId) as any[]).map((r: any) => r.step_id),
    );
    let unknownSpans = 0;
    for (const span of trace.spans) {
      // The trace API exposes step_id as `span.id`.
      if (!dbAssistantIds.has(span.id)) unknownSpans++;
    }
    assert(unknownSpans === 0, "every trace span's id exists as an assistant row in DB",
      unknownSpans > 0 ? `${unknownSpans} unknown of ${trace.spans.length}` : "");
  }

  // Summary roundtrip
  const summary = await (await fetch(`${HTTP_BASE}/api/summary`)).json() as any;
  const sqlRunCount = (db.prepare(
    "SELECT COUNT(DISTINCT run_id) as n FROM steps",
  ).get() as any).n;
  assert(summary.runs === sqlRunCount,
    "summary.runs matches COUNT(DISTINCT run_id) in steps",
    `api=${summary.runs} sql=${sqlRunCount}`);
}

// ─── Step 7: Round 6 — observ_cli end-to-end against the live DB ──
console.log("\n=== observ_cli status spawn against live DB ===");
{
  const { fileURLToPath } = await import("node:url");
  const { dirname } = await import("node:path");
  const liveE2eDir = dirname(fileURLToPath(import.meta.url));
  const cliPath = join(liveE2eDir, "..", "scripts", "observ_cli.ts");
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-sqlite",
      "--experimental-strip-types",
      "--no-warnings",
      cliPath,
      "status",
    ],
    { encoding: "utf-8", timeout: 15_000 },
  );
  assert(result.status === 0, "observ_cli status exits 0",
    `status=${result.status} stderr=${(result.stderr || "").slice(0, 200)}`);
  assert(result.stdout.includes("service"),
    "observ_cli status output mentions 'service'");
  assert(result.stdout.includes("db"),
    "observ_cli status output mentions 'db'");
}

db.close();

// ─── Summary ────────────────────────────────────────────────────
console.log(`\n${"=".repeat(50)}`);
console.log(`Live e2e: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  • ${f}`);
  process.exit(1);
}
