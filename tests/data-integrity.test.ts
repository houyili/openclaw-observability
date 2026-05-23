/**
 * Data integrity sweep against the LIVE obs.db.
 *
 * This is a "the database itself must hold up" test — independent of
 * what the parser does today. It walks the actual rows and asserts every
 * structural invariant the schema and the parser are supposed to enforce
 * jointly. If any of these fire, something has been writing bad data
 * (parser bug, schema migration drift, manual SQL).
 *
 * Categories:
 *
 *   A. Whole-table sanity
 *      - no NULLs in non-nullable columns
 *      - node_type / status / role / error_type are members of the
 *        enumerated sets we control
 *      - durations are non-negative
 *
 *   B. Per-run integrity (sampled — top N runs by step count)
 *      - step_ids are unique within a run_id
 *      - seq is dense or at least monotone non-decreasing
 *      - ts_epoch_ms is monotone non-decreasing in seq order
 *      - the first step in a run is an `assistant` step (not a stray
 *        toolResult)
 *
 *   C. Cross-table integrity
 *      - every distinct session_key in `steps` has either a matching
 *        sessions row OR is a base key for a `:run:UUID` variant
 *      - registry rows referenced by steps still exist
 *
 *   D. HTTP API consistency (only when /healthz is up)
 *      - GET /api/sessions returns same total as direct SQL
 *      - GET /api/skills row.call_count matches direct SQL per skill
 *
 * Skipped gracefully when obs.db doesn't exist (clean clone). Otherwise
 * fails on any drift.
 *
 * Run:
 *   node --experimental-sqlite --experimental-strip-types --no-warnings \
 *     tests/data-integrity.test.ts
 */

import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { CONFIG } from "../src/config.ts";
import { redactKey, redactId } from "./_lib/redact.ts";

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
  console.log(`[data-integrity] obs.db not found at ${CONFIG.DB_PATH} — skipping (this suite is live-only).`);
  process.exit(0);
}

// Use the current code's dynamic stale/blocker logic before asserting stored
// session state. This keeps the live-only suite from depending on whether the
// long-running service has already restarted onto this revision.
{
  const { recomputeAllSessionOps } = await import("../src/storage/sessions-repo.ts");
  const { closeDb } = await import("../src/storage/db.ts");
  recomputeAllSessionOps();
  closeDb();
}

const db = new DatabaseSync(CONFIG.DB_PATH, { readOnly: true });

// ─── A. Whole-table sanity ──────────────────────────────────────
console.log("\n=== A. Whole-table sanity ===");

const stepCount = (db.prepare("SELECT COUNT(*) as n FROM steps").get() as any).n;
const sessionCount = (db.prepare("SELECT COUNT(*) as n FROM sessions").get() as any).n;
console.log(`  (probing ${stepCount} steps, ${sessionCount} sessions)`);

// A1: no NULLs in non-nullable columns
function nullCount(col: string): number {
  return (db.prepare(`SELECT COUNT(*) as n FROM steps WHERE ${col} IS NULL`).get() as any).n;
}
assert(nullCount("session_key") === 0, "no NULL session_key in steps");
assert(nullCount("run_id")      === 0, "no NULL run_id in steps");
assert(nullCount("node_type")   === 0, "no NULL node_type in steps");
assert(nullCount("ts")          === 0, "no NULL ts in steps");
assert(nullCount("ts_epoch_ms") === 0, "no NULL ts_epoch_ms in steps");
assert(nullCount("role")        === 0, "no NULL role in steps");
assert(nullCount("status")      === 0, "no NULL status in steps");
assert(nullCount("step_id")     === 0, "no NULL step_id in steps");

// A2: enumerated columns hold expected values
const KNOWN_NODE_TYPES = new Set([
  "MODEL_THINK", "TOOL_CALL", "SHELL_EXEC", "MCP_CALL", "SUBAGENT_SPAWN",
  "SKILL_EXEC", "EXTERNAL_CALL", "INTERNAL_OP", "REPLY",
]);
const KNOWN_STATUS = new Set(["ok", "error", "running"]);
const KNOWN_ROLES = new Set(["assistant", "toolResult"]);
const KNOWN_ERROR_TYPES = new Set([
  "auth_error", "timeout", "not_found", "rate_limit", "http_4xx", "http_5xx", "unknown",
]);

