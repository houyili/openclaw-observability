/**
 * Replay-verify: per-run-id correctness check against currently-existing transcripts.
 *
 * Design intent:
 *   For every transcript file that still exists on disk, clean-parse it with
 *   the current parser and count steps per run_id. Then look up the same
 *   run_id in obs.db. If the counts disagree, the live watcher dropped or
 *   double-counted steps.
 *
 *   Run_ids are the UUIDs of user-message entries (globally unique) — so a
 *   1:1 correspondence between "clean-parse of file X" and "DB rows with that
 *   run_id" is safe. Deleted-file history in the DB is IGNORED by this test,
 *   which matches the design doc §6 requirement that historical data is
 *   preserved rather than pruned.
 *
 * What counts as drift:
 *   - run_id present in the current file but missing from DB  → missed ingest
 *   - step count in DB < clean-parse count for that run_id    → dropped steps
 *   - step count in DB > clean-parse count for that run_id    → double-counted
 *
 *   Per-key aggregate drift is ONLY a warning (may be legitimate history).
 *
 * Run:
 *   node --experimental-sqlite --experimental-strip-types --no-warnings \
 *     tests/replay-verify.ts
 */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CONFIG } from "../src/config.ts";
import { parseTranscript, type TranscriptEntry } from "../src/ingest/transcript-parser.ts";
import { isCanonicalTranscriptFile } from "../src/ingest/transcript-files.ts";

// Any file the OS reports as written within this many ms of "now" is
// considered "actively being written" — drift on these is treated as a
// snapshot/watcher race rather than a real bug. 8 s comfortably covers
// one transcript-watcher tick (2 s) plus a slow upsert + filesystem
// timestamp granularity.
const RACE_MTIME_GRACE_MS = 8_000;

// ─── File discovery ─────────────────────────────────────────────

function findTranscripts(): string[] {
  const files: string[] = [];
  const agentsDir = CONFIG.AGENTS_DIR;
  if (!existsSync(agentsDir)) return files;
  for (const agent of readdirSync(agentsDir, { withFileTypes: true })) {
    if (!agent.isDirectory()) continue;
    const sessionsDir = join(agentsDir, agent.name, "sessions");
    if (!existsSync(sessionsDir)) continue;
    for (const f of readdirSync(sessionsDir)) {
      if (!isCanonicalTranscriptFile(f)) continue;
      files.push(join(sessionsDir, f));
    }
  }
  return files;
}

// ─── Clean parse each file → per-run-id step counts ─────────────

interface RunCount { filePath: string; runId: string; cleanSteps: number; }

function parseAll(files: string[]): RunCount[] {
  const result: RunCount[] = [];
  let totalSteps = 0;
  for (const file of files) {
    try {
      const raw = readFileSync(file, "utf-8");
      if (!raw.trim()) continue;
      const entries: TranscriptEntry[] = [];
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try { entries.push(JSON.parse(line)); } catch { /* skip */ }
      }
      // sessionKey does not affect per-run-step counts, use a placeholder.
      const runs = parseTranscript(entries, "__replay__");
      for (const run of runs) {
        result.push({ filePath: file, runId: run.runId, cleanSteps: run.steps.length });
        totalSteps += run.steps.length;
      }
    } catch (err) {
      console.error(`  ! ${basename(file)}: ${(err as Error).message}`);
    }
  }
  console.log(`[replay-verify] clean-parse: ${files.length} files → ${result.length} runs, ${totalSteps} steps`);
  return result;
}

// ─── DB lookup per run_id ───────────────────────────────────────

function dbStepCounts(runIds: string[]): Map<string, number> {
  const db = new DatabaseSync(CONFIG.DB_PATH, { readOnly: true });
  const map = new Map<string, number>();
  const stmt = db.prepare("SELECT COUNT(*) as n FROM steps WHERE run_id = ?");
  for (const rid of runIds) {
    const row = stmt.get(rid) as any;
    map.set(rid, row?.n || 0);
  }
  db.close();
  return map;
}

// ─── Compare ────────────────────────────────────────────────────

const files = findTranscripts();
const runCounts = parseAll(files);

const counts = dbStepCounts(runCounts.map(r => r.runId));

