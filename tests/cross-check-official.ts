/**
 * Cross-check observability-v2 vs OpenClaw official dashboard.
 *
 * The constitution (design_doc_read_only/observablity_design_doc.md §1.3.1)
 * requires: "主表数值必须与 OpenClaw 官方 Dashboard 保持一致。官方 Dashboard
 * 是统计口径上的准绳，尤其是 token 等数值要以它为准".
 *
 * This script pulls the authoritative numbers from
 *    `openclaw sessions --all-agents --active N --json`
 * and diff-checks them against what obs.db currently shows for every
 * overlapping session_key. It fails if token drift > TOLERANCE.
 *
 * Run:
 *   node --experimental-sqlite --experimental-strip-types --no-warnings \
 *     tests/cross-check-official.ts [--active 60] [--tolerance 0]
 *
 * Exit codes:
 *   0 = perfect match (within tolerance)
 *   1 = drift detected OR CLI unavailable
 */

import { execSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { CONFIG } from "../src/config.ts";

// ─── Config ─────────────────────────────────────────────────────

const args = process.argv.slice(2);
function argValue(flag: string, fallback: string): string {
  const i = args.indexOf(flag);
  return (i >= 0 && args[i + 1]) ? args[i + 1] : fallback;
}
const ACTIVE_MINUTES = parseInt(argValue("--active", "60"), 10);
const TOLERANCE = parseInt(argValue("--tolerance", "0"), 10);
const OPENCLAW_BIN = argValue("--bin", process.env.OPENCLAW_BIN || "openclaw");
// Seconds to wait before a single retry if mismatches appear on the first
// pass. auth-poller runs every 30 s, so a 35 s delay guarantees at least one
// fresh poll has landed. Set to 0 to fail fast.
const RETRY_WAIT_SEC = parseInt(argValue("--retry-wait", "35"), 10);

// ─── Fetch official ─────────────────────────────────────────────

interface OfficialSession {
  key: string;
  sessionId: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  model: string;
}

function fetchOfficial(): OfficialSession[] {
  console.log(`[cross-check] fetching ground truth via ${OPENCLAW_BIN} sessions --active ${ACTIVE_MINUTES} ...`);
  let raw: string;
  try {
    raw = execSync(`${OPENCLAW_BIN} sessions --all-agents --active ${ACTIVE_MINUTES} --json`, {
      encoding: "utf-8",
      timeout: 60_000,
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (err) {
    console.error(`[cross-check] FATAL: openclaw CLI failed — ${(err as Error).message?.slice(0, 200)}`);
    process.exit(1);
  }
  let parsed: any;
  try { parsed = JSON.parse(raw); }
  catch {
    console.error("[cross-check] FATAL: openclaw CLI returned non-JSON");
    process.exit(1);
  }
  const list: any[] = Array.isArray(parsed) ? parsed : parsed.sessions || [];
  return list.map((s) => ({
    key: s.key || "",
    sessionId: s.sessionId || "",
    inputTokens: s.inputTokens || 0,
    outputTokens: s.outputTokens || 0,
    totalTokens: s.totalTokens || 0,
    model: s.model || "",
  })).filter(s => s.key);
}

// ─── Read obs.db sessions by composite (key, sessionId) ─────────
// Cron sessions have many rows sharing a key (one per run); a plain
// `WHERE session_key = ?` with LIMIT 1 returns the wrong row. We pin by
// (session_key, session_id) which matches the sessions PRIMARY KEY.

interface ObsRow { input: number; output: number; total: number; source: string; model: string }

function readObsDb(pairs: Array<{ key: string; sessionId: string }>): Map<string, ObsRow> {
  const db = new DatabaseSync(CONFIG.DB_PATH, { readOnly: true });
  const map = new Map<string, ObsRow>();
  const stmt = db.prepare(
    "SELECT input_tokens, output_tokens, total_tokens, source, model FROM sessions WHERE session_key = ? AND session_id = ? LIMIT 1",
  );
  for (const { key, sessionId } of pairs) {
    const row = stmt.get(key, sessionId) as any;
    if (row) {
      map.set(`${key}|${sessionId}`, {
        input: row.input_tokens || 0,
        output: row.output_tokens || 0,
        total: row.total_tokens || 0,
        source: row.source || "unknown",
        model: row.model || "",
      });
    }
  }
  db.close();
  return map;
}

// ─── Compare ────────────────────────────────────────────────────

interface Mismatch {
  key: string;
  sessionId: string;
  field: string;
  official: number;
  obs: number;
  diff: number;
}

interface CompareOutcome {
  official: OfficialSession[];
  obsData: Map<string, ObsRow>;
  mismatches: Mismatch[];
  missing: Array<{ key: string; sessionId: string }>;
}

function compareOnce(): CompareOutcome {
  const official = fetchOfficial();
  console.log(`[cross-check] official returned ${official.length} sessions`);
  if (official.length === 0) {
    return { official, obsData: new Map(), mismatches: [], missing: [] };
  }

  const obsData = readObsDb(official.map(s => ({ key: s.key, sessionId: s.sessionId })));
  console.log(`[cross-check] obs.db covered ${obsData.size}/${official.length} of them (composite key)`);

  const mismatches: Mismatch[] = [];
  const missing: Array<{ key: string; sessionId: string }> = [];

  for (const off of official) {
    const obs = obsData.get(`${off.key}|${off.sessionId}`);
    if (!obs) { missing.push({ key: off.key, sessionId: off.sessionId }); continue; }
    const fields: Array<[string, number, number]> = [
      ["total_tokens",  off.totalTokens,  obs.total],
      ["input_tokens",  off.inputTokens,  obs.input],
      ["output_tokens", off.outputTokens, obs.output],
    ];
    for (const [field, o, a] of fields) {
      const diff = Math.abs(o - a);
      if (diff > TOLERANCE) mismatches.push({ key: off.key, sessionId: off.sessionId, field, official: o, obs: a, diff });
    }
  }
  return { official, obsData, mismatches, missing };
}

let { official, obsData, mismatches, missing } = compareOnce();

// Retry once if the first pass failed — auth-poller runs every 30 s, so a
// brand-new session can legitimately be in obs.db a few seconds stale.
if ((mismatches.length > 0 || missing.length > 0) && RETRY_WAIT_SEC > 0 && official.length > 0) {
  console.log(`\n[cross-check] first-pass drift detected; sleeping ${RETRY_WAIT_SEC}s and retrying to rule out auth-poller lag ...`);
  await sleep(RETRY_WAIT_SEC * 1000);
  ({ official, obsData, mismatches, missing } = compareOnce());
}

if (official.length === 0) {
  console.log("[cross-check] no sessions to check — pass trivially");
  process.exit(0);
}

// ─── Report ─────────────────────────────────────────────────────

console.log("\n=== Cross-check report ===");
console.log(`  official sessions:     ${official.length}`);
console.log(`  covered in obs.db:     ${obsData.size}`);
console.log(`  missing in obs.db:     ${missing.length}`);
console.log(`  token field mismatches: ${mismatches.length}  (tolerance ±${TOLERANCE})`);

if (missing.length > 0) {
  console.log("\n  missing (first 5):");
  for (const m of missing.slice(0, 5)) console.log(`    ${m.key}  sid=${m.sessionId.slice(0, 8)}`);
}

if (mismatches.length > 0) {
  console.log("\n  mismatches (first 10):");
  for (const m of mismatches.slice(0, 10)) {
    console.log(`    ${m.field}: official=${m.official} obs=${m.obs} diff=${m.diff}`);
    console.log(`      ${m.key}  sid=${m.sessionId.slice(0, 8)}`);
  }
  console.log("\n  RESULT: FAIL");
  process.exit(1);
}

console.log("\n  RESULT: PASS — every overlapping session matches within tolerance");
process.exit(0);