const distinctNodes = new Set<string>(
  (db.prepare("SELECT DISTINCT node_type FROM steps").all() as any[]).map((r: any) => r.node_type),
);
const unknownNodes = [...distinctNodes].filter(t => !KNOWN_NODE_TYPES.has(t));
assert(unknownNodes.length === 0, "all node_type values are in the known set",
  unknownNodes.length > 0 ? `found: ${JSON.stringify(unknownNodes)}` : "");

const distinctStatus = new Set<string>(
  (db.prepare("SELECT DISTINCT status FROM steps").all() as any[]).map((r: any) => r.status),
);
const unknownStatus = [...distinctStatus].filter(s => !KNOWN_STATUS.has(s));
assert(unknownStatus.length === 0, "all status values are in {ok, error, running}",
  unknownStatus.length > 0 ? `found: ${JSON.stringify(unknownStatus)}` : "");

const distinctRoles = new Set<string>(
  (db.prepare("SELECT DISTINCT role FROM steps").all() as any[]).map((r: any) => r.role),
);
const unknownRoles = [...distinctRoles].filter(r => !KNOWN_ROLES.has(r));
assert(unknownRoles.length === 0, "all role values are in {assistant, toolResult}",
  unknownRoles.length > 0 ? `found: ${JSON.stringify(unknownRoles)}` : "");

const distinctErrors = new Set<string>(
  (db.prepare("SELECT DISTINCT error_type FROM steps WHERE error_type IS NOT NULL").all() as any[])
    .map((r: any) => r.error_type),
);
const unknownErrors = [...distinctErrors].filter(t => !KNOWN_ERROR_TYPES.has(t));
assert(unknownErrors.length === 0, "all error_type values are in the known set",
  unknownErrors.length > 0 ? `found: ${JSON.stringify(unknownErrors)}` : "");

// A3: error rows must carry an error_text
const errorsWithoutText =
  (db.prepare("SELECT COUNT(*) as n FROM steps WHERE status='error' AND (error_text IS NULL OR error_text='')").get() as any).n;
assert(errorsWithoutText === 0, "every status='error' row has an error_text",
  errorsWithoutText > 0 ? `${errorsWithoutText} rows missing error_text` : "");

// A4: durations are non-negative (NULL is allowed for in-progress steps)
const negDurations =
  (db.prepare("SELECT COUNT(*) as n FROM steps WHERE duration_ms < 0").get() as any).n;
assert(negDurations === 0, "no negative duration_ms",
  negDurations > 0 ? `${negDurations} rows with negative duration` : "");

// A5: step_id is unique across the entire steps table (it's PK so this is
// schema-enforced, but a paranoia check costs nothing)
const dupStepIds = (db.prepare(`
  SELECT COUNT(*) as n FROM (
    SELECT step_id, COUNT(*) as c FROM steps GROUP BY step_id HAVING c > 1
  )
`).get() as any).n;
assert(dupStepIds === 0, "step_id is globally unique");

// A6: every assistant MODEL_THINK has output_tokens (or none if usage absent)
const modelThinkBadTokens = (db.prepare(`
  SELECT COUNT(*) as n FROM steps WHERE node_type = 'MODEL_THINK' AND output_tokens < 0
`).get() as any).n;
assert(modelThinkBadTokens === 0, "no MODEL_THINK with negative output_tokens");

// A7: registry referenced by steps is consistent
const orphanSkillRefs = (db.prepare(`
  SELECT COUNT(DISTINCT skill_name) as n FROM steps
  WHERE skill_name IS NOT NULL
    AND skill_name NOT IN (SELECT name FROM registry WHERE type='skill')
`).get() as any).n;
assert(orphanSkillRefs === 0, "every skill_name referenced in steps exists in registry",
  orphanSkillRefs > 0 ? `${orphanSkillRefs} orphan skill refs` : "");

// ─── B. Per-run integrity (top 5 runs by step count) ────────────
console.log("\n=== B. Per-run integrity (top 5 runs) ===");

const topRuns = db.prepare(`
  SELECT run_id, session_key, COUNT(*) as n
  FROM steps GROUP BY run_id ORDER BY n DESC LIMIT 5
`).all() as any[];