let missing = 0;     // run_id absent from DB
let dropped = 0;     // DB < clean (missed ingest of specific steps)
let duplicated = 0;  // DB > clean (double-counted from THIS file)
let matched = 0;
const diffs: string[] = [];

for (const rc of runCounts) {
  const dbN = counts.get(rc.runId) || 0;
  // clean=0 runs are user messages with no assistant response (e.g. llmbox
  // probe pings that never reply). "Zero in file, zero in DB" is a match.
  if (rc.cleanSteps === 0 && dbN === 0) { matched++; continue; }
  if (dbN === 0) {
    missing++;
    if (diffs.length < 20) {
      diffs.push(`  MISSING  ${basename(rc.filePath)} run=${rc.runId.slice(0,8)} clean=${rc.cleanSteps} db=0`);
    }
    continue;
  }
  if (dbN < rc.cleanSteps) {
    dropped++;
    if (diffs.length < 20) {
      diffs.push(`  DROPPED  ${basename(rc.filePath)} run=${rc.runId.slice(0,8)} clean=${rc.cleanSteps} db=${dbN}`);
    }
    continue;
  }
  if (dbN > rc.cleanSteps) {
    duplicated++;
    if (diffs.length < 20) {
      diffs.push(`  EXTRA    ${basename(rc.filePath)} run=${rc.runId.slice(0,8)} clean=${rc.cleanSteps} db=${dbN}`);
    }
    continue;
  }
  matched++;
}

console.log("\n=== Replay-verify report ===");
console.log(`  runs checked:   ${runCounts.length}`);
console.log(`  matched:        ${matched}`);
console.log(`  missing in DB:  ${missing}`);
console.log(`  dropped steps:  ${dropped}`);
console.log(`  extra steps:    ${duplicated}`);

if (diffs.length > 0) {
  console.log("\n  Diffs (first 20):");
  for (const d of diffs) console.log(d);
}

// Grace window for live races (P2-2 fix):
//   Clean-parse and the DB snapshot are not atomic. A session that is
//   actively writing its transcript will normally show a 1-2 step drift
//   between the parsed file and what the watcher has flushed to the DB.
//   The old version hard-coded "≤ 1 such run". That is wrong on a busy
//   machine where 3 sessions can all be live at once.
//
//   New rule: a DROPPED run is forgiven IFF its source file's mtime is
//   within RACE_MTIME_GRACE_MS of "now" — i.e. the OS thinks the file is
//   being touched right now. There is no per-run cap. A drift on an
//   unchanged file (mtime > grace window in the past) is always a real
//   regression and fails the suite.
const now = Date.now();

let realDrops = 0;
let raceForgiven = 0;
for (const d of diffs) {
  if (!d.startsWith("  DROPPED")) continue;

  // Recover the source file path from the diff line we already built.
  // Format: "  DROPPED  <basename>.jsonl run=... clean=N db=M"
  const fnMatch = d.match(/DROPPED\s+(\S+)/);
  if (!fnMatch) { realDrops++; continue; }
  const fileBaseName = fnMatch[1];

  // Look the runCount entry up by basename to recover the absolute path.
  const rc = runCounts.find((r) => basename(r.filePath) === fileBaseName);
  if (!rc) { realDrops++; continue; }

  let mtimeMs = 0;
  try { mtimeMs = statSync(rc.filePath).mtimeMs; } catch { /* ignore */ }
  const isLiveRace = mtimeMs > 0 && now - mtimeMs < RACE_MTIME_GRACE_MS;

  if (isLiveRace) {
    raceForgiven++;
  } else {
    realDrops++;
  }
}

const fail = missing + realDrops + duplicated;
if (fail > 0) {
  console.log(`\n  RESULT: FAIL — ${fail}/${runCounts.length} runs drifted (forgave ${raceForgiven} live-write race${raceForgiven === 1 ? "" : "s"})`);
  process.exit(1);
}

if (raceForgiven > 0) {
  console.log(`\n  RESULT: PASS — every run matches (${raceForgiven} forgiven by mtime race window, ${RACE_MTIME_GRACE_MS}ms)`);
} else {
  console.log("\n  RESULT: PASS — every run in every live file matches DB step count");
}
process.exit(0);
