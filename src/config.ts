import { homedir } from "node:os";
import { join } from "node:path";

const HOME = process.env.OPENCLAW_HOME || join(homedir(), ".openclaw");

export const CONFIG = {
  // Paths
  OPENCLAW_HOME: HOME,
  AGENTS_DIR: join(HOME, "agents"),
  DB_PATH: join(HOME, "logs/observability-v2/obs.db"),
  OTEL_EVENTS_FILE: join(HOME, "logs/research-observability/events.jsonl"),
  HOOK_REMINDERS_FILE: join(HOME, "logs/hooks/reminders.jsonl"),

  // Network
  HOST: process.env.OBS_HOST || "127.0.0.1",
  // Honoring OBS_PORT lets the demo mode (and any other side-by-side
  // launch) run without colliding with the user's primary obs-v2
  // service. Falls back to the canonical 18902.
  PORT: Number(process.env.OBS_PORT) || 18902,

  // Poll intervals
  // auth-poller calls `openclaw sessions --all-agents --active N --json` which
  // itself takes 10+ seconds at high CPU. 30s cadence keeps us below 50% duty.
  AUTH_POLL_MS: 30_000,
  TRANSCRIPT_POLL_MS: 2_000,
  // OTel is only used for diagnosticState — tail 200KB of events.jsonl.
  // We also gate the tick by file mtime so unchanged = no work.
  OTEL_POLL_MS: 15_000,
  HOOK_POLL_MS: 5_000,
  // recomputeAllSessionOps is a heavy DB pass (one aggregation per base key).
  // It does NOT need to run on every OTel tick — 30s is plenty for current_op/blocker freshness.
  RECOMPUTE_OPS_MS: 30_000,

  // Timeouts
  EXTERNAL_TIMEOUT_MS: 30_000,

  // Windows
  // 240 minutes (4h) keeps the CLI call bounded. 720 historically timed out.
  AUTH_ACTIVE_MINUTES: 240,

  // Stuck threshold (requirement 3.1: > 60s = stuck)
  STUCK_THRESHOLD_MS: 60_000,

  // Activity thumbnail bars (8x window: 4h total, 4min per bucket, 60 buckets)
  ACTIVITY_BAR_MINUTES: 240,
  ACTIVITY_BAR_BUCKETS: 60,

  // Built-in tool names (anything not in this set is treated as MCP tool)
  BUILTIN_TOOLS: new Set([
    "read",
    "write",
    "edit",
    "exec",
    "glob",
    "grep",
    "process",
    "cron",
    "sessions_spawn",
    "sessions_list",
    "sessions_yield",
    "sessions_history",
    "sessions_send",
    "session_status",
    "subagents",
    "web_search",
    "web_fetch",
    "memory_search",
    "image",
    "canvas",
    "pdf",
  ]),
} as const;