for (const r of topRuns) {
  const tag = `${r.run_id.slice(0, 8)} (${r.n} steps)`;
  const rows = db.prepare(
    "SELECT step_id, seq, ts_epoch_ms, role FROM steps WHERE run_id = ? ORDER BY seq",
  ).all(r.run_id) as any[];

  // B1: step_ids unique within this run
  const idSet = new Set(rows.map(x => x.step_id));
  assert(idSet.size === rows.length, `${tag}: step_ids unique within run`,
    `${rows.length} rows, ${idSet.size} unique`);

  // B2: seq monotone non-decreasing
  let monoSeq = true;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].seq < rows[i - 1].seq) { monoSeq = false; break; }
  }
  assert(monoSeq, `${tag}: seq is monotone non-decreasing`);

  // B3: ts_epoch_ms monotone non-decreasing in seq order
  let monoTs = true;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].ts_epoch_ms < rows[i - 1].ts_epoch_ms) { monoTs = false; break; }
  }
  assert(monoTs, `${tag}: ts_epoch_ms monotone non-decreasing in seq order`);

  // B4: the first step is `assistant`-role (a stray toolResult at seq=0
  // would mean we lost the user-message boundary)
  if (rows.length > 0) {
    assert(rows[0].role === "assistant", `${tag}: first step is role=assistant`,
      `got role=${rows[0].role}`);
  }
}

// ─── C. Cross-table integrity ───────────────────────────────────
console.log("\n=== C. Cross-table integrity ===");

// Helper: strip :run:UUID suffix to get the base key.
function toBaseKey(k: string): string {
  return k.replace(/:run:[a-f0-9-]+$/, "");
}

// Steps preserve history — keys can outlive their sessions row by design
// (auth-poller only carries the last AUTH_ACTIVE_MINUTES window, while
// the steps table is never pruned per constitution §6). The right
// invariant is the OPPOSITE direction: every base key currently in
// the sessions table SHOULD have steps in obs.db, modulo a small
// handful of brand-new auth-only sessions that haven't logged any
// transcript yet.

const sessionBaseKeys = new Set<string>(
  (db.prepare("SELECT DISTINCT session_key FROM sessions").all() as any[])
    .map((r: any) => toBaseKey(r.session_key)),
);
const stepBaseKeys = new Set<string>(
  (db.prepare("SELECT DISTINCT session_key FROM steps").all() as any[])
    .map((r: any) => r.session_key),
);

let sessionsWithoutSteps = 0;
for (const sk of sessionBaseKeys) {
  if (!stepBaseKeys.has(sk)) sessionsWithoutSteps++;
}
const sessionsWithoutStepsPct = sessionBaseKeys.size > 0
  ? sessionsWithoutSteps / sessionBaseKeys.size
  : 0;
// "auth-only session that has never written a transcript yet" is normal;
// allow a fairly generous fraction.
assert(sessionsWithoutStepsPct <= 0.5,
  `≤ 50% of session base keys lack any steps (rest are normal auth-only)`,
  `${sessionsWithoutSteps}/${sessionBaseKeys.size} (${(sessionsWithoutStepsPct * 100).toFixed(1)}%)`);

// C2: every "transcript+auth" session base key MUST have steps somewhere
// (that's literally what the source field means after recomputeSessionCounts
// upgrades it). Use base-key lookup, not exact key, because cron rows
// have :run:UUID suffixes that don't appear in steps.
const taSessionKeys = new Set<string>(
  (db.prepare(
    "SELECT DISTINCT session_key FROM sessions WHERE source = 'transcript+auth'",
  ).all() as any[]).map((r: any) => toBaseKey(r.session_key)),
);
let taWithoutSteps = 0;
for (const sk of taSessionKeys) {
  if (!stepBaseKeys.has(sk)) taWithoutSteps++;
}
assert(taWithoutSteps === 0,
  `every 'transcript+auth' session base key has matching steps`,
  taWithoutSteps > 0 ? `${taWithoutSteps}/${taSessionKeys.size} missing` : "");

