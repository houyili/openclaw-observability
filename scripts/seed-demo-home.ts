/**
 * Seed a hermetic `$OPENCLAW_HOME` for the obs-v2 demo mode.
 *
 * Copies `tests/fixtures/demo/` into the target directory so the rest
 * of obs-v2 (transcript-watcher, registry-scanner, auth-poller) can
 * run against synthetic data instead of the user's real OpenClaw
 * install. The target is intentionally NOT `~/.openclaw` — we never
 * touch the operator's live runtime state.
 *
 * Defaults to `/tmp/obs-v2-demo-home` (override with `--target=...`).
 * Force rebuild with `--force` (otherwise refuses to clobber an
 * existing populated directory).
 *
 * Usage:
 *   node --experimental-sqlite --experimental-strip-types --no-warnings \
 *     scripts/seed-demo-home.ts [--target /path] [--force]
 *
 * Once seeded, run:
 *   OPENCLAW_HOME=/path npm run start
 *
 * (Or just `scripts/demo.sh` which wraps both steps.)
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = dirname(dirname(__filename));
const FIXTURE_DIR = join(REPO_ROOT, "tests", "fixtures", "demo");

function argValue(flag: string, fallback: string): string {
  const args = process.argv.slice(2);
  for (const a of args) {
    if (a === flag) return "true";
    if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1);
  }
  return fallback;
}

const TARGET = argValue("--target", "/tmp/obs-v2-demo-home");
const FORCE = argValue("--force", "") !== "";

function copyTree(src: string, dst: string): number {
  let copied = 0;
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name);
    const dstPath = join(dst, entry.name);
    if (entry.isDirectory()) {
      copied += copyTree(srcPath, dstPath);
    } else if (entry.isFile()) {
      copyFileSync(srcPath, dstPath);
      copied++;
    }
  }
  return copied;
}

function isPopulated(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const entries = readdirSync(path);
    return entries.length > 0;
  } catch {
    return false;
  }
}

if (!existsSync(FIXTURE_DIR)) {
  console.error(`[demo] fixture missing: ${FIXTURE_DIR}`);
  process.exit(1);
}

if (isPopulated(TARGET) && !FORCE) {
  console.error(`[demo] target already populated: ${TARGET}`);
  console.error(`[demo] re-run with --force to overwrite, or use --target=/some/other/path`);
  process.exit(1);
}

// Ensure log/db dirs exist alongside the seed so obs-v2 has a place
// to write its own state without touching the user's live ~/.openclaw.
mkdirSync(join(TARGET, "logs", "observability-v2"), { recursive: true });

// Copy every fixture file into the target (preserves relative paths).
const copied = copyTree(FIXTURE_DIR, TARGET);

// Pre-seed sessions.json for each demo agent so readSessionStoreExtras
// can resolve labels and parent links if the user spins up downstream
// tooling. Each entry mirrors the canonical session_id used in the
// transcript filename.
function writeSessionsJson(agent: string, entries: Record<string, any>): void {
  const path = join(TARGET, "agents", agent, "sessions", "sessions.json");
  writeFileSync(path, JSON.stringify(entries, null, 2));
}
const _nowIso = new Date().toISOString();
writeSessionsJson("demo-research", {
  "agent:demo-research:chat:direct:demo-user-alpha": {
    sessionId: "demo-research-active",
    label: "demo: arxiv synthesis run",
    spawnedBy: null,
  },
  "agent:demo-research:chat:direct:demo-user-stuck": {
    sessionId: "demo-research-stuck",
    label: "demo: web_fetch hanging",
    spawnedBy: null,
  },
});
writeSessionsJson("demo-publishing", {
  "agent:demo-publishing:chat:direct:demo-user-alpha": {
    sessionId: "demo-publishing-success",
    label: "demo: publish + sync",
    spawnedBy: null,
  },
});

// Pre-seed obs.db: insert synthetic sessions rows so the dashboard's
// session table is not empty on first load. obs-v2 itself only creates
// sessions rows from auth-poller output, which requires a working
// `openclaw` CLI; the demo intentionally fakes the auth-poller side
// here so the dashboard works without OpenClaw installed.
const dbPath = join(TARGET, "logs", "observability-v2", "obs.db");
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode=WAL");
db.exec(`CREATE TABLE IF NOT EXISTS sessions (
  session_key TEXT NOT NULL, session_id TEXT,
  agent_id TEXT, channel TEXT, diag TEXT, label TEXT, kind TEXT,
  model TEXT, model_provider TEXT,
  input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER, context_tokens INTEGER,
  runtime_mode TEXT,
  llm_call_count INTEGER DEFAULT 0, tool_call_count INTEGER DEFAULT 0,
  skill_call_count INTEGER DEFAULT 0, mcp_call_count INTEGER DEFAULT 0,
  diag_state TEXT, current_op TEXT, blocker TEXT, last_block_ts INTEGER,
  updated_at INTEGER, age_ms INTEGER,
  source TEXT DEFAULT 'auth-only', token_source TEXT DEFAULT 'official',
  parent_session_key TEXT, parent_session_id TEXT,
  PRIMARY KEY (session_key, session_id)
)`);
const seed = db.prepare(`INSERT OR REPLACE INTO sessions
  (session_key, session_id, agent_id, channel, diag, label, kind,
   model, model_provider, input_tokens, output_tokens, total_tokens, context_tokens,
   runtime_mode, updated_at, source, token_source)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const tNow = Date.now();
seed.run(
  "agent:demo-research:chat:direct:demo-user-alpha",
  "demo-research-active",
  "demo-research",
  "chat-direct",
  "user:demo-user-alpha",
  "demo: arxiv synthesis run",
  "direct",
  "demo-fast-model",
  "demo-provider",
  5000,
  110,
  5085,
  5000,
  "default",
  tNow,
  "transcript+auth",
  "transcript-backfill",
);
seed.run(
  "agent:demo-research:chat:direct:demo-user-stuck",
  "demo-research-stuck",
  "demo-research",
  "chat-direct",
  "user:demo-user-stuck",
  "demo: web_fetch hanging",
  "direct",
  "demo-fast-model",
  "demo-provider",
  900,
  80,
  980,
  900,
  "default",
  tNow,
  "transcript+auth",
  "transcript-backfill",
);
seed.run(
  "agent:demo-publishing:chat:direct:demo-user-alpha",
  "demo-publishing-success",
  "demo-publishing",
  "chat-direct",
  "user:demo-user-alpha",
  "demo: publish + sync",
  "direct",
  "demo-fast-model",
  "demo-provider",
  1900,
  35,
  1935,
  1900,
  "default",
  tNow,
  "transcript+auth",
  "transcript-backfill",
);
db.close();

console.log(`[demo] seeded ${copied} file(s) into ${TARGET}`);
console.log(`[demo] pre-populated obs.db with 3 demo sessions`);
console.log(`[demo] obs.db will be created at: ${join(TARGET, "logs/observability-v2/obs.db")}`);
console.log(`[demo] start the dashboard with:`);
console.log(`[demo]   OPENCLAW_HOME=${TARGET} npm run start`);
console.log(`[demo] dashboard URL: http://127.0.0.1:18902`);
console.log(`[demo] (set OBS_AUTH_TOKEN='' in your shell if .env normally enables auth)`);
