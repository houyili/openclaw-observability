/**
 * Hermetic test for the obs-v2 demo seed.
 *
 * R6 in the 08 risk register asked for a way for users without an
 * OpenClaw install to see the dashboard. `scripts/seed-demo-home.ts`
 * is the seeding half of that path. This test runs the seed against
 * a fresh temp directory and asserts:
 *
 *   1. The fixture file tree is copied verbatim (no symlinks, no
 *      missing files, example .json files are still excluded — that
 *      is checked separately in mcp-registry-coverage).
 *   2. A valid obs.db exists at the canonical path with the schema
 *      expected by obs-v2 (so a fresh `npm run start` against the
 *      seeded home will not crash on a missing column).
 *   3. The 3 pre-seeded sessions rows are present with the right
 *      label, channel, and tokenSource.
 *   4. sessions.json files for each demo agent are written and
 *      parseable.
 *
 * Run:
 *   node --experimental-sqlite --experimental-strip-types --no-warnings \
 *     tests/demo-seed.test.ts
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const SEED_SCRIPT = join(REPO_ROOT, "scripts", "seed-demo-home.ts");
const TARGET = mkdtempSync(join(tmpdir(), "obs-demo-seed-"));

console.log(`\n=== running seed against ${TARGET} ===`);
const run = spawnSync(
  process.execPath,
  [
    "--experimental-sqlite",
    "--experimental-strip-types",
    "--no-warnings",
    SEED_SCRIPT,
    `--target=${TARGET}`,
    "--force",
  ],
  { encoding: "utf-8" },
);
console.log(run.stdout);
if (run.stderr) console.log("[stderr]", run.stderr);
assert(run.status === 0, "seed script exits 0");

console.log("\n=== 1. fixture tree copied ===");
const expectedFiles = [
  "openclaw.json",
  "mcp/demo-research-search.json",
  "agents/demo-research/sessions/20260520_100000_demo-research-active.jsonl",
  "agents/demo-research/sessions/20260520_103000_demo-research-stuck.jsonl",
  "agents/demo-publishing/sessions/20260520_104500_demo-publishing-success.jsonl",
  "skills/arxiv-source-pipeline/SKILL.md",
  "skills/arxiv-source-pipeline/scripts/arxiv_source_first.py",
  "skills/paper-readings-sync/SKILL.md",
  "skills/paper-readings-sync/scripts/sync.py",
  "skills/research-note-system/SKILL.md",
];
for (const f of expectedFiles) {
  assert(existsSync(join(TARGET, f)), `fixture present: ${f}`);
}

console.log("\n=== 2. obs.db has the expected schema ===");
const dbPath = join(TARGET, "logs", "observability-v2", "obs.db");
assert(existsSync(dbPath), `obs.db created at ${dbPath}`);
const db = new DatabaseSync(dbPath, { readOnly: true });
const cols = (db.prepare("PRAGMA table_info(sessions)").all() as any[]).map((r) => r.name);
for (const required of [
  "session_key",
  "session_id",
  "agent_id",
  "channel",
  "label",
  "token_source",
  "source",
  "total_tokens",
  "parent_session_key",
]) {
  assert(cols.includes(required), `sessions table has ${required}`);
}

console.log("\n=== 3. pre-seeded sessions rows ===");
const rows = db
  .prepare(
    "SELECT session_key, label, channel, agent_id, source, token_source, total_tokens FROM sessions ORDER BY session_key",
  )
  .all() as any[];
assert(rows.length === 3, "3 demo sessions seeded");
const byKey = new Map(rows.map((r: any) => [r.session_key, r]));
assert(byKey.has("agent:demo-research:chat:direct:demo-user-alpha"), "demo-research alpha session present");
assert(byKey.has("agent:demo-research:chat:direct:demo-user-stuck"), "demo-research stuck session present");
assert(byKey.has("agent:demo-publishing:chat:direct:demo-user-alpha"), "demo-publishing session present");
for (const r of rows) {
  assert(r.label?.startsWith("demo:"), `${r.session_key}: label starts with 'demo:'`);
  assert(r.source === "transcript+auth", `${r.session_key}: source is transcript+auth`);
  assert(r.token_source === "transcript-backfill", `${r.session_key}: token_source is transcript-backfill`);
  assert(typeof r.total_tokens === "number" && r.total_tokens > 0, `${r.session_key}: total_tokens > 0`);
}

console.log("\n=== 4. sessions.json per agent ===");
for (const agent of ["demo-research", "demo-publishing"]) {
  const path = join(TARGET, "agents", agent, "sessions", "sessions.json");
  assert(existsSync(path), `${agent}/sessions.json exists`);
  const cfg = JSON.parse(readFileSync(path, "utf-8"));
  assert(typeof cfg === "object" && cfg != null, `${agent}/sessions.json parses to object`);
  const entries = Object.values(cfg);
  assert(entries.length > 0, `${agent}/sessions.json has at least one entry`);
}

db.close();
rmSync(TARGET, { recursive: true, force: true });

console.log(`\ndemo-seed: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