// C3: the OVERLAP between sessions and steps base-key sets should be
// substantial. If the live machine has any active session at all, at
// least one of them must show up in steps. (This catches the case where
// auth-poller is healthy but the watcher stopped writing.)
let overlap = 0;
for (const sk of sessionBaseKeys) if (stepBaseKeys.has(sk)) overlap++;
if (sessionBaseKeys.size > 0) {
  assert(overlap > 0,
    "at least one session base key has matching steps (watcher is alive)",
    `overlap=${overlap}`);
}

// ─── C.1 step_id collision guard (R4 deferral monitoring) ─────
//
// 08 risk register's R4 says current schema keeps step_id as a global
// primary key, with `PRIMARY KEY (session_key, step_id)` reserved for
// v0.2. To detect the moment a collision actually shows up in live
// data — which would force a real migration — this assert is run
// against the LIVE obs.db on every integrity sweep.
//
// A collision is defined as "the same step_id appearing under more
// than one (session_key, run_id) scope". Within a single run a step
// MUST be unique (already covered by B1 above); across runs the
// current global PK forbids any collision physically (the INSERT
// would silently UPDATE the existing row), but the guard catches
// the moment we ever loosen the schema.
console.log("\n=== C.1 step_id collision guard (R4 deferral) ===");
{
  const collisions = db.prepare(`
    SELECT step_id, COUNT(DISTINCT (session_key || '|' || run_id)) as scopes
    FROM steps
    GROUP BY step_id
    HAVING scopes > 1
    LIMIT 5
  `).all() as Array<{ step_id: string; scopes: number }>;
  assert(
    collisions.length === 0,
    "no step_id collisions across (session_key, run_id) scopes",
    collisions.length > 0
      ? `${collisions.length} colliding step_id(s); first scopes=${collisions[0].scopes} — v0.2 must do composite identity migration`
      : "",
  );
}

// ─── D. HTTP API consistency (only if obs-v2 service is up) ─────
console.log("\n=== D. HTTP API consistency (if service up) ===");

const HTTP_BASE = `http://${CONFIG.HOST}:${CONFIG.PORT}`;
let serviceUp = false;
try {
  const probe = await fetch(`${HTTP_BASE}/healthz`, { signal: AbortSignal.timeout(2000) });
  serviceUp = probe.ok;
} catch { /* not running */ }

if (!serviceUp) {
  console.log("  (service not up — skipping HTTP API checks)");
} else {
  // D1: /api/sessions total matches direct SQL count for non-cron tab
  const apiNonCron = await (await fetch(`${HTTP_BASE}/api/sessions?tab=sessions&page=1`)).json() as any;
  const sqlNonCron = (db.prepare("SELECT COUNT(*) as n FROM sessions WHERE channel != 'cron'").get() as any).n;
  assert(apiNonCron.total === sqlNonCron,
    "/api/sessions?tab=sessions total matches SELECT COUNT(*) WHERE channel != 'cron'",
    `api=${apiNonCron.total} sql=${sqlNonCron}`);

  const apiCron = await (await fetch(`${HTTP_BASE}/api/sessions?tab=cron&page=1`)).json() as any;
  const sqlCron = (db.prepare("SELECT COUNT(*) as n FROM sessions WHERE channel = 'cron'").get() as any).n;
  assert(apiCron.total === sqlCron,
    "/api/sessions?tab=cron total matches SELECT COUNT(*) WHERE channel = 'cron'",
    `api=${apiCron.total} sql=${sqlCron}`);

  // D2: /api/skills row.call_count matches direct SQL per skill (sample top 3)
  // Endpoint returns { range, skills, rankings } — pull the .skills array.
  const apiSkillsResp = await (await fetch(`${HTTP_BASE}/api/skills?range=all`)).json() as any;
  const skillRows: any[] = apiSkillsResp.skills || [];
  const topSkills = skillRows.filter(s => s.call_count > 0).slice(0, 3);
  for (const s of topSkills) {
    const sql = (db.prepare(
      "SELECT COUNT(*) as n FROM steps WHERE skill_name = ?",
    ).get(s.name) as any).n;
    assert(sql === s.call_count,
      `/api/skills "${s.name}" call_count matches SQL`,
      `api=${s.call_count} sql=${sql}`);
  }

  // D3: /api/summary tools count matches SQL
  const apiSummary = await (await fetch(`${HTTP_BASE}/api/summary`)).json() as any;
  const sqlTools = (db.prepare(`
    SELECT COUNT(*) as n FROM steps
    WHERE role = 'assistant' AND node_type NOT IN ('MODEL_THINK','REPLY')
  `).get() as any).n;
  assert(apiSummary.tools === sqlTools,
    "/api/summary tools count matches SQL aggregate",
    `api=${apiSummary.tools} sql=${sqlTools}`);

  // D4: /healthz reports the same step count as direct SQL
  const apiHealth = await (await fetch(`${HTTP_BASE}/healthz`)).json() as any;
  assert(apiHealth.steps === stepCount,
    "/healthz steps count matches SQL",
    `api=${apiHealth.steps} sql=${stepCount}`);
}

