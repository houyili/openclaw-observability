import { statSync } from "node:fs";
import { CONFIG } from "./config.ts";
import { getDb, closeDb } from "./storage/db.ts";
import { startTranscriptWatcher } from "./ingest/transcript-watcher.ts";
import { pollAuthSessionsAsync, readSessionStoreExtras } from "./ingest/auth-poller.ts";
import { readLatestOtelStates } from "./ingest/otel-reader.ts";
import { scanAll } from "./ingest/registry-scanner.ts";
import { upsertAuthSessions, recomputeSessionCounts, recomputeAllSessionCounts, recomputeAllSessionOps, updateSessionDiagState, updateSessionLabel, updateSessionParent, updateSessionBlocker } from "./storage/sessions-repo.ts";
import { upsertSteps } from "./storage/steps-repo.ts";
import { upsertRegistryEntries, touchRegistryEntry } from "./storage/registry-repo.ts";
import { startServer } from "./api/server.ts";
import type { ParsedRun } from "./ingest/transcript-parser.ts";

console.log("[observability-v2] Starting...");
console.log(`  DB: ${CONFIG.DB_PATH}`);
console.log(`  Agents dir: ${CONFIG.AGENTS_DIR}`);

// ─── Initialize DB ──────────────────────────────────────────────
getDb();

// ─── Registry scan (one-time at startup) ────────────────────────
const registryEntries = scanAll();
upsertRegistryEntries(registryEntries);
console.log(`[registry] Scanned ${registryEntries.length} entries (${registryEntries.filter(e => e.type === "skill").length} skills, ${registryEntries.filter(e => e.type === "script").length} scripts, ${registryEntries.filter(e => e.type === "mcp").length} MCPs)`);

// ─── Auth session poller (async — never blocks HTTP server) ─────
function doAuthPoll(): void {
  pollAuthSessionsAsync((sessions) => {
    try {
      if (sessions.length > 0) {
        upsertAuthSessions(sessions);
      }
      // Enrich with label + parent from session store (not available in CLI --json)
      const extras = readSessionStoreExtras();
      for (const [key, extra] of extras) {
        if (extra.label) updateSessionLabel(key, extra.label);
        if (extra.parentSessionKey) updateSessionParent(key, extra.parentSessionKey, extra.parentSessionId);
      }
    } catch (err) {
      console.error("[auth-poller] Error:", (err as Error).message);
    }
  });
}
doAuthPoll();
const authInterval = setInterval(doAuthPoll, CONFIG.AUTH_POLL_MS);

// ─── OTel state reader ─────────────────────────────────────────
// Gate the read by events.jsonl mtime so we do zero work when nothing changed.
let lastOtelMtime = 0;
function doOtelRead(): void {
  try {
    let mtime = 0;
    try { mtime = statSync(CONFIG.OTEL_EVENTS_FILE).mtimeMs; } catch { return; }
    if (mtime === lastOtelMtime) return;
    lastOtelMtime = mtime;

    const states = readLatestOtelStates();
    for (const [key, state] of states) {
      updateSessionDiagState(key, state.diagnosticState);
    }
  } catch (err) {
    console.error("[otel-reader] Error:", (err as Error).message);
  }
}
doOtelRead();
const otelInterval = setInterval(doOtelRead, CONFIG.OTEL_POLL_MS);

// ─── Targeted recompute scheduler ───────────────────────────────
// Instead of re-aggregating every session_key on every tick, the transcript
// watcher records which base keys actually received new steps. A throttled
// interval drains that set (empty set → whole-table recompute when no activity
// for long, to pick up auth-only sessions). Cost is bounded to sessions that
// actually changed.
const dirtyBaseKeys = new Set<string>();
let lastFullOpsSweepAt = 0;
function doRecomputeOps(): void {
  try {
    if (dirtyBaseKeys.size > 0) {
      const pending = new Set(dirtyBaseKeys);
      dirtyBaseKeys.clear();
      recomputeAllSessionOps(pending);
    }
    const now = Date.now();
    if (now - lastFullOpsSweepAt >= CONFIG.RECOMPUTE_OPS_MS) {
      recomputeAllSessionOps();
      lastFullOpsSweepAt = now;
    }
  } catch (err) {
    console.error("[recompute-ops] Error:", (err as Error).message);
  }
}
const recomputeInterval = setInterval(doRecomputeOps, CONFIG.RECOMPUTE_OPS_MS);

// ──�� Transcript watcher ────────────────────────────────────────
const watcher = startTranscriptWatcher({
  onRuns(sessionKey: string, runs: ParsedRun[]): void {
    for (const run of runs) {
      upsertSteps(run);

      for (const step of run.steps) {
        // Lazy-load new skills/scripts/MCPs into registry (with path from input preview)
        if (step.skillName) {
          const skillDir = CONFIG.OPENCLAW_HOME + "/skills/" + step.skillName;
          touchRegistryEntry("skill", step.skillName, skillDir);
        }
        if (step.scriptName && step.skillName) {
          const scriptPath = CONFIG.OPENCLAW_HOME + "/skills/" + step.skillName + "/scripts/" + step.scriptName;
          touchRegistryEntry("script", step.scriptName, scriptPath);
        } else if (step.scriptName) {
          touchRegistryEntry("script", step.scriptName);
        }
        if (step.mcpTool) touchRegistryEntry("mcp", step.mcpTool);

        // Update blocker if step is stuck
        if (step.isStuck && step.isCurrent) {
          updateSessionBlocker(sessionKey, step.toolName || step.nodeType, step.tsEpochMs);
        }
      }
    }

    // Recompute counts from steps table (idempotent — safe on restart)
    recomputeSessionCounts(sessionKey);

    // Mark this session dirty so the next recompute tick picks it up.
    // sessionKey coming from the watcher is already a base key.
    dirtyBaseKeys.add(sessionKey);

    // Set currentOp from the latest running step
    const lastRunningStep = runs[runs.length - 1]?.steps.filter(s => s.isCurrent).pop();
    if (lastRunningStep) {
      updateSessionDiagState(sessionKey, "processing", lastRunningStep.toolName || lastRunningStep.nodeType);
    }
  },
});

// ─── Startup recompute (catch up on data from previous runs) ────
recomputeAllSessionCounts();
recomputeAllSessionOps(); // full pass once, then incremental via dirtyBaseKeys
console.log("[startup] Recomputed all session counts and ops from steps table");

// ─── HTTP server ────────────────────────────────────────────────
startServer();

// ─── Graceful shutdown ──────────────────────────────────────────
function shutdown(): void {
  console.log("\n[observability-v2] Shutting down...");
  watcher.stop();
  clearInterval(authInterval);
  clearInterval(otelInterval);
  clearInterval(recomputeInterval);
  closeDb();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