// ─── E. Round 6 — Context Length sanity invariants on LIVE data ──
// For up to 5 sample runs that have ≥ 2 MODEL_THINK rows, verify
// `frameworkBaseline + Σ Δ == totalLatest` and that the timeline's
// peak input matches MAX(input_tokens).
console.log("\n=== E. Round 6: Context Length live invariants ===");
{
  const { getContextBreakdown, getContextTimeline } = await import("../src/storage/context-repo.ts");

  // Find runs that have at least 2 MODEL_THINK rows AND a populated input_tokens
  const sampleRuns = db.prepare(`
    SELECT session_key, run_id, COUNT(*) as n
    FROM steps
    WHERE node_type = 'MODEL_THINK' AND input_tokens IS NOT NULL
    GROUP BY session_key, run_id
    HAVING n >= 2
    ORDER BY n DESC LIMIT 5
  `).all() as Array<{ session_key: string; run_id: string; n: number }>;

  if (sampleRuns.length === 0) {
    // First-tick reparse hasn't backfilled yet — that's OK on a freshly
    // restarted obs-v2. Don't fail the suite, just note it.
    console.log("  (no runs with input_tokens populated yet — backfill pending)");
  }

  for (const r of sampleRuns) {
    const tag = `${redactKey(r.session_key)} run=${redactId(r.run_id)}`;

    const breakdown = getContextBreakdown(r.session_key, r.run_id);
    if (!breakdown) {
      assert(false, `${tag}: getContextBreakdown returned a result`);
      continue;
    }
    const sumDelta = breakdown.turns
      .slice(1)
      .reduce((s, t) => s + (t.deltaFromPrev || 0), 0);
    const recomputed = breakdown.frameworkBaseline + sumDelta;
    assert(recomputed === breakdown.totalLatest,
      `${tag}: baseline + Σ Δ == totalLatest`,
      `${breakdown.frameworkBaseline} + ${sumDelta} = ${recomputed}, expected ${breakdown.totalLatest}`);

    const timeline = getContextTimeline(r.session_key, r.run_id);
    if (!timeline) {
      assert(false, `${tag}: getContextTimeline returned a result`);
      continue;
    }

    const dbPeak = (db.prepare(`
      SELECT MAX(input_tokens + COALESCE(cache_read_tokens, 0)) as p FROM steps
      WHERE session_key = ? AND run_id = ? AND input_tokens IS NOT NULL
    `).get(r.session_key, r.run_id) as any).p;
    assert(timeline.cumulative.peakInputTokens === dbPeak,
      `${tag}: timeline peakInputTokens == MAX(input_tokens + cache_read_tokens)`,
      `timeline=${timeline.cumulative.peakInputTokens} db=${dbPeak}`);
  }
}

// ─── F-pre. Round 7 (2026-04-14): updated_at freshness ─────────
console.log("\n=== F-pre. updated_at vs latest step ts drift ===");
{
  // Bug caught 2026-04-14: sessions.updated_at is set ONLY by auth-poller
  // from CLI output. If a session falls out of the CLI's --active window
  // but transcript-watcher keeps ingesting steps, updated_at freezes while
  // the step timestamps keep moving. Fix: recomputeSessionCounts pushes
  // updated_at to MAX(current, latest step ts).
  const drift = db.prepare(`
    SELECT s.session_key, s.updated_at, MAX(st.ts_epoch_ms) as latest_step,
           (MAX(st.ts_epoch_ms) - s.updated_at) as drift_ms
    FROM sessions s
    JOIN steps st ON st.session_key = s.session_key
    WHERE s.updated_at IS NOT NULL
    GROUP BY s.session_key
    HAVING drift_ms > 300000  -- 5 min tolerance
    LIMIT 10
  `).all() as any[];
  assert(
    drift.length === 0,
    "F-pre: no session has updated_at lagging latest step by >5min",
    drift.length > 0
      ? `${drift.length} stale sessions, worst: ${drift[0].session_key} (drift ${Math.round(drift[0].drift_ms / 60000)}m)`
      : undefined,
  );
}

// ─── F-stale. Current op/blocker freshness ─────────────────────
console.log("\n=== F-stale. current processing/blocker freshness ===");
{
  const staleProcessing = db.prepare(`
    SELECT s.session_key, s.diag_state, st.status, st.is_current
    FROM sessions s
    JOIN steps st ON (st.session_key = s.session_key OR s.session_key LIKE st.session_key || ':run:%')
      AND st.ts_epoch_ms = (
        SELECT MAX(ts_epoch_ms) FROM steps latest
        WHERE latest.session_key = s.session_key OR s.session_key LIKE latest.session_key || ':run:%'
      )
    WHERE s.diag_state = 'processing'
      AND COALESCE(st.is_current, 0) = 0
    LIMIT 10
  `).all() as any[];
  assert(staleProcessing.length === 0,
    "F-stale.1: no processing sessions whose latest step is completed",
    staleProcessing.length > 0 ? `${staleProcessing.length} stale processing sessions` : undefined);

  const blockersWithoutCurrentStuck = db.prepare(`
    SELECT s.session_key, s.blocker
    FROM sessions s
    WHERE s.blocker IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM steps st
        WHERE (st.session_key = s.session_key OR s.session_key LIKE st.session_key || ':run:%')
          AND st.is_current = 1
          AND st.is_stuck = 1
      )
    LIMIT 10
  `).all() as any[];
  assert(blockersWithoutCurrentStuck.length === 0,
    "F-stale.2: no blocker without a current stuck step",
    blockersWithoutCurrentStuck.length > 0 ? `${blockersWithoutCurrentStuck.length} stale blockers` : undefined);
}

// ─── F. Round 7: Parent-child relationship integrity ───────────
console.log("\n=== F. Round 7: Parent-child session integrity ===");
{
  // F.1 Every parent_session_key should reference an existing session_key
  const orphans = db.prepare(`
    SELECT DISTINCT s.parent_session_key
    FROM sessions s
    WHERE s.parent_session_key IS NOT NULL
    AND s.parent_session_key NOT IN (SELECT DISTINCT session_key FROM sessions)
  `).all() as any[];
  assert(orphans.length === 0,
    "F.1: no orphaned parent_session_key references",
    orphans.length > 0 ? `${orphans.length} orphans: ${orphans.map((o: any) => o.parent_session_key).slice(0, 3).join(", ")}` : undefined);

  // F.2 COUNT(DISTINCT session_key) == COUNT(*) for child rows (no multi-session_id inflation)
  const inflation = db.prepare(`
    SELECT parent_session_key,
      COUNT(*) as total_rows,
      COUNT(DISTINCT session_key) as distinct_keys
    FROM sessions
    WHERE parent_session_key IS NOT NULL
    GROUP BY parent_session_key
    HAVING total_rows != distinct_keys
  `).all() as any[];
  assert(inflation.length === 0,
    "F.2: child COUNT(*) matches COUNT(DISTINCT session_key) for all parents",
    inflation.length > 0 ? `${inflation.length} parents with inflated counts` : undefined);

  // F.3 Subagent sessions have parent_session_key set (coverage check)
  const subagentTotal = (db.prepare(
    "SELECT COUNT(DISTINCT session_key) as n FROM sessions WHERE channel = 'subagent'"
  ).get() as any).n;
  const subagentWithParent = (db.prepare(
    "SELECT COUNT(DISTINCT session_key) as n FROM sessions WHERE channel = 'subagent' AND parent_session_key IS NOT NULL"
  ).get() as any).n;
  // We expect most subagents to have a parent — warn if coverage is low but don't hard-fail
  // because sessions.json may have been cleaned up for old sessions
  const coverage = subagentTotal > 0 ? subagentWithParent / subagentTotal : 1;
  assert(coverage >= 0.5,
    `F.3: subagent parent coverage >= 50% (${subagentWithParent}/${subagentTotal} = ${(coverage * 100).toFixed(0)}%)`,
    `only ${(coverage * 100).toFixed(0)}% of subagent sessions have a parent`);

  // F.4 idx_sessions_parent index exists
  const indexes = db.prepare("PRAGMA index_list(sessions)").all() as any[];
  assert(indexes.some((idx: any) => idx.name === "idx_sessions_parent"),
    "F.4: idx_sessions_parent index exists");
}

// ─── G. Workflow Graph projection self-validation ──────────────
console.log("\n=== G. Workflow Graph projection self-validation ===");
{
  const { getWorkflowGraph } = await import("../src/storage/workflow-repo.ts");

  const spawnedRuns = db.prepare(`
    SELECT session_key, session_id, run_id, MAX(ts_epoch_ms) as latest_ts,
           SUM(CASE WHEN tool_name = 'sessions_spawn' OR node_type = 'SUBAGENT_SPAWN' THEN 1 ELSE 0 END) as spawns
    FROM steps
    GROUP BY session_key, session_id, run_id
    HAVING spawns > 0
    ORDER BY latest_ts DESC
    LIMIT 8
  `).all() as Array<{ session_key: string; session_id: string | null; run_id: string; latest_ts: number; spawns: number }>;

  const recentRuns = db.prepare(`
    SELECT session_key, session_id, run_id, MAX(ts_epoch_ms) as latest_ts, COUNT(*) as n
    FROM steps
    GROUP BY session_key, session_id, run_id
    ORDER BY latest_ts DESC
    LIMIT 8
  `).all() as Array<{ session_key: string; session_id: string | null; run_id: string; latest_ts: number; n: number }>;

  const seen = new Set<string>();
  const candidates: Array<{ session_key: string; session_id: string | null; run_id: string; kind: string }> = [];
  for (const r of spawnedRuns) {
    const id = `${r.session_key}\n${r.session_id || ""}\n${r.run_id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    candidates.push({ session_key: r.session_key, session_id: r.session_id, run_id: r.run_id, kind: "spawn" });
  }
  for (const r of recentRuns) {
    const id = `${r.session_key}\n${r.session_id || ""}\n${r.run_id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    candidates.push({ session_key: r.session_key, session_id: r.session_id, run_id: r.run_id, kind: "recent" });
    if (candidates.length >= 12) break;
  }

  if (candidates.length === 0) {
    console.log("  (no workflow candidates in live steps table)");
  }

  let warnings = 0;
  for (const c of candidates) {
    const graph = getWorkflowGraph(c.session_key, c.run_id, c.session_id);
    const tag = `${c.kind} ${redactKey(c.session_key)} run=${redactId(c.run_id)} sid=${redactId(c.session_id)}`;
    const errorChecks = graph.validation.checks.filter(ch => ch.status === "error");
    const warningChecks = graph.validation.checks.filter(ch => ch.status === "warning");
    warnings += warningChecks.length;

    assert(graph.validation.status !== "error",
      `${tag}: workflow validation has no errors`,
      errorChecks.map(ch => `${ch.id}: ${ch.message}`).join("; "));
    assert(errorChecks.length === 0,
      `${tag}: no error-level validation checks`,
      errorChecks.map(ch => `${ch.id}: ${ch.message}`).join("; "));
    assert(graph.validation.checks.length >= 8,
      `${tag}: workflow validation ran core checks`,
      `checks=${graph.validation.checks.length}`);
    assert(graph.runId === c.run_id,
      `${tag}: graph runId matches requested runId`,
      `graph=${graph.runId}`);
  }

  console.log(`  (workflow self-validation sampled ${candidates.length} runs, warning checks: ${warnings})`);
}

db.close();

// ─── Summary ────────────────────────────────────────────────────
console.log(`\n${"=".repeat(50)}`);
console.log(`Data integrity: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  • ${f}`);
  process.exit(1);
}
